import { type MessagePort, parentPort } from "node:worker_threads";
import type { AuthStorage, Provider, UsageHeaderIngestOptions } from "@oh-my-pi/pi-ai";
import type { WorkerThreadLink } from "../../../src/thread/protocol";
import { type RpcFrame, RpcLink } from "../../../src/thread/rpc";
import { authService } from "../../../src/thread/services/auth";

export interface Probe {
	ingest(storage: AuthStorage, provider: Provider, options: UsageHeaderIngestOptions): Promise<boolean>;
}
const port = parentPort;
if (!port) throw new Error("worker fixture requires parent port");
port.once("message", (init: { sync: MessagePort; counter: SharedArrayBuffer }) => {
	const link: WorkerThreadLink = new RpcLink(
		{
			send: frame => port.postMessage(frame),
			listen: handler => {
				const listener = (frame: RpcFrame) => handler(frame);
				port.on("message", listener);
				return () => port.off("message", listener);
			},
		},
		{ name: "usage-mirror-scope", sync: { port: init.sync, counter: new Int32Array(init.counter) } },
	);
	authService.installWorker?.(link);
	link.handle("ping", nonce => nonce);
	link.handle("boot", async globals => {
		await authService.boot?.(globals[authService.name], link);
		const test = globals.test as { ready(probe: Probe): Promise<void> };
		await test.ready({
			ingest: async (storage, provider, options) =>
				storage.usage.ingestHeaders(provider, { "x-test": "1" }, options),
		});
	});
	port.postMessage({ ready: true });
});
