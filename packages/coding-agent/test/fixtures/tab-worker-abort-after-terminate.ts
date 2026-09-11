/**
 * Child program behind `test/tools/browser-tab-worker-gone-send.test.ts`.
 *
 * Reproduces the production interleaving: the caller of a browser run aborts
 * (the eval idle watchdog firing `Idle for Ns`) after the tab's worker has
 * already been terminated (tab release, timed-out recycle, or force-kill).
 *
 * It runs in a child process because the failure is process-level: a throw from
 * inside an `abort` listener has no catch site and reaches the process as an
 * uncaught exception. The child reports that outcome as a `FATAL:` marker plus a
 * non-zero exit code instead of letting it reach the test runner, and prints how
 * many of the run's tool-call controllers the abort listener reached.
 */
import { wrapBunWorkerForTest } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";

process.on("uncaughtException", (error: Error): void => {
	process.stdout.write(`FATAL:${error.name}: ${error.message}\n`);
	process.exitCode = 7;
});

// Spawned exactly like a real tab worker: a module worker file, not an inline
// data URL, so `postMessage` and thread teardown behave the same way.
const worker = new Worker(new URL("./tab-worker-echo.ts", import.meta.url), { type: "module" });

function nextWorkerMessage(): Promise<unknown> {
	const { promise, resolve } = Promise.withResolvers<unknown>();
	worker.addEventListener("message", (event: MessageEvent) => resolve(event.data), { once: true });
	return promise;
}

// Live transport first, so the state under test is a worker that died rather
// than one that never started.
const echoed = nextWorkerMessage();
worker.postMessage("ready");
await echoed;

const handle = wrapBunWorkerForTest(worker);
// `postMessage` keeps accepting messages for a moment after `terminate()`
// returns and only starts rejecting once the thread is really gone, so waiting
// for `close` is what makes the terminated state deterministic.
const closed = Promise.withResolvers<void>();
worker.addEventListener("close", () => closed.resolve(), { once: true });
worker.terminate();
await closed.promise;

const caller = new AbortController();
let abortedToolCalls = 0;
// Mirrors `runInTabWithSnapshot`: the caller's `abort` listener posts the run's
// `abort` and only then unwinds the run's tool-call controllers, so a throw from
// the post strands the delegated work of an already-cancelled run.
caller.signal.addEventListener(
	"abort",
	() => {
		handle.send({ type: "abort", id: "r-1" });
		abortedToolCalls++;
	},
	{ once: true },
);
caller.abort(new DOMException("Idle for 300s", "TimeoutError"));
// Yields one event-loop turn: the awaited condition is the turn itself, so an
// error escaping the listener has reached the process handlers when the child
// reports its outcome.
await new Promise<void>(resolve => setTimeout(resolve, 0));
process.stdout.write(`ABORTED_TOOL_CALLS:${abortedToolCalls}\n`);
