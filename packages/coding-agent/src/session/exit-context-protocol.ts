/**
 * Messages between `readExitContext` (`./exit-context`) and its reader thread
 * (`./exit-context-worker`). Imports nothing, so the thread loads fast.
 */

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
}

/** The reader thread's answer: the fields whose files it could read. */
export interface ExitContextIoResult {
	oomKills?: number;
	intent?: string;
}
