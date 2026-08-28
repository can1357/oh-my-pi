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
	// Replication statements, prepared lazily on first sync use so the ordinary
	// record/lookup open path prepares nothing extra.
	// See scanChangedSinceForSessionIds/mergeRemote.
	scanScoped?: Statement;
	merge?: Statement;
}

let handle: TitleIndexHandle | undefined;
/** Db path whose open failed; skip retries (and log spam) until the path changes. */
let failedPath: string | undefined;

function closeHandle(): void {
	if (!handle) return;
	try {
		handle.upsert.finalize();
		handle.select.finalize();
		handle.scanScoped?.finalize();
		handle.merge?.finalize();
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

/** One replicated session-title row. `updatedAt` is epoch SECONDS (the table's clock). */
export interface TitleRow {
	sessionId: string;
	title: string;
	updatedAt: number;
}

/**
 * Project-scoped replication read path: session titles whose `updated_at` is
 * strictly greater than `afterRev` AND whose `session_id` is in `sessionIds`
 * (the ids belonging to sync-enabled projects), ordered ASCENDING so the sync
 * engine can advance its watermark to the last row's clock without skipping
 * entries.
 *
 * The intersection is applied BEFORE the page limit is satisfied: we page
 * through candidate rows in ascending `updated_at` order via OFFSET, collecting
 * matches until we have `limit` of them or rows are exhausted. This guarantees a
 * full page never comes back empty while eligible rows remain beyond it — an
 * all-filtered page would stall the sync watermark (the engine advances only to
 * the last RETURNED row's clock). Because we stop the instant we hit `limit`
 * matches, the last returned row is also the last one considered, so the
 * watermark advances correctly past every skipped row: either the page is full,
 * and the engine trims its trailing same-`rev` tie itself, or the candidate rows
 * ran out and every second the scan touched is complete.
 *
 * `afterRev`/`updatedAt` are epoch SECONDS (the domain adapter converts to the
 * wire's epoch-millis `rev`). Best-effort: swallows and logs failures.
 */
export function scanChangedSinceForSessionIds(
	afterRev: number,
	limit: number,
	sessionIds: ReadonlySet<string>,
): TitleRow[] {
	if (sessionIds.size === 0 || limit <= 0) return [];
	const index = openTitleIndex();
	if (!index) return [];
	try {
		index.scanScoped ??= index.db.prepare(
			"SELECT session_id, title, updated_at FROM session_titles WHERE updated_at > ? ORDER BY updated_at ASC, session_id ASC LIMIT ? OFFSET ?",
		);
		const stmt = index.scanScoped;
		// Candidate batch size for OFFSET paging; unrelated to the caller's match
		// budget. Large enough that a typical cycle needs one round trip.
		const BATCH = 500;
		const result: TitleRow[] = [];
		let offset = 0;
		for (;;) {
			const batch = stmt.all(afterRev, BATCH, offset) as Array<{
				session_id: string;
				title: string;
				updated_at: number;
			}>;
			for (const row of batch) {
				if (!sessionIds.has(row.session_id)) continue;
				result.push({ sessionId: row.session_id, title: row.title, updatedAt: row.updated_at });
				if (result.length >= limit) return result;
			}
			if (batch.length < BATCH) break; // rows exhausted
			offset += BATCH;
		}
		return result;
	} catch (error) {
		logger.debug("Session title index scoped scan failed", { error: String(error) });
		return [];
	}
}

/**
 * Replication merge path: last-writer-wins upsert of remote titles, preserving
 * the REMOTE `updated_at` so the clock stays comparable across machines. The
 * `WHERE excluded.updated_at > session_titles.updated_at` guard means an older
 * remote rename can never clobber a newer local one. Best-effort.
 */
export function mergeRemote(rows: Array<{ sessionId: string; title: string; updatedAt: number }>): void {
	const index = openTitleIndex();
	if (!index) return;
	try {
		index.merge ??= index.db.prepare(`
INSERT INTO session_titles (session_id, title, updated_at)
VALUES (?, ?, ?)
ON CONFLICT(session_id) DO UPDATE SET
	title = excluded.title,
	updated_at = excluded.updated_at
WHERE excluded.updated_at > session_titles.updated_at
		`);
		const merge = index.merge;
		index.db.transaction((batch: typeof rows) => {
			for (const row of batch) {
				merge.run(row.sessionId, row.title, row.updatedAt);
			}
		})(rows);
	} catch (error) {
		logger.debug("Session title index merge failed", { error: String(error) });
	}
}

/** @internal Close the cached connection so the next call re-resolves the db path — test-only. */
export function resetSessionTitleIndexForTests(): void {
	closeHandle();
	failedPath = undefined;
}
