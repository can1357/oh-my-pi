/**
 * Identity of the JavaScript thread this module instance runs on.
 *
 * The main thread is always `"main"`. Subagent host workers are numbered
 * `w1`, `w2`, … by the main-thread pool and set their id once during
 * bootstrap. Agent sessions record the thread that owns them ("home") so
 * other threads can route calls to the owner instead of touching a copy.
 */

/** Owning thread of an agent session or other thread-bound object. */
export type ThreadId = "main" | `w${number}`;

let current: ThreadId = "main";

/** Thread id of this module instance; `"main"` unless a worker bootstrap set it. */
export function currentThreadId(): ThreadId {
	return current;
}

/** Whether this module instance runs on the main thread. */
export function isMainThread(): boolean {
	return current === "main";
}

/** Worker bootstrap only: record the pool-assigned id before any session is created. */
export function setCurrentThreadId(id: ThreadId): void {
	current = id;
}

/** Narrow an untrusted value (e.g. decoded wire data) to a {@link ThreadId}. */
export function isThreadId(value: unknown): value is ThreadId {
	return value === "main" || (typeof value === "string" && /^w[1-9][0-9]*$/.test(value));
}
