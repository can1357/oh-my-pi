/**
 * SQLite-backed model cache for atomic cross-process access.
 * Replaces per-provider JSON files with a single cache.db.
 */
import { Database } from "bun:sqlite";
import { renameSync } from "node:fs";
import { getModelDbPath, isEnoent, isSqliteCorruptionError, logger, VERSION } from "@oh-my-pi/pi-utils";
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
const HEADER_RESTORE_VERSION = 1;
/**
 * Explicit compatibility gate for materialized rows. Bump whenever buildModel
 * semantics change without an app-version change. The compiled-rules content
 * hash catches every KDL policy edit even when the package version is unchanged;
 * computed lazily on first cache access and memoized, so processes that never
 * touch the model cache skip the stringify entirely.
 */
const MODEL_MATERIALIZATION_VERSION = 1;
let cachedMaterializationPolicy: string | undefined;
function materializationPolicy(): string {
	if (cachedMaterializationPolicy === undefined) {
		cachedMaterializationPolicy =
			`app-${VERSION}:builder-${MODEL_MATERIALIZATION_VERSION}:rules-${RULES.version}-` +
			Bun.hash(JSON.stringify(RULES)).toString(36);
	}
	return cachedMaterializationPolicy;
}

interface CacheRow {
	provider_id: string;
	version: number;
	materialization_policy: string;
	updated_at: number;
	authoritative: number;
	static_fingerprint: string;
	models: string;
	header_omitted_model_ids: string;
	unrestorable_header_model_ids: string;
	header_restore_version: number;
}

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

const readRowCache = new Map<string, { dataVersion: number; entry: CacheEntry<Api> | null }>();
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
		readRowCache.delete(readCacheKey(dbPath ?? getModelDbPath(), providerId));
	} catch {
		// Best-effort only; a missed invalidation just costs one extra parse.
	}
}

function invalidateReadPath(resolvedPath: string): void {
	for (const key of readRowCache.keys()) {
		if (key.startsWith(`${resolvedPath} `)) readRowCache.delete(key);
	}
}

function openDb(resolvedPath: string): Database {
	const db = new Database(resolvedPath, { create: true });
	// Install the busy handler BEFORE any lock-taking statement. See
	// https://github.com/can1357/oh-my-pi/issues/2421.
	db.run("PRAGMA busy_timeout = 3000");
	// Schema invalidation can delete rows containing credentials written by old
	// versions. Overwrite deleted SQLite cells instead of leaving their bytes in
	// free pages where a raw scan of models.db can still recover them (#5780).
	db.run("PRAGMA secure_delete = ON");
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
			models TEXT NOT NULL
		)
	`);
	migrateCacheSchema(db);
	return db;
}

function getSharedDb(resolvedPath: string): Database {
	if (sharedDb && sharedDbPath === resolvedPath) {
		return sharedDb;
	}
	if (sharedDb) {
		sharedDb.close();
		sharedDb = null;
		sharedDbPath = null;
	}
	const db = openDb(resolvedPath);
	sharedDb = db;
	sharedDbPath = resolvedPath;
	return db;
}

function runModelCacheDb<T>(resolvedPath: string, shared: boolean, useDb: (db: Database) => T): T {
	if (shared) return useDb(getSharedDb(resolvedPath));
	const db = openDb(resolvedPath);
	try {
		return useDb(db);
	} finally {
		db.close();
	}
}

// Paths already reported corrupt this process: the first unrecoverable failure
// is logged at `error`, later heals at `debug`, so a dying disk cannot spam.
const reportedCorruptPaths = new Set<string>();

/**
 * Move a physically corrupt `models.db` (plus its `-wal`/`-shm` sidecars) aside
 * so {@link openDb} can recreate a fresh cache at the original path. Renames are
 * best-effort: a vanished sidecar (already healed by a peer process) is fine,
 * and any other rename failure is left for {@link openDb} to surface.
 */
function quarantineCorruptModelCache(resolvedPath: string): void {
	const stamp = Date.now();
	for (const suffix of ["", "-wal", "-shm"]) {
		try {
			renameSync(`${resolvedPath}${suffix}`, `${resolvedPath}.corrupt-${stamp}${suffix}`);
		} catch (err) {
			if (!isEnoent(err)) {
				logger.debug("model cache: could not quarantine corrupt file", { path: `${resolvedPath}${suffix}` });
			}
		}
	}
}

/**
 * Recover from unrecoverable `models.db` corruption: drop the cached handle,
 * quarantine the broken files, and let the next open recreate the cache. A
 * corrupt cache would otherwise be re-queried on every read/write forever,
 * permanently masking a successful live catalog (issue #8867). Only
 * {@link isSqliteCorruptionError} codes reach here; BUSY/permission errors keep
 * their existing best-effort paths.
 */
function healCorruptModelCache(resolvedPath: string, shared: boolean, err: unknown): void {
	if (shared && sharedDb) {
		sharedDb.close();
		sharedDb = null;
		sharedDbPath = null;
	}
	invalidateReadPath(resolvedPath);
	quarantineCorruptModelCache(resolvedPath);
	const code = err && typeof err === "object" && "code" in err ? err.code : undefined;
	if (reportedCorruptPaths.has(resolvedPath)) {
		logger.debug("model cache: re-healed corrupt database", { path: resolvedPath, code });
	} else {
		reportedCorruptPaths.add(resolvedPath);
		logger.error("model cache corrupt; quarantined and recreated a fresh cache", { path: resolvedPath, code });
	}
}

function withModelCacheDb<T>(dbPath: string | undefined, useDb: (db: Database) => T): T {
	const resolvedPath = dbPath ?? getModelDbPath();
	const shared = dbPath === undefined;
	try {
		return runModelCacheDb(resolvedPath, shared, useDb);
	} catch (err) {
		if (!isSqliteCorruptionError(err)) throw err;
		healCorruptModelCache(resolvedPath, shared, err);
		return runModelCacheDb(resolvedPath, shared, useDb);
	}
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
	} finally {
		stmt.finalize();
	}
	// Delete rows written under any older schema so they cannot be reused. The
	// legacy `UPDATE ... WHERE version = 2` migration silently promoted the very
	// first cache version to whatever the current one is, defeating every
	// subsequent invalidation (see #4146: pre-V2 Codex rows kept the legacy
	// compaction path even after CACHE_SCHEMA_VERSION was bumped).
	db.run("DELETE FROM model_cache WHERE version <> ? OR materialization_policy <> ?", [
		CACHE_SCHEMA_VERSION,
		materializationPolicy(),
	]);
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
		typeof model.baseUrl !== "string" ||
		model.baseUrl.length === 0 ||
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
		const resolvedPath = dbPath ?? getModelDbPath();
		const key = readCacheKey(resolvedPath, providerId);
		// Monotonic change signal: same-shaped WAL overwrites after checkpoint
		// can leave every size:mtime pair identical, so file metadata alone
		// cannot invalidate. PRAGMA data_version increments on each committed
		// write transaction visible to a new reader.
		const entry = withModelCacheDb(dbPath, db => {
			const dataVersion = dbDataVersion(db);
			if (dataVersion !== null) {
				const cached = readRowCache.get(key);
				if (cached !== undefined && cached.dataVersion === dataVersion) {
					// Freshness is time-relative: recompute per call from the
					// cached row's updatedAt so a long-lived process goes stale.
					return { hit: true as const, entry: withFreshness(cached.entry as CacheEntry<TApi> | null, ttlMs, now) };
				}
			}
			const fresh = readRowUncached<TApi>(db, providerId, ttlMs, now);
			if (dataVersion !== null) {
				if (readRowCache.size >= READ_ROW_CACHE_MAX) readRowCache.clear();
				readRowCache.set(key, { dataVersion, entry: fresh as CacheEntry<Api> | null });
			}
			return { hit: false as const, entry: fresh };
		});
		return entry.entry;
	} catch {
		return null;
	}
}

function readRowUncached<TApi extends Api>(
	db: Database,
	providerId: string,
	ttlMs: number,
	now: () => number,
): CacheEntry<TApi> | null {
	const stmt = db.query<CacheRow, [string]>("SELECT * FROM model_cache WHERE provider_id = ?");
	try {
		const row = stmt.get(providerId);
		if (!row || row.version !== CACHE_SCHEMA_VERSION || row.materialization_policy !== materializationPolicy()) {
			return null;
		}
		const models = parseMaterializedModels<TApi>(row.models);
		const headerOmittedModelIds = parseModelIds(row.header_omitted_model_ids);
		const unrestorableHeaderModelIds = parseModelIds(row.unrestorable_header_model_ids);
		if (models === null || headerOmittedModelIds === null || unrestorableHeaderModelIds === null) {
			// Fail closed on corrupt header provenance: treating malformed
			// markers as empty could return a model with required credentials
			// silently absent. secure_delete scrubs the rejected payload.
			db.run("DELETE FROM model_cache WHERE provider_id = ?", [providerId]);
			return null;
		}
		const ageMs = now() - row.updated_at;
		const fresh = Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= ttlMs;
		return {
			models,
			fresh,
			authoritative: row.authoritative === 1,
			updatedAt: row.updated_at,
			headerOmittedModelIds,
			unrestorableHeaderModelIds,
			legacyHeaderRestoreMarkers: row.header_restore_version < HEADER_RESTORE_VERSION,
			staticFingerprint: row.static_fingerprint ?? "",
		};
	} finally {
		stmt.finalize();
	}
}

function readModelCacheUncached<TApi extends Api>(
	providerId: string,
	ttlMs: number,
	now: () => number,
	dbPath?: string,
): CacheEntry<TApi> | null {
	try {
		return withModelCacheDb(dbPath, db => readRowUncached<TApi>(db, providerId, ttlMs, now));
	} catch {
		return null;
	}
}

/** Whether a live model carries at least one request header. */
function hasModelHeaders(model: Model<Api>): boolean {
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
	const { headers: _headers, ...rest } = model;
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
			const staticById = new Map(staticHeaderSources.map(model => [model.id, model]));
			for (const model of models) {
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
					const matchesStatic = staticHeaderSource
						? headersEqual(model.headers, staticHeaderSource.headers)
						: headersEqual(model.headers, restorableHeaderFallback);
					if (!matchesStatic) {
						unrestorableHeaderModelIds.push(model.id);
					}
				}
				cachedModels.push(toCachedModel(model));
			}
			db.run(
				`INSERT OR REPLACE INTO model_cache (
					provider_id, version, materialization_policy, updated_at, authoritative, static_fingerprint,
					header_omitted_model_ids, unrestorable_header_model_ids,
					header_restore_version, models
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					providerId,
					CACHE_SCHEMA_VERSION,
					materializationPolicy(),
					updatedAt,
					authoritative ? 1 : 0,
					staticFingerprint,
					JSON.stringify(headerOmittedModelIds),
					JSON.stringify(unrestorableHeaderModelIds),
					HEADER_RESTORE_VERSION,
					JSON.stringify(cachedModels),
				],
			);
		});
	} catch {
		// Cache writes are best-effort; failures should not break model resolution.
	}
}
