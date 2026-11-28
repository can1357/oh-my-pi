import { describe, expect, test } from "bun:test";
import { type AgentMessage, ASIDE_MESSAGE_COMMIT } from "@oh-my-pi/pi-agent-core";
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

type SettlementPath = "idle commit" | "idle discard" | "lazy commit";

/**
 * Delivers one receipt-tracked entry through `path`, keeping the built message in `transcript` the
 * way an agent's context keeps a delivered message, and returns a weak ref to the entry's value.
 * Kept out of the test body so no strong local binding to the value survives.
 */
async function settleOneEntry(path: SettlementPath, transcript: AgentMessage[]): Promise<WeakRef<object>> {
	const scheduledFlushes: Array<() => Promise<void>> = [];
	const queue = new YieldQueue({
		isStreaming: () => path === "lazy commit",
		injectIdle: async messages => {
			transcript.push(...messages);
			if (path === "idle discard") throw new Error("turn ended before insertion");
		},
		scheduleIdleFlush: run => scheduledFlushes.push(run),
	});
	queue.register<Entry>("items", {
		build: entries => userMessage(entries.map(entry => entry.id).join(",")),
	});
	const value: Entry = { id: `entry-${transcript.length}` };
	const receipt = queue.enqueueWithReceipt("items", value).catch(() => {});
	if (path === "lazy commit") {
		const message = queue.drainLazy()[0]!();
		if (!message) throw new Error("lazy thunk built no message");
		transcript.push(message);
		(message as AgentMessage & { [ASIDE_MESSAGE_COMMIT]?: () => void })[ASIDE_MESSAGE_COMMIT]?.();
	} else {
		await scheduledFlushes[0]!();
	}
	await receipt;
	return new WeakRef(value);
}

/**
 * Collects across a few event-loop turns and returns how many targets are still reachable. Bun's
 * conservative stack scan can pin the most recently dropped object in a stale native stack slot,
 * so callers settle several entries and tolerate one survivor.
 */
async function liveAfterGc(refs: WeakRef<object>[]): Promise<number> {
	let live = refs.length;
	for (let turn = 0; turn < 20; turn++) {
		Bun.gc(true);
		live = refs.filter(ref => ref.deref() !== undefined).length;
		if (live === 0) break;
		// A WeakRef target stays alive until the current task ends: a zero-length sleep yields one
		// task so the next collection can clear it (no wall-clock wait; fake timers cannot end a task).
		await Bun.sleep(0);
	}
	return live;
}

/**
 * Delivers one receipt-tracked entry through an idle flush whose injection commits the message into
 * `transcript` and then fails (the turn it started ends in an error), recording how the receipt
 * settled in `outcomes`, and returns a weak ref to the entry's value.
 */
async function commitThenFailOneEntry(transcript: AgentMessage[], outcomes: string[]): Promise<WeakRef<object>> {
	const scheduledFlushes: Array<() => Promise<void>> = [];
	const queue = new YieldQueue({
		isStreaming: () => false,
		injectIdle: async messages => {
			transcript.push(...messages);
			(messages[0] as AgentMessage & { [ASIDE_MESSAGE_COMMIT]?: () => void })[ASIDE_MESSAGE_COMMIT]?.();
			throw new Error("the turn failed after the message reached the context");
		},
		scheduleIdleFlush: run => scheduledFlushes.push(run),
	});
	queue.register<Entry>("items", {
		build: entries => userMessage(entries.map(entry => entry.id).join(",")),
	});
	const value: Entry = { id: `entry-${transcript.length}` };
	const receipt = queue.enqueueWithReceipt("items", value).then(
		() => outcomes.push("resolved"),
		() => outcomes.push("rejected"),
	);
	await scheduledFlushes[0]!();
	await receipt;
	return new WeakRef(value);
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

	// A delivered message stays in the session's context for the session's life. If its settlement
	// hooks kept the entries reachable, every delivered value (a finished background job and everything
	// it references, such as a subagent's tool output) would stay in memory with it.
	test.each<SettlementPath>(["idle commit", "idle discard", "lazy commit"])(
		"a message settled by %s keeps none of its entries reachable",
		async path => {
			const transcript: AgentMessage[] = [];
			const refs: WeakRef<object>[] = [];
			for (let i = 0; i < 8; i++) refs.push(await settleOneEntry(path, transcript));
			expect(transcript).toHaveLength(8);
			expect(await liveAfterGc(refs)).toBeLessThanOrEqual(1);
		},
	);

	// If this regresses, a background job's result that reached the agent's context before its idle turn
	// failed is reported as never delivered (its receipt rejects), or its entries stay in memory for the
	// rest of the session behind the message.
	test("a message committed before its idle injection fails resolves its receipt and keeps none of its entries reachable", async () => {
		const transcript: AgentMessage[] = [];
		const outcomes: string[] = [];
		const refs: WeakRef<object>[] = [];
		for (let i = 0; i < 8; i++) refs.push(await commitThenFailOneEntry(transcript, outcomes));
		expect(transcript).toHaveLength(8);
		expect(outcomes).toEqual(Array.from({ length: 8 }, () => "resolved"));
		expect(await liveAfterGc(refs)).toBeLessThanOrEqual(1);
	});
});
