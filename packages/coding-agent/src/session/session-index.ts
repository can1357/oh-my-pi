/**
 * Per-session index tables in history.db, keyed by session id:
 *
 * - `session_titles`: session id → display title, written whenever a title is
 *   created or renamed ({@link SessionManager.setSessionName}) and backfilled by
 *   the recent-session fallback scan and the resume picker's full scan. Lets the
 *   welcome "Recent sessions" list resolve names from a stat + lookup, and the
 *   resume picker show its rows before reading any session file, instead of
 *   content-scanning every session file in the project directory (seconds on
 *   dirs with thousands of sessions). A title has no life beyond its session;
 *   `omp gc` drops rows of archived sessions.
 * - `session_recaps`: append-only journal of idle recaps
 *   ({@link SessionManager.recordRecap}). Recaps are side-channel output that
 *   never enters the session JSONL or LLM context; this table is their only
 *   durable record. `omp gc` drops rows of archived sessions.
 * - `session_lineage`: session id → `(parent_session_id, session_path, cwd)`,
 *   indexed by `parent_session_id` and `session_path` so parent/child lineage
 *   and preliminary picker metadata resolve in O(1) without scanning session
 *   files. `omp gc` drops rows of archived sessions.
 *
 * Holds its own lazily-opened connection instead of {@link HistoryStorage}'s
 * path-pinned singleton: the db path is re-resolved on every call so
 * `setAgentDir`/profile switches (and test isolation) transparently reopen
 * against the right file. Never versions the db — `PRAGMA user_version` is
 * owned by HistoryStorage's rebuild pass, which drops only its own tables.
 */
import type { Database, SQLQueryBindings, Statement } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	isEnoent,
	isEnotdir,
	isFullyQualifiedPath,
	isSqliteBusyError,
	openSqliteDatabaseSync,
	readSalvageableRows,
	sqliteFileIdentity,
	type SqliteFileIdentity,
	stripWindowsExtendedLengthPathPrefix,
} from "@oh-my-pi/pi-utils";
import { getHistoryDbPath, onAgentDirChange, relativePathWithinNormalizedRoot } from "@oh-my-pi/pi-utils/dirs";
import { getDbBusyTimeoutMs, isBunTestRuntime } from "@oh-my-pi/pi-utils/env";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { mapWithConcurrencyLimit } from "../task/parallel";
import { isRegularFile, isRegularFileMissing } from "../utils/regular-file";
import { parseSessionFileName, tryReadSessionHeaderId, tryReadSessionHeaderIdSync } from "./session-header";

const SESSION_INDEX_IO_CONCURRENCY = Math.max(1, Math.min(16, os.availableParallelism()));

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
CREATE TABLE IF NOT EXISTS session_lineage (
	session_id TEXT PRIMARY KEY,
	parent_session_id TEXT,
	session_path TEXT NOT NULL,
	cwd TEXT,
	updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
);
CREATE INDEX IF NOT EXISTS idx_session_lineage_parent ON session_lineage(parent_session_id);
CREATE INDEX IF NOT EXISTS idx_session_lineage_path ON session_lineage(session_path);
`;

const READABLE_LINEAGE_CLAUSE =
	"typeof(session_id) = 'text' AND (parent_session_id IS NULL OR typeof(parent_session_id) = 'text') AND typeof(session_path) = 'text' AND (cwd IS NULL OR typeof(cwd) = 'text') AND typeof(updated_at) = 'integer'";

interface SessionIndexHandle {
	dbPath: string;
	/** Identity of the file this handle is attached to; the path alone does not identify it after a quarantine. */
	identity: SqliteFileIdentity;
	db: Database;
	statements: Statement[];
	upsertTitle: Statement;
	selectTitle: Statement;
	insertRecap: Statement;
	upsertLineage: Statement;
	deleteLineageOtherIdAtPath: Statement;
	deleteLineageById: Statement;
	deleteLineageByPath: Statement;
	deleteLineageAtPath: Statement;
	repointLineageAtPath: Statement;
	selectLineageById: Statement;
	selectLineageByPath: Statement;
	selectLineageUnderPrefix: Statement;
	selectReadableLineageUnderPrefix: Statement;
	selectChildrenByParent: Statement;
	selectSessionIdByPath: Statement;
}

let handle: SessionIndexHandle | undefined;
/** Db path whose open failed; skip retries (and log spam) until the path changes. */
let failedPath: string | undefined;

function closeHandle(): void {
	if (!handle) return;
	try {
		for (const stmt of handle.statements) stmt.finalize();
		handle.db.close();
	} catch {}
	handle = undefined;
}

onAgentDirChange(() => {
	closeSessionIndex();
});

function openSessionIndex(): SessionIndexHandle | undefined {
	// A test run never writes the user's history.db: under the test runner the
	// index opens only an agent dir the test chose (`setAgentDir` exports
	// PI_CODING_AGENT_DIR). Otherwise every test naming a file-backed session
	// leaves a title row behind in the real index.
	if (isBunTestRuntime() && !process.env.PI_CODING_AGENT_DIR) return undefined;
	const dbPath = getHistoryDbPath();
	// A quarantined history.db is unlinked and recreated at the same path, so
	// the path alone still matches a handle pinned to the dead inode. Reopen
	// unless the file behind the path is still the one this handle was opened
	// on. An `undefined` identity means the stat itself failed: no conclusion
	// is safe there, so treat the handle as stale.
	if (handle?.dbPath === dbPath) {
		const identity = sqliteFileIdentity(dbPath);
		if (identity !== undefined && identity === handle.identity) return handle;
	}

	if (failedPath === dbPath) return undefined;
	closeHandle();
	try {
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		handle = openSqliteDatabaseSync(
			dbPath,
			db => {
				const statements: Statement[] = [];
				const prepare = (sql: string): Statement => {
					const stmt = db.prepare(sql);
					statements.push(stmt);
					return stmt;
				};
				try {
					db.run(SESSION_INDEX_DDL);
					return {
						dbPath,
						identity: sqliteFileIdentity(dbPath),
						db,
						statements,
						upsertTitle: prepare(`
INSERT INTO session_titles (session_id, title, updated_at)
VALUES (?, ?, CAST(strftime('%s','now') AS INTEGER))
ON CONFLICT(session_id) DO UPDATE SET
	title = excluded.title,
	updated_at = excluded.updated_at
						`),
						selectTitle: prepare(
							"SELECT title FROM session_titles WHERE session_id = ? AND typeof(title) = 'text'",
						),
						insertRecap: prepare("INSERT INTO session_recaps (session_id, cwd, recap) VALUES (?, ?, ?)"),
						upsertLineage: prepare(`
INSERT INTO session_lineage (session_id, parent_session_id, session_path, cwd, updated_at)
VALUES (?, ?, ?, ?, COALESCE(?, CAST(strftime('%s','now') AS INTEGER)))
ON CONFLICT(session_id) DO UPDATE SET
	parent_session_id = excluded.parent_session_id,
	session_path = excluded.session_path,
	cwd = CASE
		WHEN excluded.cwd IS NOT NULL THEN excluded.cwd
		WHEN session_lineage.session_path = excluded.session_path THEN session_lineage.cwd
		ELSE NULL
	END,
	updated_at = excluded.updated_at
						`),
						deleteLineageOtherIdAtPath: prepare(
							"DELETE FROM session_lineage WHERE session_path = ? AND session_id != ?",
						),
						deleteLineageById: prepare("DELETE FROM session_lineage WHERE session_id = ?"),
						deleteLineageByPath: prepare("DELETE FROM session_lineage WHERE session_path = ?"),
						deleteLineageAtPath: prepare("DELETE FROM session_lineage WHERE session_id = ? AND session_path = ?"),
						repointLineageAtPath: prepare(
							"UPDATE session_lineage SET session_path = ?, parent_session_id = ?, updated_at = CAST(strftime('%s','now') AS INTEGER) WHERE session_id = ? AND session_path = ?",
						),
						selectLineageById: prepare(
							`SELECT session_id, parent_session_id, session_path, cwd, updated_at FROM session_lineage WHERE session_id = ? AND ${READABLE_LINEAGE_CLAUSE}`,
						),
						selectLineageByPath: prepare(
							`SELECT session_id, parent_session_id, session_path, cwd, updated_at FROM session_lineage WHERE session_path = ? AND ${READABLE_LINEAGE_CLAUSE} ORDER BY updated_at DESC, session_id ASC LIMIT 1`,
						),
						selectLineageUnderPrefix: prepare(
							"SELECT session_id, parent_session_id, session_path FROM session_lineage WHERE session_path >= ? AND session_path < ? AND substr(session_path, 1, length(?)) = ? AND typeof(session_id) = 'text' AND (parent_session_id IS NULL OR typeof(parent_session_id) = 'text') AND typeof(session_path) = 'text'",
						),
						selectReadableLineageUnderPrefix: prepare(
							`SELECT session_id, parent_session_id, session_path, cwd, updated_at FROM session_lineage WHERE session_path >= ? AND session_path < ? AND substr(session_path, 1, length(?)) = ? AND ${READABLE_LINEAGE_CLAUSE}`,
						),
						selectChildrenByParent: prepare(
							`SELECT session_id, parent_session_id, session_path, cwd, updated_at FROM session_lineage WHERE parent_session_id = ? AND ${READABLE_LINEAGE_CLAUSE} ORDER BY updated_at DESC, session_id ASC`,
						),
						selectSessionIdByPath: prepare(
							"SELECT session_id FROM session_lineage WHERE session_path = ? AND typeof(session_id) = 'text' ORDER BY updated_at DESC LIMIT 1",
						),
					};
				} catch (error) {
					for (const stmt of statements) {
						try {
							stmt.finalize();
						} catch {}
					}
					throw error;
				}
			},
			{
				busyTimeoutMs: getDbBusyTimeoutMs(),
				journalMode: "WAL",
				synchronous: "NORMAL",
			},
		);
		failedPath = undefined;
		return handle;
	} catch (error) {
		// A busy store is transient (a peer process holds the lock), so it must
		// not latch the path as unusable for the rest of the session.
		if (isSqliteBusyError(error)) return undefined;
		failedPath = dbPath;
		logger.warn("Session index unavailable", { dbPath, error: String(error) });
		return undefined;
	}
}

/**
 * Record (or replace) the indexed title for a session id. Best-effort: index
 * failures must never break a rename, so errors are logged and swallowed.
 */
export function recordSessionTitle(sessionId: string, title: string): void {
	const index = openSessionIndex();
	if (!index) return;
	try {
		index.upsertTitle.run(sessionId, title);
	} catch (error) {
		logger.debug("Session title index write failed", { sessionId, error: String(error) });
	}
}

/**
 * Record (or replace) many indexed titles in one transaction, so a picker
 * scan backfilling thousands of sessions pays one commit instead of one per
 * row. Best-effort like {@link recordSessionTitle}.
 */
export function recordSessionTitles(titles: ReadonlyMap<string, string>): void {
	if (titles.size === 0) return;
	const index = openSessionIndex();
	if (!index) return;
	try {
		index.db
			.transaction(() => {
				for (const [sessionId, title] of titles) index.upsertTitle.run(sessionId, title);
			})
			.immediate();
	} catch (error) {
		logger.debug("Session title index write failed", { count: titles.size, error: String(error) });
	}
}

/**
 * Every indexed title by session id, in one query: the resume picker
 * pre-populates its rows from it before any session file is read. Empty when
 * the index is unavailable or unreadable.
 */
export function listSessionTitles(): Map<string, string> {
	const titles = new Map<string, string>();
	const index = openSessionIndex();
	if (!index) return titles;
	try {
		// A damaged page can decode foreign bytes into these columns; never hand them to callers.
		using statement = index.db.prepare<{ session_id: string; title: string }, []>(
			"SELECT session_id, title FROM session_titles WHERE typeof(session_id) = 'text' AND typeof(title) = 'text'",
		);
		for (const row of statement.iterate()) titles.set(row.session_id, row.title);
	} catch (error) {
		logger.debug("Session title index read failed", { error: String(error) });
	}
	return titles;
}

/** Indexed title for a session id, or undefined when unindexed/unavailable. */
export function lookupSessionTitle(sessionId: string): string | undefined {
	const index = openSessionIndex();
	if (!index) return undefined;
	try {
		const row = index.selectTitle.get(sessionId) as { title: string } | null;
		return row?.title ?? undefined;
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
	const index = openSessionIndex();
	if (!index) return;
	try {
		index.insertRecap.run(sessionId, cwd, recap);
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
	const index = openSessionIndex();
	if (!index) return [];
	// A damaged page can decode foreign bytes into these columns; never hand them to callers.
	const where = ["typeof(recap) = 'text'", "typeof(cwd) = 'text'", "typeof(created_at) = 'integer'"];
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
		// Ad-hoc SQL (the IN list varies), so prepare and finalize per call
		// instead of growing the connection's statement cache.
		using statement = index.db.prepare(sql);
		return (statement.all(...params) as SessionRecapRow[]).map(row => ({
			sessionId: row.session_id,
			cwd: row.cwd,
			recap: row.recap,
			createdAt: row.created_at,
		}));
	} catch (error) {
		logger.debug("Session recap journal read failed", { error: String(error) });
		return [];
	}
}

/** Indexed lineage record for one session. */
export interface SessionLineage {
	sessionId: string;
	parentSessionId: string | null;
	sessionPath: string;
	cwd: string | null;
	/** Unix seconds. */
	updatedAt: number;
}

/** Input passed to {@link recordSessionLineage} and {@link recordSessionLineages}. */
export interface SessionLineageEntry {
	sessionId: string;
	/** Parent session id or parent `.jsonl` path from `SessionHeader.parentSession`. */
	parentSession?: string | null;
	sessionPath: string;
	cwd?: string | null;
	/** Optional explicit Unix seconds timestamp (used when restoring snapshotted rows). */
	updatedAt?: number;
}

interface SessionLineageRow {
	session_id: string;
	parent_session_id: string | null;
	session_path: string;
	cwd: string | null;
	updated_at: number;
}

function toSessionLineage(row: SessionLineageRow): SessionLineage {
	return {
		sessionId: row.session_id,
		parentSessionId: row.parent_session_id,
		sessionPath: row.session_path,
		cwd: row.cwd,
		updatedAt: row.updated_at,
	};
}

export function isSessionPathReference(reference: string): boolean {
	return reference.endsWith(".jsonl") || reference.includes("/") || reference.includes("\\");
}

function isForeignWindowsAbsolutePath(filePath: string): boolean {
	if (process.platform === "win32") return false;
	const stripped = stripWindowsExtendedLengthPathPrefix(filePath.trim(), "win32");
	return !stripped.startsWith("/") && isFullyQualifiedPath(stripped, "win32");
}

/**
 * Resolve `filePath` as a local host path, or `undefined` when it is a foreign
 * Windows drive/UNC path on POSIX (which `path.resolve` would wrongly join onto
 * `process.cwd()`).
 */
export function resolveLocalSessionPath(filePath: string): string | undefined {
	const trimmed = filePath.trim();
	if (!trimmed || isForeignWindowsAbsolutePath(trimmed)) return undefined;
	return path.resolve(trimmed);
}

export function normalizeSessionCwd(cwd: string): string {
	const trimmed = cwd.trim();
	if (!trimmed) return "";
	return isForeignWindowsAbsolutePath(trimmed) ? trimmed : path.resolve(trimmed);
}

function normalizeLexicalSessionPath(filePath: string): string {
	const trimmed = filePath.trim();
	if (isForeignWindowsAbsolutePath(trimmed)) {
		const stripped = stripWindowsExtendedLengthPathPrefix(trimmed, "win32");
		return path.posix.resolve("/", stripped.replaceAll("\\", "/"));
	}
	return path.resolve(trimmed);
}

interface ParentLookupContext {
	forSessionId?: string;
	sessionPath?: string;
	lookupPathId: (resolvedPath: string) => string | undefined;
	readHeaderId?: (resolvedPath: string) => string | undefined;
	lookupExistingParentId?: () => string | null | undefined;
}

function resolveSessionOwnerAtArtifactDir(
	artifactDir: string,
	lookupPathId: (resolvedPath: string) => string | undefined,
	readHeaderId: (resolvedPath: string) => string | undefined,
): string | undefined {
	const ownerTranscript = `${artifactDir}.jsonl`;
	return lookupPathId(ownerTranscript) ?? readHeaderId(ownerTranscript) ?? parseSessionFileName(ownerTranscript)?.id;
}

function resolveRelocatedArtifactParentId(
	resolvedParentPath: string,
	resolvedSessionPath: string,
	lookupPathId: (resolvedPath: string) => string | undefined,
	readHeaderId: (resolvedPath: string) => string | undefined,
): string | undefined {
	const parentBase = path.basename(resolvedParentPath);
	for (
		let ancNew = path.dirname(resolvedSessionPath);
		path.dirname(ancNew) !== ancNew;
		ancNew = path.dirname(ancNew)
	) {
		const ownerTranscript = `${ancNew}.jsonl`;
		if (path.basename(ownerTranscript) === parentBase && ownerTranscript !== resolvedSessionPath) {
			const directId = lookupPathId(ownerTranscript) ?? readHeaderId(ownerTranscript);
			if (directId) return directId;
		}

		const newOwnerId = resolveSessionOwnerAtArtifactDir(ancNew, lookupPathId, readHeaderId);
		if (!newOwnerId) continue;

		const artifactDirName = path.basename(ancNew);
		for (
			let ancOld = path.dirname(resolvedParentPath);
			path.dirname(ancOld) !== ancOld;
			ancOld = path.dirname(ancOld)
		) {
			if (path.basename(ancOld) !== artifactDirName) continue;
			const oldGeneratedOwnerId = parseSessionFileName(`${ancOld}.jsonl`)?.id;
			if (oldGeneratedOwnerId && oldGeneratedOwnerId !== newOwnerId) continue;
			const relParent = relativePathWithinNormalizedRoot(ancOld, resolvedParentPath);
			if (!relParent) continue;
			const relocatedParentPath = path.resolve(ancNew, relParent);
			if (relocatedParentPath === resolvedSessionPath) continue;
			const relocatedId = lookupPathId(relocatedParentPath) ?? readHeaderId(relocatedParentPath);
			if (relocatedId) return relocatedId;
		}
	}
	return undefined;
}

function resolveRenamedRootArtifactParentId(
	resolvedParentPath: string,
	resolvedSessionPath: string,
	lookupPathId: (resolvedPath: string) => string | undefined,
	readHeaderId: (resolvedPath: string) => string | undefined,
): string | undefined {
	let rootAncNew: string | undefined;
	let rootOwnerId: string | undefined;
	for (
		let ancNew = path.dirname(resolvedSessionPath);
		path.dirname(ancNew) !== ancNew;
		ancNew = path.dirname(ancNew)
	) {
		const ownerId = resolveSessionOwnerAtArtifactDir(ancNew, lookupPathId, readHeaderId);
		if (ownerId) {
			rootAncNew = ancNew;
			rootOwnerId = ownerId;
		}
	}
	if (!rootAncNew || !rootOwnerId) return undefined;

	const relSession = relativePathWithinNormalizedRoot(rootAncNew, resolvedSessionPath);
	if (!relSession) return undefined;
	const maxAncSteps = Math.min(4, relSession.split(path.sep).length);
	for (
		let ancOld = path.dirname(resolvedParentPath), step = 0;
		step < maxAncSteps && path.dirname(ancOld) !== ancOld;
		ancOld = path.dirname(ancOld), step++
	) {
		const oldGeneratedOwnerId = parseSessionFileName(`${ancOld}.jsonl`)?.id;
		if (oldGeneratedOwnerId && oldGeneratedOwnerId !== rootOwnerId) continue;
		const relParent = relativePathWithinNormalizedRoot(ancOld, resolvedParentPath);
		if (!relParent) continue;
		const relocatedParentPath = path.resolve(rootAncNew, relParent);
		if (relocatedParentPath === resolvedSessionPath) continue;
		const relocatedId = lookupPathId(relocatedParentPath) ?? readHeaderId(relocatedParentPath);
		if (relocatedId) return relocatedId;
	}

	return undefined;
}

function resolveParentSessionIdWithLookup(
	parentSession: string | null | undefined,
	context: ParentLookupContext,
): string | null {
	const trimmed = parentSession?.trim();
	if (!trimmed) return null;
	if (!isSessionPathReference(trimmed)) return trimmed;
	const readHeaderId = context.readHeaderId ?? tryReadSessionHeaderIdSync;
	const localPath = resolveLocalSessionPath(trimmed);
	if (localPath) {
		const mapped = context.lookupPathId(localPath);
		if (mapped) return mapped;
		const headerId = readHeaderId(localPath);
		if (headerId) return headerId;
	}
	const generated = parseSessionFileName(trimmed);
	if (generated?.id) return generated.id;
	const lexicalParentPath = normalizeLexicalSessionPath(trimmed);
	const localSessionPath = context.sessionPath ? resolveLocalSessionPath(context.sessionPath) : undefined;
	if (localSessionPath) {
		const relocatedId = resolveRelocatedArtifactParentId(
			lexicalParentPath,
			localSessionPath,
			context.lookupPathId,
			readHeaderId,
		);
		if (relocatedId && relocatedId !== context.forSessionId) return relocatedId;
	}
	const existingParentId = context.lookupExistingParentId?.()?.trim();
	if (existingParentId && !isSessionPathReference(existingParentId) && existingParentId !== context.forSessionId) {
		return existingParentId;
	}
	if (localSessionPath) {
		const renamedRootId = resolveRenamedRootArtifactParentId(
			lexicalParentPath,
			localSessionPath,
			context.lookupPathId,
			readHeaderId,
		);
		if (renamedRootId && renamedRootId !== context.forSessionId) return renamedRootId;
	}
	return trimmed;
}

function resolveParentSessionId(
	index: SessionIndexHandle,
	parentSession: string | null | undefined,
	batchPathToId?: ReadonlyMap<string, string>,
	forSessionId?: string,
	sessionPath?: string,
	readHeaderId?: (resolvedPath: string) => string | undefined,
): string | null {
	return resolveParentSessionIdWithLookup(parentSession, {
		forSessionId,
		sessionPath,
		readHeaderId,
		lookupPathId: resolvedPath => {
			const fromBatch = batchPathToId?.get(resolvedPath);
			if (fromBatch) return fromBatch;
			const indexed = index.selectSessionIdByPath.get(resolvedPath) as { session_id: string } | null;
			return indexed?.session_id || undefined;
		},
		lookupExistingParentId: forSessionId
			? () => (index.selectLineageById.get(forSessionId) as SessionLineageRow | null)?.parent_session_id
			: undefined,
	});
}

export interface ResolveParentSessionOptions {
	forSessionId?: string;
	sessionPath?: string;
	existingParentSessionId?: string | null;
	batchPathToId?: ReadonlyMap<string, string>;
	indexedPathToId?: ReadonlyMap<string, string>;
	readHeaderId?: (resolvedPath: string) => string | undefined;
}

/**
 * Resolve a `SessionHeader.parentSession` value (either a session id or `.jsonl`
 * path) to the normalized `parent_session_id` persisted by {@link recordSessionLineage}.
 */
export function resolveParentSessionReference(
	parentSession: string | null | undefined,
	options?: ResolveParentSessionOptions,
): string | null {
	const resolved = resolveParentSessionIdWithLookup(parentSession, {
		forSessionId: options?.forSessionId,
		sessionPath: options?.sessionPath,
		readHeaderId: options?.readHeaderId,
		lookupPathId: resolvedPath => {
			const fromBatch = options?.batchPathToId?.get(resolvedPath);
			if (fromBatch) return fromBatch;
			if (options?.indexedPathToId !== undefined) {
				return options.indexedPathToId.get(resolvedPath);
			}
			const index = openSessionIndex();
			if (!index) return undefined;
			try {
				const indexed = index.selectSessionIdByPath.get(resolvedPath) as { session_id: string } | null;
				return indexed?.session_id || undefined;
			} catch {
				return undefined;
			}
		},
		lookupExistingParentId: () => {
			if (options?.existingParentSessionId !== undefined) return options.existingParentSessionId;
			if (!options?.forSessionId) return undefined;
			const index = openSessionIndex();
			if (!index) return undefined;
			try {
				return (index.selectLineageById.get(options.forSessionId) as SessionLineageRow | null)?.parent_session_id;
			} catch {
				return undefined;
			}
		},
	});
	return options?.forSessionId && resolved === options.forSessionId ? null : resolved;
}

/**
 * Pre-read any unindexed parent/owner session headers needed to resolve `probes`
 * so subsequent {@link resolveParentSessionReference} or {@link recordSessionLineages}
 * calls run without synchronous filesystem reads.
 */
export async function prefetchParentHeaderIds(
	probes: ReadonlyArray<{
		parentSession: string | null | undefined;
		forSessionId?: string;
		sessionPath?: string;
		existingParentSessionId?: string | null;
		batchPathToId?: ReadonlyMap<string, string>;
		indexedPathToId?: ReadonlyMap<string, string>;
	}>,
	concurrency = SESSION_INDEX_IO_CONCURRENCY,
): Promise<Map<string, string | undefined>> {
	const headerIdCache = new Map<string, string | undefined>();
	for (let pass = 0; pass < 3; pass++) {
		const uncachedPaths = new Set<string>();
		for (const probe of probes) {
			const rawParent = probe.parentSession?.trim() || null;
			if (!rawParent || !isSessionPathReference(rawParent)) continue;
			resolveParentSessionReference(rawParent, {
				forSessionId: probe.forSessionId,
				sessionPath: probe.sessionPath,
				existingParentSessionId: probe.existingParentSessionId,
				batchPathToId: probe.batchPathToId,
				indexedPathToId: probe.indexedPathToId,
				readHeaderId: p => {
					if (headerIdCache.has(p)) return headerIdCache.get(p);
					uncachedPaths.add(p);
					return undefined;
				},
			});
		}
		if (uncachedPaths.size === 0) break;
		const paths = [...uncachedPaths];
		const fetched = await mapWithConcurrencyLimit(paths, concurrency, p => tryReadSessionHeaderId(p));
		for (let i = 0; i < paths.length; i++) {
			headerIdCache.set(paths[i], fetched.results[i]);
		}
	}
	return headerIdCache;
}

function writeLineageRow(
	index: SessionIndexHandle,
	entry: SessionLineageEntry,
	batchPathToId?: ReadonlyMap<string, string>,
	readHeaderId?: (resolvedPath: string) => string | undefined,
): void {
	if (!entry.sessionId || !entry.sessionPath) return;
	const sessionPath = path.resolve(entry.sessionPath);
	const parentSessionId = resolveParentSessionId(
		index,
		entry.parentSession,
		batchPathToId,
		entry.sessionId,
		sessionPath,
		readHeaderId,
	);
	const cwd = entry.cwd ? normalizeSessionCwd(entry.cwd) || null : null;
	const updatedAt = entry.updatedAt !== undefined && Number.isSafeInteger(entry.updatedAt) ? entry.updatedAt : null;
	index.deleteLineageOtherIdAtPath.run(sessionPath, entry.sessionId);
	index.upsertLineage.run(
		entry.sessionId,
		parentSessionId === entry.sessionId ? null : parentSessionId,
		sessionPath,
		cwd,
		updatedAt,
	);
}

function prewarmParentHeaderIdsSync(
	index: SessionIndexHandle,
	entries: readonly SessionLineageEntry[],
	batchPathToId?: ReadonlyMap<string, string>,
): (resolvedPath: string) => string | undefined {
	const headerIdCache = new Map<string, string | undefined>();
	for (let pass = 0; pass < 3; pass++) {
		const uncachedPaths = new Set<string>();
		for (const entry of entries) {
			if (!entry.sessionId || !entry.sessionPath) continue;
			const rawParent = entry.parentSession?.trim() || null;
			if (!rawParent || !isSessionPathReference(rawParent)) continue;
			resolveParentSessionId(
				index,
				rawParent,
				batchPathToId,
				entry.sessionId,
				path.resolve(entry.sessionPath),
				p => {
					if (headerIdCache.has(p)) return headerIdCache.get(p);
					uncachedPaths.add(p);
					return undefined;
				},
			);
		}
		if (uncachedPaths.size === 0) break;
		for (const p of uncachedPaths) {
			headerIdCache.set(p, tryReadSessionHeaderIdSync(p));
		}
	}
	return p => headerIdCache.get(p);
}

/**
 * Record (or update) `(session_id, parent_session_id, session_path, cwd)` in
 * `session_lineage`. Best-effort: index failures never fail session persistence.
 */
export function recordSessionLineage(
	entry: SessionLineageEntry,
	options?: { readHeaderId?: (resolvedPath: string) => string | undefined },
): void {
	if (!entry.sessionId || !entry.sessionPath) return;
	const index = openSessionIndex();
	if (!index) return;
	try {
		const readHeaderId = options?.readHeaderId ?? prewarmParentHeaderIdsSync(index, [entry]);
		index.db
			.transaction(() => {
				writeLineageRow(index, entry, undefined, readHeaderId);
			})
			.immediate();
	} catch (error) {
		logger.debug("Session lineage index write failed", { sessionId: entry.sessionId, error: String(error) });
	}
}

/**
 * Asynchronous counterpart to {@link recordSessionLineage} that pre-reads any
 * unindexed parent/owner headers off the event loop before entering SQLite.
 */
export async function recordSessionLineageAsync(
	entry: SessionLineageEntry,
	options?: { commitGuard?: () => boolean },
): Promise<void> {
	if (!entry.sessionId || !entry.sessionPath) return;
	if (options?.commitGuard && !options.commitGuard()) return;
	const rawParent = entry.parentSession?.trim() || null;
	if (!rawParent || !isSessionPathReference(rawParent)) {
		recordSessionLineage(entry, { readHeaderId: () => undefined });
		return;
	}
	const headerIdCache = await prefetchParentHeaderIds([
		{
			parentSession: rawParent,
			forSessionId: entry.sessionId,
			sessionPath: entry.sessionPath,
		},
	]);
	if (options?.commitGuard && !options.commitGuard()) return;
	recordSessionLineage(entry, { readHeaderId: p => headerIdCache.get(p) });
}

/**
 * Record (or update) many session lineage entries in a single transaction.
 */
export function recordSessionLineages(
	entries: readonly SessionLineageEntry[],
	options?: { readHeaderId?: (resolvedPath: string) => string | undefined },
): void {
	if (entries.length === 0) return;
	const index = openSessionIndex();
	if (!index) return;
	try {
		const batchPathToId = new Map<string, string>();
		for (const entry of entries) {
			if (entry.sessionId && entry.sessionPath) {
				batchPathToId.set(path.resolve(entry.sessionPath), entry.sessionId);
			}
		}
		const readHeaderId = options?.readHeaderId ?? prewarmParentHeaderIdsSync(index, entries, batchPathToId);
		index.db
			.transaction(() => {
				for (const entry of entries) writeLineageRow(index, entry, batchPathToId, readHeaderId);
			})
			.immediate();
	} catch (error) {
		logger.debug("Session lineage index write failed", { count: entries.length, error: String(error) });
	}
}

/**
 * Asynchronous counterpart to {@link recordSessionLineages} that pre-reads any
 * unindexed parent/owner headers off the event loop before entering SQLite.
 */
export async function recordSessionLineagesAsync(entries: readonly SessionLineageEntry[]): Promise<void> {
	if (entries.length === 0) return;
	const batchPathToId = new Map<string, string>();
	for (const entry of entries) {
		if (entry.sessionId && entry.sessionPath) {
			batchPathToId.set(path.resolve(entry.sessionPath), entry.sessionId);
		}
	}
	const probes = entries
		.filter(entry => {
			const rawParent = entry.parentSession?.trim() || null;
			return Boolean(entry.sessionId && entry.sessionPath && rawParent && isSessionPathReference(rawParent));
		})
		.map(entry => ({
			parentSession: entry.parentSession,
			forSessionId: entry.sessionId,
			sessionPath: entry.sessionPath,
			batchPathToId,
		}));
	if (probes.length === 0) {
		recordSessionLineages(entries, { readHeaderId: () => undefined });
		return;
	}
	const headerIdCache = await prefetchParentHeaderIds(probes);
	recordSessionLineages(entries, { readHeaderId: p => headerIdCache.get(p) });
}

/**
 * Indexed lineage for `sessionIdOrPath` (either a session id or `.jsonl` path),
 * or `undefined` when unindexed or unavailable.
 */
export function getSessionLineage(
	sessionIdOrPath: string,
	options?: { readHeaderId?: (resolvedPath: string) => string | undefined },
): SessionLineage | undefined {
	const trimmed = sessionIdOrPath.trim();
	if (!trimmed) return undefined;
	const index = openSessionIndex();
	if (!index) return undefined;
	try {
		if (!isSessionPathReference(trimmed)) {
			const byId = index.selectLineageById.get(trimmed) as SessionLineageRow | null;
			return byId ? toSessionLineage(byId) : undefined;
		}
		const localPath = resolveLocalSessionPath(trimmed);
		if (localPath) {
			const byPath = index.selectLineageByPath.get(localPath) as SessionLineageRow | null;
			if (byPath) return toSessionLineage(byPath);
			const readHeaderId = options?.readHeaderId ?? tryReadSessionHeaderIdSync;
			const headerId = readHeaderId(localPath);
			if (headerId) {
				const byHeaderId = index.selectLineageById.get(headerId) as SessionLineageRow | null;
				return byHeaderId ? toSessionLineage(byHeaderId) : undefined;
			}
		}
		const generated = parseSessionFileName(trimmed);
		if (generated?.id) {
			const byGeneratedId = index.selectLineageById.get(generated.id) as SessionLineageRow | null;
			if (byGeneratedId) return toSessionLineage(byGeneratedId);
		}
		const byLiteralId = index.selectLineageById.get(trimmed) as SessionLineageRow | null;
		return byLiteralId ? toSessionLineage(byLiteralId) : undefined;
	} catch (error) {
		logger.debug("Session lineage index read failed", { sessionIdOrPath, error: String(error) });
		return undefined;
	}
}

/**
 * Direct child sessions whose `parent_session_id` resolves to `parentSessionIdOrPath`,
 * newest `updated_at` first, resolved in O(1) via `idx_session_lineage_parent`.
 */
export function getChildSessions(parentSessionIdOrPath: string): SessionLineage[] {
	const trimmed = parentSessionIdOrPath.trim();
	if (!trimmed) return [];
	const index = openSessionIndex();
	if (!index) return [];
	try {
		const parentId = resolveParentSessionId(index, trimmed);
		if (!parentId) return [];
		const rows = index.selectChildrenByParent.all(parentId) as SessionLineageRow[];
		return rows.map(toSessionLineage);
	} catch (error) {
		logger.debug("Session lineage children read failed", { parentSessionIdOrPath, error: String(error) });
		return [];
	}
}

/**
 * Every indexed lineage record keyed by `sessionId`, loaded in one query.
 */
export function listSessionLineages(): Map<string, SessionLineage> {
	const lineages = new Map<string, SessionLineage>();
	const index = openSessionIndex();
	if (!index) return lineages;
	try {
		using statement = index.db.prepare<SessionLineageRow, []>(
			`SELECT session_id, parent_session_id, session_path, cwd, updated_at FROM session_lineage WHERE ${READABLE_LINEAGE_CLAUSE}`,
		);
		for (const row of statement.iterate()) {
			lineages.set(row.session_id, toSessionLineage(row));
		}
	} catch (error) {
		logger.debug("Session lineage index read failed", { error: String(error) });
	}
	return lineages;
}

function openExistingSessionIndex(): SessionIndexHandle | undefined {
	if (isBunTestRuntime() && !process.env.PI_CODING_AGENT_DIR) return undefined;
	const dbPath = getHistoryDbPath();
	if (handle?.dbPath !== dbPath && !fs.existsSync(dbPath)) return undefined;
	return openSessionIndex();
}

async function openExistingSessionIndexAsync(): Promise<SessionIndexHandle | undefined> {
	if (isBunTestRuntime() && !process.env.PI_CODING_AGENT_DIR) return undefined;
	const dbPath = getHistoryDbPath();
	if (handle?.dbPath !== dbPath && !(await isRegularFile(dbPath))) return undefined;
	return openSessionIndex();
}

/** Delete the lineage entry for `sessionId`, if present. */
export function deleteSessionLineage(sessionId: string): void {
	if (!sessionId) return;
	const index = openExistingSessionIndex();
	if (!index) return;
	try {
		index.deleteLineageById.run(sessionId);
	} catch (error) {
		logger.debug("Session lineage delete failed", { sessionId, error: String(error) });
	}
}

/** Delete any lineage entry pointing at `sessionPath`, if present. */
export async function deleteSessionLineageByPath(sessionPath: string): Promise<void> {
	if (!sessionPath) return;
	const index = await openExistingSessionIndexAsync();
	if (!index) return;
	try {
		index.deleteLineageByPath.run(path.resolve(sessionPath));
	} catch (error) {
		logger.debug("Session lineage delete failed", { sessionPath, error: String(error) });
	}
}

export interface DirectoryPathPrefixBounds {
	root: string;
	prefix: string;
	upper: string;
}

/**
 * Exact path-boundary range `[prefix, upper)` for paths strictly inside `dir`
 * (`resolvedDir + path.sep`), so `/dir/sess` never matches `/dir/sess-other/...`.
 */
export function directoryPathPrefixBounds(dir: string): DirectoryPathPrefixBounds | null {
	if (!dir) return null;
	const root = path.resolve(dir);
	if (path.dirname(root) === root) return null;
	const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
	const lastCode = prefix.charCodeAt(prefix.length - 1);
	const upper = `${prefix.slice(0, -1)}${String.fromCharCode(lastCode + 1)}`;
	return { root, prefix, upper };
}

interface PrefixLineageRow {
	session_id: string;
	parent_session_id: string | null;
	session_path: string;
}

async function wasTranscriptRelocatedTo(oldPath: string, newPath: string, sessionId: string): Promise<boolean> {
	let newStat: fs.Stats;
	try {
		newStat = await fs.promises.stat(newPath);
	} catch {
		return false;
	}
	if (!newStat.isFile()) return false;

	let sourceMoved = false;
	try {
		const oldStat = await fs.promises.stat(oldPath);
		sourceMoved =
			!oldStat.isFile() || (newStat.ino !== 0 && oldStat.dev === newStat.dev && oldStat.ino === newStat.ino);
	} catch (error) {
		sourceMoved = isEnoent(error) || isEnotdir(error);
	}
	if (!sourceMoved) return false;

	const destHeaderId = await tryReadSessionHeaderId(newPath);
	return destHeaderId === undefined || destHeaderId === sessionId;
}

/**
 * Repoint indexed `session_lineage` rows strictly inside `oldDir` to their
 * relocated paths under `newDir`, updating only transcripts confirmed at their
 * destination path (leaving collided or stranded entries on their old path).
 */
export async function repointSessionLineageUnderDirectory(oldDir: string, newDir: string): Promise<void> {
	const oldBounds = directoryPathPrefixBounds(oldDir);
	const newBounds = directoryPathPrefixBounds(newDir);
	if (!oldBounds || !newBounds || oldBounds.root === newBounds.root) return;
	const readIndex = await openExistingSessionIndexAsync();
	if (!readIndex) return;
	try {
		const rows = readIndex.selectLineageUnderPrefix.all(
			oldBounds.prefix,
			oldBounds.upper,
			oldBounds.prefix,
			oldBounds.prefix,
		) as PrefixLineageRow[];
		if (rows.length === 0) return;

		const candidates: Array<{
			sessionId: string;
			parentSessionId: string | null;
			fromPath: string;
			toPath: string;
		}> = [];
		for (const row of rows) {
			const rel = relativePathWithinNormalizedRoot(oldBounds.root, path.resolve(row.session_path));
			if (!rel) continue;
			const toPath = path.resolve(newBounds.root, rel);
			if (toPath === row.session_path) continue;
			candidates.push({
				sessionId: row.session_id,
				parentSessionId: row.parent_session_id,
				fromPath: row.session_path,
				toPath,
			});
		}
		if (candidates.length === 0) return;

		const checks = await mapWithConcurrencyLimit(candidates, SESSION_INDEX_IO_CONCURRENCY, candidate =>
			wasTranscriptRelocatedTo(candidate.fromPath, candidate.toPath, candidate.sessionId),
		);
		const relocated: typeof candidates = [];
		const movedPathToId = new Map<string, string>();
		for (let i = 0; i < candidates.length; i++) {
			if (!checks.results[i]) continue;
			const candidate = candidates[i];
			relocated.push(candidate);
			movedPathToId.set(candidate.fromPath, candidate.sessionId);
		}
		if (relocated.length === 0) return;

		const parentProbes = relocated
			.filter(item => {
				if (item.parentSessionId === null || !isSessionPathReference(item.parentSessionId)) return false;
				const localParent = resolveLocalSessionPath(item.parentSessionId);
				return !localParent || !movedPathToId.has(localParent);
			})
			.map(item => ({
				parentSession: item.parentSessionId,
				forSessionId: item.sessionId,
				sessionPath: item.toPath,
				batchPathToId: movedPathToId,
			}));
		const headerIdCache =
			parentProbes.length > 0
				? await prefetchParentHeaderIds(parentProbes, SESSION_INDEX_IO_CONCURRENCY)
				: new Map<string, string | undefined>();
		const readCachedHeaderId = (p: string): string | undefined => movedPathToId.get(p) ?? headerIdCache.get(p);

		const writeIndex = await openExistingSessionIndexAsync();
		if (!writeIndex) return;
		writeIndex.db
			.transaction(() => {
				for (const item of relocated) {
					const localParent =
						item.parentSessionId && isSessionPathReference(item.parentSessionId)
							? resolveLocalSessionPath(item.parentSessionId)
							: undefined;
					const nextParentId =
						item.parentSessionId && isSessionPathReference(item.parentSessionId)
							? ((localParent ? movedPathToId.get(localParent) : undefined) ??
								resolveParentSessionId(
									writeIndex,
									item.parentSessionId,
									movedPathToId,
									item.sessionId,
									item.toPath,
									readCachedHeaderId,
								))
							: item.parentSessionId;
					const normalizedParent = nextParentId === item.sessionId ? null : nextParentId;
					const result = writeIndex.repointLineageAtPath.run(
						item.toPath,
						normalizedParent,
						item.sessionId,
						item.fromPath,
					);
					if (Number(result.changes) > 0) {
						writeIndex.deleteLineageOtherIdAtPath.run(item.toPath, item.sessionId);
					}
				}
			})
			.immediate();
	} catch (error) {
		logger.debug("Session lineage directory repoint failed", { oldDir, newDir, error: String(error) });
	}
}

/**
 * Readable indexed `session_lineage` rows strictly inside `dir`.
 */
export async function listSessionLineagesUnderDirectory(dir: string): Promise<SessionLineage[]> {
	const bounds = directoryPathPrefixBounds(dir);
	if (!bounds) return [];
	const index = await openExistingSessionIndexAsync();
	if (!index) return [];
	try {
		const rows = index.selectReadableLineageUnderPrefix.all(
			bounds.prefix,
			bounds.upper,
			bounds.prefix,
			bounds.prefix,
		) as SessionLineageRow[];
		return rows.map(toSessionLineage);
	} catch (error) {
		logger.debug("Session lineage directory read failed", { dir, error: String(error) });
		return [];
	}
}

/**
 * Delete indexed `session_lineage` rows strictly inside `dir` whose
 * `session_path` no longer exists on disk.
 */
export async function deleteMissingSessionLineageUnderDirectory(dir: string): Promise<void> {
	const bounds = directoryPathPrefixBounds(dir);
	if (!bounds) return;
	const readIndex = await openExistingSessionIndexAsync();
	if (!readIndex) return;
	try {
		const rows = readIndex.selectLineageUnderPrefix.all(
			bounds.prefix,
			bounds.upper,
			bounds.prefix,
			bounds.prefix,
		) as PrefixLineageRow[];
		if (rows.length === 0) return;
		const checks = await mapWithConcurrencyLimit(rows, SESSION_INDEX_IO_CONCURRENCY, row =>
			isRegularFileMissing(row.session_path),
		);
		const missing = rows.filter((_, i) => checks.results[i] === true);
		if (missing.length === 0) return;
		const writeIndex = await openExistingSessionIndexAsync();
		if (!writeIndex) return;
		writeIndex.db
			.transaction(() => {
				for (const row of missing) {
					writeIndex.deleteLineageAtPath.run(row.session_id, row.session_path);
				}
			})
			.immediate();
	} catch (error) {
		logger.debug("Session lineage directory cleanup failed", { dir, error: String(error) });
	}
}

/** Closes the cached connection; the next call reopens it. History recovery closes it so Windows can replace history.db. */
export function closeSessionIndex(): void {
	closeHandle();
	failedPath = undefined;
}

interface SalvagedTitle {
	session_id: unknown;
	title: unknown;
	updated_at: unknown;
}

interface SalvagedRecap {
	session_id: unknown;
	cwd: unknown;
	recap: unknown;
	created_at: unknown;
}

interface SalvagedLineage {
	session_id: unknown;
	parent_session_id: unknown;
	session_path: unknown;
	cwd: unknown;
	updated_at: unknown;
}

function readSalvageable<T extends object>(source: Database, table: string, columns: string): T[] {
	try {
		return readSalvageableRows<T>(source, table, columns);
	} catch (error) {
		logger.warn("Session index salvage could not read table", { table, error: String(error) });
		return [];
	}
}

/**
 * Copies the readable titles, recaps, and lineage rows of a quarantined
 * history.db into the replacement `target`. Runs once per quarantined store,
 * so recaps append as-is; titles and lineage rows already rewritten in the
 * replacement keep the newer value.
 */
export function salvageSessionIndex(
	source: Database,
	target: Database,
): { titles: number; recaps: number; lineages: number } {
	target.run(SESSION_INDEX_DDL);
	const titles = readSalvageable<SalvagedTitle>(source, "session_titles", "session_id, title, updated_at").filter(
		row =>
			typeof row.session_id === "string" && typeof row.title === "string" && Number.isSafeInteger(row.updated_at),
	);
	const recaps = readSalvageable<SalvagedRecap>(source, "session_recaps", "session_id, cwd, recap, created_at").filter(
		row =>
			typeof row.session_id === "string" &&
			typeof row.cwd === "string" &&
			typeof row.recap === "string" &&
			Number.isSafeInteger(row.created_at),
	);
	const rawLineages = readSalvageable<SalvagedLineage>(
		source,
		"session_lineage",
		"session_id, parent_session_id, session_path, cwd, updated_at",
	).filter(
		row =>
			typeof row.session_id === "string" &&
			row.session_id.length > 0 &&
			(row.parent_session_id === null || typeof row.parent_session_id === "string") &&
			typeof row.session_path === "string" &&
			row.session_path.length > 0 &&
			(row.cwd === null || typeof row.cwd === "string") &&
			Number.isSafeInteger(row.updated_at),
	);
	const newestById = new Map<string, SalvagedLineage>();
	for (const row of rawLineages) {
		const id = row.session_id as string;
		const prev = newestById.get(id);
		if (!prev || (row.updated_at as number) >= (prev.updated_at as number)) {
			newestById.set(id, row);
		}
	}
	const sortedLineages = [...newestById.values()].sort((a, b) => {
		const timeDiff = (a.updated_at as number) - (b.updated_at as number);
		if (timeDiff !== 0) return timeDiff;
		const aId = a.session_id as string;
		const bId = b.session_id as string;
		return aId < bId ? -1 : aId > bId ? 1 : 0;
	});

	using upsertTitle = target.prepare(`
INSERT INTO session_titles (session_id, title, updated_at) VALUES (?, ?, ?)
ON CONFLICT(session_id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at
WHERE excluded.updated_at > session_titles.updated_at
	`);
	using insertRecap = target.prepare(
		"INSERT INTO session_recaps (session_id, cwd, recap, created_at) VALUES (?, ?, ?, ?)",
	);
	using selectExistingById = target.prepare("SELECT updated_at FROM session_lineage WHERE session_id = ?");
	using selectNewerOrEqualOwnerAtPath = target.prepare(
		"SELECT 1 AS present FROM session_lineage WHERE session_path = ? AND session_id != ? AND updated_at >= ? LIMIT 1",
	);
	using deleteOlderOwnersAtPath = target.prepare(
		"DELETE FROM session_lineage WHERE session_path = ? AND session_id != ? AND updated_at < ?",
	);
	using upsertLineage = target.prepare(`
INSERT INTO session_lineage (session_id, parent_session_id, session_path, cwd, updated_at)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT(session_id) DO UPDATE SET
	parent_session_id = excluded.parent_session_id,
	session_path = excluded.session_path,
	cwd = CASE
		WHEN excluded.cwd IS NOT NULL THEN excluded.cwd
		WHEN session_lineage.session_path = excluded.session_path THEN session_lineage.cwd
		ELSE NULL
	END,
	updated_at = excluded.updated_at
WHERE excluded.updated_at > session_lineage.updated_at
	`);

	let salvagedLineages = 0;
	target.transaction(() => {
		for (const row of titles)
			upsertTitle.run(row.session_id as string, row.title as string, row.updated_at as number);
		for (const row of recaps) {
			insertRecap.run(row.session_id as string, row.cwd as string, row.recap as string, row.created_at as number);
		}
		for (const row of sortedLineages) {
			const sessionId = row.session_id as string;
			const updatedAt = row.updated_at as number;
			const existingById = selectExistingById.get(sessionId) as { updated_at?: unknown } | null;
			if (existingById && typeof existingById.updated_at === "number" && existingById.updated_at >= updatedAt) {
				continue;
			}
			const sessionPath = path.resolve(row.session_path as string);
			const newerOwner = selectNewerOrEqualOwnerAtPath.get(sessionPath, sessionId, updatedAt) as {
				present: number;
			} | null;
			if (newerOwner) continue;
			deleteOlderOwnersAtPath.run(sessionPath, sessionId, updatedAt);
			const rawParent = typeof row.parent_session_id === "string" ? row.parent_session_id.trim() : null;
			const parentSessionId = !rawParent || rawParent === sessionId ? null : rawParent;
			const cwd = typeof row.cwd === "string" && row.cwd.length > 0 ? normalizeSessionCwd(row.cwd) || null : null;
			const result = upsertLineage.run(sessionId, parentSessionId, sessionPath, cwd, updatedAt);
			salvagedLineages += Number(result.changes);
		}
	})();
	return { titles: titles.length, recaps: recaps.length, lineages: salvagedLineages };
}
