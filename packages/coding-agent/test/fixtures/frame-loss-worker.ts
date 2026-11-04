// A subagent worker that speaks the real init protocol and serves one method: post frames to main,
// then die while main still holds them undispatched (see `postThenDie` in subagent-worker.test.ts).
import { MessagePort, parentPort } from "node:worker_threads";
import { isThreadId, setCurrentThreadId } from "../../src/thread/identity";
import type { SubagentWorkerInit, SubagentWorkerReady } from "../../src/thread/protocol";
import { type RpcFrame, RpcLink, type RpcMethod } from "../../src/thread/rpc";

/** How the worker ends after posting its frames. */
export type FrameLossDeath = "terminated" | "crash";

/** Methods the fixture serves to main. */
export type FrameLossWorkerApi = {
	/** Start-up handshake every subagent worker serves; the fixture has no services to boot. */
	boot: RpcMethod<[globals: Record<string, unknown>], void>;
	/**
	 * Notify main `frameProbe`, reply `"done"`, then set `flags[0]` and either block
	 * (main terminates it) or crash with an uncaught error.
	 */
	postThenDie: RpcMethod<[flags: SharedArrayBuffer, death: FrameLossDeath], string>;
};

/** Methods main serves to the fixture. */
export type FrameLossMainApi = {
	frameProbe: RpcMethod<[frame: { id: string; status: string }], void>;
};

const port = parentPort;
if (!port) throw new Error("fixture must run in a worker");

function isInit(value: unknown): value is SubagentWorkerInit {
	return (
		typeof value === "object" &&
		value !== null &&
		Reflect.get(value, "type") === "subagent-worker-init" &&
		isThreadId(Reflect.get(value, "threadId")) &&
		Reflect.get(value, "framePort") instanceof MessagePort &&
		Reflect.get(value, "replyPort") instanceof MessagePort &&
		Reflect.get(value, "counter") instanceof SharedArrayBuffer
	);
}

function isFrame(value: unknown): value is RpcFrame {
	return typeof value === "object" && value !== null && typeof Reflect.get(value, "t") === "string";
}

let frameHandler: ((frame: RpcFrame) => void) | undefined;

port.on("message", (message: unknown) => {
	if (!frameHandler) {
		if (!isInit(message)) return;
		setCurrentThreadId(message.threadId);
		const frames = message.framePort;
		const link = new RpcLink<FrameLossWorkerApi, FrameLossMainApi>(
			{
				send: frame => frames.postMessage(frame),
				listen: handler => {
					frameHandler = handler;
					return () => {
						frameHandler = undefined;
					};
				},
			},
			{
				name: `${message.threadId}↔main`,
				sync: { port: message.replyPort, counter: new Int32Array(message.counter) },
			},
		);
		link.handle("boot", () => {});
		link.handle("postThenDie", (buffer, death) => {
			const flags = new Int32Array(buffer);
			link.notify("frameProbe", { id: "frame-loss-run", status: "started" });
			// Timers run after the microtask that posts this call's reply, so both frames are posted by then.
			setTimeout(() => {
				Atomics.store(flags, 0, 1);
				Atomics.notify(flags, 0);
				if (death === "crash") throw new Error("fixture crash after posting");
				Atomics.wait(flags, 1, 0, 60_000);
			}, 0);
			return "done";
		});
		const ready: SubagentWorkerReady = { type: "subagent-worker-ready", changedModules: [] };
		port.postMessage(ready);
		return;
	}
	if (isFrame(message)) frameHandler(message);
});
