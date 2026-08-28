/**
 * SQLite-backed model cache for atomic cross-process access.
 * Replaces per-provider JSON files with a single cache.db.
 */
import { Database } from "bun:sqlite";
import { renameSync } from "node:fs";
import { getModelDbPath, isEnoent, isSqliteCorruptionError, logger } from "@oh-my-pi/pi-utils";
import type { Api, Model, ModelSpec } from "./types";

// Rows persist ModelSpec JSON (sparse `compat`, never the resolved record);
// the model manager rebuilds via `buildModel` on load. Request headers are
// intentionally omitted: arbitrary provider-defined header names can carry
// credentials. v12 invalidates Kimi Code rows carrying the blanket
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
const CACHE_SCHEMA_VERSION = 12;
const HEADER_RESTORE_VERSION = 1;

interface CacheRow {
	provider_id: string;
	version: number;
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

interface CacheEntry<TApi extends Api = Api> {
	models: ModelSpec<TApi>[];
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
	db.run("DELETE FROM model_cache WHERE version <> ?", [CACHE_SCHEMA_VERSION]);
}

export function readModelCache<TApi extends Api>(
	providerId: string,
	ttlMs: number,
	now: () => number,
	dbPath?: string,
): CacheEntry<TApi> | null {
	try {
		return withModelCacheDb(dbPath, db => {
			const stmt = db.query<CacheRow, [string]>("SELECT * FROM model_cache WHERE provider_id = ?");
			try {
				const row = stmt.get(providerId);
				if (!row || row.version !== CACHE_SCHEMA_VERSION) {
					return null;
				}
				const models = JSON.parse(row.models) as ModelSpec<TApi>[];
				const parsedHeaderModelIds: unknown = JSON.parse(row.header_omitted_model_ids);
				const headerOmittedModelIds = Array.isArray(parsedHeaderModelIds)
					? parsedHeaderModelIds.filter((id): id is string => typeof id === "string")
					: [];
				const parsedUnrestorableModelIds: unknown = JSON.parse(row.unrestorable_header_model_ids);
				const unrestorableHeaderModelIds = Array.isArray(parsedUnrestorableModelIds)
					? parsedUnrestorableModelIds.filter((id): id is string => typeof id === "string")
					: [];
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
		});
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
 * Project a live model to cache-safe metadata.
 *
 * Headers are never persisted: custom/runtime providers may use arbitrary
 * credential header names, so no name-based filter can be complete. The
 * separately persisted model-id list lets the manager restore matching static
 * headers and reject/refetch dynamic-only cached models that need live headers.
 */
function toCachedModelSpec<TApi extends Api>(model: Model<TApi>): ModelSpec<TApi> {
	const { headers: _headers, compatConfig, supportsComputerUseConfig, ...rest } = model;
	return { ...rest, supportsComputerUse: supportsComputerUseConfig, compat: compatConfig };
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
		withModelCacheDb(dbPath, db => {
			const headerOmittedModelIds: string[] = [];
			const unrestorableHeaderModelIds: string[] = [];
			const cachedModels: ModelSpec<TApi>[] = [];
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
				cachedModels.push(toCachedModelSpec(model));
			}
			db.run(
				`INSERT OR REPLACE INTO model_cache (
					provider_id, version, updated_at, authoritative, static_fingerprint,
					header_omitted_model_ids, unrestorable_header_model_ids,
					header_restore_version, models
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					providerId,
					CACHE_SCHEMA_VERSION,
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
