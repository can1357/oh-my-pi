/**
 * SQLite-backed model cache for atomic cross-process access.
 * Replaces per-provider JSON files with a single cache.db.
 */
import type { Database } from "bun:sqlite";
import * as path from "node:path";
import { getModelDbPath, isSqliteCorruptionError, logger, openSqliteDatabaseSync, VERSION } from "@oh-my-pi/pi-utils";
import RULES from "./compat/rules.json" with { type: "json" };
import type { Api, Model } from "./types";

// Rows persist fully materialized Models so compatible warm-cache reads do not
// rerun the compat cascade. Request headers are intentionally omitted:
// arbitrary provider-defined header names can carry credentials. v13 replaces
// sparse ModelSpec rows with materialized rows and records the exact app/rules/
// builder policy that produced them. v12 invalidated Kimi Code rows carrying the blanket
// maxTokens: 32000 that predate per-family output caps (k3/k3-256k -> 131072,
// kimi-for-coding[-highspeed] -> 32768, #6711); v11 invalidates rows that may
// persist derived computer-use
// headers and records which model ids lost headers or cannot be rebuilt.
// v9 invalidated Kimi Code rows predating live effort and protocol metadata;
// v8 invalidated Codex discovery rows predating provider-native V2 compaction
// metadata; v7 invalidated rows predating the Antigravity Gemini budget-mode
// migration (cached specs still carrying `thinking.mode: "google-level"` and
// the old 3.5-flash effort routing); v6 invalidated rows that may contain the
// retired unknown-limit sentinels (222222/8888); v5 invalidated rows predating
// effort-tier variant collapsing (raw `-low`/`-high`/`-thinking` member ids);
// v4 dropped the pre-efforts ThinkingConfig shape.
const CACHE_SCHEMA_VERSION = 13;
/** Oldest schema whose rows are guaranteed never to carry request headers. */
const FIRST_HEADERLESS_SCHEMA_VERSION = 11;
const HEADER_RESTORE_VERSION = 1;
/**
 * Explicit compatibility gate for materialized rows. Bump whenever buildModel
 * semantics change without an app-version change. The compiled-rules content
 * hash catches every KDL policy edit even when the package version is unchanged;
 * computed lazily on first cache access and memoized, so processes that never
 * touch the model cache skip the stringify entirely.
 */
const MODEL_MATERIALIZATION_VERSION = 2;
let cachedMaterializationPolicy: string | undefined;
function materializationPolicy(): string {
	if (cachedMaterializationPolicy === undefined) {
		cachedMaterializationPolicy =
			`app-${VERSION}:builder-${MODEL_MATERIALIZATION_VERSION}:rules-${RULES.version}-` +
			Bun.hash(JSON.stringify(RULES)).toString(36);
	}
	return cachedMaterializationPolicy;
}

interface CacheRowMeta {
	provider_id: string;
	version: number;
	materialization_policy: string;
	updated_at: number;
	authoritative: number;
	static_fingerprint: string;
	/**
	 * `Bun.hash` of `models`; empty for rows written before the column existed
	 * (never equal). An in-place `UPDATE` of `models` that leaves the hash
	 * untouched resets it to empty (`model_cache_models_hash_reset` trigger).
	 */
	models_hash: string;
	header_omitted_model_ids: string;
	unrestorable_header_model_ids: string;
	header_restore_version: number;
	/** `model_cache_refresh` columns joined onto the payload row; null when absent. */
	refresh_payload_updated_at: number | null;
	refresh_updated_at: number | null;
	refresh_authoritative: number | null;
}

interface CacheRow extends CacheRowMeta {
	models: string;
}

/**
 * Payload rows are multi-MB and SQLite rewrites a whole record (including its
 * overflow pages) on any column update. Freshness that advances without a
 * payload change therefore lives in `model_cache_refresh`, a small side row
 * keyed by provider. It applies only while `payload_updated_at` still matches
 * the payload row's `updated_at`, so a payload rewritten by another binary
 * silently invalidates it.
 */
const CACHE_ROW_FROM = `
	FROM model_cache m
	LEFT JOIN model_cache_refresh r ON r.provider_id = m.provider_id
	WHERE m.provider_id = ?
`;
const CACHE_ROW_REFRESH_COLUMNS = `
		r.payload_updated_at AS refresh_payload_updated_at,
		r.updated_at AS refresh_updated_at,
		r.authoritative AS refresh_authoritative`;
const SELECT_CACHE_ROW = `SELECT m.*, ${CACHE_ROW_REFRESH_COLUMNS} ${CACHE_ROW_FROM}`;
/** Scalar columns plus `models_hash`: validates a memoized parse without reading the multi-MB payload. */
const SELECT_CACHE_ROW_META = `
	SELECT m.provider_id, m.version, m.materialization_policy, m.updated_at, m.authoritative,
		m.static_fingerprint, m.models_hash, m.header_omitted_model_ids,
		m.unrestorable_header_model_ids, m.header_restore_version, ${CACHE_ROW_REFRESH_COLUMNS}
	${CACHE_ROW_FROM}
`;

/** Cumulative model-cache write counters for this process. */
export interface ModelCacheWriteStats {
	/** Payload rows (re)written because their stored content changed. */
	payloadWrites: number;
	/** Serialized model bytes written by `payloadWrites`. */
	payloadBytes: number;
	/** Unchanged payloads whose freshness/authority advanced via the side table. */
	refreshWrites: number;
	/** Writes that matched the stored row exactly and touched nothing. */
	skippedWrites: number;
	/** Provider ids of the most recent payload writes (bounded). */
	recentPayloadProviders: readonly string[];
}

const writeStats = { payloadWrites: 0, payloadBytes: 0, refreshWrites: 0, skippedWrites: 0 };
const recentPayloadProviders: string[] = [];
const RECENT_PAYLOAD_PROVIDERS_MAX = 64;

/** Snapshot of this process's model-cache write counters. */
export function getModelCacheWriteStats(): ModelCacheWriteStats {
	return { ...writeStats, recentPayloadProviders: [...recentPayloadProviders] };
}

type StoredRowState = Pick<
	CacheRow,
	"updated_at" | "authoritative" | "refresh_payload_updated_at" | "refresh_updated_at" | "refresh_authoritative"
>;

interface TableInfoRow {
	name: string;
}

/**
 * On-disk materialized row. `null` preserves the distinction between an
 * inferred computer-use value and an explicitly authored boolean through JSON.
 */
type PersistedModel<TApi extends Api = Api> = Omit<Model<TApi>, "supportsComputerUseConfig"> & {
	supportsComputerUseConfig: boolean | null;
};

/** Materialized provider snapshot with freshness and header-restoration provenance. */
export interface CacheEntry<TApi extends Api = Api> {
	/** Trusted, fully materialized rows; request headers remain omitted. */
	models: Model<TApi>[];
	fresh: boolean;
	authoritative: boolean;
	updatedAt: number;
	/** Model ids whose live headers were intentionally omitted from disk. */
	headerOmittedModelIds: readonly string[];
	/** Header-bearing model ids that cannot be rebuilt from the static source. */
	unrestorableHeaderModelIds: readonly string[];
	/** Whether unrestorable markers predate request-model header matching. */
	legacyHeaderRestoreMarkers: boolean;
	/**
	 * Hash of the static catalog slice that was merged into `models` when this
	 * row was written. `resolveProviderModels` compares against the current
	 * static fingerprint and bypasses the static+cache re-merge when they
	 * match — the cache already incorporates the same static state.
	 */
	staticFingerprint: string;
}

let sharedDb: Database | null = null;
let sharedDbPath: string | null = null;

interface ReadRowCacheEntry {
	/** `PRAGMA data_version` of the shared connection when validated; null for per-call connections. */
	dataVersion: number | null;
	/**
	 * Scalar columns (plus `models_hash`) of the row the entry was parsed from;
	 * null when the row was absent or rejected. Never the multi-MB payload itself.
	 */
	meta: CacheRowMeta | null;
	entry: CacheEntry<Api> | null;
}

const readRowCache = new Map<string, ReadRowCacheEntry>();
const READ_ROW_CACHE_MAX = 64;

function readCacheKey(resolvedPath: string, providerId: string): string {
	return `${resolvedPath} ${providerId}`;
}

function dbDataVersion(db: Database): number | null {
	try {
		const row = db.query<{ data_version: number }, []>("PRAGMA data_version").get();
		return typeof row?.data_version === "number" ? row.data_version : null;
	} catch {
		return null;
	}
}

function withFreshness<TApi extends Api>(
	entry: CacheEntry<TApi> | null,
	ttlMs: number,
	now: () => number,
): CacheEntry<TApi> | null {
	if (entry === null) return null;
	const ageMs = now() - entry.updatedAt;
	const fresh = Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= ttlMs;
	return fresh === entry.fresh ? entry : { ...entry, fresh };
}
function invalidateReadRow(providerId: string, dbPath?: string): void {
	try {
		readRowCache.delete(readCacheKey(resolveCacheDb(dbPath).resolvedPath, providerId));
	} catch {
		// Best-effort only; a missed invalidation just costs one extra parse.
	}
}

function invalidateReadPath(resolvedPath: string): void {
	for (const key of readRowCache.keys()) {
		if (key.startsWith(`${resolvedPath} `)) readRowCache.delete(key);
	}
}

function initializeDb(db: Database): void {
	// The shared opener installs the busy handler before any lock-taking
	// statement. Current rows never persist request headers, so routine
	// replacements do not need freed overflow pages zero-filled (that doubled
	// the I/O of every multi-MB refresh). The legacy credential purge (#5780)
	// re-enables ON just around its DELETE.
	db.run("PRAGMA secure_delete = FAST");
	db.run("PRAGMA journal_mode = WAL");
	db.run(`
		CREATE TABLE IF NOT EXISTS model_cache (
			provider_id TEXT PRIMARY KEY,
			version INTEGER NOT NULL,
			materialization_policy TEXT NOT NULL DEFAULT '',
			updated_at INTEGER NOT NULL,
			authoritative INTEGER NOT NULL DEFAULT 0,
			static_fingerprint TEXT NOT NULL DEFAULT '',
			header_omitted_model_ids TEXT NOT NULL DEFAULT '[]',
			unrestorable_header_model_ids TEXT NOT NULL DEFAULT '[]',
			header_restore_version INTEGER NOT NULL DEFAULT 0,
			models_hash TEXT NOT NULL DEFAULT '',
			models TEXT NOT NULL
		)
	`);
	db.run(`
		CREATE TABLE IF NOT EXISTS model_cache_refresh (
			provider_id TEXT PRIMARY KEY,
			payload_updated_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			authoritative INTEGER NOT NULL
		)
	`);
	migrateCacheSchema(db);
	// `models_hash` is the only payload-change detector for the read memo and the
	// unchanged-write skip. Writers here replace whole rows; this keeps an
	// in-place edit of `models` by any other tool or binary from reusing a stale hash.
	db.run(`
		CREATE TRIGGER IF NOT EXISTS model_cache_models_hash_reset
		AFTER UPDATE OF models ON model_cache
		WHEN NEW.models_hash = OLD.models_hash
		BEGIN
			UPDATE model_cache SET models_hash = '' WHERE provider_id = NEW.provider_id;
		END
	`);
}

function closeSharedDb(): void {
	if (!sharedDb) return;
	sharedDb.close();
	sharedDb = null;
	sharedDbPath = null;
}

/**
 * Closes the shared handle to the default `<agent-dir>/models.db`; the next
 * default-path access reopens it. Call before deleting an agent directory the
 * cache was opened under — Windows cannot remove a database that is still open.
 */
export function closeModelCache(): void {
	if (sharedDbPath) invalidateReadPath(sharedDbPath);
	closeSharedDb();
}

function runModelCacheDb<T>(resolvedPath: string, shared: boolean, useDb: (db: Database) => T): T {
	if (shared && sharedDb && sharedDbPath !== resolvedPath) closeSharedDb();
	if (shared && sharedDb) {
		try {
			return useDb(sharedDb);
		} catch (error) {
			if (!isSqliteCorruptionError(error)) throw error;
			// The opener owns recovery for new handles. Drop this stale handle
			// first so its WAL cannot remain attached to the replacement.
			closeSharedDb();
			invalidateReadPath(resolvedPath);
			return runModelCacheDb(resolvedPath, shared, useDb);
		}
	}

	return openSqliteDatabaseSync(
		resolvedPath,
		db => {
			initializeDb(db);
			const result = useDb(db);
			if (shared) {
				sharedDb = db;
				sharedDbPath = resolvedPath;
			} else {
				db.close();
			}
			return result;
		},
		{
			recoverCorruption: true,
			onCorruptionPreserved: () => invalidateReadPath(resolvedPath),
		},
	);
}

function withModelCacheDb<T>(dbPath: string | undefined, useDb: (db: Database) => T): T {
	const { resolvedPath, shared } = resolveCacheDb(dbPath);
	return runModelCacheDb(resolvedPath, shared, useDb);
}

/**
 * An explicit path naming the default `models.db` (e.g. the SDK passing
 * `getModelDbPath(agentDir)` for the default agent dir) shares the long-lived
 * handle, so it gets the `data_version` fast path instead of opening,
 * initializing and re-reading the row on every call.
 */
function resolveCacheDb(dbPath: string | undefined): { resolvedPath: string; shared: boolean } {
	const defaultPath = getModelDbPath();
	if (dbPath === undefined || dbPath === defaultPath || path.resolve(dbPath) === path.resolve(defaultPath)) {
		return { resolvedPath: defaultPath, shared: true };
	}
	return { resolvedPath: dbPath, shared: false };
}

function migrateCacheSchema(db: Database): void {
	const stmt = db.prepare("PRAGMA table_info(model_cache)");
	try {
		const columns = stmt.all() as TableInfoRow[];
		if (!columns.some(column => column.name === "materialization_policy")) {
			db.run("ALTER TABLE model_cache ADD COLUMN materialization_policy TEXT NOT NULL DEFAULT ''");
		}
		if (!columns.some(column => column.name === "static_fingerprint")) {
			db.run("ALTER TABLE model_cache ADD COLUMN static_fingerprint TEXT NOT NULL DEFAULT ''");
		}
		if (!columns.some(column => column.name === "header_omitted_model_ids")) {
			db.run("ALTER TABLE model_cache ADD COLUMN header_omitted_model_ids TEXT NOT NULL DEFAULT '[]'");
		}
		if (!columns.some(column => column.name === "unrestorable_header_model_ids")) {
			db.run("ALTER TABLE model_cache ADD COLUMN unrestorable_header_model_ids TEXT NOT NULL DEFAULT '[]'");
		}
		if (!columns.some(column => column.name === "header_restore_version")) {
			// Existing v10 rows get 0, distinguishing markers produced by the
			// old id-only header matcher from rows written after request-model
			// header matching was introduced.
			db.run("ALTER TABLE model_cache ADD COLUMN header_restore_version INTEGER NOT NULL DEFAULT 0");
		}
		if (!columns.some(column => column.name === "models_hash")) {
			// Rows from older binaries keep '' (never equal), so they are re-read in
			// full until the next write records their hash; no version bump needed.
			// Older binaries rewriting a row via INSERT OR REPLACE reset it to ''.
			db.run("ALTER TABLE model_cache ADD COLUMN models_hash TEXT NOT NULL DEFAULT ''");
		}
	} finally {
		stmt.finalize();
	}
	// Rows predating v11 may carry credential-bearing request headers (v10 could
	// still persist derived computer-use headers), so purge them and scrub the
	// freed cells (#5780). Every other non-current row (v11/v12, a newer schema,
	// or another materialization policy from a different app version sharing
	// this file) never persisted headers: readers gate on the exact version and
	// policy, treat it as absent, and the next write for that provider replaces
	// it lazily, so switching versions does not wipe and re-download every
	// provider. Never promote old rows in place: the legacy `UPDATE ... WHERE
	// version = 2` migration did, defeating every later invalidation (#4146).
	const legacyStmt = db.prepare("SELECT 1 AS found FROM model_cache WHERE version < ? LIMIT 1");
	let hasLegacyRows: boolean;
	try {
		hasLegacyRows = legacyStmt.get(FIRST_HEADERLESS_SCHEMA_VERSION) !== null;
	} finally {
		legacyStmt.finalize();
	}
	if (!hasLegacyRows) return;
	db.run("PRAGMA secure_delete = ON");
	try {
		db.run("DELETE FROM model_cache WHERE version < ?", [FIRST_HEADERLESS_SCHEMA_VERSION]);
	} finally {
		db.run("PRAGMA secure_delete = FAST");
	}
}

function isMaterializedModel(value: unknown): value is PersistedModel<Api> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const model = value as Partial<PersistedModel<Api>>;
	if (
		typeof model.id !== "string" ||
		model.id.length === 0 ||
		typeof model.name !== "string" ||
		model.name.length === 0 ||
		typeof model.api !== "string" ||
		model.api.length === 0 ||
		typeof model.provider !== "string" ||
		model.provider.length === 0 ||
		// Empty is legitimate: Azure-style providers resolve the endpoint from
		// configuration at request time, and their bundled rows carry "".
		typeof model.baseUrl !== "string" ||
		typeof model.reasoning !== "boolean" ||
		!Array.isArray(model.input) ||
		model.input.length === 0 ||
		model.input.some(input => input !== "text" && input !== "image") ||
		model.headers !== undefined ||
		!Object.hasOwn(model, "supportsComputerUseConfig") ||
		(model.supportsComputerUseConfig !== null && typeof model.supportsComputerUseConfig !== "boolean")
	) {
		return false;
	}
	const contextWindow = model.contextWindow;
	const maxTokens = model.maxTokens;
	if (
		(contextWindow !== null &&
			(typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0)) ||
		(maxTokens !== null && (typeof maxTokens !== "number" || !Number.isFinite(maxTokens) || maxTokens <= 0))
	) {
		return false;
	}
	if (
		model.identity === null ||
		typeof model.identity !== "object" ||
		typeof model.identity.class !== "string" ||
		(model.compat !== undefined &&
			(model.compat === null || typeof model.compat !== "object" || Array.isArray(model.compat)))
	) {
		return false;
	}
	if (model.cost === null || typeof model.cost !== "object") return false;
	const cost = model.cost as Partial<Model<Api>["cost"]>;
	return (
		typeof cost.input === "number" &&
		Number.isFinite(cost.input) &&
		typeof cost.output === "number" &&
		Number.isFinite(cost.output) &&
		typeof cost.cacheRead === "number" &&
		Number.isFinite(cost.cacheRead) &&
		typeof cost.cacheWrite === "number" &&
		Number.isFinite(cost.cacheWrite)
	);
}

function parseMaterializedModels<TApi extends Api>(serialized: string): Model<TApi>[] | null {
	try {
		const parsed: unknown = JSON.parse(serialized);
		if (!Array.isArray(parsed) || !parsed.every(isMaterializedModel)) return null;
		return parsed.map(model => ({
			...model,
			supportsComputerUseConfig: model.supportsComputerUseConfig ?? undefined,
		})) as Model<TApi>[];
	} catch {
		return null;
	}
}

function parseModelIds(serialized: string): string[] | null {
	try {
		const parsed: unknown = JSON.parse(serialized);
		return Array.isArray(parsed) && parsed.every((id): id is string => typeof id === "string") ? parsed : null;
	} catch {
		return null;
	}
}
export function readModelCache<TApi extends Api>(
	providerId: string,
	ttlMs: number,
	now: () => number,
	dbPath?: string,
): CacheEntry<TApi> | null {
	try {
		// Monotonic change signal: same-shaped WAL overwrites after checkpoint
		// can leave every size:mtime pair identical, so file metadata alone
		// cannot invalidate. PRAGMA data_version increments on each committed
		// write transaction visible to a new reader. It is only comparable
		// across calls on the same connection, so it gates the no-query fast
		// path for the shared handle only.
		const { resolvedPath, shared } = resolveCacheDb(dbPath);
		const key = readCacheKey(resolvedPath, providerId);
		return runModelCacheDb(resolvedPath, shared, db => {
			const dataVersion = shared ? dbDataVersion(db) : null;
			const cached = readRowCache.get(key);
			if (dataVersion !== null && cached?.dataVersion === dataVersion) {
				// Freshness is time-relative: recompute per call from the
				// cached row's updatedAt so a long-lived process goes stale.
				return withFreshness(cached.entry as CacheEntry<TApi> | null, ttlMs, now);
			}
			// Any commit (to any provider's row) bumps data_version. Validate the
			// memoized parse against the row's scalar columns and payload hash
			// first; only a changed payload pays for the multi-MB `models` read.
			let entry: CacheEntry<TApi> | null = null;
			let meta: CacheRowMeta | null = null;
			if (cached?.entry && cached.meta) {
				meta = queryRow<CacheRowMeta>(db, SELECT_CACHE_ROW_META, providerId);
				if (meta && meta.materialization_policy === materializationPolicy() && cacheRowsEqual(cached.meta, meta)) {
					// Payload unchanged; only side-table freshness may have moved.
					entry = withFreshness(withRowState(cached.entry as CacheEntry<TApi>, meta), ttlMs, now);
				} else {
					meta = null;
				}
			}
			if (entry === null) {
				// One statement reads payload and scalars from the same snapshot.
				const row = queryRow<CacheRow>(db, SELECT_CACHE_ROW, providerId);
				entry = parseCacheRow<TApi>(db, providerId, row, ttlMs, now);
				if (entry !== null && row !== null) {
					// Drop the payload so the memo never pins the multi-MB `models` string.
					const { models: _models, ...rowScalars } = row;
					meta = rowScalars;
				}
			}
			if (readRowCache.size >= READ_ROW_CACHE_MAX) readRowCache.clear();
			readRowCache.set(key, { dataVersion, meta, entry: entry as CacheEntry<Api> | null });
			return entry;
		});
	} catch {
		return null;
	}
}

function queryRow<T>(db: Database, sql: string, providerId: string): T | null {
	const stmt = db.query<T, [string]>(sql);
	try {
		return stmt.get(providerId);
	} finally {
		stmt.finalize();
	}
}

/**
 * Whether two rows carry the same payload record (refresh side-row columns
 * excluded). Payloads compare by `models_hash`; rows without one never match.
 */
function cacheRowsEqual(left: CacheRowMeta, right: CacheRowMeta): boolean {
	return (
		left.version === right.version &&
		left.materialization_policy === right.materialization_policy &&
		left.updated_at === right.updated_at &&
		left.authoritative === right.authoritative &&
		left.static_fingerprint === right.static_fingerprint &&
		left.header_omitted_model_ids === right.header_omitted_model_ids &&
		left.unrestorable_header_model_ids === right.unrestorable_header_model_ids &&
		left.header_restore_version === right.header_restore_version &&
		left.models_hash !== "" &&
		left.models_hash === right.models_hash
	);
}

/** Effective freshness/authority: the side row wins while it refers to this payload. */
function rowState(row: StoredRowState): { updatedAt: number; authoritative: boolean } {
	if (
		row.refresh_updated_at !== null &&
		row.refresh_payload_updated_at === row.updated_at &&
		row.refresh_authoritative !== null
	) {
		return { updatedAt: row.refresh_updated_at, authoritative: row.refresh_authoritative === 1 };
	}
	return { updatedAt: row.updated_at, authoritative: row.authoritative === 1 };
}

function withRowState<TApi extends Api>(entry: CacheEntry<TApi>, row: StoredRowState): CacheEntry<TApi> {
	const { updatedAt, authoritative } = rowState(row);
	return entry.updatedAt === updatedAt && entry.authoritative === authoritative
		? entry
		: { ...entry, updatedAt, authoritative };
}

function parseCacheRow<TApi extends Api>(
	db: Database,
	providerId: string,
	row: CacheRow | null,
	ttlMs: number,
	now: () => number,
): CacheEntry<TApi> | null {
	if (!row || row.version !== CACHE_SCHEMA_VERSION || row.materialization_policy !== materializationPolicy()) {
		return null;
	}
	const models = parseMaterializedModels<TApi>(row.models);
	const headerOmittedModelIds = parseModelIds(row.header_omitted_model_ids);
	const unrestorableHeaderModelIds = parseModelIds(row.unrestorable_header_model_ids);
	if (models === null || headerOmittedModelIds === null || unrestorableHeaderModelIds === null) {
		// Fail closed on corrupt header provenance: treating malformed
		// markers as empty could return a model with required credentials
		// silently absent. Current-schema rows never persist headers, so the
		// rejected payload needs no secure scrub.
		db.run("DELETE FROM model_cache WHERE provider_id = ?", [providerId]);
		return null;
	}
	const { updatedAt, authoritative } = rowState(row);
	const ageMs = now() - updatedAt;
	const fresh = Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= ttlMs;
	return {
		models,
		fresh,
		authoritative,
		updatedAt,
		headerOmittedModelIds,
		unrestorableHeaderModelIds,
		legacyHeaderRestoreMarkers: row.header_restore_version < HEADER_RESTORE_VERSION,
		staticFingerprint: row.static_fingerprint ?? "",
	};
}

/** Whether a live model carries at least one request header. */
function hasModelHeaders(model: Model<Api>): boolean {
	if (model.resolveHeaders) return true;
	const headers = model.headers;
	if (!headers) return false;
	for (const _key in headers) return true;
	return false;
}

/**
 * Project a materialized model to cache-safe metadata.
 *
 * Headers are never persisted: custom/runtime providers may use arbitrary
 * credential header names, so no name-based filter can be complete. All other
 * resolved fields are retained verbatim, including sparse provenance fields,
 * so a compatible cache can be consumed without running `buildModel`.
 */
function toCachedModel<TApi extends Api>(model: Model<TApi>): PersistedModel<TApi> {
	const { headers: _headers, resolveHeaders: _resolveHeaders, ...rest } = model;
	return {
		...rest,
		supportsComputerUseConfig: model.supportsComputerUseConfig ?? null,
	};
}

/** Whether two in-memory header records are byte-for-byte equivalent. */
function headersEqual(left: Record<string, string> | undefined, right: Record<string, string> | undefined): boolean {
	if (!left || !right) return left === right;
	for (const key in left) {
		if (right[key] !== left[key]) return false;
	}
	for (const key in right) {
		if (!(key in left)) return false;
	}
	return true;
}

/**
 * Persist a provider snapshot.
 *
 * When the stored payload (models, header provenance, fingerprint, schema and
 * materialization policy) is byte-identical, the multi-MB row is left alone and
 * only `model_cache_refresh` records the new freshness and authority; a write
 * that changes nothing at all is skipped. Every model persisted here is
 * validated with the reader's own predicate, so a row this writes is never
 * rejected (and deleted) by `readModelCache`.
 */
export function writeModelCache<TApi extends Api>(
	providerId: string,
	updatedAt: number,
	models: Model<TApi>[],
	authoritative: boolean,
	staticFingerprint: string,
	dbPath?: string,
	staticHeaderSources: readonly Model<TApi>[] = [],
	restorableHeaderFallback?: Record<string, string>,
): void {
	try {
		invalidateReadRow(providerId, dbPath);
		withModelCacheDb(dbPath, db => {
			const headerOmittedModelIds: string[] = [];
			const unrestorableHeaderModelIds: string[] = [];
			const cachedModels: PersistedModel<TApi>[] = [];
			const rejectedModelIds: string[] = [];
			const staticById = new Map(staticHeaderSources.map(model => [model.id, model]));
			for (const model of models) {
				const cachedModel = toCachedModel(model);
				if (!isMaterializedModel(cachedModel)) {
					// One unreadable model must not make the whole row fail
					// validation on read (which deletes it and refetches forever).
					rejectedModelIds.push(model.id);
					continue;
				}
				if (hasModelHeaders(model)) {
					headerOmittedModelIds.push(model.id);
					// Synthesized variants (e.g. Copilot `-1m`) have no same-id static
					// entry; their headers come from the `requestModelId` base. Match
					// against that source too, else they are wrongly flagged
					// unrestorable and dropped on the next offline read (#6037, #6284).
					const staticHeaderSource =
						staticById.get(model.id) ?? (model.requestModelId ? staticById.get(model.requestModelId) : undefined);
					// A model with no static source is still restorable when its live
					// headers equal a trusted provider-wide fallback that the reader can
					// re-derive without persisting it. This keeps reference-less models
					// with constant or configured headers alive offline.
					const matchesStatic = model.resolveHeaders
						? staticHeaderSource?.resolveHeaders === model.resolveHeaders
						: staticHeaderSource
							? headersEqual(model.headers, staticHeaderSource.headers)
							: headersEqual(model.headers, restorableHeaderFallback);
					if (!matchesStatic) {
						unrestorableHeaderModelIds.push(model.id);
					}
				}
				cachedModels.push(cachedModel);
			}
			if (rejectedModelIds.length > 0) {
				logger.debug("model cache skipped models that would fail cache validation", {
					provider: providerId,
					models: rejectedModelIds,
				});
			}
			const policy = materializationPolicy();
			const authoritativeFlag = authoritative ? 1 : 0;
			const serializedHeaderOmitted = JSON.stringify(headerOmittedModelIds);
			const serializedUnrestorable = JSON.stringify(unrestorableHeaderModelIds);
			const serializedModels = JSON.stringify(cachedModels);
			// Length prefix: a collision would also need an equal payload size.
			const modelsHash = `${serializedModels.length.toString(36)}:${Bun.hash(serializedModels).toString(36)}`;
			const outcome = db
				.transaction((): "skipped" | "refreshed" | "written" => {
					const matchStmt = db.prepare<
						StoredRowState,
						[string, number, string, string, string, string, number, string]
					>(
						`SELECT m.updated_at, m.authoritative,
							r.payload_updated_at AS refresh_payload_updated_at,
							r.updated_at AS refresh_updated_at,
							r.authoritative AS refresh_authoritative
						FROM model_cache m
						LEFT JOIN model_cache_refresh r ON r.provider_id = m.provider_id
						WHERE m.provider_id = ? AND m.version = ? AND m.materialization_policy = ?
							AND m.static_fingerprint = ? AND m.header_omitted_model_ids = ?
							AND m.unrestorable_header_model_ids = ? AND m.header_restore_version = ? AND m.models_hash = ?`,
					);
					let stored: StoredRowState | null;
					try {
						stored = matchStmt.get(
							providerId,
							CACHE_SCHEMA_VERSION,
							policy,
							staticFingerprint,
							serializedHeaderOmitted,
							serializedUnrestorable,
							HEADER_RESTORE_VERSION,
							modelsHash,
						);
					} finally {
						matchStmt.finalize();
					}
					if (stored) {
						const state = rowState(stored);
						if (state.updatedAt === updatedAt && state.authoritative === authoritative) return "skipped";
						db.run(
							`INSERT INTO model_cache_refresh (provider_id, payload_updated_at, updated_at, authoritative)
							VALUES (?, ?, ?, ?)
							ON CONFLICT(provider_id) DO UPDATE SET
								payload_updated_at = excluded.payload_updated_at,
								updated_at = excluded.updated_at,
								authoritative = excluded.authoritative`,
							[providerId, stored.updated_at, updatedAt, authoritativeFlag],
						);
						return "refreshed";
					}
					db.run(
						`INSERT OR REPLACE INTO model_cache (
							provider_id, version, materialization_policy, updated_at, authoritative, static_fingerprint,
							header_omitted_model_ids, unrestorable_header_model_ids,
							header_restore_version, models_hash, models
						) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
						[
							providerId,
							CACHE_SCHEMA_VERSION,
							policy,
							updatedAt,
							authoritativeFlag,
							staticFingerprint,
							serializedHeaderOmitted,
							serializedUnrestorable,
							HEADER_RESTORE_VERSION,
							modelsHash,
							serializedModels,
						],
					);
					db.run("DELETE FROM model_cache_refresh WHERE provider_id = ?", [providerId]);
					return "written";
				})
				.immediate();
			if (outcome === "skipped") {
				writeStats.skippedWrites++;
			} else if (outcome === "refreshed") {
				writeStats.refreshWrites++;
			} else {
				writeStats.payloadWrites++;
				writeStats.payloadBytes += serializedModels.length;
				if (recentPayloadProviders.length >= RECENT_PAYLOAD_PROVIDERS_MAX) recentPayloadProviders.shift();
				recentPayloadProviders.push(providerId);
			}
		});
	} catch {
		// Cache writes are best-effort; failures should not break model resolution.
	}
}
