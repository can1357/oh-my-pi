/**
 * Persistent per-path approval cache for `tools.approvalMode: always-ask-cached`.
 *
 * The first read/write operation on a target prompts. When the user approves it,
 * the resolved target key is recorded in `approval-cache.db` (SQLite) under the
 * active agent directory (e.g. `~/.omp/agent/approval-cache.db`) so later
 * operations on the same target run without asking again. A directory answer
 * records the folder around the call instead.
 *
 * IO is best-effort: an unreadable or corrupt database degrades to "nothing
 * approved" — prompting more, never allowing more — and a failed write logs and
 * leaves the next call to ask again. Connections open per operation rather than
 * for the process lifetime, so the file is never locked and deleting it (or its
 * rows) revokes grants without restarting a session.
 */
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolTier } from "@oh-my-pi/pi-agent-core";
import { getAgentDir, logger, normalizePathForComparison } from "@oh-my-pi/pi-utils";

/** File name of the approval cache inside the agent directory. */
export const APPROVAL_CACHE_FILENAME = "approval-cache.db";

/** Pre-SQLite JSON cache, imported once and renamed aside. */
const LEGACY_JSON_FILENAME = "approval-cache.json";

/** `busy_timeout` for the rare case of two sessions writing at the same time. */
const BUSY_TIMEOUT_MS = 5000;

/**
 * Grant key for one capability tier: a subject — an exact target, a directory key, or a
 * `tool:<name>` subject — behind the tier that earned it, so a grant records what its approval
 * actually authorized. Coverage runs from the call's tier upward, so approving a write also
 * covers reads of that target, while approving a read never authorizes writes or exec calls.
 */
export function approvalGrantKey(capability: ToolTier, subject: string): string {
	return `${capability}\0${subject}`;
}

/**
 * One remembered approval, in the same record shape in both tiers: a grant in
 * this instance's memory and a row of the global `approval-cache.db` describe
 * the same thing — the key that covers the call, the tool that recorded it,
 * when it was approved, and whether it is a whole folder.
 */
export interface ApprovalGrant {
	/** Cache key of the grant: a target path or URL, or a directory key with its trailing separator. */
	key: string;
	/** Tool whose call the user approved for this target (`read`, `write`, `edit`, …). */
	tool: string;
	/** ISO timestamp of the approving decision. */
	approvedAt: string;
	/**
	 * `"directory"` for a folder grant: the key is a directory (trailing
	 * separator) and covers the folder's own entries, one level deep.
	 */
	scope?: "directory";
}

/**
 * Read/write surface `resolveApproval` (checks) and the tool wrapper (records
 * after an interactive approval) share, so both halves of `always-ask-cached`
 * agree on one store.
 */
export interface ApprovalGrantStore {
	has(key: string): boolean;
}

/** Where a grant lives: this instance's memory (`session`) or the shared database (`global`). */
export type ApprovalTier = "session" | "global";

/**
 * Grants for one running instance, held in memory: they cover calls until the
 * process exits and two instances never share them. Answers other than the
 * "Always …" ones write here, so a plain approval forgets itself when omp
 * closes; `ApprovalGrants` layers the persistent global cache underneath.
 */
export class SessionApprovals implements ApprovalGrantStore {
	#grants = new Map<string, ApprovalGrant>();

	has(key: string): boolean {
		return this.#grants.has(key);
	}

	/** The grant behind `key`, in the same record shape {@link ApprovalCache.get} answers. */
	get(key: string): ApprovalGrant | undefined {
		return this.#grants.get(key);
	}

	record(key: string, tool = "", scope?: "directory"): void {
		if (key.length === 0 || this.#grants.has(key)) return;
		const grant: ApprovalGrant = { key, tool, approvedAt: new Date().toISOString() };
		if (scope !== undefined) grant.scope = scope;
		this.#grants.set(key, grant);
	}

	/** Number of in-memory grants. */
	get size(): number {
		return this.#grants.size;
	}

	clear(): void {
		this.#grants.clear();
	}
}

/**
 * Session grants plus the global database behind one interface: a call is
 * covered when either tier holds its key. "Always …" answers write to the
 * global cache and survive this instance; every other answer writes to
 * {@link SessionApprovals} and is gone when the process exits.
 */
export class ApprovalGrants implements ApprovalGrantStore {
	readonly filePath: string;

	constructor(
		readonly session: SessionApprovals,
		readonly global: ApprovalCache,
	) {
		this.filePath = global.filePath;
	}

	has(key: string): boolean {
		return this.session.has(key) || this.global.has(key);
	}

	record(key: string, tool = "", scope?: "directory", tier: ApprovalTier = "session"): void {
		(tier === "global" ? this.global : this.session).record(key, tool, scope);
	}
}

interface GrantRow {
	key: string;
	tool: string;
	approved_at: string;
	scope: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS grants (
	key         TEXT PRIMARY KEY,
	tool        TEXT NOT NULL DEFAULT '',
	approved_at TEXT NOT NULL,
	scope       TEXT
);
PRAGMA user_version = 1;
`;

/**
 * SQLite-backed grant store for one agent directory. Every operation opens a
 * short-lived connection (read-only for checks) so the database file stays
 * unlocked between calls.
 */
export class ApprovalCache implements ApprovalGrantStore {
	readonly filePath: string;

	constructor(agentDir: string = getAgentDir()) {
		this.filePath = path.join(agentDir, APPROVAL_CACHE_FILENAME);
	}

	has(key: string): boolean {
		const db = this.#open(false);
		if (!db) return false;
		try {
			return db.query<GrantRow, [string]>("SELECT key FROM grants WHERE key = ?").get(key) !== null;
		} catch (err) {
			logger.debug("approval cache: read failed", { err: String(err), path: this.filePath });
			return false;
		} finally {
			db.close();
		}
	}

	/** The stored grant for `key`, in the same record shape {@link SessionApprovals.get} answers. */
	get(key: string): ApprovalGrant | undefined {
		const db = this.#open(false);
		if (!db) return undefined;
		try {
			const row = db
				.query<GrantRow, [string]>("SELECT key, tool, approved_at, scope FROM grants WHERE key = ?")
				.get(key);
			if (row === null) return undefined;
			return {
				key: row.key,
				tool: row.tool,
				approvedAt: row.approved_at,
				...(row.scope === "directory" ? { scope: "directory" as const } : {}),
			};
		} catch (err) {
			logger.debug("approval cache: read failed", { err: String(err), path: this.filePath });
			return undefined;
		} finally {
			db.close();
		}
	}

	record(key: string, tool = "", scope?: "directory"): void {
		if (key.length === 0) return;
		const db = this.#open(true);
		if (!db) return;
		try {
			db.query(
				"INSERT INTO grants (key, tool, approved_at, scope) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO NOTHING",
			).run(key, tool, new Date().toISOString(), scope ?? null);
		} catch (err) {
			logger.debug("approval cache: write failed", { err: String(err), path: this.filePath });
		} finally {
			db.close();
		}
	}

	/** Number of grants; 0 when the database is missing or unreadable. */
	get size(): number {
		const db = this.#open(false);
		if (!db) return 0;
		try {
			const row = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM grants").get();
			return row?.count ?? 0;
		} catch (err) {
			logger.debug("approval cache: count failed", { err: String(err), path: this.filePath });
			return 0;
		} finally {
			db.close();
		}
	}

	/**
	 * Delete every remembered grant. A missing database means there is nothing
	 * to forget, so no empty file is created; the file itself stays, and later
	 * approvals write into it again. A failed delete is logged and swallowed:
	 * the cache is rebuildable, and the settings panel must stay usable.
	 */
	clear(): void {
		const db = this.#open(false);
		if (!db) return;
		try {
			db.query("DELETE FROM grants").run();
			logger.info("approval cache: forgotten", { path: this.filePath });
		} catch (err) {
			logger.warn("approval cache: clear failed", { err: String(err), path: this.filePath });
		} finally {
			db.close();
		}
	}

	/**
	 * Open a connection; `create` allows creating the file and schema. Checks do
	 * not create an empty database — merely running a session leaves no cache
	 * behind — but they do open a creating connection to import a legacy JSON
	 * cache once. A corrupt database is moved aside and recreated.
	 */
	#open(create: boolean): Database | undefined {
		if (!create && !fs.existsSync(this.filePath) && !fs.existsSync(legacyJsonPath(this.filePath))) {
			return undefined;
		}
		try {
			fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
			return this.#connect();
		} catch (err) {
			logger.debug("approval cache: failed to open", { err: String(err), path: this.filePath });
			return undefined;
		}
	}

	#connect(): Database {
		try {
			return this.#initialize();
		} catch (err) {
			// A file that is not a database (truncated, foreign, pre-SQLite) is
			// moved aside so the next check starts from an empty cache.
			const quarantined = `${this.filePath}.corrupt`;
			try {
				fs.rmSync(quarantined, { force: true });
				fs.renameSync(this.filePath, quarantined);
				logger.warn("approval cache: unusable database moved aside", {
					err: String(err),
					path: this.filePath,
					quarantined,
				});
			} catch (renameError) {
				logger.debug("approval cache: could not quarantine", {
					err: String(renameError),
					path: this.filePath,
				});
				throw err;
			}
			return this.#initialize();
		}
	}

	#initialize(): Database {
		const db = new Database(this.filePath);
		try {
			// Install the busy handler before any lock-taking statement.
			db.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
			db.run("PRAGMA synchronous = NORMAL");
			db.run(SCHEMA);
			migrateLegacyJson(db, this.filePath);
			purgeLegacyGrants(db);
			return db;
		} catch (err) {
			db.close();
			throw err;
		}
	}
}

/** Directories whose legacy JSON cache has been checked in this process. */
const migratedDirs = new Set<string>();

/**
 * Drop grants in shapes nothing checks any more: rows keyed by command text
 * (`bash: …`), which briefly recorded exact commands, and rows without a
 * capability-tier prefix, which predate tier-keyed grants (a read grant used to
 * cover writes). Left in place they would sit in the database doing nothing.
 */
function purgeLegacyGrants(db: Database): void {
	try {
		const stale = db.query("SELECT 1 FROM grants WHERE key LIKE 'bash: %' OR instr(key, char(0)) = 0 LIMIT 1").get();
		if (stale === null) return;
		db.query("DELETE FROM grants WHERE key LIKE 'bash: %' OR instr(key, char(0)) = 0").run();
		logger.info("approval cache: dropped legacy grants");
	} catch (err) {
		logger.debug("approval cache: legacy-grant purge failed", { err: String(err) });
	}
}

/**
 * Capability a pre-SQLite grant's tool implies, for the one-time JSON import: write tools
 * authorized a write, the shell an exec call, everything else the read it was recorded under.
 */
function legacyCapability(tool: string): ToolTier {
	switch (tool) {
		case "write":
		case "edit":
			return "write";
		case "bash":
			return "exec";
		default:
			return "read";
	}
}

/** Sibling path of the pre-SQLite JSON cache for a database path. */
function legacyJsonPath(filePath: string): string {
	return path.join(path.dirname(filePath), LEGACY_JSON_FILENAME);
}

/**
 * Import a pre-SQLite `approval-cache.json` once: grants move into the database
 * and the JSON file is removed, so nothing but `approval-cache.db` is left
 * behind. An unreadable or unrecognized file is renamed to `.json.bak` instead,
 * so a broken legacy cache is never dropped on the floor.
 */
function migrateLegacyJson(db: Database, filePath: string): void {
	const jsonPath = legacyJsonPath(filePath);
	if (migratedDirs.has(jsonPath)) return;
	migratedDirs.add(jsonPath);
	let raw: string;
	try {
		raw = fs.readFileSync(jsonPath, "utf8");
	} catch {
		return;
	}
	let imported = 0;
	let recognized = false;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && "paths" in parsed) {
			const entries = parsed.paths;
			if (entries !== null && typeof entries === "object" && !Array.isArray(entries)) {
				recognized = true;
				const insert = db.query(
					"INSERT INTO grants (key, tool, approved_at, scope) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO NOTHING",
				);
				for (const [key, value] of Object.entries(entries)) {
					if (key.length === 0 || value === null || typeof value !== "object" || Array.isArray(value)) continue;
					const tool = "tool" in value && typeof value.tool === "string" ? value.tool : "";
					const approvedAt =
						"approvedAt" in value && typeof value.approvedAt === "string"
							? value.approvedAt
							: new Date().toISOString();
					const scope = "scope" in value && value.scope === "directory" ? "directory" : null;
					// The old cache stored no capability: infer it from the tool that recorded the
					// grant, falling back to read — the tightest reading of what it authorized.
					insert.run(approvalGrantKey(legacyCapability(tool), key), tool, approvedAt, scope);
					imported++;
				}
			}
		}
	} catch (err) {
		logger.debug("approval cache: legacy JSON unreadable", { err: String(err), path: jsonPath });
	}
	if (!recognized) {
		try {
			fs.renameSync(jsonPath, `${jsonPath}.bak`);
			logger.warn("approval cache: legacy JSON not recognized; kept as .bak", { path: jsonPath });
		} catch (err) {
			logger.debug("approval cache: could not rename legacy JSON", { err: String(err), path: jsonPath });
		}
		return;
	}
	try {
		fs.rmSync(jsonPath, { force: true });
		logger.info("approval cache: migrated legacy JSON grants", { count: imported, from: jsonPath });
	} catch (err) {
		logger.debug("approval cache: could not remove legacy JSON", { err: String(err), path: jsonPath });
	}
}

/** Trailing separator that marks a directory grant and makes it prefix-matchable. */
function withTrailingSeparator(dir: string): string {
	return dir.endsWith(path.sep) ? dir : `${dir}${path.sep}`;
}

/**
 * Cache key for a filesystem target: absolute, symlink-resolved when it exists,
 * and case-folded on case-insensitive platforms, so different spellings of one
 * file hit one grant.
 */
export function approvalCacheKeyForPath(target: string): string {
	return normalizePathForComparison(path.resolve(target));
}

/**
 * Cache key for a granted directory: the same normalization as
 * {@link approvalCacheKeyForPath} plus a trailing separator, so a folder grant
 * reads as one in the database and covers the folder's own entries.
 */
export function approvalDirectoryKey(directory: string): string {
	return withTrailingSeparator(normalizePathForComparison(path.resolve(directory)));
}

/**
 * Whether `directoryKey` contains `targetKey` (the key itself or anything below it) — containment math
 * for {@link commonApprovalDirectoryKey} and the "folder around the call" candidate. Grant coverage is
 * stricter and lives in the resolver: a folder grant covers its own entries, not its whole tree.
 */
export function approvalDirectoryCovers(directoryKey: string, targetKey: string): boolean {
	return targetKey === directoryKey || targetKey.startsWith(directoryKey);
}

/**
 * Ancestor directory keys of a path-shaped target key, nearest first (`read
 * /a/b/f.ts` → `/a/b/`, `/a/`, `/`). Empty for keys that are not absolute
 * filesystem paths — commands, URLs, and other opaque targets match exactly.
 */
export function approvalAncestorDirectoryKeys(target: string): string[] {
	if (!path.isAbsolute(target)) return [];
	const ancestors: string[] = [];
	let current = target;
	for (;;) {
		const parent = path.dirname(current);
		if (parent === current) break;
		ancestors.push(withTrailingSeparator(normalizePathForComparison(parent)));
		current = parent;
	}
	return ancestors;
}

/**
 * Deepest directory that contains every entry of `directories`, as a grant key;
 * `undefined` when they share no root (e.g. two drives). Serves the approval
 * prompt's "approve folder" option for calls that touch several paths.
 */
export function commonApprovalDirectoryKey(directories: readonly string[]): string | undefined {
	if (directories.length === 0) return undefined;
	const keys = directories.map(dir => approvalDirectoryKey(dir));
	let common = keys[0]!;
	for (const key of keys.slice(1)) {
		if (approvalDirectoryCovers(common, key)) continue;
		if (approvalDirectoryCovers(key, common)) {
			common = key;
			continue;
		}
		const parent = approvalAncestorDirectoryKeys(common.replace(/[\\/]+$/, "")).find(candidate =>
			approvalDirectoryCovers(candidate, key),
		);
		if (parent === undefined) return undefined;
		common = parent;
	}
	return common;
}

const cachesByDir = new Map<string, ApprovalCache>();

/** Scope prefix for one agent directory: every conversation under it shares this prefix. */
function directoryScopeKey(resolvedDir: string): string {
	const folded = process.platform === "win32" ? resolvedDir.toLowerCase() : resolvedDir;
	return `${folded}\0`;
}

/**
 * In-memory session tiers, keyed by agent directory and conversation. A grant approved "for this
 * session" belongs to the conversation it was approved in, so `/new`, a session switch, another
 * agent directory, or a second session in the same process starts without it.
 */
const sessionApprovalsByScope = new Map<string, SessionApprovals>();

const grantsByDir = new Map<string, ApprovalGrants>();

/**
 * Session plus global grants for an agent directory and conversation. The session tier is this
 * process's memory, isolated per conversation — cleared when omp exits, never shared between
 * instances, never carried into another session in the same process; the global tier is
 * `approval-cache.db` in that directory and outlives every instance. Both the resolver's checks and
 * the wrapper's records go through it.
 */
export function getApprovalGrants(agentDir: string = getAgentDir(), sessionId?: string): ApprovalGrants {
	const resolved = path.resolve(agentDir);
	const scopeKey = `${directoryScopeKey(resolved)}${sessionId ?? ""}`;
	let grants = grantsByDir.get(scopeKey);
	if (!grants) {
		let approvals = sessionApprovalsByScope.get(scopeKey);
		if (!approvals) {
			approvals = new SessionApprovals();
			sessionApprovalsByScope.set(scopeKey, approvals);
		}
		grants = new ApprovalGrants(approvals, getApprovalCache(resolved));
		grantsByDir.set(scopeKey, grants);
	}
	return grants;
}

/** Drop every in-memory grant, simulating a fresh instance (tests only). */
export function __resetSessionApprovalsForTests(): void {
	// Clear the stores too: a caller holding one keeps seeing revoked grants otherwise.
	for (const approvals of sessionApprovalsByScope.values()) approvals.clear();
	sessionApprovalsByScope.clear();
	grantsByDir.clear();
}

/**
 * Forget every remembered approval for an agent directory: the persistent
 * grants in `approval-cache.db` and the in-memory ones for this process. What
 * the settings panel's "Forget Remembered Approvals" action runs; the next
 * read, write, or command asks again.
 */
export function clearApprovalGrants(agentDir: string = getAgentDir()): void {
	const resolved = path.resolve(agentDir);
	// Every conversation's in-memory tier for this directory, plus the persistent database.
	const scopePrefix = directoryScopeKey(resolved);
	for (const [scope, approvals] of sessionApprovalsByScope) {
		if (scope.startsWith(scopePrefix)) approvals.clear();
	}
	getApprovalCache(resolved).clear();
}

/**
 * Shared grant store for an agent directory. Defaults to the active
 * `getAgentDir()` (honoring `PI_CODING_AGENT_DIR` and named profiles), so the
 * resolver's checks and the wrapper's records land in one database.
 */
export function getApprovalCache(agentDir: string = getAgentDir()): ApprovalCache {
	const resolved = path.resolve(agentDir);
	// String-only key: cheap on the per-call path, and a symlinked agent dir
	// still yields one store because callers pass the directory they resolved.
	const directoryKey = process.platform === "win32" ? resolved.toLowerCase() : resolved;
	let cache = cachesByDir.get(directoryKey);
	if (!cache) {
		cache = new ApprovalCache(resolved);
		cachesByDir.set(directoryKey, cache);
	}
	return cache;
}
