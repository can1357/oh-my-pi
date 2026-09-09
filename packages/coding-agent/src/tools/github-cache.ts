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
 *   Soft TTL → return cached row directly.
 *   Stateful issue/PR rows past soft TTL but within hard TTL → refresh
 *     synchronously, falling back to the cached row if the live fetch fails.
 *   Expensive PR diff rows past soft TTL but within hard TTL → return cached
 *     row AND schedule a background refresh (errors logged, never thrown).
 *   Past hard TTL → treat as miss and fetch fresh.
 */

import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getGithubCacheDbPath, logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import { defaultGhHost, parseRepoRef } from "./gh-common";
import { ToolAbortError } from "./tool-errors";

// ────────────────────────────────────────────────────────────────────────────
// Storage layer
// ────────────────────────────────────────────────────────────────────────────

export type CacheKind = "issue" | "pr" | "pr-diff";

const DEFAULT_CACHE_AUTH_KEY = "default";

export interface CachedView<T = unknown> {
	authKey: string;
	repo: string;
	kind: CacheKind;
	number: number;
	includeComments: boolean;
	fetchedAt: number;
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
}

const DEFAULT_SOFT_TTL_SEC = 300; // 5 minutes
const DEFAULT_HARD_TTL_SEC = 60 * 60 * 24 * 7; // 7 days

let cachedDb: Database | null = null;
let openAttempted = false;

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
		// Migrate any pre-existing table whose key/check constraint predates
		// the current schema. The cache is regenerable, so we drop rows rather
		// than running an in-place ALTER dance.
		const userVersion = (db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined)
			?.user_version;
		if (userVersion !== undefined && userVersion < 3) {
			db.run("DROP TABLE IF EXISTS github_view_cache");
		}
		db.run(`
			CREATE TABLE IF NOT EXISTS github_view_cache (
				auth_key        TEXT    NOT NULL,
				repo             TEXT    NOT NULL,
				kind             TEXT    NOT NULL CHECK (kind IN ('issue','pr','pr-diff')),
				number           INTEGER NOT NULL,
				include_comments INTEGER NOT NULL,
				fetched_at       INTEGER NOT NULL,
				payload          TEXT    NOT NULL,
				rendered         TEXT    NOT NULL,
				source_url       TEXT,
				PRIMARY KEY (auth_key, repo, kind, number, include_comments)
			);
			CREATE INDEX IF NOT EXISTS idx_github_view_cache_fetched ON github_view_cache(fetched_at);
			PRAGMA user_version = 3;
		`);
		protectDbFiles(dbPath);
		cachedDb = db;
		// No eviction on open: the default `DEFAULT_HARD_TTL_SEC` is a coarse
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
		db.prepare("DELETE FROM github_view_cache WHERE fetched_at < ?").run(cutoff);
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
 * Memo for {@link resolveGithubCacheAuthKey}. Recomputed only when the token
 * env vars or the hosts.yml path/mtime change, so the per-lookup cost on the
 * cache hot path is four env reads plus one `stat` instead of a full file
 * read + hash.
 */
interface AuthKeyMemoEntry {
	envSig: string;
	hostsPath: string;
	hostsMtimeMs: number;
	value: string | undefined;
}
const AUTH_KEY_TOKEN_ENV_VARS = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];
const authKeyMemo = new Map<string, AuthKeyMemoEntry>();

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
	const hostsPath = path.join(getGhConfigDir(), "hosts.yml");
	let envSig = "";
	for (const name of AUTH_KEY_TOKEN_ENV_VARS) {
		const value = process.env[name];
		if (value) envSig += `${name}=${value.length}:${value}\0`;
	}
	let hostsMtimeMs = -1;
	try {
		hostsMtimeMs = fs.statSync(hostsPath, { throwIfNoEntry: false })?.mtimeMs ?? -1;
	} catch (err) {
		logger.debug("github cache: failed to stat gh hosts config for cache identity", { err: String(err) });
	}
	const memo = authKeyMemo.get(host);
	if (memo && memo.envSig === envSig && memo.hostsPath === hostsPath && memo.hostsMtimeMs === hostsMtimeMs) {
		return memo.value;
	}

	const parts: string[] = [`host:${host}`];
	let hasCredentialMaterial = false;
	for (const name of AUTH_KEY_TOKEN_ENV_VARS) {
		const value = process.env[name];
		if (!value) continue;
		hasCredentialMaterial = true;
		parts.push(`${name}:${value}`);
	}
	try {
		const hosts = fs.readFileSync(hostsPath, "utf8");
		hasCredentialMaterial = true;
		parts.push(`hosts:${hosts}`);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			logger.debug("github cache: failed to read gh hosts config for cache identity", { err: String(err) });
		}
	}
	const value = hasCredentialMaterial ? `${host}:${hashCacheIdentity(parts)}` : undefined;
	authKeyMemo.set(host, { envSig, hostsPath, hostsMtimeMs, value });
	return value;
}

/**
 * Row identity for a repo, relative to the host `gh` defaults to. A prefix
 * naming that same host is dropped so `github.com/owner/repo` and `owner/repo`
 * share one row — but under `GH_HOST` the bare form means the configured
 * instance, so an explicit `github.com/` prefix then stays and keeps its own
 * rows instead of answering with another host's issue.
 */
function normalizeRepo(repo: string): string {
	const ref = parseRepoRef(repo.toLowerCase());
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
			.prepare(
				"SELECT auth_key, repo, kind, number, include_comments, fetched_at, payload, rendered, source_url FROM github_view_cache WHERE auth_key = ? AND repo = ? AND kind = ? AND number = ? AND include_comments = ?",
			)
			.get(authKey, normalizeRepo(repo), kind, number, includeComments ? 1 : 0) as Row | undefined;
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
	fetchedAt?: number;
}

export function putCached<T = unknown>(input: PutCachedInput<T>): void {
	const db = openDb();
	if (!db) return;
	try {
		const fetchedAt = input.fetchedAt ?? Date.now();
		const payloadJson = JSON.stringify(input.payload);
		db.prepare(
			"INSERT OR REPLACE INTO github_view_cache (auth_key, repo, kind, number, include_comments, fetched_at, payload, rendered, source_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		).run(
			input.authKey ?? DEFAULT_CACHE_AUTH_KEY,
			normalizeRepo(input.repo),
			input.kind,
			input.number,
			input.includeComments ? 1 : 0,
			fetchedAt,
			payloadJson,
			input.rendered,
			input.sourceUrl ?? null,
		);
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
	const db = openDb();
	if (!db) return;
	try {
		if (includeComments === undefined) {
			db.prepare("DELETE FROM github_view_cache WHERE auth_key = ? AND repo = ? AND kind = ? AND number = ?").run(
				authKey,
				normalizeRepo(repo),
				kind,
				number,
			);
		} else {
			db.prepare(
				"DELETE FROM github_view_cache WHERE auth_key = ? AND repo = ? AND kind = ? AND number = ? AND include_comments = ?",
			).run(authKey, normalizeRepo(repo), kind, number, includeComments ? 1 : 0);
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
	const db = openDb();
	if (!db) return;
	try {
		if (repo === undefined) {
			db.prepare("DELETE FROM github_view_cache WHERE number = ?").run(number);
		} else {
			db.prepare("DELETE FROM github_view_cache WHERE number = ? AND repo = ?").run(number, normalizeRepo(repo));
		}
	} catch (err) {
		logger.debug("github cache: invalidateAllForNumber failed", { err: String(err) });
	}
}

/** Drop every cached row. Test helper. */
export function clearAll(): void {
	const db = openDb();
	if (!db) return;
	try {
		db.prepare("DELETE FROM github_view_cache").run();
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
	const db = openDb();
	if (!db) return;
	try {
		if (repo === undefined) {
			db.prepare("DELETE FROM github_view_cache").run();
		} else {
			db.prepare("DELETE FROM github_view_cache WHERE repo = ?").run(normalizeRepo(repo));
		}
	} catch (err) {
		logger.debug("github cache: invalidateAllForRepo failed", { err: String(err) });
	}
}

/**
 * Test/maintenance helper. Closes and forgets the cached connection so the
 * next access reopens against (possibly) a different DB path.
 */
export function resetForTests(): void {
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

function readNumberSetting(settings: Settings | undefined, key: string, fallback: number): number {
	if (!settings) return fallback;
	try {
		const value = (settings as unknown as { get(k: string): unknown }).get(key);
		if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
	} catch {
		// Unknown setting paths fall through to default; settings may be a
		// stripped test stub that doesn't expose every key.
	}
	return fallback;
}

function readBooleanSetting(settings: Settings | undefined, key: string, fallback: boolean): boolean {
	if (!settings) return fallback;
	try {
		const value = (settings as unknown as { get(k: string): unknown }).get(key);
		if (typeof value === "boolean") return value;
	} catch {
		// Same fallback rationale as readNumberSetting.
	}
	return fallback;
}

export interface CacheTtl {
	softMs: number;
	hardMs: number;
	enabled: boolean;
}

export function resolveCacheTtl(settings?: Settings): CacheTtl {
	const softSec = readNumberSetting(settings, "github.cache.softTtlSec", DEFAULT_SOFT_TTL_SEC);
	const hardSec = readNumberSetting(settings, "github.cache.hardTtlSec", DEFAULT_HARD_TTL_SEC);
	const enabled = readBooleanSetting(settings, "github.cache.enabled", true);
	return {
		softMs: Math.max(0, softSec) * 1000,
		hardMs: Math.max(0, hardSec) * 1000,
		enabled,
	};
}

function storeResult<T>(
	authKey: string,
	repo: string,
	kind: CacheKind,
	number: number,
	includeComments: boolean,
	result: FreshResult<T>,
	fetchedAt: number,
): void {
	putCached<T>({
		authKey,
		repo,
		kind,
		number,
		includeComments,
		payload: result.payload,
		rendered: result.rendered,
		sourceUrl: result.sourceUrl,
		fetchedAt,
	});
}

/**
 * In-flight background refreshes keyed by row identity. N concurrent stale
 * reads of the same row must spawn one `gh` subprocess, not N identical ones.
 */
const inflightRefreshes = new Set<string>();

function scheduleBackgroundRefresh<T>(
	authKey: string,
	repo: string,
	kind: CacheKind,
	number: number,
	includeComments: boolean,
	fetchFresh: () => Promise<FreshResult<T>>,
): void {
	const key = `${authKey}|${normalizeRepo(repo)}|${kind}|${number}|${includeComments ? 1 : 0}`;
	if (inflightRefreshes.has(key)) return;
	inflightRefreshes.add(key);
	queueMicrotask(() => {
		fetchFresh()
			.then(fresh => {
				storeResult(authKey, repo, kind, number, includeComments, fresh, Date.now());
			})
			.catch(err => {
				logger.debug("github cache: background refresh failed", {
					err: String(err),
					repo,
					kind,
					number,
				});
			})
			.finally(() => {
				inflightRefreshes.delete(key);
			});
	});
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

	const cached: CachedView<T> | null = getCached<T>(
		options.repo,
		options.kind,
		options.number,
		options.includeComments,
		authKey,
	);

	if (cached) {
		const age = now - cached.fetchedAt;
		if (age > ttl.hardMs) {
			// Past hard TTL: drop the row eagerly so the on-disk exposure window
			// is bounded even if `fetchFresh()` then fails (network down, gh
			// auth lapse, etc.) and we never get to overwrite it.
			invalidate(options.repo, options.kind, options.number, options.includeComments, authKey);
		} else if (age <= ttl.softMs) {
			return {
				rendered: cached.rendered,
				sourceUrl: cached.sourceUrl,
				payload: cached.payload,
				status: "fresh",
				fetchedAt: cached.fetchedAt,
			};
		} else if (options.kind === "pr-diff") {
			scheduleBackgroundRefresh(
				authKey,
				options.repo,
				options.kind,
				options.number,
				options.includeComments,
				options.fetchFresh,
			);
			return {
				rendered: cached.rendered,
				sourceUrl: cached.sourceUrl,
				payload: cached.payload,
				status: "stale",
				fetchedAt: cached.fetchedAt,
			};
		} else {
			try {
				const fresh = await options.fetchFresh();
				const fetchedAt = Date.now();
				storeResult(authKey, options.repo, options.kind, options.number, options.includeComments, fresh, fetchedAt);
				return { ...fresh, status: "refreshed", fetchedAt };
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

	const fresh = await options.fetchFresh();
	const fetchedAt = Date.now();
	storeResult(authKey, options.repo, options.kind, options.number, options.includeComments, fresh, fetchedAt);
	return { ...fresh, status: "miss", fetchedAt };
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
	if (status === "stale")
		return `WARNING: showing cached content from ${human}; live refresh failed or is still running`;
	return `Cached: ${human}`;
}
