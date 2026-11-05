import { type MessagePort, parentPort } from "node:worker_threads";
import { isSharedLspEnabled } from "../../src/lsp/client";
import { setCurrentThreadId } from "../../src/thread/identity";
import type { WorkerThreadLink } from "../../src/thread/protocol";
import { type RpcFrame, RpcLink } from "../../src/thread/rpc";
import { lspThreadService } from "../../src/thread/services/lsp";

/** Worker-side operations the test drives; each crosses to main as an async function. */
export interface LspModeProbe {
	/** The worker's `isSharedLspEnabled()`. */
	mode(): Promise<boolean>;
}

function isTestGlobals(value: unknown): value is { ready(probe: LspModeProbe): void } {
	return typeof value === "object" && value !== null && typeof Reflect.get(value, "ready") === "function";
}

const probe: LspModeProbe = { mode: async () => isSharedLspEnabled() };

const port = parentPort;
if (!port) throw new Error("fixture must run in a worker");

port.once("message", (init: { sync: MessagePort; counter: SharedArrayBuffer }) => {
	setCurrentThreadId("w1");
	const link: WorkerThreadLink = new RpcLink(
		{
			send: frame => port.postMessage(frame),
			listen: handler => {
				const listener = (frame: RpcFrame): void => handler(frame);
				port.on("message", listener);
				return () => port.off("message", listener);
			},
		},
		{ name: "lsp-fixture", sync: { port: init.sync, counter: new Int32Array(init.counter) } },
	);
	lspThreadService.installWorker?.(link);
	link.handle("ping", nonce => nonce);
	link.handle("boot", async globals => {
		await lspThreadService.boot?.(globals[lspThreadService.name], link);
		const test = globals.test;
		if (!isTestGlobals(test)) throw new Error("lsp fixture: missing test globals");
		await test.ready(probe);
	});
	port.postMessage({ ready: true });
});
