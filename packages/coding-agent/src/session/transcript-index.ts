/**
 * Full-text index of top-level session transcripts (`transcripts.db`): the
 * user and assistant text of every message, so `archive.search` finds a
 * session by what was said in it. Thinking, tool calls, tool output, and
 * subagent transcripts are not indexed.
 *
 * Derived data in a store of its own, rebuildable at any time.
 * {@link syncTranscriptIndex} tails each session file from the byte offset it
 * last indexed, newest files first, so once the first pass is done a sync
 * reads only appended lines; a file that shrank is indexed afresh and a
 * vanished one dropped. The first pass reads every transcript, so callers on
 * the UI thread cap the backlog they index inline (`maxBytes`) and hand a
 * larger one to `transcript-index-client.ts`. Queries answer from whatever is
 * indexed.
 */
import type { Database, Statement } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { textContent } from "@oh-my-pi/pi-tui/chat/transcript-entry";
import {
	getSessionsDir,
	getTranscriptIndexDbPath,
	logger,
	openSqliteDatabaseSync,
	type SqliteFileIdentity,
	sqliteFileIdentity,
	tryAcquireFileLock,
} from "@oh-my-pi/pi-utils";
import { isBunTestRuntime } from "@oh-my-pi/pi-utils/env";
import type { WordQuery } from "./search-query";
import { listSessionFiles } from "./session-listing";

const TRANSCRIPT_INDEX_DDL = `
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
CREATE TABLE IF NOT EXISTS files (
	id INTEGER PRIMARY KEY,
	path TEXT NOT NULL UNIQUE,
	session_id TEXT NOT NULL,
	cwd TEXT NOT NULL,
	indexed INTEGER NOT NULL,
	messages INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
	id INTEGER PRIMARY KEY,
	file INTEGER NOT NULL,
	role TEXT NOT NULL,
	at INTEGER NOT NULL,
	text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_file ON messages(file);
CREATE TABLE IF NOT EXISTS meta (
	key TEXT PRIMARY KEY,
	value INTEGER NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text, content='messages', content_rowid='id');
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
	INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
	INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
`;

/** Bytes of a session file read per step, bounding memory on huge transcripts. */
const SYNC_CHUNK_BYTES = 16 * 1024 * 1024;
/** Leading bytes of a line that carry its entry type. */
const TYPE_PROBE_BYTES = 32;
/** Leading bytes of a message line searched for its role before falling back to a full parse. */
const ROLE_PROBE_BYTES = 1024;
/** Characters a match snippet keeps on each side of the hit. */
const SNIPPET_CONTEXT = 100;

const NEWLINE = 0x0a;
const decoder = new TextDecoder();
/** Entry type at the head of a line; spaced JSON (`{"type": "message"`) included. */
const LINE_TYPE = /^\{\s*"type"\s*:\s*"(\w+)"/;
/** Role at the head of a message object. */
const MESSAGE_ROLE = /"message"\s*:\s*\{\s*"role"\s*:\s*"(\w+)"/;

/** The fields of a session header line the index keeps. */
const SessionHeader = type({ id: "string", cwd: "string" });
/** The fields of a user or assistant message line the index keeps. */
const MessageEntry = type({
	"timestamp?": "string",
	message: {
		role: "'user' | 'assistant'",
		content: type("string").or(type({ type: "string", "text?": "string" }).array()),
	},
});

/** Message roles the index holds. */
export type TranscriptRole = "user" | "assistant";

/**
 * How a {@link syncTranscriptIndex} pass ended: `synced` (the index holds every
 * complete line on disk), `busy` (another process holds the sync), `deferred`
 * (the backlog exceeded `maxBytes`), or `unavailable` (the index cannot be
 * opened). Only `synced` indexed anything.
 */
export type TranscriptSyncOutcome = "synced" | "busy" | "deferred" | "unavailable";

/** What one {@link syncTranscriptIndex} pass did. */
export interface TranscriptSyncResult {
	outcome: TranscriptSyncOutcome;
	/** Session files with newly indexed messages. */
	files: number;
	/** Messages added. */
	messages: number;
}

/** Narrows one {@link syncTranscriptIndex} pass. */
export interface TranscriptSyncOptions {
	/** Root holding one directory per project. Default: {@link getSessionsDir}. */
	sessionsRoot?: string;
	/** Largest backlog of unindexed transcript bytes to take on; a larger one is left `deferred`. */
	maxBytes?: number;
	/** Skip the pass, reporting `synced`, when a sync in any process completed within this many milliseconds. */
	maxAgeMs?: number;
}

/** A message that answered a transcript search. */
export interface TranscriptMatch {
	sessionId: string;
	role: TranscriptRole;
	/** Unix milliseconds. */
	at: number;
	/** The message cut to {@link SNIPPET_CONTEXT} characters around the hit, whitespace collapsed. */
	snippet: string;
}

interface IndexHandle {
	dbPath: string;
	identity: SqliteFileIdentity;
	db: Database;
}

interface IndexedFile {
	id: number;
	path: string;
	indexed: number;
}

interface MessageRow {
	role: TranscriptRole;
	at: number;
	text: string;
}

/** Lines of one read step: the session header when the step holds it, and the indexable messages. */
interface Chunk {
	header?: { id: string; cwd: string };
	rows: MessageRow[];
	/** Message records of every role, tool results included. */
	records: number;
}

let handle: IndexHandle | undefined;
/** Db path whose open failed; skip retries (and log spam) until the path changes. */
let failedPath: string | undefined;

/**
 * The index connection for the current agent dir, reopened when the path or the
 * file behind it changed. `undefined` when the store cannot be opened, and under
 * the test runner unless a test chose the agent dir, so tests never touch the
 * user's index.
 */
function openTranscriptIndex(): Database | undefined {
	if (isBunTestRuntime() && !process.env.PI_CODING_AGENT_DIR) return undefined;
	const dbPath = getTranscriptIndexDbPath();
	if (handle?.dbPath === dbPath) {
		const identity = sqliteFileIdentity(dbPath);
		if (identity !== undefined && identity === handle.identity) return handle.db;
	}
	if (failedPath === dbPath) return undefined;
	handle?.db.close();
	handle = undefined;
	try {
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		const db = openSqliteDatabaseSync(
			dbPath,
			db => {
				db.run(TRANSCRIPT_INDEX_DDL);
				return db;
			},
			{ recoverCorruption: true },
		);
		handle = { dbPath, identity: sqliteFileIdentity(dbPath), db };
		failedPath = undefined;
		return db;
	} catch (error) {
		failedPath = dbPath;
		logger.warn("Transcript index unavailable", { dbPath, error: String(error) });
		return undefined;
	}
}

/** Closes the cached connection; the next call reopens it. */
export function closeTranscriptIndex(): void {
	handle?.db.close();
	handle = undefined;
	failedPath = undefined;
}

/**
 * Brings the index up to date with the top-level session files, newest first.
 * One process syncs at a time; a call that finds another sync running returns
 * `busy` at once. Reads every new transcript line, so the first pass over a
 * large history takes minutes: on the UI thread, pass `maxBytes`.
 */
export async function syncTranscriptIndex(options: TranscriptSyncOptions = {}): Promise<TranscriptSyncResult> {
	const result: TranscriptSyncResult = { outcome: "unavailable", files: 0, messages: 0 };
	const db = openTranscriptIndex();
	if (!db) return result;
	if (options.maxAgeMs !== undefined) {
		const synced = db.query<{ value: number }, []>("SELECT value FROM meta WHERE key = 'synced_at'").get();
		if (synced && Date.now() - synced.value < options.maxAgeMs) {
			result.outcome = "synced";
			return result;
		}
	}
	const lock = tryAcquireFileLock(`${getTranscriptIndexDbPath()}.sync`);
	if (!lock) {
		result.outcome = "busy";
		return result;
	}
	try {
		const known = new Map<string, IndexedFile>();
		for (const row of db.query<IndexedFile, []>("SELECT id, path, indexed FROM files").all()) {
			known.set(row.path, row);
		}
		const files = await listSessionFiles(options.sessionsRoot ?? getSessionsDir());
		if (options.maxBytes !== undefined) {
			let backlog = 0;
			for (const { file, stat } of files) {
				const indexed = known.get(file)?.indexed ?? 0;
				// A file shorter than its indexed end is read again from the start.
				backlog += stat.size >= indexed ? stat.size - indexed : stat.size;
			}
			if (backlog > options.maxBytes) {
				result.outcome = "deferred";
				return result;
			}
		}
		result.outcome = "synced";
		const writer = new IndexWriter(db);
		for (const { file, stat } of files) {
			const indexed = known.get(file);
			known.delete(file);
			if (indexed?.indexed === stat.size) continue;
			let added: number;
			try {
				added = await writer.index(file, stat.size, indexed);
			} catch (error) {
				// Removed or unreadable since the listing; the next sync settles it.
				logger.debug("Transcript index skipped a session file", { file, error: String(error) });
				continue;
			}
			if (added === 0) continue;
			result.files++;
			result.messages += added;
		}
		// An empty listing is an unreadable sessions root, not a deleted history.
		if (files.length > 0) writer.drop([...known.values()]);
		db.run(
			"INSERT INTO meta (key, value) VALUES ('synced_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
			[Date.now()],
		);
	} finally {
		lock.release();
	}
	return result;
}

/** Prepared writes of one sync pass. */
class IndexWriter {
	readonly #db: Database;
	readonly #upsertFile: Statement;
	readonly #advanceFile: Statement;
	readonly #insertMessage: Statement;
	readonly #clearFile: Statement;
	readonly #deleteFile: Statement;

	constructor(db: Database) {
		this.#db = db;
		this.#upsertFile = db.prepare(`
INSERT INTO files (path, session_id, cwd, indexed, messages) VALUES (?1, ?2, ?3, ?4, ?5)
ON CONFLICT(path) DO UPDATE SET session_id = ?2, cwd = ?3, indexed = ?4, messages = ?5
RETURNING id`);
		this.#advanceFile = db.prepare("UPDATE files SET indexed = ?, messages = messages + ? WHERE id = ?");
		this.#insertMessage = db.prepare("INSERT INTO messages (file, role, at, text) VALUES (?, ?, ?, ?)");
		this.#clearFile = db.prepare("DELETE FROM messages WHERE file = ?");
		this.#deleteFile = db.prepare("DELETE FROM files WHERE id = ?");
	}

	/**
	 * Indexes `file` from where the last sync stopped (from the start when it
	 * shrank since) through its last complete line, one transaction per read
	 * step. Returns the messages added; a file without a session header adds
	 * none and stays unrecorded.
	 */
	async index(file: string, size: number, indexed: IndexedFile | undefined): Promise<number> {
		let id = indexed && size >= indexed.indexed ? indexed.id : undefined;
		let offset = id === undefined ? 0 : (indexed?.indexed ?? 0);
		let added = 0;
		let span = SYNC_CHUNK_BYTES;
		while (offset < size) {
			const bytes = await Bun.file(file)
				.slice(offset, Math.min(size, offset + span))
				.bytes();
			const end = bytes.lastIndexOf(NEWLINE) + 1;
			if (end === 0) {
				// An unterminated last line waits for its newline; a longer line widens the step.
				if (offset + bytes.length >= size) break;
				span *= 2;
				continue;
			}
			span = SYNC_CHUNK_BYTES;
			const chunk = readChunk(bytes.subarray(0, end));
			const next = offset + end;
			if (id === undefined) {
				const header = chunk.header;
				if (!header) return 0;
				id = this.#db.transaction(() => {
					const row = this.#upsertFile.get(file, header.id, header.cwd, next, chunk.records) as { id: number };
					// A rewritten file replaces everything indexed from its old content.
					this.#clearFile.run(row.id);
					this.#insertRows(row.id, chunk.rows);
					return row.id;
				})();
			} else {
				const fileId = id;
				this.#db.transaction(() => {
					this.#insertRows(fileId, chunk.rows);
					this.#advanceFile.run(next, chunk.records, fileId);
				})();
			}
			added += chunk.rows.length;
			offset = next;
		}
		return added;
	}

	/** Removes files gone from disk with their messages. */
	drop(files: readonly IndexedFile[]): void {
		if (files.length === 0) return;
		this.#db.transaction(() => {
			for (const file of files) {
				this.#clearFile.run(file.id);
				this.#deleteFile.run(file.id);
			}
		})();
	}

	#insertRows(fileId: number, rows: readonly MessageRow[]): void {
		for (const row of rows) this.#insertMessage.run(fileId, row.role, row.at, row.text);
	}
}

/**
 * The session header and the user and assistant messages among complete
 * `lines`. Tool results, the bulk of a transcript, are skipped from a type and
 * role probe of the line's head without decoding or parsing the whole line.
 */
function readChunk(lines: Uint8Array): Chunk {
	const chunk: Chunk = { rows: [], records: 0 };
	for (let start = 0; start < lines.length;) {
		const end = lines.indexOf(NEWLINE, start);
		const line = lines.subarray(start, end);
		start = end + 1;
		const kind = LINE_TYPE.exec(decoder.decode(line.subarray(0, TYPE_PROBE_BYTES)))?.[1];
		if (kind === "message") {
			chunk.records++;
			const row = messageRow(line);
			if (row) chunk.rows.push(row);
		} else if (kind === "session" && !chunk.header) {
			const header = SessionHeader(parseLine(line));
			if (!(header instanceof type.errors)) chunk.header = { id: header.id, cwd: header.cwd };
		}
	}
	return chunk;
}

/** The indexed form of a message line; `undefined` for other roles, empty text, or a malformed line. */
function messageRow(line: Uint8Array): MessageRow | undefined {
	const role = MESSAGE_ROLE.exec(decoder.decode(line.subarray(0, ROLE_PROBE_BYTES)))?.[1];
	if (role !== undefined && role !== "user" && role !== "assistant") return undefined;
	const entry = MessageEntry(parseLine(line));
	if (entry instanceof type.errors) return undefined;
	const text = textContent(entry.message.content, "\n").trim();
	if (!text) return undefined;
	const at = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN;
	return { role: entry.message.role, at: Number.isFinite(at) ? at : 0, text };
}

/** The JSON value of a line; `undefined` when malformed. */
function parseLine(line: Uint8Array): unknown {
	try {
		return JSON.parse(decoder.decode(line));
	} catch {
		return undefined;
	}
}

/**
 * Ids of the sessions, of the project `cwd` or of every project, with a user or
 * assistant message matching `words`. Empty when the index is unavailable.
 */
export function transcriptSessionIds(words: WordQuery, cwd: string | undefined): Set<string> {
	const db = openTranscriptIndex();
	if (!db) return new Set();
	try {
		const rows = db
			.query<{ session_id: string }, [string, string | null]>(`
SELECT DISTINCT f.session_id FROM messages_fts
JOIN messages m ON m.id = messages_fts.rowid
JOIN files f ON f.id = m.file
WHERE messages_fts MATCH ?1 AND (?2 IS NULL OR f.cwd = ?2)`)
			.all(words.match, cwd ?? null);
		return new Set(rows.map(row => row.session_id));
	} catch (error) {
		logger.debug("Transcript index query failed", { error: String(error) });
		return new Set();
	}
}

/**
 * One indexed transcript file per session of `ids`, within the project `cwd`
 * when given. Sessions the index has not reached are missing. Empty when the
 * index is unavailable.
 */
export function indexedSessionFiles(ids: ReadonlySet<string>, cwd: string | undefined): string[] {
	const db = openTranscriptIndex();
	if (!db || ids.size === 0) return [];
	try {
		// One per session: a transcript linked into the root under two names is indexed under both.
		return db
			.query<{ path: string }, [string, string | null]>(`
SELECT min(path) AS path FROM files
WHERE session_id IN (SELECT value FROM json_each(?1)) AND (?2 IS NULL OR cwd = ?2)
GROUP BY session_id`)
			.all(JSON.stringify([...ids]), cwd ?? null)
			.map(row => row.path);
	} catch (error) {
		logger.debug("Transcript index query failed", { error: String(error) });
		return [];
	}
}

/**
 * Message records of every role in each of `files` the index holds through its
 * current `size`, by path; a file the index lags behind is missing. Empty when
 * the index is unavailable.
 */
export function indexedMessageCounts(files: readonly { path: string; size: number }[]): Map<string, number> {
	const counts = new Map<string, number>();
	const db = openTranscriptIndex();
	if (!db || files.length === 0) return counts;
	try {
		const rows = db
			.query<{ path: string; indexed: number; messages: number }, [string]>(
				"SELECT path, indexed, messages FROM files WHERE path IN (SELECT value FROM json_each(?1))",
			)
			.all(JSON.stringify(files.map(file => file.path)));
		const sizes = new Map(files.map(file => [file.path, file.size]));
		for (const row of rows) {
			if (sizes.get(row.path) === row.indexed) counts.set(row.path, row.messages);
		}
	} catch (error) {
		logger.debug("Transcript index query failed", { error: String(error) });
	}
	return counts;
}

/** `text` cut to {@link SNIPPET_CONTEXT} characters around the first hit of `words`, `…` marking each cut. */
function snippet(text: string, words: WordQuery): string {
	const hit = words.locate(text) ?? { start: 0, end: 0 };
	let start = Math.max(0, hit.start - SNIPPET_CONTEXT);
	let end = Math.min(text.length, hit.end + SNIPPET_CONTEXT);
	// Never split a surrogate pair.
	if (start > 0 && isLowSurrogate(text.charCodeAt(start))) start--;
	if (end < text.length && isLowSurrogate(text.charCodeAt(end))) end++;
	const body = text.slice(start, end).replace(/\s+/g, " ").trim();
	return `${start > 0 ? "…" : ""}${body}${end < text.length ? "…" : ""}`;
}

function isLowSurrogate(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * The newest `perSession` messages matching `words` in each of `sessionIds`,
 * newest first, each cut to a snippet around the hit. Empty when the index is
 * unavailable.
 */
export function transcriptMatches(
	words: WordQuery,
	sessionIds: readonly string[],
	perSession: number,
): TranscriptMatch[] {
	const db = openTranscriptIndex();
	if (!db || sessionIds.length === 0) return [];
	try {
		const ids = db
			.query<{ id: number }, [string, string, number]>(`
SELECT id FROM (
	SELECT m.id, row_number() OVER (PARTITION BY f.session_id ORDER BY m.at DESC, m.id DESC) AS rank
	FROM messages_fts
	JOIN messages m ON m.id = messages_fts.rowid
	JOIN files f ON f.id = m.file
	WHERE messages_fts MATCH ?1 AND f.session_id IN (SELECT value FROM json_each(?2))
) WHERE rank <= ?3`)
			.all(words.match, JSON.stringify(sessionIds), perSession)
			.map(row => row.id);
		// FTS5's snippet() re-evaluates the whole MATCH per row: seconds for a common word.
		const rows = db
			.query<{ session_id: string; role: TranscriptRole; at: number; text: string }, [string]>(`
SELECT f.session_id, m.role, m.at, m.text
FROM messages m JOIN files f ON f.id = m.file
WHERE m.id IN (SELECT value FROM json_each(?1))
ORDER BY m.at DESC, m.id DESC`)
			.all(JSON.stringify(ids));
		return rows.map(row => ({
			sessionId: row.session_id,
			role: row.role,
			at: row.at,
			snippet: snippet(row.text, words),
		}));
	} catch (error) {
		logger.debug("Transcript index query failed", { error: String(error) });
		return [];
	}
}
