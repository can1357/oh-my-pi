/**
 * Messages between `readExitContext` (`./exit-context`) and its reader thread
 * (`./exit-context-worker`), and the board every thread of the process shares.
 * Imports nothing, so the thread loads fast.
 */

/**
 * Longest the exiting thread waits for the reader thread's answer. A reader
 * also waits this long for an intent claim another thread started before it
 * takes the claim over, so a claimer that died does not hold the word forever.
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
	/** Whether to claim the intent file; false once the process already holds a word. */
	readIntent: boolean;
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
 * What the board holds. Sessions run on several threads of one process (worker
 * subagents), each with its own module state, so the word one thread claims
 * lives here for the others.
 */
export interface ExitContextBoardState {
	/** The word claimed from each intent file path; the first word claimed for a path stays. */
	words: Record<string, string>;
	/** Claims in progress, by intent file path: the claiming reader's token and when it started (epoch ms). */
	claims: Record<string, { token: string; since: number }>;
}

/** Board size: a production process uses one intent path; tests use a few hundred at most. */
const BOARD_BYTES = 64 * 1024;
/** Int32 words: a lock (0 free, 1 held), the state's JSON length, and a change count readers wait on. */
const BOARD_LOCK = 0;
const BOARD_LENGTH = 1;
const BOARD_CHANGE = 2;
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
	if (length === 0) return { words: {}, claims: {} };
	try {
		const parsed = JSON.parse(
			new TextDecoder().decode(new Uint8Array(board, BOARD_DATA_OFFSET, length).slice()),
		) as Partial<ExitContextBoardState>;
		return { words: parsed.words ?? {}, claims: parsed.claims ?? {} };
	} catch {
		return { words: {}, claims: {} };
	}
}

/** Encode `state`, dropping the oldest words until it fits; `undefined` when even that is not enough. */
function encodeBoardState(state: ExitContextBoardState, keep: string | undefined): Uint8Array | undefined {
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
 * Run `update` on the board's state under its lock and store what it leaves,
 * waking threads that wait for a change. The lock is held only for this memory
 * work, never across file I/O. `change` is the board's change count before
 * `update`, for {@link waitForExitContextBoardChange}. Returns `undefined`
 * when the lock does not come free within `timeoutMs`; `keep` names the path
 * whose word must survive trimming.
 */
export function updateExitContextBoard<T>(
	board: SharedArrayBuffer,
	timeoutMs: number,
	keep: string | undefined,
	update: (state: ExitContextBoardState, change: number) => T,
): { value: T } | undefined {
	const words = new Int32Array(board, 0, 3);
	const deadline = performance.now() + timeoutMs;
	while (Atomics.compareExchange(words, BOARD_LOCK, 0, 1) !== 0) {
		const left = deadline - performance.now();
		if (left <= 0) return undefined;
		Atomics.wait(words, BOARD_LOCK, 1, Math.min(left, 10));
	}
	try {
		const state = readBoardState(board, Atomics.load(words, BOARD_LENGTH));
		const before = JSON.stringify(state);
		const value = update(state, Atomics.load(words, BOARD_CHANGE));
		if (JSON.stringify(state) !== before) {
			const encoded = encodeBoardState(state, keep);
			if (encoded) {
				new Uint8Array(board, BOARD_DATA_OFFSET, encoded.length).set(encoded);
				Atomics.store(words, BOARD_LENGTH, encoded.length);
				Atomics.add(words, BOARD_CHANGE, 1);
				Atomics.notify(words, BOARD_CHANGE);
			}
		}
		return { value };
	} finally {
		Atomics.store(words, BOARD_LOCK, 0);
		Atomics.notify(words, BOARD_LOCK, 1);
	}
}

/** Wait until the board's change count moves past `change`, or `timeoutMs` passes. */
export function waitForExitContextBoardChange(board: SharedArrayBuffer, change: number, timeoutMs: number): void {
	Atomics.wait(new Int32Array(board, 0, 3), BOARD_CHANGE, change, Math.max(0, timeoutMs));
}
