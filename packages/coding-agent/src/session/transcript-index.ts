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
 * vanished one dropped. Each row keeps its entry's id, so an `entry_patch`
 * record read in a later step or sync sets the text of the row it names (an
 * elide pass's placeholder) as a resume would: the row of the last line in the
 * file with that id, as every reader sets a record's fields on the last entry
 * with its id. When that line has no row (a tool result, a message without
 * text), the record sets no row's text. The index keeps the latest text the
 * records set for each id, the text a patched row was written with, and the
 * ids whose last line has no row, so a row read after a record takes its text
 * and an earlier row with that id gets its own back. A message written without
 * text that a record later gives text is not indexed. The first pass reads every
 * transcript, so syncs run on a worker thread (`transcript-index-client.ts`),
 * hosted by the daemon's `transcripts` module. Queries answer from whatever is
 * indexed.
 */
import type { Database, Statement } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { textContent } from "./transcript/transcript-entry";
import {
	getSessionsDir,
	getTranscriptIndexDbPath,
	isRecord,
	logger,
	openSqliteDatabaseSync,
	type SqliteFileIdentity,
	sqliteFileIdentity,
	tryAcquireFileLock,
} from "@oh-my-pi/pi-utils";
import {
	type EntryPatch,
	entryPatchesOf,
	entryPatchMarkerAt,
	isEntryPatchRecord,
	patchFitsMessageRole,
} from "@oh-my-pi/pi-utils/entry-patches";
import { isBunTestRuntime } from "@oh-my-pi/pi-utils/env";
import type { WordQuery } from "./search-query";
import { listSessionFiles } from "./session-listing";
import type { TimeWindow } from "./time-window";

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
	entry TEXT NOT NULL DEFAULT '',
	role TEXT NOT NULL,
	at INTEGER NOT NULL,
	text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_file ON messages(file);
CREATE INDEX IF NOT EXISTS idx_messages_file_entry ON messages(file, entry);
CREATE TABLE IF NOT EXISTS patch_texts (
	file INTEGER NOT NULL,
	entry TEXT NOT NULL,
	role TEXT NOT NULL,
	text TEXT NOT NULL,
	PRIMARY KEY (file, entry, role)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS patched_rows (
	id INTEGER PRIMARY KEY,
	file INTEGER NOT NULL,
	original TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_patched_rows_file ON patched_rows(file);
CREATE TABLE IF NOT EXISTS rowless_entries (
	file INTEGER NOT NULL,
	entry TEXT NOT NULL,
	PRIMARY KEY (file, entry)
) WITHOUT ROWID;
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
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF text ON messages BEGIN
	INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
	INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;
`;

/**
 * A store indexed before rows kept their entry's id cannot apply a record to
 * the row it names: its tables are dropped, `meta` with its `synced_at` too so
 * the emptied index does not read as fresh, and the next sync indexes every
 * transcript again. The new `entry` column defaults to empty, so an older
 * binary's inserts into the rebuilt store still succeed; a later sync that
 * reads a record for a file holding such a row indexes that file afresh.
 */
const DROP_INDEX_WITHOUT_ENTRY_IDS = `
DROP TRIGGER IF EXISTS messages_ai;
DROP TRIGGER IF EXISTS messages_ad;
DROP TRIGGER IF EXISTS messages_au;
DROP TABLE IF EXISTS messages_fts;
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS patch_texts;
DROP TABLE IF EXISTS patched_rows;
DROP TABLE IF EXISTS rowless_entries;
DROP TABLE IF EXISTS files;
DROP TABLE IF EXISTS meta;
`;

/** Bytes of a session file read per step, bounding memory on huge transcripts. */
const SYNC_CHUNK_BYTES = 16 * 1024 * 1024;
/** Leading bytes of a line that carry its entry type, and the id written right after it. */
const HEAD_PROBE_BYTES = 128;
/** Leading bytes of a message line searched for its role before falling back to a full parse. */
const ROLE_PROBE_BYTES = 1024;
/** Characters a match snippet keeps on each side of the hit. */
const SNIPPET_CONTEXT = 100;

const NEWLINE = 0x0a;
const decoder = new TextDecoder();
/** Entry type at the head of a line; spaced JSON (`{"type": "message"`) included. */
const LINE_TYPE = /^\{\s*"type"\s*:\s*"(\w+)"/;
/** An entry's plain-string id right after its type, as session files write every message's. */
const LINE_ID = /^\{\s*"type"\s*:\s*"\w+"\s*,\s*"id"\s*:\s*"([^"\\]*)"/;
/** Role at the head of a message object. */
const MESSAGE_ROLE = /"message"\s*:\s*\{\s*"role"\s*:\s*"(\w+)"/;

/** The fields of a session header line the index keeps. */
const SessionHeader = type({ id: "string", cwd: "string" });
/** The fields of a user or assistant message line the index keeps. */
const MessageEntry = type({
	"id?": "string",
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
 * complete line on disk), `busy` (another process holds the sync), or
 * `unavailable` (the index cannot be opened). Only `synced` indexed anything.
 */
export type TranscriptSyncOutcome = "synced" | "busy" | "unavailable";

/** What one {@link syncTranscriptIndex} pass did. */
export interface TranscriptSyncResult {
	outcome: TranscriptSyncOutcome;
	/** Session files with newly indexed messages. */
	files: number;
	/** Messages added. */
	messages: number;
}

/** The store one {@link syncTranscriptIndex} pass brings up to date, and the sessions it reads. */
export interface TranscriptSyncOptions {
	/** Index store. Default: {@link getTranscriptIndexDbPath}. */
	dbPath?: string;
	/** Root holding one directory per project. Default: {@link getSessionsDir}. */
	sessionsRoot?: string;
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
	identity: SqliteFileIdentity;
	db: Database;
}

interface IndexedFile {
	id: number;
	path: string;
	indexed: number;
}

interface MessageRow {
	/** Id of the message's entry; empty for a line written without one. */
	entry: string;
	role: TranscriptRole;
	at: number;
	text: string;
}

/**
 * A line of a read step that names an entry: a row the index holds, or the id of an entry it holds no row for,
 * with the line's bytes.
 */
type ChunkLine = { row: MessageRow } | { rowless: string; bytes: Uint8Array };

/** Lines of one read step: the session header when the step holds it, the entries' lines, and its records. */
interface Chunk {
	header?: { id: string; cwd: string };
	/** The lines that name an entry, in file order. */
	lines: ChunkLine[];
	/** Rows among {@link lines}. */
	rows: number;
	/** Message records of every role, tool results included. */
	records: number;
	/** Patches of the step's `entry_patch` records that set a message's `content`, in file order. */
	patches: EntryPatch[];
}

/** Open connections by store path: the daemon's indexer serves the store of every profile. */
const handles = new Map<string, IndexHandle>();
/** Store paths whose open failed; skipped, without retries or log spam, until {@link closeTranscriptIndex}. */
const failedPaths = new Set<string>();

/**
 * The connection to the store at `dbPath`, by default the current agent dir's,
 * reopened when the file behind the path changed. `undefined` when the store
 * cannot be opened.
 */
function openTranscriptIndex(dbPath?: string): Database | undefined {
	// Tests never touch the user's index: the default store needs an agent dir the test chose.
	if (dbPath === undefined && isBunTestRuntime() && !process.env.PI_CODING_AGENT_DIR) return undefined;
	const store = dbPath ?? getTranscriptIndexDbPath();
	const open = handles.get(store);
	if (open) {
		const identity = sqliteFileIdentity(store);
		if (identity !== undefined && identity === open.identity) return open.db;
		open.db.close();
		handles.delete(store);
	}
	if (failedPaths.has(store)) return undefined;
	try {
		fs.mkdirSync(path.dirname(store), { recursive: true });
		const db = openSqliteDatabaseSync(
			store,
			db => {
				const columns = db.query<{ name: string }, []>("PRAGMA table_info(messages)").all();
				if (columns.length > 0 && !columns.some(column => column.name === "entry")) {
					db.run(DROP_INDEX_WITHOUT_ENTRY_IDS);
				}
				db.run(TRANSCRIPT_INDEX_DDL);
				return db;
			},
			{ recoverCorruption: true },
		);
		handles.set(store, { identity: sqliteFileIdentity(store), db });
		return db;
	} catch (error) {
		failedPaths.add(store);
		logger.warn("Transcript index unavailable", { dbPath: store, error: String(error) });
		return undefined;
	}
}

/** Closes the cached connections; the next call reopens them. */
export function closeTranscriptIndex(): void {
	for (const open of handles.values()) open.db.close();
	handles.clear();
	failedPaths.clear();
}

/** Whether a sync of the current agent dir's index, in any process, completed within `maxAgeMs`. */
export function isTranscriptIndexFresh(maxAgeMs: number): boolean {
	const db = openTranscriptIndex();
	if (!db) return false;
	try {
		const synced = db.query<{ value: number }, []>("SELECT value FROM meta WHERE key = 'synced_at'").get();
		return synced !== null && Date.now() - synced.value < maxAgeMs;
	} catch (error) {
		logger.debug("Transcript index query failed", { error: String(error) });
		return false;
	}
}

/**
 * Brings the index up to date with the top-level session files, newest first.
 * One process syncs a store at a time; a call that finds another sync running
 * returns `busy` at once. Reads every new transcript line, so the first pass
 * over a large history takes a minute or more: never run it on the UI thread.
 */
export async function syncTranscriptIndex(options: TranscriptSyncOptions = {}): Promise<TranscriptSyncResult> {
	const result: TranscriptSyncResult = { outcome: "unavailable", files: 0, messages: 0 };
	const db = openTranscriptIndex(options.dbPath);
	if (!db) return result;
	const lock = tryAcquireFileLock(`${options.dbPath ?? getTranscriptIndexDbPath()}.sync`);
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
	readonly #hasRowWithoutEntry: Statement;
	readonly #hasRow: Statement;
	readonly #lastRow: Statement;
	readonly #keepOriginal: Statement;
	readonly #setRowText: Statement;
	readonly #setPatchText: Statement;
	readonly #patchTexts: Statement;
	readonly #restoreEarlier: Statement;
	readonly #forgetEarlier: Statement;
	readonly #isRowless: Statement;
	readonly #markRowless: Statement;
	readonly #unmarkRowless: Statement;
	readonly #clearFile: Statement;
	readonly #clearPatchTexts: Statement;
	readonly #clearPatchedRows: Statement;
	readonly #clearRowless: Statement;
	readonly #deleteFile: Statement;

	constructor(db: Database) {
		this.#db = db;
		this.#upsertFile = db.prepare(`
INSERT INTO files (path, session_id, cwd, indexed, messages) VALUES (?1, ?2, ?3, ?4, ?5)
ON CONFLICT(path) DO UPDATE SET session_id = ?2, cwd = ?3, indexed = ?4, messages = ?5
RETURNING id`);
		this.#advanceFile = db.prepare("UPDATE files SET indexed = ?, messages = messages + ? WHERE id = ?");
		this.#insertMessage = db.prepare(
			"INSERT INTO messages (file, entry, role, at, text) VALUES (?, ?, ?, ?, ?) RETURNING id",
		);
		this.#hasRowWithoutEntry = db.prepare("SELECT 1 FROM messages WHERE file = ? AND entry = '' LIMIT 1");
		this.#hasRow = db.prepare("SELECT 1 FROM messages WHERE file = ? AND entry = ? LIMIT 1");
		this.#lastRow = db.prepare("SELECT id, role FROM messages WHERE file = ? AND entry = ? ORDER BY id DESC LIMIT 1");
		this.#keepOriginal = db.prepare(
			"INSERT OR IGNORE INTO patched_rows (id, file, original) SELECT id, file, text FROM messages WHERE id = ?",
		);
		this.#setRowText = db.prepare("UPDATE messages SET text = ? WHERE id = ?");
		this.#setPatchText = db.prepare(`
INSERT INTO patch_texts (file, entry, role, text) VALUES (?, ?, ?, ?)
ON CONFLICT(file, entry, role) DO UPDATE SET text = excluded.text`);
		this.#patchTexts = db.prepare("SELECT role, text FROM patch_texts WHERE file = ? AND entry = ?");
		// The rows of file ?1 with entry id ?2, other than row ?3 (0 for none), that a record set text on.
		const earlier = "file = ?1 AND id <> ?3 AND id IN (SELECT id FROM messages WHERE file = ?1 AND entry = ?2)";
		this.#restoreEarlier = db.prepare(`
UPDATE messages SET text = (SELECT original FROM patched_rows WHERE patched_rows.id = messages.id)
WHERE id IN (SELECT id FROM patched_rows WHERE ${earlier})`);
		this.#forgetEarlier = db.prepare(`DELETE FROM patched_rows WHERE ${earlier}`);
		this.#isRowless = db.prepare("SELECT 1 FROM rowless_entries WHERE file = ? AND entry = ?");
		this.#markRowless = db.prepare("INSERT OR IGNORE INTO rowless_entries (file, entry) VALUES (?, ?)");
		this.#unmarkRowless = db.prepare("DELETE FROM rowless_entries WHERE file = ? AND entry = ?");
		this.#clearFile = db.prepare("DELETE FROM messages WHERE file = ?");
		this.#clearPatchTexts = db.prepare("DELETE FROM patch_texts WHERE file = ?");
		this.#clearPatchedRows = db.prepare("DELETE FROM patched_rows WHERE file = ?");
		this.#clearRowless = db.prepare("DELETE FROM rowless_entries WHERE file = ?");
		this.#deleteFile = db.prepare("DELETE FROM files WHERE id = ?");
	}

	/**
	 * Indexes `file` from where the last sync stopped through its last complete
	 * line, one transaction per read step: from the start when it shrank since,
	 * or when a record arrives for a file holding a row without its entry's id,
	 * which an older binary indexed and no record can reach. Returns the
	 * messages added; a file without a session header adds none and stays
	 * unrecorded.
	 */
	async index(file: string, size: number, indexed: IndexedFile | undefined): Promise<number> {
		let id = indexed && size >= indexed.indexed ? indexed.id : undefined;
		let offset = id === undefined ? 0 : (indexed?.indexed ?? 0);
		let fromStart = id === undefined;
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
			// A row an older binary indexed lacks its entry's id: index the file afresh, so this record reaches it.
			if (id !== undefined && !fromStart && chunk.patches.length > 0 && this.#hasRowWithoutEntry.get(id)) {
				id = undefined;
				offset = 0;
				added = 0;
				fromStart = true;
				continue;
			}
			const next = offset + end;
			if (id === undefined) {
				const header = chunk.header;
				if (!header) return 0;
				id = this.#db.transaction(() => {
					const row = this.#upsertFile.get(file, header.id, header.cwd, next, chunk.records) as { id: number };
					// A rewritten file replaces everything indexed from its old content.
					this.#clear(row.id);
					this.#indexLines(row.id, chunk.lines);
					this.#applyPatches(row.id, chunk.patches);
					return row.id;
				})();
			} else {
				const fileId = id;
				this.#db.transaction(() => {
					this.#indexLines(fileId, chunk.lines);
					this.#applyPatches(fileId, chunk.patches);
					this.#advanceFile.run(next, chunk.records, fileId);
				})();
			}
			added += chunk.rows;
			offset = next;
		}
		return added;
	}

	/** Removes files gone from disk with their messages. */
	drop(files: readonly IndexedFile[]): void {
		if (files.length === 0) return;
		this.#db.transaction(() => {
			for (const file of files) {
				this.#clear(file.id);
				this.#deleteFile.run(file.id);
			}
		})();
	}

	/** Removes the rows of file `fileId` and what the index keeps for the records that name them. */
	#clear(fileId: number): void {
		this.#clearFile.run(fileId);
		this.#clearPatchTexts.run(fileId);
		this.#clearPatchedRows.run(fileId);
		this.#clearRowless.run(fileId);
	}

	/**
	 * Indexes `lines`, which follow every line of `fileId` indexed so far, in file order. A row whose id a record
	 * of an earlier step or sync named is now the last line with the id: it takes the text the records set for
	 * its role, and the rows before it with the id get back their own text. A line the index holds no row for,
	 * with the id of a row or of a record, is now the last line with that id: those rows get back their own
	 * text, and the records set no row's text until a row with the id follows. Such a line that does not parse
	 * (a writer killed mid-line) is no entry, as every reader skips it. A record of this step reaches these
	 * lines afterwards.
	 */
	#indexLines(fileId: number, lines: readonly ChunkLine[]): void {
		for (const line of lines) {
			if ("rowless" in line) {
				const entry = line.rowless;
				if (!this.#hasRow.get(fileId, entry) && !this.#patchTexts.get(fileId, entry)) continue;
				if (parseLine(line.bytes) === undefined) continue;
				this.#restoreEarlier.run(fileId, entry, 0);
				this.#forgetEarlier.run(fileId, entry, 0);
				this.#markRowless.run(fileId, entry);
				continue;
			}
			const { row } = line;
			const { id } = this.#insertMessage.get(fileId, row.entry, row.role, row.at, row.text) as { id: number };
			if (row.entry === "") continue;
			this.#unmarkRowless.run(fileId, row.entry);
			const texts = this.#patchTexts.all(fileId, row.entry) as { role: TranscriptRole; text: string }[];
			if (texts.length === 0) continue;
			this.#restoreEarlier.run(fileId, row.entry, id);
			this.#forgetEarlier.run(fileId, row.entry, id);
			const text = texts.find(patched => patched.role === row.role)?.text;
			if (text !== undefined) this.#setText(id, text);
		}
	}

	/**
	 * Sets, in file order, the text of the row of `fileId` a patch names to the text of the patch's `content`,
	 * as a resume reads the message: the row of the last line with the patch's entry id, when it has one and
	 * the patch fits its role. The text is kept for each role the patch fits, for a row with the id read
	 * later. A patch that leaves no text leaves the row empty, which no search matches, and keeps the row, so
	 * a later patch that sets text again finds it. The lines of this step are indexed first, so a patch
	 * reaches them as it reaches lines of an earlier step or sync.
	 */
	#applyPatches(fileId: number, patches: readonly EntryPatch[]): void {
		for (const patch of patches) {
			const content = patch.message?.content;
			if (content === undefined || patch.entryId === "") continue;
			const roles = (["user", "assistant"] as const).filter(role => patchFitsMessageRole(patch, role));
			if (roles.length === 0) continue;
			const text = textContent(content, "\n").trim();
			for (const role of roles) this.#setPatchText.run(fileId, patch.entryId, role, text);
			if (this.#isRowless.get(fileId, patch.entryId)) continue;
			const last = this.#lastRow.get(fileId, patch.entryId) as { id: number; role: TranscriptRole } | null;
			if (last && roles.includes(last.role)) this.#setText(last.id, text);
		}
	}

	/** Sets the text of row `id`, keeping the text it was written with for a later row with its id to give back. */
	#setText(id: number, text: string): void {
		this.#keepOriginal.run(id);
		this.#setRowText.run(text, id);
	}
}

/**
 * The session header, the lines that name an entry, and the patches of the
 * `entry_patch` records among complete `lines`. A line's type, and the id
 * written right after it, come from a probe of its head: a user or assistant
 * message is parsed for its text, any other line only when its id is not at
 * its head, so tool results, the bulk of a transcript, are not parsed.
 */
function readChunk(lines: Uint8Array): Chunk {
	const chunk: Chunk = { lines: [], rows: 0, records: 0, patches: [] };
	for (let start = 0; start < lines.length;) {
		const end = lines.indexOf(NEWLINE, start);
		const line = lines.subarray(start, end);
		start = end + 1;
		const head = decoder.decode(line.subarray(0, HEAD_PROBE_BYTES));
		const kind = LINE_TYPE.exec(head)?.[1];
		if (kind === undefined) continue;
		if (kind === "session") {
			const header = chunk.header ? undefined : SessionHeader(parseLine(line));
			if (header && !(header instanceof type.errors)) chunk.header = { id: header.id, cwd: header.cwd };
			continue;
		}
		let id: string | undefined;
		if (kind === "message") {
			chunk.records++;
			const row = messageRow(line);
			if (row?.text) {
				chunk.lines.push({ row });
				chunk.rows++;
				continue;
			}
			id = row?.entry;
		} else if (kind === "custom" && entryPatchMarkerAt(line) !== -1) {
			const record = parseLine(line);
			if (isRecord(record) && isEntryPatchRecord(record)) {
				for (const patch of entryPatchesOf(record) ?? []) {
					if (patch.message?.content !== undefined) chunk.patches.push(patch);
				}
			}
		}
		id ??= entryIdOf(head, line);
		if (id) chunk.lines.push({ rowless: id, bytes: line });
	}
	return chunk;
}

/** Id of the entry on `line`, whose head is `head`: from the head when written right after the type, else parsed. */
function entryIdOf(head: string, line: Uint8Array): string | undefined {
	const id = LINE_ID.exec(head)?.[1];
	if (id !== undefined) return id;
	const entry = parseLine(line);
	return isRecord(entry) && typeof entry.id === "string" ? entry.id : undefined;
}

/**
 * The indexed form of a user or assistant message line, its text empty when it has none; `undefined` for
 * other roles or a malformed line.
 */
function messageRow(line: Uint8Array): MessageRow | undefined {
	const role = MESSAGE_ROLE.exec(decoder.decode(line.subarray(0, ROLE_PROBE_BYTES)))?.[1];
	if (role !== undefined && role !== "user" && role !== "assistant") return undefined;
	const entry = MessageEntry(parseLine(line));
	if (entry instanceof type.errors) return undefined;
	const text = textContent(entry.message.content, "\n").trim();
	const at = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN;
	return { entry: entry.id ?? "", role: entry.message.role, at: Number.isFinite(at) ? at : 0, text };
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
 * assistant message matching `words`, sent within `window` when given. Empty
 * when the index is unavailable.
 */
export function transcriptSessionIds(words: WordQuery, cwd: string | undefined, window?: TimeWindow): Set<string> {
	const db = openTranscriptIndex();
	if (!db) return new Set();
	try {
		const rows = db
			.query<{ session_id: string }, [string, string | null, number | null, number | null]>(`
SELECT DISTINCT f.session_id FROM messages_fts
JOIN messages m ON m.id = messages_fts.rowid
JOIN files f ON f.id = m.file
WHERE messages_fts MATCH ?1 AND (?2 IS NULL OR f.cwd = ?2)
	AND (?3 IS NULL OR m.at >= ?3) AND (?4 IS NULL OR m.at < ?4)`)
			.all(words.match, cwd ?? null, window?.since ?? null, window?.until ?? null);
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
 * sent within `window` when given, newest first, each cut to a snippet around
 * the hit. Empty when the index is unavailable.
 */
export function transcriptMatches(
	words: WordQuery,
	sessionIds: readonly string[],
	perSession: number,
	window?: TimeWindow,
): TranscriptMatch[] {
	const db = openTranscriptIndex();
	if (!db || sessionIds.length === 0) return [];
	try {
		const ids = db
			.query<{ id: number }, [string, string, number, number | null, number | null]>(`
SELECT id FROM (
	SELECT m.id, row_number() OVER (PARTITION BY f.session_id ORDER BY m.at DESC, m.id DESC) AS rank
	FROM messages_fts
	JOIN messages m ON m.id = messages_fts.rowid
	JOIN files f ON f.id = m.file
	WHERE messages_fts MATCH ?1 AND f.session_id IN (SELECT value FROM json_each(?2))
		AND (?4 IS NULL OR m.at >= ?4) AND (?5 IS NULL OR m.at < ?5)
) WHERE rank <= ?3`)
			.all(words.match, JSON.stringify(sessionIds), perSession, window?.since ?? null, window?.until ?? null)
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
