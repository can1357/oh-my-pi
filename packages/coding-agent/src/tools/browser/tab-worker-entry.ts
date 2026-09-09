import { parentPort } from "node:worker_threads";
import { consumeWorkerInbox } from "@oh-my-pi/pi-utils/worker-host";
import type { Transport, WorkerInbound, WorkerOutbound } from "./tab-protocol";
import { WorkerCore } from "./tab-worker";

if (!parentPort) throw new Error("tab-worker-entry: missing parentPort");

const port = parentPort;
// When the CLI host pre-buffered messages (it imports this module dynamically),
// bind that inbox so the parent's already-delivered `init` is replayed. Loaded
// directly (test/SDK fallback), this module's top-level runs synchronously at
// worker start, so the direct `parentPort.on` below wins the flush on its own.
const inbox = consumeWorkerInbox();
const transport: Transport = {
	send(msg, transferList) {
		port.postMessage(msg, transferList ?? []);
	},
	onMessage(handler) {
		if (inbox) return inbox.bind(data => handler(data as WorkerOutbound | WorkerInbound));
		const wrap = (message: unknown): void => handler(message as WorkerOutbound | WorkerInbound);
		port.on("message", wrap);
		return () => port.off("message", wrap);
	},
	close() {
		port.close();
	},
};

new WorkerCore(transport, true);
