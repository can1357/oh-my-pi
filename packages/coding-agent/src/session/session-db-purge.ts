import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { getHistoryDbPath, getStatsDbPath } from "@oh-my-pi/pi-utils/dirs";
import { isBunTestRuntime } from "@oh-my-pi/pi-utils/env";
import { readSessionHeaderIdSync, sessionIdFromContent } from "./session-header-id";
/**
 * Purge the SQLite rows a deleted session leaves behind (`history.db` prompts,
 * titles, recaps and the FTS index; `stats.db` rows for the transcript and
 * nested subagent files under its artifacts dir). The row sets mirror gc's
 * archive pass (#7286, #13930): {@link deleteHistoryRowsForSessions} is the
 * single implementation both gc and the explicit delete paths share, so the
 * two cannot drift apart again.
 *
 * Best-effort: purge failures are swallowed so a session delete never fails
 * because a dashboard store was busy or missing. Callers invoke this BEFORE
 * removing the transcript so the session id is read from the live header.
 */

const SESSION_SUFFIX = ".jsonl";
const COMPRESSED_SESSION_SUFFIX = ".jsonl.gz";

interface SqliteRunResult {
	changes?: number | bigint;
}

function sqliteNumber(value: number | bigint | null | undefined): number {
	if (typeof value === "bigint") return Number(value);
	if (typeof value === "number") return value;
	return 0;
}

function tableExists(db: Database, table: string): boolean {
	using stmt = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type IN ('table','view') AND name = ?");
	const row = stmt.get(table) as { present?: number } | null;
	return row?.present === 1;
}

function tableHasColumn(db: Database, table: string, column: string): boolean {
	using stmt = db.prepare(`PRAGMA table_info(${table})`);
	const rows = stmt.all() as Array<{ name?: string | null }>;
	return rows.some(row => row.name === column);
}

function sessionArtifactsPath(sessionPath: string): string {
	if (sessionPath.endsWith(COMPRESSED_SESSION_SUFFIX)) {
		return sessionPath.slice(0, -COMPRESSED_SESSION_SUFFIX.length);
	}
	return sessionPath.slice(0, -SESSION_SUFFIX.length);
}

const STATS_SESSION_TABLES = [
	"messages",
	"user_messages",
	"tool_calls",
	"file_offsets",
	"session_rollup",
	"session_dirty",
	"spotlight_sessions",
	"spotlight_results",
	"spotlight_calls",
	"spotlight_requests",
	"spotlight_needs",
] as const;

function deleteHistoryRows(db: Database, sessionIds: string[]): { deleted: number; ftsRebuilt: boolean } {
	const hasHistory = tableExists(db, "history") && tableHasColumn(db, "history", "session_id");
	const hasRecaps = tableExists(db, "session_recaps");
	const hasTitles = tableExists(db, "session_titles");
	if (!hasHistory && !hasRecaps && !hasTitles) return { deleted: 0, ftsRebuilt: false };
	const hasFts = hasHistory && tableExists(db, "history_fts");
	using deleteStmt = hasHistory ? db.prepare("DELETE FROM history WHERE session_id = ?") : undefined;
	// Recaps and titles are session-scoped side output with no life beyond their session.
	using deleteRecapsStmt = hasRecaps ? db.prepare("DELETE FROM session_recaps WHERE session_id = ?") : undefined;
	using deleteTitlesStmt = hasTitles ? db.prepare("DELETE FROM session_titles WHERE session_id = ?") : undefined;
	let deleted = 0;
	const tx = db.transaction((ids: string[]) => {
		for (const id of ids) {
			deleteRecapsStmt?.run(id);
			deleteTitlesStmt?.run(id);
			if (!deleteStmt) continue;
			const result = deleteStmt.run(id) as SqliteRunResult;
			deleted += sqliteNumber(result.changes);
		}
		if (deleted > 0 && hasFts) db.run("INSERT INTO history_fts(history_fts) VALUES('rebuild')");
	});
	tx(sessionIds);
	return { deleted, ftsRebuilt: deleted > 0 && hasFts };
}

/**
 * Delete `history.db` rows for `sessionIds` — prompts, recaps, titles — and
 * rebuild the FTS index when prompt rows went away. Shared by gc's archive
 * pass and the explicit session-delete paths.
 */
export function deleteHistoryRowsForSessions(
	dbPath: string,
	sessionIds: string[],
): { deleted: number; ftsRebuilt: boolean } {
	if (sessionIds.length === 0) return { deleted: 0, ftsRebuilt: false };
	const db = new Database(dbPath);
	try {
		db.run("PRAGMA busy_timeout = 5000");
		return deleteHistoryRows(db, sessionIds);
	} finally {
		db.close();
	}
}

/**
 * Delete `stats.db` rows for one transcript plus nested subagent files under
 * its artifacts dir. Unlike gc's archive reconciliation there is no live peer
 * to transfer surviving rows to, so every row under the deleted root goes.
 *
 * Nested rows match as a half-open `session_file` range rather than gc's
 * `instr(session_file, ?) = 1`: this runs synchronously on interactive delete,
 * and `instr` defeats the `session_file` index, full-scanning every table
 * (tens of seconds on a multi-GB stats.db).
 */
function deleteStatsRowsForSession(db: Database, sessionPath: string): number {
	const sessionTables = STATS_SESSION_TABLES.filter(
		table => tableExists(db, table) && tableHasColumn(db, table, "session_file"),
	);
	if (sessionTables.length === 0) return 0;
	using statements = new DisposableStack();
	const deletionStatements = sessionTables.map(table => ({
		table,
		statement: statements.use(
			db.prepare(`DELETE FROM ${table} WHERE session_file = ? OR (session_file >= ? AND session_file < ?)`),
		),
	}));
	let deleted = 0;
	const tx = db.transaction(() => {
		const nestedPrefix = `${sessionArtifactsPath(sessionPath)}${path.sep}`;
		// Smallest string greater than every string starting with `nestedPrefix`.
		const nestedEnd = `${nestedPrefix.slice(0, -1)}${String.fromCharCode(nestedPrefix.charCodeAt(nestedPrefix.length - 1) + 1)}`;
		for (const { statement } of deletionStatements) {
			const result = statement.run(sessionPath, nestedPrefix, nestedEnd) as SqliteRunResult;
			deleted += sqliteNumber(result.changes);
		}
	});
	tx();
	return deleted;
}

export interface PurgeDeletedSessionRowsOptions {
	/** Skip the header read when the caller already knows the session id. */
	sessionId?: string;
	/** Skip the header read when the caller already holds the transcript. */
	content?: string;
	/** Override the resolved `history.db` path (tests). */
	historyDbPath?: string;
	/** Override the resolved `stats.db` path (tests). */
	statsDbPath?: string;
}

/**
 * Purge `history.db` / `stats.db` rows for the session at `sessionPath`.
 * Reads the session id from the transcript, so it MUST run before the
 * transcript is unlinked. Never throws: a missing file, an unreadable store,
 * or a busy/locked db leaves the rows behind like before.
 *
 * Under the test runner the stores resolve to the real user files, so the
 * default paths are skipped there unless the test isolated the agent dir
 * (`PI_CODING_AGENT_DIR`) or passed explicit `historyDbPath`/`statsDbPath` —
 * exactly like the session-index writer guard.
 */
export function purgeDeletedSessionRows(sessionPath: string, options?: PurgeDeletedSessionRowsOptions): void {
	const testDefaultPaths =
		isBunTestRuntime() && !process.env.PI_CODING_AGENT_DIR && !options?.historyDbPath && !options?.statsDbPath;
	if (testDefaultPaths) return;
	const sessionId = options?.sessionId ?? (options?.content ? sessionIdFromContent(options.content) : undefined);
	const resolvedId = sessionId ?? readSessionHeaderIdSync(sessionPath);
	const historyDbPath = options?.historyDbPath ?? getHistoryDbPath();
	try {
		if (resolvedId !== undefined && fs.existsSync(historyDbPath)) {
			deleteHistoryRowsForSessions(historyDbPath, [resolvedId]);
		}
	} catch {}
	try {
		const statsDbPath = options?.statsDbPath ?? getStatsDbPath();
		if (fs.existsSync(statsDbPath)) {
			const db = new Database(statsDbPath);
			try {
				db.run("PRAGMA busy_timeout = 5000");
				deleteStatsRowsForSession(db, sessionPath);
			} finally {
				db.close();
			}
		}
	} catch {}
}
