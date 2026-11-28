/**
 * SQLite-backed cache for rendered `github` issue/PR view output, plus a
 * generic cache-aware wrapper that the tool ops and the `issue://`/`pr://`
 * protocol handlers share.
 *
 * Storage:
 *   One process-wide connection opens lazily on first hit and stays open. All
 *   helpers swallow open/IO failures and degrade to "no cache" so a corrupt or
 *   unreadable DB never blocks a `gh` call.
 *
 *   Soft TTL → return cached issue/PR rows directly. Open issue/PR rows use a
 *     shorter revalidation window because their state can change at any time.
 *   Issue/PR rows past soft TTL but within hard TTL → refresh synchronously,
 *     falling back to the cached row if the live fetch fails.
 *   Diff rows with a revision key → probe live revisions on every lookup and
 *     reuse only a matching row within the hard TTL. Revision changes fetch
 *     synchronously; they never fall back to an unchecked row.
 *     Only `/review` stores the snapshot it froze, keyed by `fetched_at`.
 *     Cache writes do not. A published generation is insert-only: a later
 *     snapshot that collides on the same millisecond gets a new id.
 *   Past hard TTL → treat as miss and fetch fresh. Pinned generation reads
 *     use that same hard TTL, counted from when `/review` retained the
 *     snapshot, and honor the cache kill switch.
 */

import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getGithubCacheDbPath, logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import { defaultGhHost, parseRepoRef } from "./gh-common";
import { cfgGithubCacheEnabled, cfgGithubCacheHardTtlSec, cfgGithubCacheSoftTtlSec } from "./settings";
import { ToolAbortError } from "./tool-errors";

// ────────────────────────────────────────────────────────────────────────────
// Storage layer
// ────────────────────────────────────────────────────────────────────────────

export type CacheKind = "issue" | "pr" | "pr-diff" | "mr" | "mr-diff" | "gl-issue";

const DEFAULT_CACHE_AUTH_KEY = "default";

export interface CachedView<T = unknown> {
	authKey: string;
	repo: string;
	kind: CacheKind;
	number: number;
	includeComments: boolean;
	fetchedAt: number;
	revision?: string;
	payload: T;
	rendered: string;
	sourceUrl: string | undefined;
}

interface Row {
	auth_key: string;
	repo: string;
	kind: CacheKind;
	number: number;
	include_comments: number;
	fetched_at: number;
	payload: string;
	rendered: string;
	source_url: string | null;
	revision?: string | null;
}

let cachedDb: Database | null = null;
let openAttempted = false;

/**
 * Bumped by every invalidation. A fetch that started before a bump returns its
 * result but does not cache it, so a pre-mutation response cannot repopulate a
 * row the mutation just dropped. Fencing every in-flight fetch, not only the
 * matching rows, is deliberate: a skipped store costs one refetch.
 */
let invalidationEpoch = 0;

function ensureParentDir(filePath: string): void {
	try {
		const dir = path.dirname(filePath);
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	} catch (err) {
		logger.debug("github cache: failed to create private parent dir", { err: String(err) });
	}
}

function chmodIfExists(filePath: string, mode: number): void {
	try {
		fs.chmodSync(filePath, mode);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			logger.debug("github cache: chmod failed", { err: String(err), path: filePath });
		}
	}
}

function protectDbFiles(dbPath: string): void {
	chmodIfExists(dbPath, 0o600);
	chmodIfExists(`${dbPath}-wal`, 0o600);
	chmodIfExists(`${dbPath}-shm`, 0o600);
}

export function openDb(): Database | null {
	if (cachedDb) return cachedDb;
	if (openAttempted) return null;
	openAttempted = true;
	try {
		const dbPath = getGithubCacheDbPath();
		ensureParentDir(dbPath);
		const db = new Database(dbPath);
		// Install the busy handler BEFORE any lock-taking statement. See #2421.
		db.run("PRAGMA busy_timeout = 5000");
		db.run(`
			PRAGMA journal_mode=WAL;
			PRAGMA synchronous=NORMAL;
		`);
		// Pre-v5 live rows used an obsolete kind constraint and are regenerable.
		// Pinned generations are not: keep those rows while upgrading their
		// constraint below so existing PR review URLs remain valid.
		const userVersion = (db.query("PRAGMA user_version").get() as { user_version?: number } | undefined)
			?.user_version;
		if (userVersion !== undefined && userVersion < 5) {
			db.run("DROP TABLE IF EXISTS github_view_cache");
		}
		db.run(`
			CREATE TABLE IF NOT EXISTS github_view_cache (
				auth_key        TEXT    NOT NULL,
				repo             TEXT    NOT NULL,
				kind             TEXT    NOT NULL CHECK (kind IN ('issue','pr','pr-diff','mr','mr-diff','gl-issue')),
				number           INTEGER NOT NULL,
				include_comments INTEGER NOT NULL,
				fetched_at       INTEGER NOT NULL,
				payload          TEXT    NOT NULL,
				rendered         TEXT    NOT NULL,
				source_url       TEXT,
				revision         TEXT,
				PRIMARY KEY (auth_key, repo, kind, number, include_comments)
			);
			CREATE TABLE IF NOT EXISTS github_forge_index (
				auth_key   TEXT    NOT NULL,
				repo       TEXT    NOT NULL,
				kind       TEXT    NOT NULL CHECK (kind IN ('pr','issue')),
				number     INTEGER NOT NULL,
				title      TEXT    NOT NULL,
				state      TEXT    NOT NULL,
				author     TEXT    NOT NULL,
				updated_at TEXT    NOT NULL,
				fetched_at INTEGER NOT NULL,
				PRIMARY KEY (auth_key, repo, kind, number)
			);
		`);
		db.transaction(() => {
			const viewColumns = db.query("PRAGMA table_info(github_view_cache)").all() as { name: string }[];
			if (!viewColumns.some(column => column.name === "revision")) {
				db.run("ALTER TABLE github_view_cache ADD COLUMN revision TEXT");
			}
			const generationSchema = db
				.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
				.get("github_view_cache_generation") as { sql: string | null } | undefined;
			const needsGenerationMigration = !!generationSchema?.sql && !generationSchema.sql.includes("'mr-diff'");
			if (needsGenerationMigration) {
				db.run("ALTER TABLE github_view_cache_generation RENAME TO github_view_cache_generation_legacy");
			}
			db.run(`
				CREATE TABLE IF NOT EXISTS github_view_cache_generation (
					auth_key        TEXT    NOT NULL,
					repo             TEXT    NOT NULL,
					kind             TEXT    NOT NULL CHECK (kind IN ('issue','pr','pr-diff','mr-diff')),
					number           INTEGER NOT NULL,
					include_comments INTEGER NOT NULL,
					fetched_at       INTEGER NOT NULL,
					retained_at      INTEGER NOT NULL,
					payload          TEXT    NOT NULL,
					rendered         TEXT    NOT NULL,
					source_url       TEXT,
					PRIMARY KEY (auth_key, repo, kind, number, include_comments, fetched_at)
				)
			`);
			if (needsGenerationMigration) {
				db.run(`
					INSERT INTO github_view_cache_generation
					SELECT auth_key, repo, kind, number, include_comments, fetched_at, retained_at, payload, rendered, source_url
					FROM github_view_cache_generation_legacy
				`);
				db.run("DROP TABLE github_view_cache_generation_legacy");
			}
		}).immediate();
		db.run(`
			CREATE INDEX IF NOT EXISTS idx_github_view_cache_fetched ON github_view_cache(fetched_at);
			CREATE INDEX IF NOT EXISTS idx_github_view_cache_generation_retained ON github_view_cache_generation(retained_at);
			CREATE INDEX IF NOT EXISTS idx_github_forge_index_repo ON github_forge_index(auth_key, repo, fetched_at DESC);
			PRAGMA user_version = 6;
		`);
		protectDbFiles(dbPath);
		cachedDb = db;
		// No eviction on open: the default hard TTL is a coarse
		// backstop that runs before user settings load, so applying it here
		// would nuke rows still valid under a stricter-or-laxer configured
		// `github.cache.hardTtlSec`. The per-lookup `sweepIfDue()` in
		// `getOrFetchView()` enforces the *configured* retention instead.
		return db;
	} catch (err) {
		logger.warn("github cache: failed to open DB; cache disabled", { err: String(err) });
		return null;
	}
}

function evictExpired(db: Database, hardTtlMs: number): void {
	try {
		const cutoff = Date.now() - hardTtlMs;
		db.query("DELETE FROM github_view_cache WHERE fetched_at < ?").run(cutoff);
		db.query("DELETE FROM github_view_cache_generation WHERE retained_at < ?").run(cutoff);
		db.query("DELETE FROM github_forge_index WHERE fetched_at < ?").run(cutoff);
	} catch (err) {
		logger.debug("github cache: eviction failed", { err: String(err) });
	}
}

/**
 * Throttle for the per-lookup configured-TTL sweep. We don't want every
 * cached read to issue a DELETE; once per `SWEEP_INTERVAL_MS` is enough to
 * cap the on-disk exposure window at roughly `hardTtlMs + SWEEP_INTERVAL_MS`.
 */
const SWEEP_INTERVAL_MS = 60_000;
let lastSweepAt = 0;

function sweepIfDue(hardTtlMs: number): void {
	const now = Date.now();
	if (now - lastSweepAt < SWEEP_INTERVAL_MS) return;
	const db = openDb();
	if (!db) return;
	lastSweepAt = now;
	evictExpired(db, hardTtlMs);
}

function getGhConfigDir(): string {
	const override = process.env.GH_CONFIG_DIR;
	if (override) return override;
	const xdg = process.env.XDG_CONFIG_HOME;
	if (xdg) return path.join(xdg, "gh");
	return path.join(os.homedir(), ".config", "gh");
}

function hashCacheIdentity(parts: string[]): string {
	return Bun.hash(parts.map(part => `${part.length}:${part}`).join("|")).toString(36);
}

/**
 * glab config file, following glab's search order: `GLAB_CONFIG_DIR` wins
 * outright; otherwise the legacy `~/.config/glab-cli` path, then the
 * XDG/platform config dir. Returns the first existing candidate, else the first.
 */
export function getGlabConfigPath(): string {
	const override = process.env.GLAB_CONFIG_DIR;
	if (override) return path.join(override, "config.yml");
	const home = os.homedir();
	const candidates = [path.join(home, ".config", "glab-cli", "config.yml")];
	const xdg = process.env.XDG_CONFIG_HOME;
	if (xdg) {
		candidates.push(path.join(xdg, "glab-cli", "config.yml"));
	} else if (process.platform === "darwin") {
		candidates.push(path.join(home, "Library", "Application Support", "glab-cli", "config.yml"));
	} else if (process.platform === "win32") {
		const localAppData = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
		candidates.push(path.join(localAppData, "glab-cli", "config.yml"));
	}
	for (const candidate of candidates) {
		try {
			if (fs.statSync(candidate, { throwIfNoEntry: false })) return candidate;
		} catch (err) {
			logger.debug("github cache: failed to stat glab config candidate", { err: String(err), path: candidate });
		}
	}
	return candidates[0]!;
}

/**
 * Memo for {@link resolveCliCacheAuthKey}. Recomputed only when the token
 * env vars or the config path/mtime change, so the per-lookup cost on the
 * cache hot path is a few env reads plus one `stat` instead of a full file
 * read + hash.
 */
interface AuthKeyMemoEntry {
	envSig: string;
	configPath: string;
	configMtimeMs: number;
	value: string | undefined;
}
const AUTH_KEY_TOKEN_ENV_VARS = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];
/** Env vars glab reads tokens from; they apply to every host glab talks to. */
export const GITLAB_TOKEN_ENV_VARS = ["GITLAB_TOKEN", "GITLAB_ACCESS_TOKEN", "OAUTH_TOKEN"];
const authKeyMemo = new Map<string, AuthKeyMemoEntry>();

function resolveCliCacheAuthKey(
	memoKey: string,
	host: string,
	tokenEnvVars: readonly string[],
	configPath: string,
	configLabel: string,
): string | undefined {
	let envSig = "";
	for (const name of tokenEnvVars) {
		const value = process.env[name];
		if (value) envSig += `${name}=${value.length}:${value}\0`;
	}
	let configMtimeMs = -1;
	try {
		configMtimeMs = fs.statSync(configPath, { throwIfNoEntry: false })?.mtimeMs ?? -1;
	} catch (err) {
		logger.debug("github cache: failed to stat CLI config for cache identity", { err: String(err) });
	}
	const memo = authKeyMemo.get(memoKey);
	if (memo && memo.envSig === envSig && memo.configPath === configPath && memo.configMtimeMs === configMtimeMs) {
		return memo.value;
	}

	const parts: string[] = [`host:${host}`];
	let hasCredentialMaterial = false;
	for (const name of tokenEnvVars) {
		const value = process.env[name];
		if (!value) continue;
		hasCredentialMaterial = true;
		parts.push(`${name}:${value}`);
	}
	try {
		const contents = fs.readFileSync(configPath, "utf8");
		hasCredentialMaterial = true;
		parts.push(`${configLabel}:${contents}`);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			logger.debug("github cache: failed to read CLI config for cache identity", { err: String(err) });
		}
	}
	const value = hasCredentialMaterial ? `${host}:${hashCacheIdentity(parts)}` : undefined;
	authKeyMemo.set(memoKey, { envSig, configPath, configMtimeMs, value });
	return value;
}

/**
 * Best-effort local fingerprint for the active GitHub CLI credentials.
 *
 * Cache hits must not cross account/token boundaries, but doing a `gh api user`
 * probe before every cached read would defeat the soft-TTL contract that cache
 * hits avoid a gh round-trip. Instead, key rows by credential material that the
 * GitHub CLI itself consumes: token environment variables and/or hosts.yml.
 * The DB stores only a hash, never the token or hosts.yml contents. If no
 * credential source is visible, callers should pass `null` to bypass caching.
 */
export function resolveGithubCacheAuthKey(host: string = defaultGhHost()): string | undefined {
	return resolveCliCacheAuthKey(
		`github:${host}`,
		host,
		AUTH_KEY_TOKEN_ENV_VARS,
		path.join(getGhConfigDir(), "hosts.yml"),
		"hosts",
	);
}

/** GitLab counterpart of {@link resolveGithubCacheAuthKey}: glab token env vars and/or glab's config.yml. */
export function resolveGitlabCacheAuthKey(host: string): string | undefined {
	return resolveCliCacheAuthKey(`gitlab:${host}`, host, GITLAB_TOKEN_ENV_VARS, getGlabConfigPath(), "glab-config");
}

/**
 * Row identity for a repo, relative to the host `gh` defaults to. A prefix
 * naming that same host is dropped so `github.com/owner/repo` and `owner/repo`
 * share one row — but under `GH_HOST` the bare form means the configured
 * instance, so an explicit `github.com/` prefix then stays and keeps its own
 * rows instead of answering with another host's issue.
 */
function normalizeRepo(repo: string, kind?: CacheKind): string {
	const lower = repo.toLowerCase();
	if (kind === "mr" || kind === "mr-diff" || kind === "gl-issue") return lower;
	const ref = parseRepoRef(lower);
	return ref.host && ref.host !== defaultGhHost() ? `${ref.host}/${ref.slug}` : ref.slug;
}

export function getCached<T = unknown>(
	repo: string,
	kind: CacheKind,
	number: number,
	includeComments: boolean,
	authKey: string = DEFAULT_CACHE_AUTH_KEY,
): CachedView<T> | null {
	const db = openDb();
	if (!db) return null;
	try {
		const row = db
			.query(
				"SELECT auth_key, repo, kind, number, include_comments, fetched_at, payload, rendered, source_url, revision FROM github_view_cache WHERE auth_key = ? AND repo = ? AND kind = ? AND number = ? AND include_comments = ?",
			)
			.get(authKey, normalizeRepo(repo, kind), kind, number, includeComments ? 1 : 0) as Row | undefined;
		if (!row) return null;
		let payload: T;
		try {
			payload = JSON.parse(row.payload) as T;
		} catch (err) {
			logger.debug("github cache: corrupt payload row, ignoring", { err: String(err), repo, kind, number });
			return null;
		}
		return {
			authKey: row.auth_key,
			repo: row.repo,
			kind: row.kind,
			number: row.number,
			includeComments: row.include_comments === 1,
			fetchedAt: row.fetched_at,
			payload,
			rendered: row.rendered,
			sourceUrl: row.source_url ?? undefined,
			revision: row.revision ?? undefined,
		};
	} catch (err) {
		logger.debug("github cache: read failed", { err: String(err) });
		return null;
	}
}

export interface PutCachedInput<T = unknown> {
	authKey?: string;
	repo: string;
	kind: CacheKind;
	number: number;
	includeComments: boolean;
	payload: T;
	rendered: string;
	sourceUrl?: string;
	revision?: string;
	fetchedAt?: number;
}

/** Caps a pathological run of distinct snapshots claiming the same millisecond. */
const MAX_GENERATION_ID_STEPS = 1000;

function isSqliteConstraint(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	const code = (err as { code?: string }).code;
	return (
		code === "SQLITE_CONSTRAINT_PRIMARYKEY" ||
		code === "SQLITE_CONSTRAINT" ||
		err.message.includes("UNIQUE constraint failed")
	);
}

/**
 * Keep one immutable pr-diff generation. The live row is still one-per-PR and
 * a background refresh replaces it; review URLs address this copy by `fetchedAt`
 * so that refresh cannot retarget a file index. Does not write the live row.
 *
 * A published id is never overwritten. Storing the same snapshot again returns
 * its existing id and restarts its retention clock. A different snapshot that
 * lands on the same millisecond gets the next free id, which the caller must
 * publish. Retention runs from `retained_at` (when `/review` saved it), not from
 * `fetched_at`, so a stale live row pinned by `/review` keeps its full hard TTL.
 * Returns that id, or null when the database is unavailable.
 */
export function retainCachedGeneration<T = unknown>(input: PutCachedInput<T>): number | null {
	const db = openDb();
	if (!db) return null;
	const authKey = input.authKey ?? DEFAULT_CACHE_AUTH_KEY;
	const repo = normalizeRepo(input.repo, input.kind);
	const includeComments = input.includeComments ? 1 : 0;
	const payloadJson = JSON.stringify(input.payload);
	let fetchedAt = input.fetchedAt ?? Date.now();
	const retainedAt = Date.now();
	try {
		for (let step = 0; step < MAX_GENERATION_ID_STEPS; step++) {
			const existing = db
				.query(
					"SELECT (payload = ? AND rendered = ?) AS same FROM github_view_cache_generation WHERE auth_key = ? AND repo = ? AND kind = ? AND number = ? AND include_comments = ? AND fetched_at = ?",
				)
				.get(payloadJson, input.rendered, authKey, repo, input.kind, input.number, includeComments, fetchedAt) as
				| { same: number }
				| undefined;
			if (existing?.same === 1) {
				db.query(
					"UPDATE github_view_cache_generation SET retained_at = ? WHERE auth_key = ? AND repo = ? AND kind = ? AND number = ? AND include_comments = ? AND fetched_at = ?",
				).run(retainedAt, authKey, repo, input.kind, input.number, includeComments, fetchedAt);
				return fetchedAt;
			}
			if (existing) {
				fetchedAt += 1;
				continue;
			}
			try {
				db.query(
					"INSERT INTO github_view_cache_generation (auth_key, repo, kind, number, include_comments, fetched_at, retained_at, payload, rendered, source_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				).run(
					authKey,
					repo,
					input.kind,
					input.number,
					includeComments,
					fetchedAt,
					retainedAt,
					payloadJson,
					input.rendered,
					input.sourceUrl ?? null,
				);
				protectDbFiles(getGithubCacheDbPath());
				return fetchedAt;
			} catch (err) {
				if (!isSqliteConstraint(err)) throw err;
				fetchedAt += 1;
			}
		}
		logger.debug("github cache: generation id retries exhausted", {
			repo,
			kind: input.kind,
			number: input.number,
		});
		return null;
	} catch (err) {
		logger.debug("github cache: generation write failed", { err: String(err) });
		return null;
	}
}

/** A generation stored by {@link retainCachedGeneration}, with the time it was saved. */
export interface CachedGeneration<T = unknown> extends CachedView<T> {
	retainedAt: number;
}

/** Read a pr-diff generation stored by {@link retainCachedGeneration}. */
export function getCachedGeneration<T = unknown>(
	repo: string,
	kind: CacheKind,
	number: number,
	includeComments: boolean,
	fetchedAt: number,
	authKey: string = DEFAULT_CACHE_AUTH_KEY,
): CachedGeneration<T> | null {
	const db = openDb();
	if (!db) return null;
	try {
		const row = db
			.query(
				"SELECT auth_key, repo, kind, number, include_comments, fetched_at, retained_at, payload, rendered, source_url FROM github_view_cache_generation WHERE auth_key = ? AND repo = ? AND kind = ? AND number = ? AND include_comments = ? AND fetched_at = ?",
			)
			.get(authKey, normalizeRepo(repo, kind), kind, number, includeComments ? 1 : 0, fetchedAt) as
			| (Row & { retained_at: number })
			| undefined;
		if (!row) return null;
		let payload: T;
		try {
			payload = JSON.parse(row.payload) as T;
		} catch (err) {
			logger.debug("github cache: corrupt generation row, ignoring", { err: String(err), repo, kind, number });
			return null;
		}
		return {
			authKey: row.auth_key,
			repo: row.repo,
			kind: row.kind,
			number: row.number,
			includeComments: row.include_comments === 1,
			fetchedAt: row.fetched_at,
			retainedAt: row.retained_at,
			payload,
			rendered: row.rendered,
			sourceUrl: row.source_url ?? undefined,
		};
	} catch (err) {
		logger.debug("github cache: generation read failed", { err: String(err) });
		return null;
	}
}

function deleteCachedGeneration(
	repo: string,
	kind: CacheKind,
	number: number,
	includeComments: boolean,
	fetchedAt: number,
	authKey: string,
): void {
	const db = openDb();
	if (!db) return;
	try {
		db.query(
			"DELETE FROM github_view_cache_generation WHERE auth_key = ? AND repo = ? AND kind = ? AND number = ? AND include_comments = ? AND fetched_at = ?",
		).run(authKey, normalizeRepo(repo, kind), kind, number, includeComments ? 1 : 0, fetchedAt);
	} catch (err) {
		logger.debug("github cache: generation delete failed", { err: String(err) });
	}
}

/**
 * Read one immutable generation, enforcing the cache kill switch and hard TTL
 * (measured from when the generation was retained). An expired generation is
 * deleted. Does not read or refresh the live row.
 */
export function getRetainedGeneration<T = unknown>(
	repo: string,
	kind: CacheKind,
	number: number,
	includeComments: boolean,
	fetchedAt: number,
	authKey: string = DEFAULT_CACHE_AUTH_KEY,
	settings?: Settings,
): CachedGeneration<T> | null {
	const ttl = resolveCacheTtl(settings);
	// Pinned-only sessions never enter `getOrFetchView`, so the sweep has to
	// run here too. Disabled lookups sweep as well; they just refuse the read.
	sweepIfDue(ttl.hardMs);
	if (!ttl.enabled) return null;
	const row = getCachedGeneration<T>(repo, kind, number, includeComments, fetchedAt, authKey);
	if (!row) return null;
	if (Date.now() - row.retainedAt > ttl.hardMs) {
		deleteCachedGeneration(repo, kind, number, includeComments, fetchedAt, authKey);
		return null;
	}
	return row;
}

export interface ForgeIndexEntry {
	readonly kind: "pr" | "issue";
	readonly number: number;
	readonly title: string;
	readonly state: string;
	readonly author: string;
	readonly updatedAt: string;
	readonly fetchedAt: number;
}

interface ForgeIndexRow {
	kind: "pr" | "issue";
	number: number;
	title: string;
	state: string;
	author: string;
	updated_at: string;
	fetched_at: number;
}

const FORGE_INDEX_READ_LIMIT = 200;

function extractForgeIndexSummary(
	kind: CacheKind,
	number: number,
	payload: unknown,
): Omit<ForgeIndexEntry, "fetchedAt"> | null {
	if (kind !== "pr" && kind !== "issue") return null;
	if (payload === null || typeof payload !== "object") return null;
	const record = payload as Record<string, unknown>;
	if (typeof record.title !== "string") return null;
	const state = typeof record.state === "string" ? record.state : "";
	let author = "";
	if (typeof record.author === "string") {
		author = record.author;
	} else if (record.author !== null && typeof record.author === "object") {
		const login = (record.author as Record<string, unknown>).login;
		if (typeof login === "string") author = login;
	}
	const updatedAt =
		typeof record.updatedAt === "string"
			? record.updatedAt
			: typeof record.updated_at === "string"
				? record.updated_at
				: "";
	return { kind, number, title: record.title, state, author, updatedAt };
}

function upsertForgeIndexRows(
	db: Database,
	authKey: string,
	normalizedRepo: string,
	entries: readonly Omit<ForgeIndexEntry, "fetchedAt">[],
	fetchedAt: number,
): void {
	const stmt = db.query(
		"INSERT OR REPLACE INTO github_forge_index (auth_key, repo, kind, number, title, state, author, updated_at, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
	);
	const writeAll = db.transaction((items: readonly Omit<ForgeIndexEntry, "fetchedAt">[]) => {
		for (const entry of items) {
			stmt.run(
				authKey,
				normalizedRepo,
				entry.kind,
				entry.number,
				entry.title,
				entry.state,
				entry.author,
				entry.updatedAt,
				fetchedAt,
			);
		}
	});
	writeAll(entries);
}

/**
 * Synchronously read cached PR/issue summaries for autocomplete (ordered newest-updated first).
 * Returns `[]` when `authKey === null` or the SQLite cache is unavailable.
 */
export function readForgeIndexSync(repo: string, authKey?: string | null): ForgeIndexEntry[] {
	if (authKey === null) return [];
	const db = openDb();
	if (!db) return [];
	try {
		const resolvedAuthKey = authKey ?? DEFAULT_CACHE_AUTH_KEY;
		const rows = db
			.query(
				"SELECT kind, number, title, state, author, updated_at, fetched_at FROM github_forge_index WHERE auth_key = ? AND repo = ? ORDER BY updated_at DESC, number DESC LIMIT ?",
			)
			.all(resolvedAuthKey, normalizeRepo(repo), FORGE_INDEX_READ_LIMIT) as ForgeIndexRow[];
		return rows.map(row => ({
			kind: row.kind,
			number: row.number,
			title: row.title,
			state: row.state,
			author: row.author,
			updatedAt: row.updated_at,
			fetchedAt: row.fetched_at,
		}));
	} catch (err) {
		logger.debug("github cache: forge index read failed", { err: String(err) });
		return [];
	}
}

/**
 * Synchronously read the latest `fetched_at` timestamp for a repo's forge index,
 * or `null` when empty, unavailable, or `authKey === null`.
 */
export function getForgeIndexFreshnessSync(repo: string, authKey?: string | null): number | null {
	if (authKey === null) return null;
	const db = openDb();
	if (!db) return null;
	try {
		const resolvedAuthKey = authKey ?? DEFAULT_CACHE_AUTH_KEY;
		const row = db
			.query("SELECT MAX(fetched_at) AS latest FROM github_forge_index WHERE auth_key = ? AND repo = ?")
			.get(resolvedAuthKey, normalizeRepo(repo)) as { latest: number | null } | undefined;
		return typeof row?.latest === "number" ? row.latest : null;
	} catch (err) {
		logger.debug("github cache: forge index freshness read failed", { err: String(err) });
		return null;
	}
}

/**
 * Transactionally upsert PR/issue summaries into `github_forge_index`.
 * No-op when `authKey === null`, `entries` is empty, or the DB is unavailable.
 */
export function upsertForgeIndex(
	repo: string,
	entries: readonly Omit<ForgeIndexEntry, "fetchedAt">[],
	authKey?: string | null,
): void {
	if (authKey === null || entries.length === 0) return;
	const db = openDb();
	if (!db) return;
	try {
		const resolvedAuthKey = authKey ?? DEFAULT_CACHE_AUTH_KEY;
		upsertForgeIndexRows(db, resolvedAuthKey, normalizeRepo(repo), entries, Date.now());
		protectDbFiles(getGithubCacheDbPath());
	} catch (err) {
		logger.debug("github cache: forge index write failed", { err: String(err) });
	}
}

export function putCached<T = unknown>(input: PutCachedInput<T>): void {
	const db = openDb();
	if (!db) return;
	try {
		const authKey = input.authKey ?? DEFAULT_CACHE_AUTH_KEY;
		const normalizedRepo = normalizeRepo(input.repo, input.kind);
		const fetchedAt = input.fetchedAt ?? Date.now();
		const payloadJson = JSON.stringify(input.payload);
		db.query(
			"INSERT OR REPLACE INTO github_view_cache (auth_key, repo, kind, number, include_comments, fetched_at, payload, rendered, source_url, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		).run(
			authKey,
			normalizedRepo,
			input.kind,
			input.number,
			input.includeComments ? 1 : 0,
			fetchedAt,
			payloadJson,
			input.rendered,
			input.sourceUrl ?? null,
			input.revision ?? null,
		);
		const summary = extractForgeIndexSummary(input.kind, input.number, input.payload);
		if (summary) {
			upsertForgeIndexRows(db, authKey, normalizedRepo, [summary], fetchedAt);
		}
		protectDbFiles(getGithubCacheDbPath());
	} catch (err) {
		logger.debug("github cache: write failed", { err: String(err) });
	}
}

/** Drop a specific cache entry. */
export function invalidate(
	repo: string,
	kind: CacheKind,
	number: number,
	includeComments?: boolean,
	authKey: string = DEFAULT_CACHE_AUTH_KEY,
): void {
	invalidationEpoch++;
	const db = openDb();
	if (!db) return;
	try {
		if (includeComments === undefined) {
			db.query("DELETE FROM github_view_cache WHERE auth_key = ? AND repo = ? AND kind = ? AND number = ?").run(
				authKey,
				normalizeRepo(repo, kind),
				kind,
				number,
			);
		} else {
			db.query(
				"DELETE FROM github_view_cache WHERE auth_key = ? AND repo = ? AND kind = ? AND number = ? AND include_comments = ?",
			).run(authKey, normalizeRepo(repo, kind), kind, number, includeComments ? 1 : 0);
		}
	} catch (err) {
		logger.debug("github cache: invalidate failed", { err: String(err) });
	}
}

/**
 * Drop every cached row for a given issue/PR number, regardless of repo,
 * auth key, include_comments flag, or row kind ({@link CacheKind}). Best-effort:
 * swallows DB failures the same way {@link invalidate} does.
 *
 * Used by the bash-side detector that reacts to `gh issue close` / `gh pr merge`
 * style mutations. Repo + auth-key narrowing is intentionally skipped because
 * the bash command often does not name the repo (defaults to cwd's `gh`
 * config) and resolving the *current* repo from `cwd` for every bash call would
 * be far more expensive than a write-amplified DELETE.
 */
export function invalidateAllForNumber(number: number, repo?: string): void {
	invalidationEpoch++;
	const db = openDb();
	if (!db) return;
	try {
		if (repo === undefined) {
			db.query("DELETE FROM github_view_cache WHERE number = ?").run(number);
		} else {
			const ghRepo = normalizeRepo(repo);
			const glRepo = normalizeRepo(repo, "mr");
			if (ghRepo === glRepo) {
				db.query("DELETE FROM github_view_cache WHERE number = ? AND repo = ?").run(number, ghRepo);
			} else {
				db.query("DELETE FROM github_view_cache WHERE number = ? AND repo IN (?, ?)").run(number, ghRepo, glRepo);
			}
		}
	} catch (err) {
		logger.debug("github cache: invalidateAllForNumber failed", { err: String(err) });
	}
}

/** Drop every cached row. Test helper. */
export function clearAll(): void {
	invalidationEpoch++;
	const db = openDb();
	if (!db) return;
	try {
		db.query("DELETE FROM github_view_cache").run();
		db.query("DELETE FROM github_view_cache_generation").run();
		db.query("DELETE FROM github_forge_index").run();
	} catch (err) {
		logger.debug("github cache: clear failed", { err: String(err) });
	}
}

/**
 * Drop every cached row for a repo, or all rows when the repo is unknown.
 * Fallback for current-branch `gh pr merge`/`gh pr close`-style mutations
 * where the bash command names no PR number or URL, so the target row cannot
 * be identified. Over-invalidation is deliberate (see module header).
 */
export function invalidateAllForRepo(repo?: string): void {
	invalidationEpoch++;
	const db = openDb();
	if (!db) return;
	try {
		if (repo === undefined) {
			db.query("DELETE FROM github_view_cache").run();
			db.query("DELETE FROM github_forge_index").run();
		} else {
			const ghRepo = normalizeRepo(repo);
			const glRepo = normalizeRepo(repo, "mr");
			if (ghRepo === glRepo) {
				db.query("DELETE FROM github_view_cache WHERE repo = ?").run(ghRepo);
			} else {
				db.query("DELETE FROM github_view_cache WHERE repo IN (?, ?)").run(ghRepo, glRepo);
			}
			db.query("DELETE FROM github_forge_index WHERE repo = ?").run(ghRepo);
		}
	} catch (err) {
		logger.debug("github cache: invalidateAllForRepo failed", { err: String(err) });
	}
}

/** Drop live PR rows after a push, leaving issues and retained snapshots alone. */
export function invalidatePullRequestsForRepo(repo: string): void {
	invalidationEpoch++;
	const ghRepo = normalizeRepo(repo);
	const glRepo = normalizeRepo(repo, "mr");
	const db = openDb();
	if (!db) return;
	try {
		if (ghRepo === glRepo) {
			db.query("DELETE FROM github_view_cache WHERE repo = ? AND kind IN ('pr', 'pr-diff', 'mr', 'mr-diff')").run(
				ghRepo,
			);
		} else {
			db.query(
				"DELETE FROM github_view_cache WHERE (repo = ? AND kind IN ('pr', 'pr-diff')) OR (repo = ? AND kind IN ('mr', 'mr-diff'))",
			).run(ghRepo, glRepo);
		}
		db.query("DELETE FROM github_forge_index WHERE repo = ? AND kind = 'pr'").run(ghRepo);
	} catch (err) {
		logger.debug("github cache: invalidatePullRequestsForRepo failed", { err: String(err) });
	}
}

/**
 * Test/maintenance helper. Closes and forgets the cached connection so the
 * next access reopens against (possibly) a different DB path.
 */
export function resetForTests(): void {
	invalidationEpoch++;
	if (cachedDb) {
		try {
			cachedDb.close();
		} catch {
			// Closing failures are non-fatal.
		}
	}
	cachedDb = null;
	openAttempted = false;
	lastSweepAt = 0;
	authKeyMemo.clear();
}

// ────────────────────────────────────────────────────────────────────────────
// Cache-aware lookup wrapper
// ────────────────────────────────────────────────────────────────────────────

export interface FreshResult<T> {
	rendered: string;
	sourceUrl: string | undefined;
	payload: T;
}

export interface CacheLookupOptions<T> {
	repo: string;
	kind: CacheKind;
	number: number;
	includeComments: boolean;
	/**
	 * Auth/credential namespace for cache rows. Omit only in storage-layer
	 * tests; pass `null` when production code cannot determine an identity and
	 * must bypass persistent cache reads/writes.
	 */
	authKey?: string | null;
	fetchFresh: () => Promise<FreshResult<T>>;
	/** Live key identifying both the base and head revisions of a diff. */
	fetchRevision?: () => Promise<string | undefined>;
	settings?: Settings | undefined;
	now?: number;
}

export type CacheStatus = "miss" | "fresh" | "refreshed" | "stale" | "disabled";

export interface CacheLookupResult<T> {
	rendered: string;
	sourceUrl: string | undefined;
	payload: T;
	status: CacheStatus;
	fetchedAt: number;
}

export interface CacheTtl {
	softMs: number;
	hardMs: number;
	enabled: boolean;
}

export function resolveCacheTtl(settings?: Settings): CacheTtl {
	if (!settings) {
		return {
			softMs: cfgGithubCacheSoftTtlSec.default * 1000,
			hardMs: cfgGithubCacheHardTtlSec.default * 1000,
			enabled: cfgGithubCacheEnabled.default,
		};
	}
	return {
		softMs: Math.max(0, cfgGithubCacheSoftTtlSec.get(settings)) * 1000,
		hardMs: Math.max(0, cfgGithubCacheHardTtlSec.get(settings)) * 1000,
		enabled: cfgGithubCacheEnabled.get(settings),
	};
}

async function fetchAndStore<T>(
	options: CacheLookupOptions<T>,
	authKey: string,
	status: "miss" | "refreshed",
	revision?: string,
): Promise<CacheLookupResult<T>> {
	const epoch = invalidationEpoch;
	const fresh = await options.fetchFresh();
	const fetchedAt = Date.now();
	// The revision must bracket the separately fetched patch before it can be
	// reused or pinned as the current review snapshot.
	if (revision !== undefined && (await options.fetchRevision?.()) !== revision) {
		throw new Error("Diff revision changed while fetching; try again.");
	}
	if (epoch === invalidationEpoch) {
		putCached({
			authKey,
			repo: options.repo,
			kind: options.kind,
			number: options.number,
			includeComments: options.includeComments,
			payload: fresh.payload,
			rendered: fresh.rendered,
			sourceUrl: fresh.sourceUrl,
			fetchedAt,
			revision,
		});
	}
	return { ...fresh, status, fetchedAt };
}

/**
 * How long a cached issue or PR that was still open stays fresh. It can be merged, closed or reopened at any
 * moment (often by the agent itself, outside this tool), so it is revalidated well before the configured soft TTL.
 */
const OPEN_STATE_SOFT_TTL_MS = 15_000;

/** Whether `payload` is an open issue/PR view, whose state can still change. */
function isOpenView(kind: CacheKind, payload: unknown): boolean {
	const state = payload !== null && typeof payload === "object" && "state" in payload ? payload.state : undefined;
	if (typeof state !== "string") return false;
	if (kind === "issue" || kind === "pr") return state.toUpperCase() === "OPEN";
	if (kind === "mr" || kind === "gl-issue") return state.toLowerCase() === "opened";
	return false;
}

export async function getOrFetchView<T>(options: CacheLookupOptions<T>): Promise<CacheLookupResult<T>> {
	const ttl = resolveCacheTtl(options.settings);
	const now = options.now ?? Date.now();
	const authKey = options.authKey === undefined ? DEFAULT_CACHE_AUTH_KEY : options.authKey;

	if (!ttl.enabled || authKey === null) {
		const fresh = await options.fetchFresh();
		return { ...fresh, status: "disabled", fetchedAt: now };
	}

	// Enforce the *configured* hard TTL against on-disk rows. This is what
	// makes `github.cache.hardTtlSec` a real retention cap rather than a soft
	// suggestion the next `openDb()` call eventually honors.
	sweepIfDue(ttl.hardMs);

	const isDiff = options.kind === "pr-diff" || options.kind === "mr-diff";
	if (isDiff && options.fetchRevision) {
		const revision = await options.fetchRevision();
		if (revision === undefined) {
			const fresh = await options.fetchFresh();
			return { ...fresh, status: "miss", fetchedAt: Date.now() };
		}

		const cached = getCached<T>(options.repo, options.kind, options.number, options.includeComments, authKey);
		if (cached) {
			const age = (options.now ?? Date.now()) - cached.fetchedAt;
			if (age > ttl.hardMs) {
				invalidate(options.repo, options.kind, options.number, options.includeComments, authKey);
				return fetchAndStore(options, authKey, "miss", revision);
			}
			if (cached.revision === revision) {
				return {
					rendered: cached.rendered,
					sourceUrl: cached.sourceUrl,
					payload: cached.payload,
					status: "fresh",
					fetchedAt: cached.fetchedAt,
				};
			}
			return fetchAndStore(options, authKey, "refreshed", revision);
		}
		return fetchAndStore(options, authKey, "miss", revision);
	}

	const cached: CachedView<T> | null = getCached<T>(
		options.repo,
		options.kind,
		options.number,
		options.includeComments,
		authKey,
	);

	if (cached) {
		const age = now - cached.fetchedAt;
		const softMs = isOpenView(options.kind, cached.payload)
			? Math.min(ttl.softMs, OPEN_STATE_SOFT_TTL_MS)
			: ttl.softMs;
		if (age > ttl.hardMs) {
			// Past hard TTL: drop the row eagerly so the on-disk exposure window
			// is bounded even if `fetchFresh()` then fails (network down, gh
			// auth lapse, etc.) and we never get to overwrite it.
			invalidate(options.repo, options.kind, options.number, options.includeComments, authKey);
		} else if (age <= softMs) {
			return {
				rendered: cached.rendered,
				sourceUrl: cached.sourceUrl,
				payload: cached.payload,
				status: "fresh",
				fetchedAt: cached.fetchedAt,
			};
		} else {
			try {
				return await fetchAndStore(options, authKey, "refreshed");
			} catch (err) {
				if (err instanceof ToolAbortError) throw err;
				logger.debug("github cache: synchronous refresh failed; returning stale view", {
					err: String(err),
					repo: options.repo,
					kind: options.kind,
					number: options.number,
				});
				return {
					rendered: cached.rendered,
					sourceUrl: cached.sourceUrl,
					payload: cached.payload,
					status: "stale",
					fetchedAt: cached.fetchedAt,
				};
			}
		}
	}

	return fetchAndStore(options, authKey, "miss");
}

/**
 * Human-friendly freshness note for protocol-handler `notes[]` rendering.
 */
export function formatFreshnessNote(status: CacheStatus, fetchedAtMs: number, now: number = Date.now()): string {
	if (status === "miss" || status === "refreshed") return "Fetched live";
	if (status === "disabled") return "Cache disabled; fetched live";
	const ageSec = Math.max(0, Math.round((now - fetchedAtMs) / 1000));
	const human =
		ageSec < 60
			? `${ageSec}s ago`
			: ageSec < 3600
				? `${Math.round(ageSec / 60)}m ago`
				: `${Math.round(ageSec / 3600)}h ago`;
	if (status === "stale") return `WARNING: showing cached content from ${human}; live refresh failed`;
	return `Cached: ${human}`;
}
