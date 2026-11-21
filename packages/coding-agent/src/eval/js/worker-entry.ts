import { MessagePort, parentPort } from "node:worker_threads";
import { consumeWorkerInbox } from "@oh-my-pi/pi-utils/worker-host";
import { WorkerCore } from "./worker-core";
import type { Transport, WorkerInbound, WorkerOutbound, WorkerOutboxMessage } from "./worker-protocol";

if (!parentPort) throw new Error("js worker-entry: missing parentPort");

const port = parentPort;
// The host's first message hands over the port every outbound message goes on (see
// `WorkerOutboxMessage`); until then nothing is sent, as the core only answers the host.
let outbox: MessagePort | undefined;

function isOutbox(data: unknown): data is WorkerOutboxMessage {
	return (
		typeof data === "object" &&
		data !== null &&
		Reflect.get(data, "type") === "outbox" &&
		Reflect.get(data, "port") instanceof MessagePort
	);
}

// When the CLI host pre-buffered messages (it imports this module dynamically),
// bind that inbox so the parent's already-delivered `init` is replayed. Loaded
// directly (test/SDK fallback), this module's top-level runs synchronously at
// worker start, so the direct `parentPort.on` below wins the flush on its own.
const inbox = consumeWorkerInbox();
const transport: Transport = {
	send: (msg: WorkerOutbound) => (outbox ?? port).postMessage(msg),
	onMessage: handler => {
		const receive = (data: unknown): void => {
			if (isOutbox(data)) outbox = data.port;
			else handler(data as WorkerInbound);
		};
		if (inbox) return inbox.bind(receive);
		port.on("message", receive);
		return () => port.off("message", receive);
	},
	close: () => {
		try {
			port.close();
		} catch {
			// Already closed.
		}

		// `parentPort.close()` only disconnects the channel in Bun; it does not
		// make the Worker emit `close` or reap ref'ed user handles. Exit from
		// inside the worker after `WorkerCore` has sent the `closed` ack so the
		// host can observe real worker exit without calling `Worker.terminate()`.
		setTimeout(() => process.exit(0), 0);
	},
};

new WorkerCore(transport, { mode: "isolated" });
