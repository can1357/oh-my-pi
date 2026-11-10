/**
 * Removes the records a session leaves outside its transcript: submitted
 * prompts, the title and idle recaps in history.db, and ingested usage rows in
 * stats.db. Deleting a session and `omp gc` archiving it both purge through
 * here, so the set of records a gone session drops cannot drift between them.
 */
import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import { purgeSessionStats } from "@oh-my-pi/omp-stats/aggregator";
import { getHistoryDbPath, getSessionsDir, isEnoent, logger, tableExists, tableHasColumn } from "@oh-my-pi/pi-utils";
import { managedHistoricalSessionPaths, readSessionLineageHeader, type SessionLineageHeader } from "./session-loader";
import type { SessionStorage } from "./session-storage";

/**
 * Delete the history.db rows keyed to `sessionIds`: prompts, titles, and
 * recaps. `history_fts` has no delete trigger, so it is rebuilt when prompts
 * go. Tables an older release never created are skipped; the store must exist.
 */
export function purgeSessionHistory(
	dbPath: string,
	sessionIds: readonly string[],
): { deleted: number; ftsRebuilt: boolean } {
	if (sessionIds.length === 0) return { deleted: 0, ftsRebuilt: false };
	const db = new Database(dbPath);
	try {
		db.run("PRAGMA busy_timeout = 5000");
		const hasHistory = tableHasColumn(db, "history", "session_id");
		const hasRecaps = tableExists(db, "session_recaps");
		const hasTitles = tableExists(db, "session_titles");
		if (!hasHistory && !hasRecaps && !hasTitles) return { deleted: 0, ftsRebuilt: false };
		const hasFts = hasHistory && tableExists(db, "history_fts");
		// `using` finalizes each statement: an unfinalized one keeps history.db open after
		// close(), and Windows refuses to delete or replace a file that is still open.
		using deleteStmt = hasHistory ? db.prepare("DELETE FROM history WHERE session_id = ?") : undefined;
		// Recaps and titles are session-scoped side output with no life beyond their session.
		using deleteRecapsStmt = hasRecaps ? db.prepare("DELETE FROM session_recaps WHERE session_id = ?") : undefined;
		using deleteTitlesStmt = hasTitles ? db.prepare("DELETE FROM session_titles WHERE session_id = ?") : undefined;
		let deleted = 0;
		db.transaction(() => {
			for (const id of sessionIds) {
				deleteRecapsStmt?.run(id);
				deleteTitlesStmt?.run(id);
				if (deleteStmt) deleted += deleteStmt.run(id).changes;
			}
			if (deleted > 0 && hasFts) db.run("INSERT INTO history_fts(history_fts) VALUES('rebuild')");
		})();
		return { deleted, ftsRebuilt: deleted > 0 && hasFts };
	} finally {
		db.close();
	}
}

/** A deleted session as its records are keyed: history rows by id, stats rows by transcript path. */
export interface DeletedSession {
	path: string;
	id?: string;
	/** The header's `previousSessionFiles`: stats rows ingested before a `/move` keep those paths. */
	previousSessionFiles?: readonly string[];
}

/**
 * Purge the history.db and stats.db records of a deleted session. History rows
 * are kept when `id` is unknown; stats rows are purged for the transcript path,
 * its managed pre-move paths, and nested subagent transcripts under each.
 * Stores that do not exist are left uncreated. Best-effort: the transcript is
 * already gone, so a failure is logged rather than failing the delete.
 */
export async function purgeSessionRecords(session: DeletedSession): Promise<void> {
	const historyDbPath = getHistoryDbPath();
	if (session.id) {
		try {
			await fs.stat(historyDbPath);
			purgeSessionHistory(historyDbPath, [session.id]);
		} catch (error) {
			if (!isEnoent(error)) {
				logger.warn("Failed to purge deleted session history", { id: session.id, error: String(error) });
			}
		}
	}
	const statsPaths = [
		session.path,
		...managedHistoricalSessionPaths(session.previousSessionFiles ?? [], session.path, getSessionsDir()),
	];
	try {
		await purgeSessionStats(statsPaths);
	} catch (error) {
		logger.warn("Failed to purge deleted session stats", { path: session.path, error: String(error) });
	}
}

/**
 * Delete a session the user picked: transcript, artifacts, then its records.
 * The header is read first, since its pre-move paths are gone with the file.
 * The interactive pickers and `/session delete` call this; a live
 * `SessionManager` drops its own session through `dropSession` instead.
 */
export async function deleteSession(storage: SessionStorage, session: { path: string; id?: string }): Promise<void> {
	let header: SessionLineageHeader | undefined;
	try {
		header = await readSessionLineageHeader(session.path);
	} catch (error) {
		// The header only widens the purge; an unreadable one must not block the delete.
		if (!isEnoent(error))
			logger.warn("Failed to read deleted session header", { path: session.path, error: String(error) });
	}
	await storage.deleteSessionWithArtifacts(session.path);
	await purgeSessionRecords({
		path: session.path,
		id: session.id ?? header?.id,
		previousSessionFiles: header?.previousSessionFiles,
	});
}
