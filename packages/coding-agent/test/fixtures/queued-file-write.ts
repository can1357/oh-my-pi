import assert from "node:assert/strict";
import * as path from "node:path";
import { setImmediate } from "node:timers/promises";
import { parentPort } from "node:worker_threads";
import { declareWorkerHostEntry, installWorkerInbox } from "@oh-my-pi/pi-utils/worker-host";
import { writethroughNoop } from "../../src/lsp/writethrough";

const channel = new BroadcastChannel(`queued-file-write:${process.pid}`);
try {
	const received = Promise.withResolvers<unknown>();
	channel.onmessage = event => received.resolve(event.data);
	if (Bun.isMainThread) {
		declareWorkerHostEntry();
		const dir = process.argv[2]!;
		const blocker = path.join(dir, "blocker.txt");
		const target = path.join(dir, "target.txt");
		const first = writethroughNoop(blocker, "first write\n");
		const controller = new AbortController();
		let failure: unknown;
		const second = writethroughNoop(target, "stale write\n", controller.signal).catch(error => {
			failure = error;
		});
		assert.equal(await received.promise, "ready");
		const reason = new Error("cancelled while queued");
		controller.abort(reason);
		await Bun.write(target, "user save\n");
		await setImmediate();
		const cancelledBeforeRelease = failure === reason;
		channel.postMessage("release");
		await Promise.all([first, second]);
		// Drain prior messages even when the caller already observed cancellation.
		await writethroughNoop(path.join(dir, "barrier.txt"), "barrier\n");
		assert.equal(await Bun.file(blocker).text(), "first write\n");
		assert.equal(await Bun.file(target).text(), "user save\n");
		assert.ok(cancelledBeforeRelease, "queued write did not reject until the worker resumed");
	} else {
		assert.ok(parentPort);
		// Hold real file-write messages at the inbox before loading the worker.
		installWorkerInbox(parentPort);
		channel.postMessage("ready");
		// The worker entry must stay live even before its async import.
		assert.equal(await received.promise, "release");
		await import("../../src/tools/file-write-worker");
	}
} finally {
	channel.close();
}
