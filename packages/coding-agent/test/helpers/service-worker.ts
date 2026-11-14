import { MessageChannel } from "node:worker_threads";
import type { MainThreadLink } from "../../src/thread/protocol";
import { type RpcFrame, RpcLink } from "../../src/thread/rpc";
import type { ThreadService, WorkerPeer } from "../../src/thread/services";
import { isSubagentWorkerLog, receiveWorkerLog } from "../../src/thread/worker-log";

/** A booted fixture worker running the services under test, linked to this (main) thread. */
export interface ServiceWorker<Probe> {
	readonly worker: Worker;
	readonly peer: WorkerPeer;
	/** What the fixture handed to its `test.ready` boot global. */
	readonly probe: Probe;
	/** Run every service's `onWorkerExit`, close the link, and terminate the worker. */
	stop(): Promise<void>;
}

/**
 * Spawn the fixture at `url` (which hand-builds the worker link, installs
 * `services`, and calls `globals.test.ready(probe)` from `boot`), then install
 * the main halves of `services` and boot it as worker `w1`.
 */
export async function startServiceWorker<Probe>(url: URL, services: ThreadService[]): Promise<ServiceWorker<Probe>> {
	const worker = new Worker(url.href, { type: "module" });
	// Fixtures that install the worker log port post records as raw messages, like the real entry.
	worker.addEventListener("message", (event: MessageEvent) => {
		if (isSubagentWorkerLog(event.data)) receiveWorkerLog("w1", event.data);
	});
	const channel = new MessageChannel();
	const counter = new SharedArrayBuffer(4);
	const { promise: ready, resolve: onReady } = Promise.withResolvers<void>();
	const readyListener = (event: MessageEvent): void => {
		if (event.data?.ready) {
			worker.removeEventListener("message", readyListener);
			onReady();
		}
	};
	worker.addEventListener("message", readyListener);
	worker.postMessage({ sync: channel.port2, counter }, [channel.port2]);
	await ready;
	const link: MainThreadLink = new RpcLink(
		{
			send: frame => worker.postMessage(frame),
			listen: handler => {
				const listener = (event: MessageEvent<RpcFrame>): void => {
					if (!isSubagentWorkerLog(event.data)) handler(event.data);
				};
				worker.addEventListener("message", listener);
				return () => worker.removeEventListener("message", listener);
			},
		},
		{ name: "main↔fixture", syncReplies: { port: channel.port1, counter: new Int32Array(counter) } },
	);
	link.handle("ping", nonce => nonce);
	const peer: WorkerPeer = { threadId: "w1", link };
	for (const service of services) service.installMain?.(peer);
	const { promise: probed, resolve: onProbe } = Promise.withResolvers<Probe>();
	const globals: Record<string, unknown> = { test: { ready: (probe: Probe) => onProbe(probe) } };
	for (const service of services) globals[service.name] = service.globals?.(peer);
	await link.call("boot", globals);
	const probe = await probed;
	return {
		worker,
		peer,
		probe,
		async stop() {
			link.close("test done");
			for (const service of services) service.onWorkerExit?.(peer, "test done");
			await worker.terminate();
		},
	};
}
