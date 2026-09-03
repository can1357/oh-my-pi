import { parentPort } from "node:worker_threads";
import { installWorkerInbox, WORKER_HOST_SELECTOR_PREFIX } from "@oh-my-pi/pi-utils/worker-host";
import { COMPUTER_WORKER_ARG } from "../../src/tools/computer/protocol";

const STATS_WORKER_ARG = `${WORKER_HOST_SELECTOR_PREFIX}stats_sync`;

declare const self: Worker & {
	onmessage: ((event: MessageEvent<{ kind: "ping" }>) => void) | null;
};

if (Bun.isMainThread) {
	const worker = new Worker(Bun.main, { type: "module", argv: [STATS_WORKER_ARG] });
	const response = Promise.withResolvers<unknown>();
	worker.addEventListener("message", event => response.resolve(event.data));
	worker.addEventListener("error", event => response.reject(event.error ?? new Error(event.message)));
	worker.postMessage({ kind: "ping" });
	try {
		process.stdout.write(`${JSON.stringify(await response.promise)}\n`);
	} finally {
		worker.terminate();
	}
} else {
	const selector = process.argv.find(arg => arg.startsWith(WORKER_HOST_SELECTOR_PREFIX));
	if (selector === COMPUTER_WORKER_ARG) {
		if (!parentPort) throw new Error("compiled worker fixture: missing parentPort");
		installWorkerInbox(parentPort);
		await import("../../src/tools/computer/worker-entry");
	} else if (selector === STATS_WORKER_ARG) {
		self.onmessage = (_event: MessageEvent<{ kind: "ping" }>) => {
			self.postMessage({ ok: true, kind: "pong" });
		};
	} else {
		throw new Error(`unknown worker selector: ${selector}`);
	}
}
