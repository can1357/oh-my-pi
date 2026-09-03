/**
 * Session-title index: a `session_titles` table in history.db mapping session
 * id → display title, written whenever a title is created or renamed
 * ({@link SessionManager.setSessionName}) and backfilled by the recent-session
 * fallback scan. Lets the welcome "Recent sessions" list resolve names from a
 * stat + lookup instead of content-scanning every session file in the project
 * directory (multi-hundred-ms on dirs with thousands of sessions).
 *
 * Holds its own lazily-opened connection instead of {@link HistoryStorage}'s
 * path-pinned singleton: the db path is re-resolved on every call so
 * `setAgentDir`/profile switches (and test isolation) transparently reopen
 * against the right file. Never versions the db — `PRAGMA user_version` is
 * owned by HistoryStorage's rebuild pass, which drops only its own tables.
 */
import { Database, type Statement } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { getDbBusyTimeoutMs, getHistoryDbPath, logger } from "@oh-my-pi/pi-utils";

const TITLE_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS session_titles (
	session_id TEXT PRIMARY KEY,
	title TEXT NOT NULL,
	updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
);
`;

interface TitleIndexHandle {
	dbPath: string;
	db: Database;
	upsert: Statement;
	select: Statement;
}

let handle: TitleIndexHandle | undefined;
/** Db path whose open failed; skip retries (and log spam) until the path changes. */
let failedPath: string | undefined;

function closeHandle(): void {
	if (!handle) return;
	try {
		handle.upsert.finalize();
		handle.select.finalize();
		handle.db.close();
	} catch {}
	handle = undefined;
}

function openTitleIndex(): TitleIndexHandle | undefined {
	const dbPath = getHistoryDbPath();
	if (handle?.dbPath === dbPath) return handle;
	if (failedPath === dbPath) return undefined;
	closeHandle();
	try {
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		const db = new Database(dbPath);
		// Install the busy handler BEFORE any lock-taking statement (see #2421).
		db.run(`PRAGMA busy_timeout = ${getDbBusyTimeoutMs()}`);
		db.run(`PRAGMA journal_mode=WAL;\nPRAGMA synchronous=NORMAL;\n${TITLE_TABLE_DDL}`);
		handle = {
			dbPath,
			db,
			upsert: db.prepare(`
INSERT INTO session_titles (session_id, title, updated_at)
VALUES (?, ?, CAST(strftime('%s','now') AS INTEGER))
ON CONFLICT(session_id) DO UPDATE SET
	title = excluded.title,
	updated_at = excluded.updated_at
			`),
			select: db.prepare("SELECT title FROM session_titles WHERE session_id = ?"),
		};
		failedPath = undefined;
		return handle;
	} catch (error) {
		failedPath = dbPath;
		logger.warn("Session title index unavailable", { dbPath, error: String(error) });
		return undefined;
	}
}

/**
 * Record (or replace) the indexed title for a session id. Best-effort: index
 * failures must never break a rename, so errors are logged and swallowed.
 */
export function recordSessionTitle(sessionId: string, title: string): void {
	const index = openTitleIndex();
	if (!index) return;
	try {
		index.upsert.run(sessionId, title);
	} catch (error) {
		logger.debug("Session title index write failed", { sessionId, error: String(error) });
	}
}

/** Indexed title for a session id, or undefined when unindexed/unavailable. */
export function lookupSessionTitle(sessionId: string): string | undefined {
	const index = openTitleIndex();
	if (!index) return undefined;
	try {
		const row = index.select.get(sessionId) as { title: string } | null;
		return row?.title ?? undefined;
	} catch (error) {
		logger.debug("Session title index read failed", { sessionId, error: String(error) });
		return undefined;
	}
}

/** @internal Close the cached connection so the next call re-resolves the db path — test-only. */
export function resetSessionTitleIndexForTests(): void {
	closeHandle();
	failedPath = undefined;
}
