/**
 * A session thread for session-exit-context.test.ts. It runs in a worker thread
 * of the test process, as a worker-thread subagent's session does, and answers
 * each request with what `readExitContext` records at that session's exit.
 *
 * A request with `processStart: "thread"` reads with the process start this
 * thread's own default sources give, as a session on this thread does. A
 * request with `gate` first posts `"at-gate"`, then waits until word 0 of the
 * gate is set, so several threads read at the same moment.
 */
import { parentPort } from "node:worker_threads";
import {
	defaultExitContextSources,
	type ExitContextSources,
	readExitContext,
	startExitContextReader,
} from "@oh-my-pi/pi-coding-agent/session/exit-context";

export interface ExitContextThreadRequest {
	sources: ExitContextSources;
	processStart?: "thread";
	gate?: SharedArrayBuffer;
}

if (!parentPort) throw new Error("session-exit-context-thread: missing parentPort");
const port = parentPort;
startExitContextReader();

port.on("message", (request: ExitContextThreadRequest) => {
	const sources =
		request.processStart === "thread"
			? { ...request.sources, processStartMs: defaultExitContextSources().processStartMs }
			: request.sources;
	if (request.gate) {
		port.postMessage("at-gate");
		Atomics.wait(new Int32Array(request.gate), 0, 0);
	}
	// A cold reader thread loads first; the deadline itself is tested on the main thread.
	port.postMessage(readExitContext(sources, 30_000));
});
port.postMessage("ready");
