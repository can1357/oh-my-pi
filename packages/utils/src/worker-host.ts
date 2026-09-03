import { stripWindowsExtendedLengthPathPrefix } from "./path";

/** Prefix reserved for argv selectors dispatched by the shared CLI worker host. */
export const WORKER_HOST_SELECTOR_PREFIX = "__omp_worker_";

/** Whether an argv value selects a worker hosted by the shared CLI entrypoint. */
export function isWorkerHostSelector(value: string | undefined): value is string {
	return value?.startsWith(WORKER_HOST_SELECTOR_PREFIX) ?? false;
}

/**
 * Main-module path declared by self-dispatching CLI entrypoints — entries
 * whose top-level argv handling routes hidden `__omp_*` worker selectors.
 * Worker spawn sites re-enter this module via `new Worker(entry, { argv })`,
 * so every distribution (source, npm bundle, compiled binary) needs exactly
 * one JavaScript entrypoint. Never set under `bun test`, SDK embedding, or
 * standalone package bins — those hosts load worker modules directly.
 */
let workerHostMain: string | null = null;

/** Called by CLI entrypoints whose main module dispatches worker argv selectors. */
export function declareWorkerHostEntry(): void {
	workerHostMain = stripWindowsExtendedLengthPathPrefix(Bun.main);
}

/** Main-module path of the self-dispatching CLI host, or null outside it. */
export function workerHostEntry(): string | null {
	return workerHostMain;
}

/**
 * Buffers messages a Bun worker thread receives before its real handler is
 * attached, then hands them off once it is.
 *
 * Bun delivers messages the parent posted before the worker spawned exactly
 * once — when the worker entry module's top-level evaluation completes — to the
 * `message` listeners present at that moment. A worker whose handler attaches
 * via a later `await import(...)` therefore misses that flush. The
 * self-dispatching CLI host imports each worker module dynamically from inside
 * its argv dispatch, so the worker's own `parentPort.on("message")` lands after
 * the flush and the parent's synchronously-posted `init` handshake is dropped —
 * every run then stalls until the init timeout fires and silently falls back to
 * the inline worker (issue: eval cells always taking the full timeout).
 *
 * The host calls {@link installWorkerInbox} synchronously in the entry's sync
 * prefix (before importing the worker module) so a `parentPort` listener exists
 * at flush time; the worker module then {@link consumeWorkerInbox}es it and
 * binds the real handler, replaying anything buffered. Re-dispatching through
 * `parentPort.emit("message", …)` is not an option — Bun's port is an
 * `EventTarget` whose `emit` throws — so the inbox calls the handler directly.
 */
export interface WorkerInbox {
	/** Route buffered and subsequent messages to `handler`; returns an unbind fn. */
	bind(handler: (message: unknown) => void): () => void;
}

/** Minimal `parentPort` surface the inbox needs (Node/Bun `MessagePort`). */
interface MessageListenerPort {
	on(event: "message", listener: (value: unknown) => void): unknown;
}

let pendingInbox: WorkerInbox | null = null;

/**
 * Attach a buffering `message` listener on `port` synchronously and stash the
 * resulting inbox for the worker module to {@link consumeWorkerInbox}. MUST be
 * called in the entry module's synchronous prefix — before the worker module is
 * imported — so the listener exists when Bun flushes pre-spawn messages.
 */
export function installWorkerInbox(port: MessageListenerPort): WorkerInbox {
	const queue: unknown[] = [];
	let handler: ((message: unknown) => void) | null = null;
	port.on("message", (data: unknown) => {
		if (handler) handler(data);
		else queue.push(data);
	});
	const inbox: WorkerInbox = {
		bind(next) {
			handler = next;
			for (const data of queue) next(data);
			queue.length = 0;
			return () => {
				if (handler === next) handler = null;
			};
		},
	};
	pendingInbox = inbox;
	return inbox;
}

/**
 * Take the inbox installed by {@link installWorkerInbox} for this worker, or
 * `null` when the worker module was loaded directly (no host pre-buffering, so
 * the module's own synchronous top-level listener already wins the flush).
 */
export function consumeWorkerInbox(): WorkerInbox | null {
	const inbox = pendingInbox;
	pendingInbox = null;
	return inbox;
}
