/**
 * Messages between `readExitContext` (`./exit-context`) and its reader thread
 * (`./exit-context-worker`), and the board every thread of the process shares.
 * Imports nothing, so the thread loads fast.
 */

/**
 * Longest the exiting thread waits for the reader thread's answer, and the
 * longest a reader thread waits for the board's lock before it goes on without
 * it and records what it read for its own thread alone.
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
 * A word taken from an intent file, dated with that file's mtime: the moment
 * the sender published it. Readers merge words by that date and never by the
 * order in which they happen to run, so what the process records does not
 * depend on how its threads were scheduled.
 */
export interface ExitContextWord {
	word: string;
	mtimeMs: number;
}

/**
 * What the board holds. Sessions run on several threads of one process (worker
 * subagents), each with its own module state, so the word one thread takes
 * lives here for the others.
 */
export interface ExitContextBoardState {
	/** The word recorded for each intent file path; replaced only by a word the sender published later. */
	words: Record<string, ExitContextWord>;
}

/** Board size: a production process uses one intent path; tests use a few hundred at most. */
const BOARD_BYTES = 64 * 1024;
/** Int32 words: a lock (0 free, 1 held) and the state's JSON length. */
const BOARD_LOCK = 0;
const BOARD_LENGTH = 1;
/** A Float64 at this byte: the epoch ms the process started, set once when the board is made. */
const BOARD_START_OFFSET = 16;
/** The state's JSON starts at this byte. */
const BOARD_DATA_OFFSET = 24;

/**
 * Make the process's board. One thread makes it and hands it to the threads it
 * starts; `processStartMs` is that thread's start, which every thread then uses
 * to date intent files, since each worker thread has its own time origin.
 */
export function createExitContextBoard(processStartMs: number): SharedArrayBuffer {
	const board = new SharedArrayBuffer(BOARD_BYTES);
	new Float64Array(board, BOARD_START_OFFSET, 1)[0] = processStartMs;
	return board;
}

/** The process start the board was made with. */
export function exitContextBoardProcessStart(board: SharedArrayBuffer): number {
	return new Float64Array(board, BOARD_START_OFFSET, 1)[0]!;
}

function readBoardState(board: SharedArrayBuffer, length: number): ExitContextBoardState {
	if (length === 0) return { words: {} };
	try {
		const parsed = JSON.parse(
			new TextDecoder().decode(new Uint8Array(board, BOARD_DATA_OFFSET, length).slice()),
		) as Partial<ExitContextBoardState>;
		return { words: parsed.words ?? {} };
	} catch {
		return { words: {} };
	}
}

/** Encode `state`, dropping the oldest words until it fits; `undefined` when even that is not enough. */
function encodeBoardState(state: ExitContextBoardState, keep: string): Uint8Array | undefined {
	const capacity = BOARD_BYTES - BOARD_DATA_OFFSET;
	for (;;) {
		const encoded = new TextEncoder().encode(JSON.stringify(state));
		if (encoded.length <= capacity) return encoded;
		const oldest = Object.keys(state.words).find(key => key !== keep);
		if (oldest === undefined) return undefined;
		delete state.words[oldest];
	}
}

/**
 * Run `update` on the board's state under its lock and store what it leaves.
 * The lock is held only for this memory work, never across file I/O. Returns
 * `undefined` when the lock does not come free within `timeoutMs`; `keep` names
 * the path whose word must survive trimming.
 */
function updateExitContextBoard<T>(
	board: SharedArrayBuffer,
	timeoutMs: number,
	keep: string,
	update: (state: ExitContextBoardState) => T,
): { value: T } | undefined {
	const words = new Int32Array(board, 0, 2);
	const deadline = performance.now() + timeoutMs;
	while (Atomics.compareExchange(words, BOARD_LOCK, 0, 1) !== 0) {
		const left = deadline - performance.now();
		if (left <= 0) return undefined;
		Atomics.wait(words, BOARD_LOCK, 1, Math.min(left, 10));
	}
	try {
		const state = readBoardState(board, Atomics.load(words, BOARD_LENGTH));
		const before = JSON.stringify(state);
		const value = update(state);
		if (JSON.stringify(state) !== before) {
			const encoded = encodeBoardState(state, keep);
			if (encoded) {
				new Uint8Array(board, BOARD_DATA_OFFSET, encoded.length).set(encoded);
				Atomics.store(words, BOARD_LENGTH, encoded.length);
			}
		}
		return { value };
	} finally {
		Atomics.store(words, BOARD_LOCK, 0);
		Atomics.notify(words, BOARD_LOCK, 1);
	}
}

/** The word recorded for `intentPath`; `undefined` when none is, or when the board stayed locked. */
export function recordedExitIntent(
	board: SharedArrayBuffer,
	timeoutMs: number,
	intentPath: string,
): ExitContextWord | undefined {
	return updateExitContextBoard(board, Math.max(0, timeoutMs), intentPath, state => state.words[intentPath])?.value;
}

/**
 * Record `candidate` for `intentPath`, unless a word the sender published no
 * earlier is already recorded, and answer with the word that stands afterwards.
 * `undefined` when the board stayed locked, and the caller keeps the word for
 * its own thread. A recorded word is only ever replaced by a later one, so no
 * exit of the process forgets a word another exit already recorded.
 */
export function recordExitIntent(
	board: SharedArrayBuffer,
	timeoutMs: number,
	intentPath: string,
	candidate: ExitContextWord,
): ExitContextWord | undefined {
	return updateExitContextBoard(board, Math.max(0, timeoutMs), intentPath, state => {
		const recorded = state.words[intentPath];
		if (!recorded || candidate.mtimeMs > recorded.mtimeMs) state.words[intentPath] = candidate;
		return state.words[intentPath]!;
	})?.value;
}
