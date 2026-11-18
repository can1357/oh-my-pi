/**
 * SQLite-backed model cache for atomic cross-process access.
 * Replaces per-provider JSON files with a single cache.db.
 */
import type { Database } from "bun:sqlite";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import {
	getDbBusyTimeoutMs,
	getModelDbPath,
	isSqliteBusyError,
	isSqliteCorruptionError,
	logger,
	openSqliteDatabaseSync,
	VERSION,
} from "@oh-my-pi/pi-utils";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import RULES from "./compat/rules.json" with { type: "json" };
import type { Api, Model } from "./types";

// Rows persist fully materialized Models so compatible warm-cache reads do not
// rerun the compat cascade. Request headers are intentionally omitted:
// arbitrary provider-defined header names can carry credentials. v15
// invalidates unbundled OpenAI-compatible rows that ignored provider-reported
// token limits. v14 invalidates Antigravity rows predating per-SKU
// `antigravityWireProfiles` (model_enum label, output cap, SKU thinking). v13 replaces
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
const CACHE_SCHEMA_VERSION = 15;
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
	/** `model_cache_freshness` columns joined onto the payload row; null when absent. */
	freshness_payload_updated_at: number | null;
	freshness_updated_at: number | null;
	freshness_authoritative: number | null;
}

interface CacheRow extends CacheRowMeta {
	models: string;
}

/**
 * Payload table. A row is one provider's snapshot under one materialization
 * policy, so app versions sharing this file each keep their own row instead of
 * evicting each other's on every refresh (a reader discards foreign-policy
 * rows, so a shared row left every other running version with the bundled
 * catalog until it refetched).
 */
const MODEL_CACHE_TABLE_BODY = `
	provider_id TEXT NOT NULL,
	version INTEGER NOT NULL,
	materialization_policy TEXT NOT NULL DEFAULT '',
	updated_at INTEGER NOT NULL,
	authoritative INTEGER NOT NULL DEFAULT 0,
	static_fingerprint TEXT NOT NULL DEFAULT '',
	header_omitted_model_ids TEXT NOT NULL DEFAULT '[]',
	unrestorable_header_model_ids TEXT NOT NULL DEFAULT '[]',
	header_restore_version INTEGER NOT NULL DEFAULT 0,
	models_hash TEXT NOT NULL DEFAULT '',
	models TEXT NOT NULL,
	PRIMARY KEY (provider_id, materialization_policy)
`;
const MODEL_CACHE_COLUMNS = `provider_id, version, materialization_policy, updated_at, authoritative,
	static_fingerprint, header_omitted_model_ids, unrestorable_header_model_ids, header_restore_version,
	models_hash, models`;

/**
 * Payload rows kept per provider: this build's plus the most recently written
 * rows of other policies, enough for an older long-running process (a gateway,
 * restored daemon sessions) to coexist with the current build without letting
 * every rules or version change leave a full catalog copy behind.
 */
const MAX_POLICIES_PER_PROVIDER = 3;

/**
 * Payload rows are multi-MB and SQLite rewrites a whole record (including its
 * overflow pages) on any column update. Freshness that advances without a
 * payload change therefore lives in `model_cache_freshness`, a small side row
 * keyed like the payload. It applies only while `payload_updated_at` still
 * matches the payload row's `updated_at`, so a rewritten payload silently
 * invalidates it.
 */
const CACHE_ROW_FROM = `
	FROM model_cache m
	LEFT JOIN model_cache_freshness f
		ON f.provider_id = m.provider_id AND f.materialization_policy = m.materialization_policy
	WHERE m.provider_id = ? AND m.materialization_policy = ?
`;
const CACHE_ROW_FRESHNESS_COLUMNS = `
		f.payload_updated_at AS freshness_payload_updated_at,
		f.updated_at AS freshness_updated_at,
		f.authoritative AS freshness_authoritative`;
const SELECT_CACHE_ROW = `SELECT m.*, ${CACHE_ROW_FRESHNESS_COLUMNS} ${CACHE_ROW_FROM}`;
/** Scalar columns plus `models_hash`: validates a memoized parse without reading the multi-MB payload. */
const SELECT_CACHE_ROW_META = `
	SELECT m.provider_id, m.version, m.materialization_policy, m.updated_at, m.authoritative,
		m.static_fingerprint, m.models_hash, m.header_omitted_model_ids,
		m.unrestorable_header_model_ids, m.header_restore_version, ${CACHE_ROW_FRESHNESS_COLUMNS}
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

/** Main-thread time one event-loop turn may spend in sliced model-refresh work. */
const REFRESH_SLICE_BUDGET_MS = 8;
/**
 * When the current turn's budget opened; undefined until a sliced loop checks
 * it. It belongs to the turn, not to one loop: sequential loops of one refresh
 * and refreshes resuming together in one turn (providers awaiting one shared
 * catalog fetch) all spend it, along with the synchronous work between them.
 */
let sliceWindowStart: number | undefined;

function closeSliceWindow(): void {
	sliceWindowStart = undefined;
}

/** Whether the current turn's budget is spent; the first check of a turn opens it. */
function sliceSpent(): boolean {
	const now = performance.now();
	if (sliceWindowStart === undefined) {
		sliceWindowStart = now;
		// An immediate runs only once the event loop turns: the next turn opens a fresh budget.
		setImmediate(closeSliceWindow);
		return false;
	}
	return now - sliceWindowStart >= REFRESH_SLICE_BUDGET_MS;
}

/**
 * Yields the spent turn through the immediate queue. Not a timer: `Bun.sleep(0)` sits in the timer
 * heap, which fake timers freeze, and a refresh parked there would never resume under a caller that
 * only advances time at its own deadlines.
 */
async function yieldSlice(): Promise<void> {
	const spentWindow = sliceWindowStart;
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	await promise;
	// The immediate normally closed it already (and another resumed loop may
	// have opened the new turn's window); never resume into the spent one.
	if (sliceWindowStart === spentWindow) sliceWindowStart = undefined;
}

/**
 * Visits `items` in order, yielding to the event loop (one immediate)
 * whenever the ~8 ms main-thread budget of the current turn is spent. The
 * budget is shared by every model-refresh loop running in that turn.
 */
export async function forEachInSlices<T>(items: readonly T[], visit: (item: T, index: number) => void): Promise<void> {
	for (let index = 0; index < items.length; index++) {
		if (sliceSpent()) await yieldSlice();
		visit(items[index], index);
	}
}

type StoredRowState = Pick<
	CacheRow,
	"updated_at" | "authoritative" | "freshness_payload_updated_at" | "freshness_updated_at" | "freshness_authoritative"
>;

interface TableInfoRow {
	name: string;
	/** 1-based position in the primary key; 0 for non-key columns. */
	pk: number;
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
	/**
	 * `authoritative` of the payload row itself, ignoring the
	 * `model_cache_refresh` side row. A failed refresh flips only the side row
	 * (freshness plus retry backoff), so this keeps answering "were `models`
	 * written by an authoritative discovery result?" after such a write.
	 */
	payloadAuthoritative: boolean;
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

/** Connection to a non-default cache path, held open while any retain is outstanding. */
interface PinnedDb {
	db: Database | null;
	refs: number;
}

const pinnedDbs = new Map<string, PinnedDb>();

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

/**
 * Parsed `models` payloads by `models_hash`, shared across database files: a
 * byte-identical payload in another file (a fresh models.db per registry, as in
 * tests) or rewritten unchanged yields the same row objects, so memos tagged on
 * row identity in the registry carry over. Rows are shared and must not be
 * mutated, as with `readRowCache`.
 */
const parsedPayloads = new LRUCache<string, Model<Api>[]>({ max: READ_ROW_CACHE_MAX });

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
	// A cache needs WAL's crash consistency, not a per-commit fsync: a power
	// loss at worst forgets the last refresh, which the next one rewrites.
	db.run("PRAGMA synchronous = NORMAL");
	db.run(`CREATE TABLE IF NOT EXISTS model_cache (${MODEL_CACHE_TABLE_BODY})`);
	db.run(`
		CREATE TABLE IF NOT EXISTS model_cache_freshness (
			provider_id TEXT NOT NULL,
			materialization_policy TEXT NOT NULL,
			payload_updated_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			authoritative INTEGER NOT NULL,
			PRIMARY KEY (provider_id, materialization_policy)
		)
	`);
	db.run(`
		CREATE TABLE IF NOT EXISTS thinking_capability (
			provider_id TEXT NOT NULL,
			api TEXT NOT NULL,
			endpoint TEXT NOT NULL,
			wire_model_id TEXT NOT NULL,
			capability TEXT NOT NULL,
			PRIMARY KEY (provider_id, api, endpoint, wire_model_id)
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
			UPDATE model_cache SET models_hash = ''
			WHERE provider_id = NEW.provider_id AND materialization_policy = NEW.materialization_policy;
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

/**
 * Keeps one connection to a non-default cache path open until the returned
 * handle is disposed. The default `models.db` already shares a long-lived
 * connection; other paths otherwise open, initialize and close the database on
 * every read and write, which a refresh pass repeats once per provider.
 * Retains nest: the connection closes when the last one is disposed.
 */
export function retainModelCacheConnection(dbPath: string | undefined): Disposable {
	const { resolvedPath, shared } = resolveCacheDb(dbPath);
	if (shared) return { [Symbol.dispose]() {} };
	let pin = pinnedDbs.get(resolvedPath);
	if (!pin) {
		pin = { db: null, refs: 0 };
		pinnedDbs.set(resolvedPath, pin);
	}
	pin.refs++;
	const held = pin;
	let released = false;
	return {
		[Symbol.dispose]() {
			if (released) return;
			released = true;
			held.refs--;
			if (held.refs > 0) return;
			pinnedDbs.delete(resolvedPath);
			held.db?.close();
			held.db = null;
		},
	};
}

function runModelCacheDb<T>(resolvedPath: string, shared: boolean, useDb: (db: Database) => T): T {
	if (shared && sharedDb && sharedDbPath !== resolvedPath) closeSharedDb();
	const pin = shared ? undefined : pinnedDbs.get(resolvedPath);
	const heldDb = shared ? sharedDb : pin?.db;
	if (heldDb) {
		try {
			return useDb(heldDb);
		} catch (error) {
			if (!isSqliteCorruptionError(error)) throw error;
			// The opener owns recovery for new handles. Drop this stale handle
			// first so its WAL cannot remain attached to the replacement.
			if (pin) {
				heldDb.close();
				pin.db = null;
			} else {
				closeSharedDb();
			}
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
			} else if (pin) {
				pin.db = db;
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

/** Secret-free identity of one probed model endpoint and request API. */
export interface ThinkingCapabilityCacheKey {
	provider: string;
	api: string;
	endpoint: string;
	wireModelId: string;
}

/** Read raw thinking-capability metadata through the shared, corruption-recovering cache connection. */
export function readCachedThinkingCapability(key: ThinkingCapabilityCacheKey, dbPath?: string): string | undefined {
	try {
		return withModelCacheDb(
			dbPath,
			db =>
				db
					.query<{ capability: string }, [string, string, string, string]>(
						"SELECT capability FROM thinking_capability WHERE provider_id = ? AND api = ? AND endpoint = ? AND wire_model_id = ?",
					)
					.get(key.provider, key.api, key.endpoint, key.wireModelId)?.capability,
		);
	} catch {
		return undefined;
	}
}

/** Persist validated thinking-capability JSON; storage failures never interrupt a request. */
export function writeCachedThinkingCapability(
	key: ThinkingCapabilityCacheKey,
	capability: string,
	dbPath?: string,
): void {
	try {
		withModelCacheDb(dbPath, db => {
			db.run(
				"INSERT OR REPLACE INTO thinking_capability (provider_id, api, endpoint, wire_model_id, capability) VALUES (?, ?, ?, ?, ?)",
				[key.provider, key.api, key.endpoint, key.wireModelId, capability],
			);
		});
	} catch {
		// Capability persistence is best-effort, like model-cache persistence.
	}
}

/**
 * An explicit default database path shares the long-lived connection rather
 * than opening and initializing the same database on every call.
 */
function resolveCacheDb(dbPath: string | undefined): { resolvedPath: string; shared: boolean } {
	const defaultPath = getModelDbPath();
	if (dbPath === undefined || dbPath === defaultPath || path.resolve(dbPath) === path.resolve(defaultPath)) {
		return { resolvedPath: defaultPath, shared: true };
	}
	return { resolvedPath: dbPath, shared: false };
}

function readTableInfo(db: Database): TableInfoRow[] {
	const stmt = db.prepare("PRAGMA table_info(model_cache)");
	try {
		return stmt.all() as TableInfoRow[];
	} finally {
		stmt.finalize();
	}
}

function migrateCacheSchema(db: Database): void {
	const columns = readTableInfo(db);
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
	// Rows predating v11 may carry credential-bearing request headers (v10 could
	// still persist derived computer-use headers), so purge them and scrub the
	// freed cells (#5780). Every other non-current row (v11/v12, a newer schema,
	// or another materialization policy from a different app version sharing
	// this file) never persisted headers: readers gate on the exact version and
	// policy and treat it as absent, so switching versions does not wipe and
	// re-download every provider. Never promote old rows in place: the legacy
	// `UPDATE ... WHERE version = 2` migration did, defeating every later
	// invalidation (#4146).
	const legacyStmt = db.prepare("SELECT 1 AS found FROM model_cache WHERE version < ? LIMIT 1");
	let hasLegacyRows: boolean;
	try {
		hasLegacyRows = legacyStmt.get(FIRST_HEADERLESS_SCHEMA_VERSION) !== null;
	} finally {
		legacyStmt.finalize();
	}
	if (hasLegacyRows) {
		db.run("PRAGMA secure_delete = ON");
		try {
			db.run("DELETE FROM model_cache WHERE version < ?", [FIRST_HEADERLESS_SCHEMA_VERSION]);
		} finally {
			db.run("PRAGMA secure_delete = FAST");
		}
	}
	if (!isKeyedByPolicy(columns)) rekeyByPolicy(db);
}

function isKeyedByPolicy(columns: readonly TableInfoRow[]): boolean {
	return columns.some(column => column.name === "materialization_policy" && column.pk > 0);
}

/**
 * Rebuild a provider-keyed `model_cache` (builds before per-policy rows) under
 * the `(provider_id, materialization_policy)` key. Builds still keyed by
 * provider keep working against the rebuilt table: their `INSERT OR REPLACE`
 * conflicts only with their own policy's row, and their freshness rows stay in
 * their own `model_cache_refresh` table. Runs after the credential purge, so
 * no header-bearing row is copied.
 */
function rekeyByPolicy(db: Database): void {
	db.transaction(() => {
		// Another process may have rebuilt the table since this one inspected it.
		if (isKeyedByPolicy(readTableInfo(db))) return;
		db.run(`CREATE TABLE model_cache_rekeyed (${MODEL_CACHE_TABLE_BODY})`);
		db.run(`INSERT INTO model_cache_rekeyed (${MODEL_CACHE_COLUMNS}) SELECT ${MODEL_CACHE_COLUMNS} FROM model_cache`);
		// Dropping the table drops the provider-keyed hash-reset trigger with it.
		db.run("DROP TABLE model_cache");
		db.run("ALTER TABLE model_cache_rekeyed RENAME TO model_cache");
	}).immediate();
}

/**
 * A cacheable materialized model. Also checked on the write side against
 * in-memory models, so optional keys may be present as `undefined`.
 */
const MaterializedModel = type({
	id: "string > 0",
	name: "string > 0",
	api: "string > 0",
	provider: "string > 0",
	// Empty is legitimate: Azure-style providers resolve the endpoint from
	// configuration at request time, and their bundled rows carry "".
	baseUrl: "string",
	reasoning: "boolean",
	input: "('text' | 'image')[] > 0",
	"headers?": "undefined",
	supportsComputerUseConfig: "boolean | null",
	contextWindow: "number > 0 | null",
	maxTokens: "number > 0 | null",
	identity: { class: "string" },
	"compat?": type("object")
		.narrow(compat => !Array.isArray(compat))
		.or("undefined"),
	cost: { input: "number", output: "number", cacheRead: "number", cacheWrite: "number" },
});

function isMaterializedModel(value: unknown): value is PersistedModel<Api> {
	return MaterializedModel.allows(value);
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

/** {@link parseMaterializedModels}, memoized by the row's `models_hash` (rows without one always parse). */
function parsePayload<TApi extends Api>(serialized: string, hash: string): Model<TApi>[] | null {
	if (hash === "") return parseMaterializedModels<TApi>(serialized);
	const cached = parsedPayloads.get(hash);
	if (cached !== undefined) return cached as Model<TApi>[];
	const models = parseMaterializedModels<TApi>(serialized);
	if (models !== null) parsedPayloads.set(hash, models as Model<Api>[]);
	return models;
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
				if (meta && cacheRowsEqual(cached.meta, meta)) {
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

/** This build's row for `providerId`; rows of other materialization policies are invisible. */
function queryRow<T>(db: Database, sql: string, providerId: string): T | null {
	const stmt = db.query<T, [string, string]>(sql);
	try {
		return stmt.get(providerId, materializationPolicy());
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
		row.freshness_updated_at !== null &&
		row.freshness_payload_updated_at === row.updated_at &&
		row.freshness_authoritative !== null
	) {
		return { updatedAt: row.freshness_updated_at, authoritative: row.freshness_authoritative === 1 };
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
	if (!row || row.version !== CACHE_SCHEMA_VERSION) {
		return null;
	}
	const models = parsePayload<TApi>(row.models, row.models_hash);
	const headerOmittedModelIds = parseModelIds(row.header_omitted_model_ids);
	const unrestorableHeaderModelIds = parseModelIds(row.unrestorable_header_model_ids);
	if (models === null || headerOmittedModelIds === null || unrestorableHeaderModelIds === null) {
		// Fail closed on corrupt header provenance: treating malformed
		// markers as empty could return a model with required credentials
		// silently absent. Current-schema rows never persist headers, so the
		// rejected payload needs no secure scrub.
		db.run("DELETE FROM model_cache WHERE provider_id = ? AND materialization_policy = ?", [
			providerId,
			row.materialization_policy,
		]);
		return null;
	}
	const { updatedAt, authoritative } = rowState(row);
	const ageMs = now() - updatedAt;
	const fresh = Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= ttlMs;
	return {
		models,
		fresh,
		authoritative,
		payloadAuthoritative: row.authoritative === 1,
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
 * Drop `providerId` rows beyond this build's and the most recently written
 * rows of other policies (see {@link MAX_POLICIES_PER_PROVIDER}), plus
 * freshness rows whose payload is gone.
 */
function pruneOtherPolicies(db: Database, providerId: string, policy: string): void {
	db.run(
		`DELETE FROM model_cache WHERE provider_id = ?1 AND materialization_policy NOT IN (
			SELECT materialization_policy FROM model_cache WHERE provider_id = ?1
			ORDER BY materialization_policy = ?2 DESC, updated_at DESC LIMIT ?3
		)`,
		[providerId, policy, MAX_POLICIES_PER_PROVIDER],
	);
	db.run(
		`DELETE FROM model_cache_freshness WHERE provider_id = ?1 AND materialization_policy NOT IN (
			SELECT materialization_policy FROM model_cache WHERE provider_id = ?1
		)`,
		[providerId],
	);
}

/**
 * What one snapshot write did: `written` replaced the payload row; `refreshed`
 * found the payload unchanged and advanced only its freshness or authority;
 * `skipped` found the stored row already equal and wrote nothing;
 * `superseded` lost to a later write for the same provider before landing;
 * `failed` hit a storage error (cache writes are best-effort).
 */
export type ModelCacheWriteOutcome = "written" | "refreshed" | "skipped" | "superseded" | "failed";

/** A provider snapshot serialized for storage as one payload row. */
interface CacheRowWrite {
	providerId: string;
	updatedAt: number;
	authoritative: boolean;
	staticFingerprint: string;
	/** Serialized id lists of the header provenance columns. */
	headerOmittedModelIds: string;
	unrestorableHeaderModelIds: string;
	models: string;
	modelsHash: string;
}

/** Projects and serializes a snapshot one model at a time, so a refresh can do it in slices. */
class CacheRowBuilder<TApi extends Api> {
	readonly #staticById: ReadonlyMap<string, Model<TApi>>;
	readonly #restorableHeaderFallback: Record<string, string> | undefined;
	readonly #headerOmittedModelIds: string[] = [];
	readonly #unrestorableHeaderModelIds: string[] = [];
	readonly #rejectedModelIds: string[] = [];
	readonly #serializedModels: string[] = [];

	constructor(
		staticHeaderSources: readonly Model<TApi>[],
		restorableHeaderFallback: Record<string, string> | undefined,
	) {
		this.#staticById = new Map(staticHeaderSources.map(model => [model.id, model]));
		this.#restorableHeaderFallback = restorableHeaderFallback;
	}

	/** Appends one model, or records it as rejected when the reader would refuse it. */
	add(model: Model<TApi>): void {
		const cachedModel = toCachedModel(model);
		if (!isMaterializedModel(cachedModel)) {
			// One unreadable model must not make the whole row fail
			// validation on read (which deletes it and refetches forever).
			this.#rejectedModelIds.push(model.id);
			return;
		}
		if (hasModelHeaders(model)) {
			this.#headerOmittedModelIds.push(model.id);
			// Synthesized variants (e.g. Copilot `-1m`) have no same-id static
			// entry; their headers come from the `requestModelId` base. Match
			// against that source too, else they are wrongly flagged
			// unrestorable and dropped on the next offline read (#6037, #6284).
			const staticHeaderSource =
				this.#staticById.get(model.id) ??
				(model.requestModelId ? this.#staticById.get(model.requestModelId) : undefined);
			// A model with no static source is still restorable when its live
			// headers equal a trusted provider-wide fallback that the reader can
			// re-derive without persisting it. This keeps reference-less models
			// with constant or configured headers alive offline.
			const matchesStatic = model.resolveHeaders
				? staticHeaderSource?.resolveHeaders === model.resolveHeaders
				: staticHeaderSource
					? headersEqual(model.headers, staticHeaderSource.headers)
					: headersEqual(model.headers, this.#restorableHeaderFallback);
			if (!matchesStatic) {
				this.#unrestorableHeaderModelIds.push(model.id);
			}
		}
		this.#serializedModels.push(JSON.stringify(cachedModel));
	}

	/** The row for every model added so far. */
	finish(providerId: string, updatedAt: number, authoritative: boolean, staticFingerprint: string): CacheRowWrite {
		if (this.#rejectedModelIds.length > 0) {
			logger.debug("model cache skipped models that would fail cache validation", {
				provider: providerId,
				models: this.#rejectedModelIds,
			});
		}
		// Joined element-wise this is byte-identical to `JSON.stringify` of the
		// whole array, so the hash matches rows serialized in one piece.
		const models = `[${this.#serializedModels.join(",")}]`;
		return {
			providerId,
			updatedAt,
			authoritative,
			staticFingerprint,
			headerOmittedModelIds: JSON.stringify(this.#headerOmittedModelIds),
			unrestorableHeaderModelIds: JSON.stringify(this.#unrestorableHeaderModelIds),
			models,
			// Length prefix: a collision would also need an equal payload size.
			modelsHash: `${models.length.toString(36)}:${Bun.hash(models).toString(36)}`,
		};
	}
}

/** Freshness of this build's stored row when its payload equals `write`'s; null when it differs or is absent. */
function matchingStoredRow(db: Database, write: CacheRowWrite): StoredRowState | null {
	const stmt = db.prepare<StoredRowState, [string, number, string, string, string, string, number, string]>(
		`SELECT m.updated_at, m.authoritative, ${CACHE_ROW_FRESHNESS_COLUMNS}
		FROM model_cache m
		LEFT JOIN model_cache_freshness f
			ON f.provider_id = m.provider_id AND f.materialization_policy = m.materialization_policy
		WHERE m.provider_id = ? AND m.version = ? AND m.materialization_policy = ?
			AND m.static_fingerprint = ? AND m.header_omitted_model_ids = ?
			AND m.unrestorable_header_model_ids = ? AND m.header_restore_version = ? AND m.models_hash = ?`,
	);
	try {
		return stmt.get(
			write.providerId,
			CACHE_SCHEMA_VERSION,
			materializationPolicy(),
			write.staticFingerprint,
			write.headerOmittedModelIds,
			write.unrestorableHeaderModelIds,
			HEADER_RESTORE_VERSION,
			write.modelsHash,
		);
	} finally {
		stmt.finalize();
	}
}

function storedStateMatches(stored: StoredRowState, write: CacheRowWrite): boolean {
	const state = rowState(stored);
	return state.updatedAt === write.updatedAt && state.authoritative === write.authoritative;
}

/** Whether the stored row already equals `write` exactly; read before taking the write lock. */
function storedRowUnchanged(db: Database, write: CacheRowWrite): boolean {
	const stored = matchingStoredRow(db, write);
	return stored !== null && storedStateMatches(stored, write);
}

/**
 * Store `write` inside the caller's write transaction. An unchanged payload
 * only advances `model_cache_freshness`; a changed one replaces the row,
 * drops the stale side row and prunes the provider's other policies.
 */
function applyCacheRowWrite(db: Database, write: CacheRowWrite): "skipped" | "refreshed" | "written" {
	const policy = materializationPolicy();
	const authoritativeFlag = write.authoritative ? 1 : 0;
	const stored = matchingStoredRow(db, write);
	if (stored) {
		if (storedStateMatches(stored, write)) return "skipped";
		db.run(
			`INSERT INTO model_cache_freshness (
				provider_id, materialization_policy, payload_updated_at, updated_at, authoritative
			)
			VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(provider_id, materialization_policy) DO UPDATE SET
				payload_updated_at = excluded.payload_updated_at,
				updated_at = excluded.updated_at,
				authoritative = excluded.authoritative`,
			[write.providerId, policy, stored.updated_at, write.updatedAt, authoritativeFlag],
		);
		return "refreshed";
	}
	db.run(
		`INSERT OR REPLACE INTO model_cache (${MODEL_CACHE_COLUMNS})
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			write.providerId,
			CACHE_SCHEMA_VERSION,
			policy,
			write.updatedAt,
			authoritativeFlag,
			write.staticFingerprint,
			write.headerOmittedModelIds,
			write.unrestorableHeaderModelIds,
			HEADER_RESTORE_VERSION,
			write.modelsHash,
			write.models,
		],
	);
	db.run("DELETE FROM model_cache_freshness WHERE provider_id = ? AND materialization_policy = ?", [
		write.providerId,
		policy,
	]);
	pruneOtherPolicies(db, write.providerId, policy);
	return "written";
}

function recordWriteOutcome(write: CacheRowWrite, outcome: ModelCacheWriteOutcome): void {
	if (outcome === "skipped") {
		writeStats.skippedWrites++;
	} else if (outcome === "refreshed") {
		writeStats.refreshWrites++;
	} else if (outcome === "written") {
		writeStats.payloadWrites++;
		writeStats.payloadBytes += write.models.length;
		if (recentPayloadProviders.length >= RECENT_PAYLOAD_PROVIDERS_MAX) recentPayloadProviders.shift();
		recentPayloadProviders.push(write.providerId);
	}
}

/**
 * Latest write claimed per cache row (`readCacheKey`). A queued write whose
 * claim is no longer the latest lands as `superseded`, so the most recent
 * call wins, as it did when every write was synchronous.
 */
const latestWriteClaims = new Map<string, number>();
let writeClaims = 0;

function claimWrite(key: string): number {
	const claim = ++writeClaims;
	latestWriteClaims.set(key, claim);
	return claim;
}

/**
 * Persist a provider snapshot as this build's row for `providerId`.
 *
 * When the stored payload (models, header provenance, fingerprint, schema and
 * materialization policy) is byte-identical, the multi-MB row is left alone and
 * only `model_cache_freshness` records the new freshness and authority; a write
 * that changes nothing at all is skipped without taking the write lock. A
 * payload write also prunes the provider's rows to {@link MAX_POLICIES_PER_PROVIDER}
 * policies. Every model persisted here is validated with the reader's own
 * predicate, so a row this writes is never rejected (and deleted) by
 * `readModelCache`. Synchronous: refreshes use {@link writeModelCacheAsync}.
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
): ModelCacheWriteOutcome {
	let claimed: { key: string; claim: number } | undefined;
	try {
		const { resolvedPath, shared } = resolveCacheDb(dbPath);
		const key = readCacheKey(resolvedPath, providerId);
		claimed = { key, claim: claimWrite(key) };
		readRowCache.delete(key);
		const builder = new CacheRowBuilder(staticHeaderSources, restorableHeaderFallback);
		for (const model of models) builder.add(model);
		const write = builder.finish(providerId, updatedAt, authoritative, staticFingerprint);
		const outcome = runModelCacheDb(resolvedPath, shared, db =>
			storedRowUnchanged(db, write) ? "skipped" : db.transaction(() => applyCacheRowWrite(db, write)).immediate(),
		);
		recordWriteOutcome(write, outcome);
		return outcome;
	} catch {
		// Cache writes are best-effort; failures should not break model resolution.
		return "failed";
	} finally {
		// Keep a later write's claim, if any.
		if (claimed && latestWriteClaims.get(claimed.key) === claimed.claim) latestWriteClaims.delete(claimed.key);
	}
}

/**
 * {@link writeModelCache} for refreshes, without holding the event loop:
 * models are projected and serialized in time-budgeted slices, an unchanged
 * snapshot is recognized before the write lock is taken, and the row lands
 * through a shared writer whose short transactions batch other providers'
 * rows and wait out another process's write lock asynchronously. Resolves once
 * the row is stored (or found unchanged); until then readers see the previous
 * row whole. When the same provider is written again before this lands, the
 * later write wins and this one resolves `superseded`.
 */
export async function writeModelCacheAsync<TApi extends Api>(
	providerId: string,
	updatedAt: number,
	models: readonly Model<TApi>[],
	authoritative: boolean,
	staticFingerprint: string,
	dbPath?: string,
	staticHeaderSources: readonly Model<TApi>[] = [],
	restorableHeaderFallback?: Record<string, string>,
): Promise<ModelCacheWriteOutcome> {
	let target: { resolvedPath: string; shared: boolean };
	try {
		target = resolveCacheDb(dbPath);
	} catch {
		return "failed";
	}
	const { resolvedPath, shared } = target;
	const key = readCacheKey(resolvedPath, providerId);
	const claim = claimWrite(key);
	// Keeps one connection to a non-default path for the comparison and the write.
	using _connection = retainModelCacheConnection(dbPath);
	try {
		const builder = new CacheRowBuilder(staticHeaderSources, restorableHeaderFallback);
		await forEachInSlices(models, model => builder.add(model));
		const write = builder.finish(providerId, updatedAt, authoritative, staticFingerprint);
		if (latestWriteClaims.get(key) !== claim) return "superseded";
		if (runModelCacheDb(resolvedPath, shared, db => storedRowUnchanged(db, write))) {
			recordWriteOutcome(write, "skipped");
			return "skipped";
		}
		const { promise, resolve } = Promise.withResolvers<ModelCacheWriteOutcome>();
		enqueueCacheWrite({ resolvedPath, shared, key, claim, write, settle: resolve });
		return await promise;
	} catch {
		return "failed";
	} finally {
		// Keep a later write's claim, if any.
		if (latestWriteClaims.get(key) === claim) latestWriteClaims.delete(key);
	}
}

/** A snapshot waiting for the shared writer. */
interface QueuedCacheWrite {
	resolvedPath: string;
	shared: boolean;
	key: string;
	claim: number;
	write: CacheRowWrite;
	settle: (outcome: ModelCacheWriteOutcome) => void;
}

const writeQueue: QueuedCacheWrite[] = [];
let writerActive = false;
/** Pause between write-lock attempts while another connection holds it. */
const WRITE_LOCK_RETRY_MS = 5;

function enqueueCacheWrite(job: QueuedCacheWrite): void {
	writeQueue.push(job);
	if (writerActive) return;
	writerActive = true;
	// Refreshes resumed by one settled fetch enqueue from successive microtasks;
	// starting behind them lets their rows share one transaction.
	queueMicrotask(drainCacheWrites);
}

function settleQueuedWrite(job: QueuedCacheWrite, outcome: ModelCacheWriteOutcome): void {
	const index = writeQueue.indexOf(job);
	if (index >= 0) writeQueue.splice(index, 1);
	if (outcome === "written" || outcome === "refreshed") readRowCache.delete(job.key);
	recordWriteOutcome(job.write, outcome);
	job.settle(outcome);
}

function failQueuedWrites(resolvedPath: string): void {
	for (const job of writeQueue.filter(queued => queued.resolvedPath === resolvedPath)) {
		settleQueuedWrite(job, "failed");
	}
}

/**
 * Lands queued rows oldest first, one database at a time, in write
 * transactions that end once the turn's slice budget is spent, yielding
 * between them. Another connection's write lock is retried after a pause
 * rather than waited out in SQLite's blocking busy handler, up to the same
 * overall timeout.
 */
async function drainCacheWrites(): Promise<void> {
	let lockWaitStart: number | undefined;
	try {
		while (writeQueue.length > 0) {
			if (sliceSpent()) await yieldSlice();
			const { resolvedPath, shared } = writeQueue[0];
			let landed: boolean;
			try {
				landed = runModelCacheDb(resolvedPath, shared, db => landQueuedWrites(db, resolvedPath));
			} catch {
				failQueuedWrites(resolvedPath);
				lockWaitStart = undefined;
				continue;
			}
			if (landed) {
				lockWaitStart = undefined;
				continue;
			}
			const now = performance.now();
			lockWaitStart ??= now;
			if (now - lockWaitStart >= getDbBusyTimeoutMs()) {
				failQueuedWrites(resolvedPath);
				lockWaitStart = undefined;
				continue;
			}
			await Bun.sleep(WRITE_LOCK_RETRY_MS);
		}
	} finally {
		writerActive = false;
	}
}

/**
 * One write transaction over the rows queued for `resolvedPath`, ending early
 * once the slice budget is spent. Returns false, having written nothing, when
 * another connection holds the write lock.
 */
function landQueuedWrites(db: Database, resolvedPath: string): boolean {
	if (!beginImmediateWithoutWaiting(db)) return false;
	const landed: { job: QueuedCacheWrite; outcome: ModelCacheWriteOutcome }[] = [];
	let failing: QueuedCacheWrite | undefined;
	try {
		for (const job of writeQueue) {
			if (job.resolvedPath !== resolvedPath) continue;
			failing = job;
			const outcome =
				latestWriteClaims.get(job.key) === job.claim ? applyCacheRowWrite(db, job.write) : "superseded";
			failing = undefined;
			landed.push({ job, outcome });
			if (sliceSpent()) break;
		}
		db.run("COMMIT");
	} catch (error) {
		try {
			db.run("ROLLBACK");
		} catch {
			// The failed statement may already have ended the transaction.
		}
		// `runModelCacheDb` replaces a corrupt handle and reruns this over the
		// rows that are still queued.
		if (isSqliteCorruptionError(error)) throw error;
		// Only the row that threw fails (every row, when COMMIT did); the rest
		// stay queued for the next transaction.
		if (failing) {
			settleQueuedWrite(failing, "failed");
		} else {
			for (const { job } of landed) settleQueuedWrite(job, "failed");
		}
		return true;
	}
	for (const { job, outcome } of landed) settleQueuedWrite(job, outcome);
	return true;
}

/** `BEGIN IMMEDIATE` that returns false at once instead of blocking in SQLite's busy handler. */
function beginImmediateWithoutWaiting(db: Database): boolean {
	db.run("PRAGMA busy_timeout = 0");
	try {
		db.run("BEGIN IMMEDIATE");
		return true;
	} catch (error) {
		if (isSqliteBusyError(error)) return false;
		throw error;
	} finally {
		db.run(`PRAGMA busy_timeout = ${getDbBusyTimeoutMs()}`);
	}
}
