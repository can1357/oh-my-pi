/**
 * Per-session index tables in history.db, keyed by session id:
 *
 * - `session_titles`: session id → display title, written whenever a title is
 *   created or renamed ({@link SessionManager.setSessionName}) and backfilled by
 *   the recent-session fallback scan. Lets the welcome "Recent sessions" list
 *   resolve names from a stat + lookup instead of content-scanning every session
 *   file in the project directory (multi-hundred-ms on dirs with thousands of
 *   sessions). A title has no life beyond its session; `omp gc` drops rows of
 *   archived sessions.
 * - `session_recaps`: append-only journal of idle recaps
 *   ({@link SessionManager.recordRecap}). Recaps are side-channel output that
 *   never enters the session JSONL or LLM context; this table is their only
 *   durable record. `omp gc` drops rows of archived sessions.
 *
 * Holds its own lazily-opened connection instead of {@link HistoryStorage}'s
 * path-pinned singleton: the db path is re-resolved on every call so
 * `setAgentDir`/profile switches (and test isolation) transparently reopen
 * against the right file. Never versions the db — `PRAGMA user_version` is
 * owned by HistoryStorage's rebuild pass, which drops only its own tables.
 */
import { Database, type SQLQueryBindings, type Statement } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { getHistoryDbPath, resolveEquivalentPath } from "@oh-my-pi/pi-utils/dirs";
import { getDbBusyTimeoutMs } from "@oh-my-pi/pi-utils/env";
import * as logger from "@oh-my-pi/pi-utils/logger";
import {
	isSqliteBusyError,
	onSqliteStoreQuarantine,
	readDamagedSqliteRows,
	sqliteFileIdentity,
	withSqliteStoreLease,
} from "@oh-my-pi/pi-utils/sqlite";

const SESSION_INDEX_DDL = `
CREATE TABLE IF NOT EXISTS session_titles (
	session_id TEXT PRIMARY KEY,
	title TEXT NOT NULL,
	updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
);
CREATE TABLE IF NOT EXISTS session_recaps (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	session_id TEXT NOT NULL,
	cwd TEXT NOT NULL,
	recap TEXT NOT NULL,
	created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
);
CREATE INDEX IF NOT EXISTS idx_session_recaps_session ON session_recaps(session_id, created_at);
`;

interface SessionIndexHandle {
	db: Database;
	upsertTitle: Statement;
	selectTitle: Statement;
	insertRecap: Statement;
}

/** Db path whose open failed; skip retries until that path's file identity changes. */
let failedPath: string | undefined;
let failedIdentity: string | null | undefined;
/** One quarantine-clearing hook per {@link failedPath}; self-unregisters once it fires. */
let failedPathUnregister: (() => void) | undefined;

function withSessionIndex<T>(operation: (index: SessionIndexHandle) => T): T | undefined {
	const dbPath = resolveEquivalentPath(getHistoryDbPath(), { allowMissing: true });
	fs.mkdirSync(path.dirname(dbPath), { recursive: true });
	return withSqliteStoreLease(dbPath, () => {
		if (failedPath === dbPath) {
			const currentIdentity = sqliteFileIdentity(dbPath);
			if (currentIdentity === undefined || currentIdentity === failedIdentity) return undefined;
			failedPath = undefined;
			failedIdentity = undefined;
			failedPathUnregister?.();
			failedPathUnregister = undefined;
		}
		let db: Database | undefined;
		const prepared: Statement[] = [];
		let index: SessionIndexHandle;
		try {
			db = new Database(dbPath);
			// Install the busy handler BEFORE any lock-taking statement (see #2421).
			db.run(`PRAGMA busy_timeout = ${getDbBusyTimeoutMs()}`);
			db.run(`PRAGMA journal_mode=WAL;\nPRAGMA synchronous=NORMAL;\n${SESSION_INDEX_DDL}`);
			prepared.push(
				db.prepare(`
INSERT INTO session_titles (session_id, title, updated_at)
VALUES (?, ?, CAST(strftime('%s','now') AS INTEGER))
ON CONFLICT(session_id) DO UPDATE SET
	title = excluded.title,
	updated_at = excluded.updated_at
				`),
			);
			prepared.push(db.prepare("SELECT title FROM session_titles WHERE session_id = ?"));
			prepared.push(db.prepare("INSERT INTO session_recaps (session_id, cwd, recap) VALUES (?, ?, ?)"));
			index = {
				db,
				upsertTitle: prepared[0],
				selectTitle: prepared[1],
				insertRecap: prepared[2],
			};
		} catch (error) {
			for (const stmt of prepared) {
				try {
					stmt.finalize();
				} catch {}
			}
			db?.close();
			if (isSqliteBusyError(error)) return undefined;
			failedPath = dbPath;
			failedIdentity = sqliteFileIdentity(dbPath);
			if (failedPathUnregister) failedPathUnregister();
			const hook = onSqliteStoreQuarantine(dbPath, () => {
				if (failedPath === dbPath) {
					failedPath = undefined;
					failedIdentity = undefined;
				}
				failedPathUnregister = undefined;
				hook();
			});
			failedPathUnregister = hook;
			logger.warn("Session index unavailable", { dbPath, error: String(error) });
			return undefined;
		}

		failedPath = undefined;
		failedIdentity = undefined;
		failedPathUnregister?.();
		failedPathUnregister = undefined;
		try {
			return operation(index);
		} finally {
			for (const stmt of prepared) {
				try {
					stmt.finalize();
				} catch {}
			}
			db.close();
		}
	});
}

/**
 * Record (or replace) the indexed title for a session id. Best-effort: index
 * failures must never break a rename, so errors are logged and swallowed.
 */
export function recordSessionTitle(sessionId: string, title: string): void {
	try {
		withSessionIndex(index => index.upsertTitle.run(sessionId, title));
	} catch (error) {
		logger.debug("Session title index write failed", { sessionId, error: String(error) });
	}
}

/** Indexed title for a session id, or undefined when unindexed/unavailable. */
export function lookupSessionTitle(sessionId: string): string | undefined {
	try {
		return withSessionIndex(index => {
			const row = index.selectTitle.get(sessionId) as { title: string } | null;
			return row?.title ?? undefined;
		});
	} catch (error) {
		logger.debug("Session title index read failed", { sessionId, error: String(error) });
		return undefined;
	}
}

/**
 * Append an idle recap to the session's recap journal. Best-effort: a journal
 * failure must never disturb the recap display, so errors are logged and swallowed.
 */
export function recordSessionRecap(sessionId: string, cwd: string, recap: string): void {
	try {
		withSessionIndex(index => index.insertRecap.run(sessionId, cwd, recap));
	} catch (error) {
		logger.debug("Session recap journal write failed", { sessionId, error: String(error) });
	}
}

/** One journaled idle recap. */
export interface SessionRecap {
	sessionId: string;
	/** Working directory of the session that produced the recap. */
	cwd: string;
	recap: string;
	/** Unix seconds. */
	createdAt: number;
}

/** Narrows {@link listSessionRecaps}; omitted fields match everything. */
export interface SessionRecapQuery {
	/** Recaps of these sessions only; empty matches nothing. */
	sessionIds?: readonly string[];
	/** Recaps produced in this exact working directory. */
	cwd?: string;
	/** Maximum rows returned. */
	limit?: number;
}

interface SessionRecapRow {
	session_id: string;
	cwd: string;
	recap: string;
	created_at: number;
}

/**
 * Journaled recaps matching `query`, newest first. Best-effort like the
 * writers: an unavailable index or failed read yields an empty list.
 */
export function listSessionRecaps(query: SessionRecapQuery = {}): SessionRecap[] {
	if (query.sessionIds?.length === 0) return [];
	const where: string[] = [];
	const params: SQLQueryBindings[] = [];
	if (query.sessionIds) {
		where.push(`session_id IN (${query.sessionIds.map(() => "?").join(", ")})`);
		params.push(...query.sessionIds);
	}
	if (query.cwd !== undefined) {
		where.push("cwd = ?");
		params.push(query.cwd);
	}
	let sql = "SELECT session_id, cwd, recap, created_at FROM session_recaps";
	if (where.length > 0) sql += ` WHERE ${where.join(" AND ")}`;
	sql += " ORDER BY created_at DESC, id DESC";
	if (query.limit !== undefined) {
		sql += " LIMIT ?";
		params.push(query.limit);
	}
	try {
		return (
			withSessionIndex(index => {
				// Ad-hoc SQL (the IN list varies), so prepare and finalize per call.
				using statement = index.db.prepare(sql);
				return (statement.all(...params) as SessionRecapRow[]).map(row => ({
					sessionId: row.session_id,
					cwd: row.cwd,
					recap: row.recap,
					createdAt: row.created_at,
				}));
			}) ?? []
		);
	} catch (error) {
		logger.debug("Session recap journal read failed", { error: String(error) });
		return [];
	}
}

interface SessionTitleRow {
	session_id: string;
	title: string;
	updated_at: number;
}

interface SalvagedRecapRow extends SessionRecapRow {
	/** Decimal text, like history rowids: a number would round past 2^53 and break the rowid bind. */
	id: string;
}

export interface SalvagedSessionIndex {
	titles: SessionTitleRow[];
	recaps: SalvagedRecapRow[];
	damagedRegions: number;
}

/** Read independently of the replacement, so source damage cannot be mistaken for a failed target write. */
export function readSalvagedSessionIndex(source: Database): SalvagedSessionIndex {
	const tables = new Set(
		(source.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
			row => row.name,
		),
	);
	const titles = tables.has("session_titles")
		? readDamagedSqliteRows<SessionTitleRow>(
				source,
				"session_titles",
				"session_id, title, updated_at",
				"typeof(session_id) = 'text' AND typeof(title) = 'text' AND typeof(updated_at) = 'integer'",
			)
		: { rows: [], damagedRegions: 0 };
	const recaps = tables.has("session_recaps")
		? readDamagedSqliteRows<SalvagedRecapRow>(
				source,
				"session_recaps",
				"CAST(id AS TEXT) AS id, session_id, cwd, recap, created_at",
				"typeof(session_id) = 'text' AND typeof(cwd) = 'text' AND typeof(recap) = 'text' AND typeof(created_at) = 'integer'",
			)
		: { rows: [], damagedRegions: 0 };
	return { titles: titles.rows, recaps: recaps.rows, damagedRegions: titles.damagedRegions + recaps.damagedRegions };
}

/** Restore a source snapshot inside the caller's salvage transaction. Identical recaps are skipped so replaying an already-carried backup cannot duplicate them under a remapped id. */
export function restoreSalvagedSessionIndex(snapshot: SalvagedSessionIndex, target: Database): void {
	target.run(SESSION_INDEX_DDL);
	const insertTitle = target.query(`
INSERT INTO session_titles (session_id, title, updated_at) VALUES (?, ?, ?)
ON CONFLICT(session_id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at
WHERE excluded.updated_at > session_titles.updated_at
	`);
	const insertRecap = target.query(`
INSERT INTO session_recaps (id, session_id, cwd, recap, created_at)
SELECT CASE WHEN EXISTS (SELECT 1 FROM session_recaps WHERE id = CAST(?1 AS INTEGER)) THEN NULL ELSE CAST(?1 AS INTEGER) END, ?2, ?3, ?4, ?5
WHERE NOT EXISTS (
	SELECT 1 FROM session_recaps
	WHERE session_id = ?2 AND cwd = ?3 AND recap = ?4 AND created_at = ?5
)
	`);
	for (const row of snapshot.titles) insertTitle.run(row.session_id, row.title, row.updated_at);
	for (const row of snapshot.recaps) insertRecap.run(row.id, row.session_id, row.cwd, row.recap, row.created_at);
}

/** @internal Clear cached availability state — test-only. */
export function resetSessionIndexForTests(): void {
	failedPath = undefined;
	failedIdentity = undefined;
	failedPathUnregister?.();
	failedPathUnregister = undefined;
}
