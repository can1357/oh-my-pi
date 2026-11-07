/**
 * Messages between `readExitContext` (`./exit-context`) and its reader thread
 * (`./exit-context-worker`), and the board every thread of the process shares.
 * Imports nothing, so the thread loads fast.
 */

/**
 * Longest the exiting thread waits for the reader thread's answer. Nothing
 * else in this protocol waits: the board below is lock-free, so no thread ever
 * blocks on another and a thread that dies holds nothing.
 */
export const EXIT_CONTEXT_IO_TIMEOUT_MS = 1_500;

/** Longest intent recorded; a longer word is cut to this many characters. */
export const EXIT_INTENT_MAX_CHARS = 64;

/** Bytes before the JSON answer in the shared buffer: a done flag (word 0) and the answer's length (word 1). */
export const EXIT_CONTEXT_RESULT_OFFSET = 8;

/** What the exiting thread asks the reader thread. */
export interface ExitContextIoRequest {
	pid: number;
	/** `/proc/self/cgroup`: the `0::<path>` line names the process's cgroup v2. */
	cgroupFile: string;
	/** cgroup v2 mount point, `/sys/fs/cgroup`. */
	cgroupRoot: string;
	/** Directory of `<pid>` intent files. */
	intentDir: string;
	/** Epoch ms the process started; an older intent file was left for an earlier process with the same pid. */
	processStartMs: number;
	/** Where the answer goes: the exiting thread is blocked in `Atomics.wait` and cannot receive a message. */
	state: SharedArrayBuffer;
	/** The process's {@link createExitContextBoard board}, where a claimed word is shared with every thread. */
	board: SharedArrayBuffer;
}

/** The reader thread's answer: the fields whose files it could read. */
export interface ExitContextIoResult {
	oomKills?: number;
	intent?: string;
}

/**
 * A word taken from an intent file, dated with that file's modification time:
 * the moment the sender's write landed on the staged file it later renamed
 * into place, which is **not** the moment of that rename. A sender writes,
 * fsyncs, closes and chmods the staged file before it renames it over
 * `<intentDir>/<pid>`, and only the write sets the time.
 *
 * Readers merge words by that date and never by the order in which they happen
 * to run, so what the process records does not depend on how its threads were
 * scheduled. Two senders for one pid whose writes overlap are therefore ranked
 * by which wrote last, which can be the opposite of which renamed last; the
 * loser is removed once the winner is recorded, as any superseded word is. A
 * reader has nothing better to rank by: the filesystem keeps no rename order,
 * and the status-change time that a rename does set is reset by the reader's
 * own rename of the file it takes.
 */
export interface ExitContextWord {
	word: string;
	mtimeMs: number;
}

/**
 * What the board holds for one intent path: the word, and the publication this
 * read observed. The version is the handle a {@link publishExitIntent} must
 * replace, so a record either lands on exactly the state it was decided
 * against or does not land at all.
 */
export interface ExitContextBoardEntry {
	word: ExitContextWord | undefined;
	version: number;
}

/** What {@link publishExitIntent} did: it landed, another thread got in first, or the board is out of room. */
export type ExitContextPublishResult = "published" | "lost" | "full";

/**
 * The board every thread of the process shares. Sessions run on several
 * threads (worker subagents), each with its own module state, so the word one
 * thread takes lives here for the others.
 *
 * It is lock-free, because a thread can be terminated between any two
 * instructions and a lock it held would never come free: a reader that waited
 * for such a lock would time out, and a timeout read as "nothing is recorded"
 * is what loses a word. Instead the board is a chain of write-once records,
 * newest first, and the whole of its mutable state is two `Int32`s:
 *
 * ```text
 *   0   Int32   head   byte offset of the newest record, 0 when there is none
 *   4   Int32   bump   byte offset of the next free byte
 *   8   Float64 the epoch ms the process started, set once when the board is made
 *  16   records, each 8-byte aligned:
 *         +0   Int32   offset of the record published before it, 0 at the end
 *         +4   Int32   length of the intent path in UTF-8 bytes
 *         +8   Float64 the modification time the sender's write left on its staged file
 *         +16  Int32   length of the word in UTF-8 bytes
 *         +20  the path's bytes, then the word's
 * ```
 *
 * A record is filled in while no one can reach it and then published by one
 * `Atomics.compareExchange` on `head`, so every reader sees either the whole
 * record or no trace of it, and a thread terminated at any instruction leaves
 * the board exactly as it was or with its record whole. Reading is one
 * `Atomics.load` of `head` plus a walk of records that never change again.
 * Offsets only grow, so the walk ends.
 */
const BOARD_BYTES = 64 * 1024;
/** Int32 indices of the head and the bump pointer. */
const BOARD_HEAD = 0;
const BOARD_BUMP = 1;
/** A Float64 at this byte: the epoch ms the process started. */
const BOARD_START_OFFSET = 8;
/** The first byte a record may use. */
const BOARD_DATA_OFFSET = 16;
/** Byte offsets inside a record. */
const RECORD_PREV = 0;
const RECORD_PATH_LENGTH = 4;
const RECORD_MTIME = 8;
const RECORD_WORD_LENGTH = 16;
const RECORD_TEXT = 20;

/**
 * Make the process's board. One thread makes it and hands it to the threads it
 * starts; `processStartMs` is that thread's start, which every thread then uses
 * to date intent files, since each worker thread has its own time origin.
 */
export function createExitContextBoard(processStartMs: number): SharedArrayBuffer {
	const board = new SharedArrayBuffer(BOARD_BYTES);
	new Float64Array(board, BOARD_START_OFFSET, 1)[0] = processStartMs;
	new Int32Array(board, 0, 2)[BOARD_BUMP] = BOARD_DATA_OFFSET;
	return board;
}

/** The process start the board was made with. */
export function exitContextBoardProcessStart(board: SharedArrayBuffer): number {
	return new Float64Array(board, BOARD_START_OFFSET, 1)[0]!;
}

function bytesMatch(bytes: Uint8Array, start: number, expected: Uint8Array): boolean {
	for (let index = 0; index < expected.length; index++) {
		if (bytes[start + index] !== expected[index]) return false;
	}
	return true;
}

/**
 * The word `path` has in the chain that starts at `head`. Each record was
 * written before it was published and never touched again, so this reads only
 * settled bytes. The newest record for a path comes first, and every
 * publication moves a path's word strictly forward, so the first match is the
 * word that stands.
 */
function wordInChain(board: SharedArrayBuffer, head: number, path: Uint8Array): ExitContextWord | undefined {
	const bytes = new Uint8Array(board);
	const view = new DataView(board);
	let offset = head;
	while (offset >= BOARD_DATA_OFFSET && offset + RECORD_TEXT <= board.byteLength) {
		const pathLength = view.getInt32(offset + RECORD_PATH_LENGTH, true);
		const text = offset + RECORD_TEXT;
		if (pathLength === path.length && bytesMatch(bytes, text, path)) {
			const wordLength = view.getInt32(offset + RECORD_WORD_LENGTH, true);
			return {
				word: new TextDecoder().decode(bytes.subarray(text + pathLength, text + pathLength + wordLength)),
				mtimeMs: view.getFloat64(offset + RECORD_MTIME, true),
			};
		}
		const prev = view.getInt32(offset + RECORD_PREV, true);
		// A record's predecessor was always allocated before it; a chain that does
		// not walk back is not one this code wrote.
		if (prev >= offset) return undefined;
		offset = prev;
	}
	return undefined;
}

/** Bytes for a record, or `undefined` when the board has no room left for one. */
function reserveRecord(board: SharedArrayBuffer, size: number): number | undefined {
	const header = new Int32Array(board, 0, 2);
	const offset = Atomics.add(header, BOARD_BUMP, size);
	if (offset < BOARD_DATA_OFFSET || offset > board.byteLength - size) {
		// Out of room (or the pointer has wrapped): hand the bytes back when no
		// other thread has taken any since, so a full board does not run away.
		Atomics.compareExchange(header, BOARD_BUMP, offset + size, offset);
		return undefined;
	}
	return offset;
}

/**
 * What the board holds for `intentPath` and the publication that put it there.
 * One `Atomics.load`: it cannot fail, cannot wait and cannot be left half done.
 */
export function readExitIntentEntry(board: SharedArrayBuffer, intentPath: string): ExitContextBoardEntry {
	const version = Atomics.load(new Int32Array(board, 0, 2), BOARD_HEAD);
	return { version, word: wordInChain(board, version, new TextEncoder().encode(intentPath)) };
}

/** The word recorded for `intentPath`, or `undefined` when the board holds none. */
export function recordedExitIntent(board: SharedArrayBuffer, intentPath: string): ExitContextWord | undefined {
	return readExitIntentEntry(board, intentPath).word;
}

/**
 * Put `candidate` on the board for `intentPath`, replacing exactly the state
 * `expected` was read from. `"published"` means the word is on the board;
 * `"lost"` means another thread published first and the caller must read again
 * and decide afresh; `"full"` means the board has no room and nothing was
 * recorded. Only the final compare-exchange changes anything another thread can
 * see, so a thread terminated anywhere in here either published its record
 * whole or published nothing.
 */
export function publishExitIntent(
	board: SharedArrayBuffer,
	intentPath: string,
	expected: ExitContextBoardEntry,
	candidate: ExitContextWord,
): ExitContextPublishResult {
	const encoder = new TextEncoder();
	const path = encoder.encode(intentPath);
	const word = encoder.encode(candidate.word);
	const size = Math.ceil((RECORD_TEXT + path.length + word.length) / 8) * 8;
	const offset = reserveRecord(board, size);
	if (offset === undefined) return "full";
	const view = new DataView(board);
	view.setInt32(offset + RECORD_PREV, expected.version, true);
	view.setInt32(offset + RECORD_PATH_LENGTH, path.length, true);
	view.setFloat64(offset + RECORD_MTIME, candidate.mtimeMs, true);
	view.setInt32(offset + RECORD_WORD_LENGTH, word.length, true);
	const bytes = new Uint8Array(board);
	bytes.set(path, offset + RECORD_TEXT);
	bytes.set(word, offset + RECORD_TEXT + path.length);
	const header = new Int32Array(board, 0, 2);
	return Atomics.compareExchange(header, BOARD_HEAD, expected.version, offset) === expected.version
		? "published"
		: "lost";
}
