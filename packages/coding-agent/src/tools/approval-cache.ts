/**
 * Remembered approvals for `tools.approvalMode: always-ask-cached`.
 *
 * Two tiers hold the same grant keys: {@link SessionApprovals} lives in memory for one
 * conversation, {@link ApprovalCache} is `approval-cache.db` in the agent directory and covers
 * every later session. A grant key pins the capability tier it authorized
 * ({@link approvalGrantKey}), so a read grant never lets a write through.
 *
 * Checks open a short-lived read-only connection and answer every candidate key in one query;
 * they never create the database or touch its schema. Only recording a grant creates the file.
 */
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolTier } from "@oh-my-pi/pi-agent-core";
import { getAgentDir, logger, resolveEquivalentPath } from "@oh-my-pi/pi-utils";

/** File name of the approval cache inside the agent directory. */
export const APPROVAL_CACHE_FILENAME = "approval-cache.db";

/** `busy_timeout` for the rare case of two instances writing at the same time. */
const BUSY_TIMEOUT_MS = 5000;

/** Grant key for one capability tier: an exact target, a directory key, or a tree key. */
export function approvalGrantKey(capability: ToolTier, subject: string): string {
	return `${capability}\0${subject}`;
}

/** Read surface shared by the resolver's checks: which of `keys` any tier holds. */
export interface ApprovalGrantStore {
	present(keys: readonly string[]): ReadonlySet<string>;
}

/** Where a grant lives: this conversation's memory (`session`) or the shared database (`global`). */
export type ApprovalTier = "session" | "global";

/** Grants approved "for this session": one conversation's memory, gone when it ends. */
export class SessionApprovals implements ApprovalGrantStore {
	#grants = new Set<string>();

	present(keys: readonly string[]): ReadonlySet<string> {
		return new Set(keys.filter(key => this.#grants.has(key)));
	}

	record(key: string): void {
		this.#grants.add(key);
	}

	clear(): void {
		this.#grants.clear();
	}
}

/** SQLite grant store for one agent directory; see the module comment for its connection rules. */
export class ApprovalCache implements ApprovalGrantStore {
	readonly filePath: string;

	constructor(agentDir: string) {
		this.filePath = path.join(agentDir, APPROVAL_CACHE_FILENAME);
	}

	present(keys: readonly string[]): ReadonlySet<string> {
		if (keys.length === 0) return new Set();
		let db: Database;
		try {
			db = new Database(this.filePath, { readonly: true });
		} catch {
			// No database yet: nothing was ever remembered "always".
			return new Set();
		}
		try {
			const rows = db
				.query<{ key: string }, string[]>(`SELECT key FROM grants WHERE key IN (${keys.map(() => "?").join(",")})`)
				.all(...keys);
			return new Set(rows.map(row => row.key));
		} catch (err) {
			logger.debug("approval cache: read failed", { err: String(err), path: this.filePath });
			return new Set();
		} finally {
			db.close();
		}
	}

	record(key: string, tool: string): void {
		try {
			fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
			const db = new Database(this.filePath, { create: true });
			try {
				db.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
				db.run(
					"CREATE TABLE IF NOT EXISTS grants (key TEXT PRIMARY KEY, tool TEXT NOT NULL, approved_at TEXT NOT NULL)",
				);
				db.query("INSERT INTO grants (key, tool, approved_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING").run(
					key,
					tool,
					new Date().toISOString(),
				);
			} finally {
				db.close();
			}
		} catch (err) {
			logger.warn("approval cache: write failed", { err: String(err), path: this.filePath });
		}
	}

	/** Delete every remembered grant; a missing database has nothing to forget. */
	clear(): void {
		let db: Database;
		try {
			db = new Database(this.filePath, { readwrite: true });
		} catch {
			return;
		}
		try {
			db.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
			db.run("DELETE FROM grants");
		} catch (err) {
			logger.warn("approval cache: clear failed", { err: String(err), path: this.filePath });
		} finally {
			db.close();
		}
	}
}

/** One conversation's session tier plus its agent directory's database. */
export class ApprovalGrants implements ApprovalGrantStore {
	constructor(
		readonly session: SessionApprovals,
		readonly global: ApprovalCache,
	) {}

	present(keys: readonly string[]): ReadonlySet<string> {
		const found = new Set(this.session.present(keys));
		const rest = keys.filter(key => !found.has(key));
		for (const key of this.global.present(rest)) found.add(key);
		return found;
	}

	record(key: string, tool: string, tier: ApprovalTier): void {
		if (tier === "global") this.global.record(key, tool);
		else this.session.record(key);
	}
}

/** Trailing separator that marks a directory key. */
function withTrailingSeparator(dir: string): string {
	return dir.endsWith(path.sep) ? dir : `${dir}${path.sep}`;
}

/**
 * Cache key for a filesystem target: absolute, symlinks resolved (through the deepest existing
 * ancestor for a path that does not exist yet), case-folded on Windows.
 */
export function approvalCacheKeyForPath(target: string): string {
	const resolved = resolveEquivalentPath(target, { throughMissing: true });
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Cache key for a directory grant: {@link approvalCacheKeyForPath} plus a trailing separator. */
export function approvalDirectoryKey(directory: string): string {
	return withTrailingSeparator(approvalCacheKeyForPath(directory));
}

/** Path-resolved agent directory, case-folded on Windows: one store per directory. */
function agentDirKey(agentDir: string): string {
	const resolved = path.resolve(agentDir);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

const cachesByDir = new Map<string, ApprovalCache>();
/** Session tiers by agent directory, then conversation id. */
const sessionsByDir = new Map<string, Map<string, SessionApprovals>>();

/**
 * Grants for one conversation under an agent directory. Without a `sessionId` the session tier is
 * a fresh, unshared store, so a caller that cannot name its conversation sees global grants only.
 */
export function getApprovalGrants(agentDir: string = getAgentDir(), sessionId?: string): ApprovalGrants {
	const dirKey = agentDirKey(agentDir);
	let cache = cachesByDir.get(dirKey);
	if (!cache) {
		cache = new ApprovalCache(path.resolve(agentDir));
		cachesByDir.set(dirKey, cache);
	}
	if (sessionId === undefined) return new ApprovalGrants(new SessionApprovals(), cache);
	let sessions = sessionsByDir.get(dirKey);
	if (!sessions) {
		sessions = new Map();
		sessionsByDir.set(dirKey, sessions);
	}
	let session = sessions.get(sessionId);
	if (!session) {
		session = new SessionApprovals();
		sessions.set(sessionId, session);
	}
	return new ApprovalGrants(session, cache);
}

/** Forget every remembered approval under an agent directory: the database and every session tier. */
export function clearApprovalGrants(agentDir: string = getAgentDir()): void {
	const dirKey = agentDirKey(agentDir);
	for (const session of sessionsByDir.get(dirKey)?.values() ?? []) session.clear();
	getApprovalGrants(agentDir).global.clear();
}
