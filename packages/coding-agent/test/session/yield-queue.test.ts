import { describe, expect, test } from "bun:test";
import {
	type AgentMessage,
	ASIDE_MESSAGE_CLAIM,
	ASIDE_MESSAGE_COMMIT,
	type CommittableAsideMessage,
} from "@oh-my-pi/pi-agent-core";
import { YieldQueue } from "@oh-my-pi/pi-coding-agent/session/yield-queue";

type Entry = {
	id: string;
	stale?: boolean;
};

function userMessage(text: string): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: 0,
	};
}

function messageText(message: AgentMessage): string {
	if (!("content" in message) || !Array.isArray(message.content)) return "";
	const block = message.content[0];
	return block?.type === "text" ? block.text : "";
}

function createHarness(initialStreaming: boolean) {
	let streaming = initialStreaming;
	const streamingMessages: AgentMessage[] = [];
	const idleBatches: AgentMessage[][] = [];
	const scheduledFlushes: Array<() => Promise<void>> = [];
	const queue = new YieldQueue({
		isStreaming: () => streaming,
		injectStreaming: message => {
			streamingMessages.push(message);
		},
		injectIdle: async messages => {
			idleBatches.push(messages);
		},
		scheduleIdleFlush: run => {
			scheduledFlushes.push(run);
		},
	});
	return {
		queue,
		streamingMessages,
		idleBatches,
		scheduledFlushes,
		setStreaming: (value: boolean) => {
			streaming = value;
		},
	};
}

describe("YieldQueue", () => {
	test("enqueue while streaming defers until streaming flush", async () => {
		const harness = createHarness(true);
		harness.queue.register<Entry>("items", {
			build: entries => userMessage(entries.map(entry => entry.id).join(",")),
		});

		harness.queue.enqueue("items", { id: "a" });

		expect(harness.scheduledFlushes).toHaveLength(0);
		expect(harness.streamingMessages).toHaveLength(0);
		expect(harness.queue.has("items")).toBe(true);

		await harness.queue.flush("streaming");

		expect(harness.queue.has()).toBe(false);
		expect(harness.streamingMessages.map(messageText)).toEqual(["a"]);
	});

	test("requested idle flush waits for an explicit stream-settlement retry", async () => {
		const harness = createHarness(true);
		harness.queue.register<Entry>("items", {
			build: entries => userMessage(entries.map(entry => entry.id).join(",")),
		});
		harness.queue.enqueue("items", { id: "late" });
		harness.queue.requestIdleFlush();
		expect(harness.scheduledFlushes).toHaveLength(1);

		await harness.scheduledFlushes[0]!();
		expect(harness.scheduledFlushes).toHaveLength(1);
		expect(harness.idleBatches).toHaveLength(0);

		harness.setStreaming(false);
		harness.queue.requestIdleFlush();
		await harness.scheduledFlushes[1]!();

		expect(harness.idleBatches[0]?.map(messageText)).toEqual(["late"]);
	});

	test("a deferred entry stays queued through a flush and is delivered at the next one", async () => {
		const harness = createHarness(false);
		let holding = true;
		harness.queue.register<Entry>("items", {
			isDeferred: () => holding,
			isStale: entry => entry.stale === true,
			build: entries => userMessage(entries.map(entry => entry.id).join(",")),
		});

		harness.queue.enqueue("items", { id: "held" });
		// Deferred: neither delivered nor dropped, and not deliverable yet.
		expect(harness.queue.hasDeliverable("items")).toBe(false);
		await harness.queue.flush("idle");
		expect(harness.idleBatches).toHaveLength(0);
		expect(harness.queue.has("items")).toBe(true);

		holding = false;
		expect(harness.queue.hasDeliverable("items")).toBe(true);
		await harness.queue.flush("idle");

		expect(harness.idleBatches.map(batch => batch.map(messageText))).toEqual([["held"]]);
		expect(harness.queue.has("items")).toBe(false);
	});
	test("requested idle flush preserves skip-only entries", async () => {
		const harness = createHarness(true);
		harness.queue.register<Entry>("advisor", {
			build: entries => userMessage(entries.map(entry => entry.id).join(",")),
			skipIdleFlush: true,
		});
		harness.queue.register<Entry>("completion", {
			build: entries => userMessage(entries.map(entry => entry.id).join(",")),
		});
		harness.queue.enqueue("advisor", { id: "advice" });
		harness.queue.requestIdleFlush();
		expect(harness.scheduledFlushes).toHaveLength(0);

		harness.queue.enqueue("completion", { id: "done" });
		harness.queue.requestIdleFlush();
		harness.setStreaming(false);
		await harness.scheduledFlushes[0]!();

		expect(harness.idleBatches[0]?.map(messageText)).toEqual(["done"]);
		expect(harness.queue.has("advisor")).toBe(true);
	});
	test("enqueue while idle schedules one debounced idle flush", async () => {
		const harness = createHarness(false);
		harness.queue.register<Entry>("items", {
			build: entries => userMessage(entries.map(entry => entry.id).join(",")),
		});

		harness.queue.enqueue("items", { id: "a" });
		harness.queue.enqueue("items", { id: "b" });

		expect(harness.scheduledFlushes).toHaveLength(1);
		expect(harness.idleBatches).toHaveLength(0);

		await harness.scheduledFlushes[0]!();

		expect(harness.idleBatches).toHaveLength(1);
		expect(harness.idleBatches[0]?.map(messageText)).toEqual(["a,b"]);
	});

	test("resolves delivery receipts only after idle injection succeeds", async () => {
		const injected = Promise.withResolvers<void>();
		const scheduledFlushes: Array<() => Promise<void>> = [];
		const queue = new YieldQueue({
			isStreaming: () => false,
			injectIdle: async () => injected.promise,
			scheduleIdleFlush: run => scheduledFlushes.push(run),
		});
		queue.register<Entry>("items", {
			build: entries => userMessage(entries.map(entry => entry.id).join(",")),
		});
		let delivered = false;
		const receipt = queue.enqueueWithReceipt("items", { id: "durable" }).then(() => {
			delivered = true;
		});

		const flush = scheduledFlushes[0]!();
		await Promise.resolve();
		expect(delivered).toBe(false);
		injected.resolve();
		await flush;
		await receipt;
		expect(delivered).toBe(true);
	});

	test("resolves an idle receipt when injection commits before the turn finishes", async () => {
		const finishTurn = Promise.withResolvers<void>();
		const scheduledFlushes: Array<() => Promise<void>> = [];
		const queue = new YieldQueue({
			isStreaming: () => false,
			injectIdle: async messages => {
				(messages[0] as AgentMessage & { [ASIDE_MESSAGE_COMMIT]?: () => void })[ASIDE_MESSAGE_COMMIT]?.();
				await finishTurn.promise;
			},
			scheduleIdleFlush: run => scheduledFlushes.push(run),
		});
		queue.register<Entry>("items", {
			build: entries => userMessage(entries.map(entry => entry.id).join(",")),
		});
		const receipt = queue.enqueueWithReceipt("items", { id: "idle-commit" });

		const flush = scheduledFlushes[0]!();
		await receipt;
		let flushFinished = false;
		void flush.then(() => {
			flushFinished = true;
		});
		await Promise.resolve();
		expect(flushFinished).toBe(false);
		finishTurn.resolve();
		await flush;
	});

	test("isStale drops stale entries and keeps survivors", async () => {
		const harness = createHarness(true);
		let survivorIds: string[] = [];
		harness.queue.register<Entry>("items", {
			isStale: entry => entry.stale === true,
			build: entries => {
				survivorIds = entries.map(entry => entry.id);
				return userMessage(survivorIds.join(","));
			},
		});

		harness.queue.enqueue("items", { id: "old", stale: true });
		harness.queue.enqueue("items", { id: "fresh" });
		await harness.queue.flush("streaming");

		expect(survivorIds).toEqual(["fresh"]);
		expect(harness.streamingMessages.map(messageText)).toEqual(["fresh"]);
	});

	test("build returning null does not inject", async () => {
		const harness = createHarness(true);
		harness.queue.register<Entry>("items", {
			build: () => null,
		});

		harness.queue.enqueue("items", { id: "a" });
		await harness.queue.flush("streaming");

		expect(harness.streamingMessages).toHaveLength(0);
		expect(harness.idleBatches).toHaveLength(0);
	});

	test("one kind failing in build does not abort other kinds", async () => {
		const harness = createHarness(true);
		harness.queue.register<Entry>("bad", {
			build: () => {
				throw new Error("boom");
			},
		});
		harness.queue.register<Entry>("good", {
			build: entries => userMessage(entries.map(entry => entry.id).join(",")),
		});

		harness.queue.enqueue("bad", { id: "bad" });
		harness.queue.enqueue("good", { id: "good" });
		await harness.queue.flush("streaming");

		expect(harness.streamingMessages.map(messageText)).toEqual(["good"]);
	});

	test("flush preserves registration order across kinds", async () => {
		const harness = createHarness(true);
		harness.queue.register<Entry>("second", {
			build: entries => userMessage(entries.map(entry => entry.id).join(",")),
		});
		harness.queue.register<Entry>("first", {
			build: entries => userMessage(entries.map(entry => entry.id).join(",")),
		});

		harness.queue.enqueue("first", { id: "first" });
		harness.queue.enqueue("second", { id: "second" });
		await harness.queue.flush("streaming");

		expect(harness.streamingMessages.map(messageText)).toEqual(["second", "first"]);
	});

	test("drainLazy snapshots+clears immediately but defers build+staleness to the thunk", () => {
		const harness = createHarness(true);
		const staleIds = new Set<string>();
		harness.queue.register<Entry>("items", {
			isStale: entry => staleIds.has(entry.id),
			build: entries => userMessage(entries.map(entry => entry.id).join(",")),
		});

		harness.queue.enqueue("items", { id: "a" });
		harness.queue.enqueue("items", { id: "b" });

		// Snapshot + clear happens at drain; the queue is emptied immediately.
		const thunks = harness.queue.drainLazy();
		expect(thunks).toHaveLength(1);
		expect(harness.queue.has()).toBe(false);

		// A mutation AFTER drainLazy but BEFORE the thunk runs supersedes "b".
		staleIds.add("b");

		// The thunk evaluates staleness at call time (injection), dropping "b".
		const message = thunks[0]!();
		expect(message && messageText(message)).toBe("a");
		// No injection side effects from the pull path.
		expect(harness.streamingMessages).toHaveLength(0);
		expect(harness.idleBatches).toHaveLength(0);
	});

	test("drainLazy thunk returns null when everything is stale by injection time", () => {
		const harness = createHarness(true);
		let stale = false;
		harness.queue.register<Entry>("items", {
			isStale: () => stale,
			build: entries => userMessage(entries.map(entry => entry.id).join(",")),
		});
		harness.queue.enqueue("items", { id: "x" });

		const thunks = harness.queue.drainLazy();
		stale = true; // superseded between drain and injection

		expect(thunks[0]!()).toBeNull();
	});
});

describe("YieldQueue claimAtRequest", () => {
	/** A claimed kind whose entries go stale or deferred when the test says. */
	function claimed() {
		const harness = createHarness(true);
		const stale = new Set<string>();
		const deferred = new Set<string>();
		harness.queue.register<Entry>("notices", {
			isStale: entry => stale.has(entry.id),
			isDeferred: entry => deferred.has(entry.id),
			build: entries => userMessage(entries.map(entry => entry.id).join(",")),
			claimAtRequest: true,
		});
		const settled = new Map<string, "resolved" | "rejected">();
		const enqueue = (id: string) =>
			harness.queue.enqueueWithReceipt<Entry>("notices", { id }).then(
				() => void settled.set(id, "resolved"),
				() => void settled.set(id, "rejected"),
			);
		const build = () => harness.queue.drainLazy()[0]!() as CommittableAsideMessage;
		return { harness, stale, deferred, settled, enqueue, build };
	}

	test("a live message answers itself at the hand-off and is delivered only by its commit", async () => {
		const q = claimed();
		const receipt = q.enqueue("a");
		const message = q.build();
		expect(message[ASIDE_MESSAGE_CLAIM]?.()).toBe(message);
		await Bun.sleep(0);
		expect(q.settled.size).toBe(0);
		message[ASIDE_MESSAGE_COMMIT]?.();
		await receipt;
		expect(q.settled.get("a")).toBe("resolved");
	});

	test("an entry stale at the hand-off is rejected and the rest are rebuilt into a claimable message", async () => {
		const q = claimed();
		const receipts = [q.enqueue("a"), q.enqueue("b")];
		const message = q.build();
		expect(messageText(message)).toBe("a,b");
		q.stale.add("b");
		const rebuilt = message[ASIDE_MESSAGE_CLAIM]?.() as CommittableAsideMessage;
		expect(rebuilt).not.toBe(message);
		expect(messageText(rebuilt)).toBe("a");
		// The withdrawn message can no longer deliver anything.
		message[ASIDE_MESSAGE_COMMIT]?.();
		expect(rebuilt[ASIDE_MESSAGE_CLAIM]?.()).toBe(rebuilt);
		rebuilt[ASIDE_MESSAGE_COMMIT]?.();
		await Promise.all(receipts);
		expect(Object.fromEntries(q.settled)).toEqual({ a: "resolved", b: "rejected" });
	});

	test("an entry deferred at the hand-off goes back to the queue unsettled", async () => {
		const q = claimed();
		void q.enqueue("a");
		const message = q.build();
		q.deferred.add("a");
		expect(message[ASIDE_MESSAGE_CLAIM]?.()).toBeNull();
		await Bun.sleep(0);
		expect(q.settled.size).toBe(0);
		expect(q.harness.queue.has("notices")).toBe(true);
	});

	test("an idle injection that sent no request carrying it rejects the receipt", async () => {
		const queue = new YieldQueue({
			isStreaming: () => false,
			injectIdle: async () => {},
			scheduleIdleFlush: () => {},
		});
		queue.register<Entry>("notices", {
			build: entries => userMessage(entries.map(entry => entry.id).join(",")),
			claimAtRequest: true,
		});
		const receipt = queue.enqueueWithReceipt<Entry>("notices", { id: "folded" });
		await queue.flush("idle");
		await expect(receipt).rejects.toThrow("No model request carried the entry");
	});

	test("a streaming insertion does not deliver a claimed entry", async () => {
		const q = claimed();
		const receipt = q.enqueue("a");
		await q.harness.queue.flush("streaming");
		await Bun.sleep(0);
		expect(q.settled.size).toBe(0);
		const message = q.harness.streamingMessages[0] as CommittableAsideMessage;
		expect(message[ASIDE_MESSAGE_CLAIM]?.()).toBe(message);
		message[ASIDE_MESSAGE_COMMIT]?.();
		await receipt;
		expect(q.settled.get("a")).toBe("resolved");
	});
});
