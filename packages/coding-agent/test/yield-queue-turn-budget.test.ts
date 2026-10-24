import { afterEach, describe, expect, test, vi } from "bun:test";
import { type AgentMessage, ASIDE_MESSAGE_DISCARD, type CommittableAsideMessage } from "@oh-my-pi/pi-agent-core";
import { PROGRESS_LIMITS } from "@oh-my-pi/pi-coding-agent/async/progress-limits";
import { WakeTurnBudget } from "@oh-my-pi/pi-coding-agent/async/wake-budget";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import { YieldQueue } from "@oh-my-pi/pi-coding-agent/session/yield-queue";

type Entry = { text: string };

function buildMessage(entries: Entry[]): CustomMessage | null {
	if (entries.length === 0) return null;
	return {
		role: "custom",
		customType: "test",
		content: entries.map(entry => entry.text).join("\n"),
		display: false,
		attribution: "agent",
		timestamp: 0,
	};
}

function messageText(message: AgentMessage): string {
	if (message.role !== "custom") throw new Error(`Expected custom message, got ${message.role}`);
	const content = (message as CustomMessage).content;
	return typeof content === "string" ? content : JSON.stringify(content);
}

interface Harness {
	queue: YieldQueue;
	prompts: string[][];
	scheduled: Array<() => Promise<void>>;
	setStreaming(value: boolean): void;
	/** Run every scheduled idle flush (the session's post-prompt task queue stand-in). */
	runScheduled(): Promise<void>;
	failNextInject(error: Error): void;
}

function createHarness(): Harness {
	let streaming = false;
	let injectFailure: Error | undefined;
	const prompts: string[][] = [];
	const scheduled: Array<() => Promise<void>> = [];
	const queue = new YieldQueue({
		isStreaming: () => streaming,
		injectStreaming: () => {},
		injectIdle: async messages => {
			if (injectFailure) {
				const error = injectFailure;
				injectFailure = undefined;
				throw error;
			}
			prompts.push(messages.map(messageText));
		},
		scheduleIdleFlush: run => {
			scheduled.push(run);
		},
	});
	return {
		queue,
		prompts,
		scheduled,
		setStreaming: value => {
			streaming = value;
		},
		runScheduled: async () => {
			while (scheduled.length > 0) {
				const runs = scheduled.splice(0);
				for (const run of runs) await run();
			}
		},
		failNextInject: error => {
			injectFailure = error;
		},
	};
}

describe("WakeTurnBudget", () => {
	test("grants a burst, then reports the wait until the next refill", () => {
		const budget = new WakeTurnBudget(2, 1_000);
		expect(budget.tryAcquire(0)).toBe(0);
		expect(budget.tryAcquire(0)).toBe(0);
		expect(budget.tryAcquire(0)).toBe(1_000);
		// A denied acquire consumes nothing: the same instant still owes 1 s.
		expect(budget.tryAcquire(0)).toBe(1_000);
		expect(budget.tryAcquire(400)).toBe(600);
		expect(budget.tryAcquire(1_000)).toBe(0);
		expect(budget.tryAcquire(1_000)).toBe(1_000);
	});

	test("refill never exceeds the burst", () => {
		const budget = new WakeTurnBudget(2, 1_000);
		expect(budget.tryAcquire(0)).toBe(0);
		expect(budget.tryAcquire(60_000)).toBe(0);
		expect(budget.tryAcquire(60_000)).toBe(0);
		expect(budget.tryAcquire(60_000)).toBe(1_000);
	});

	test("defaults to the shared progress limits", () => {
		const budget = new WakeTurnBudget();
		for (let permit = 0; permit < PROGRESS_LIMITS.WAKE_TURN_BURST; permit++) {
			expect(budget.tryAcquire(0)).toBe(0);
		}
		expect(budget.tryAcquire(0)).toBe(PROGRESS_LIMITS.WAKE_TURN_REFILL_MS);
	});
});

describe("YieldQueue idle turn budget", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	test("a denied budget keeps the entries queued and retries after the reported delay", async () => {
		vi.useFakeTimers();
		const harness = createHarness();
		let permits = 1;
		harness.queue.register<Entry>("wake", {
			idleTurnBudget: {
				tryAcquire: () => {
					if (permits > 0) {
						permits -= 1;
						return 0;
					}
					return 5_000;
				},
			},
			build: buildMessage,
		});

		harness.queue.enqueue<Entry>("wake", { text: "first" });
		await harness.runScheduled();
		expect(harness.prompts).toEqual([["first"]]);

		harness.queue.enqueue<Entry>("wake", { text: "second" });
		await harness.runScheduled();
		// Held back: nothing injected, entry still queued, no extra scheduling.
		expect(harness.prompts).toEqual([["first"]]);
		expect(harness.queue.has("wake")).toBe(true);
		expect(harness.scheduled).toHaveLength(0);
		const settled = harness.queue.idleFlushSettled();
		let settledSeen = false;
		void settled.then(() => {
			settledSeen = true;
		});

		vi.advanceTimersByTime(4_999);
		expect(harness.scheduled).toHaveLength(0);
		permits = 1;
		vi.advanceTimersByTime(1);
		await harness.runScheduled();
		expect(harness.prompts).toEqual([["first"], ["second"]]);
		expect(harness.queue.has("wake")).toBe(false);
		await Promise.resolve();
		expect(settledSeen).toBe(true);
	});

	test("a budgeted kind rides along when another kind starts the turn", async () => {
		const harness = createHarness();
		let acquires = 0;
		harness.queue.register<Entry>("wake", {
			idleTurnBudget: {
				tryAcquire: () => {
					acquires += 1;
					return 60_000;
				},
			},
			build: buildMessage,
		});
		harness.queue.register<Entry>("result", { build: buildMessage });

		harness.queue.enqueue<Entry>("wake", { text: "progress" });
		harness.queue.enqueue<Entry>("result", { text: "result" });
		await harness.runScheduled();

		// Registration order is delivery order, and the free ride spent no permit.
		expect(harness.prompts).toEqual([["progress", "result"]]);
		expect(acquires).toBe(0);
	});

	test("a denied budget never blocks streaming-boundary injection", async () => {
		vi.useFakeTimers();
		const harness = createHarness();
		harness.queue.register<Entry>("wake", {
			idleTurnBudget: { tryAcquire: () => 30_000 },
			build: buildMessage,
		});
		harness.queue.enqueue<Entry>("wake", { text: "held" });
		await harness.runScheduled();
		expect(harness.queue.has("wake")).toBe(true);

		harness.setStreaming(true);
		const thunks = harness.queue.drainLazy();
		expect(thunks.map(thunk => thunk()).map(message => (message ? messageText(message) : null))).toEqual(["held"]);
		expect(harness.queue.has("wake")).toBe(false);
	});

	test("clearing the queue drops the deferred retry", async () => {
		vi.useFakeTimers();
		const harness = createHarness();
		harness.queue.register<Entry>("wake", {
			idleTurnBudget: { tryAcquire: () => 1_000 },
			build: buildMessage,
		});
		harness.queue.enqueue<Entry>("wake", { text: "held" });
		await harness.runScheduled();
		let settled = false;
		void harness.queue.idleFlushSettled().then(() => {
			settled = true;
		});

		harness.queue.clear();
		await Promise.resolve();
		expect(settled).toBe(true);
		vi.advanceTimersByTime(1_000);
		expect(harness.scheduled).toHaveLength(0);
	});

	test("a free ride that drains held entries releases the deferred retry", async () => {
		vi.useFakeTimers();
		const harness = createHarness();
		let acquires = 0;
		harness.queue.register<Entry>("wake", {
			idleTurnBudget: {
				tryAcquire: () => {
					acquires += 1;
					return PROGRESS_LIMITS.WAKE_TURN_REFILL_MS;
				},
			},
			build: buildMessage,
		});
		harness.queue.register<Entry>("result", { build: buildMessage });

		harness.queue.enqueue<Entry>("wake", { text: "progress" });
		await harness.runScheduled();
		expect(harness.queue.has("wake")).toBe(true);
		expect(acquires).toBe(1);

		// A completion starts the turn and carries the held progress along.
		harness.queue.enqueue<Entry>("result", { text: "done" });
		await harness.runScheduled();
		expect(harness.prompts).toEqual([["progress", "done"]]);
		expect(harness.queue.has("wake")).toBe(false);

		// Nothing is held any more: settle now, not after the refill interval.
		let settled = false;
		void harness.queue.idleFlushSettled().then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(true);
		vi.advanceTimersByTime(PROGRESS_LIMITS.WAKE_TURN_REFILL_MS);
		expect(harness.scheduled).toHaveLength(0);
		expect(acquires).toBe(1);
	});

	test("a streaming-boundary drain of held entries releases the deferred retry", async () => {
		vi.useFakeTimers();
		const harness = createHarness();
		harness.queue.register<Entry>("wake", {
			idleTurnBudget: { tryAcquire: () => 30_000 },
			build: buildMessage,
		});
		harness.queue.enqueue<Entry>("wake", { text: "held" });
		await harness.runScheduled();

		harness.setStreaming(true);
		harness.queue.flush("streaming");
		expect(harness.queue.has("wake")).toBe(false);
		harness.setStreaming(false);

		let settled = false;
		void harness.queue.idleFlushSettled().then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(true);
		vi.advanceTimersByTime(30_000);
		expect(harness.scheduled).toHaveLength(0);
	});
});

describe("YieldQueue undelivered entries", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	test("a failed idle dispatch keeps receipt-less entries for the next flush and rejects receipts", async () => {
		const harness = createHarness();
		harness.queue.register<Entry>("progress", { build: buildMessage });
		harness.queue.register<Entry>("result", { build: buildMessage });

		harness.queue.enqueue<Entry>("progress", { text: "progress" });
		const receipt = harness.queue.enqueueWithReceipt<Entry>("result", { text: "result" });
		harness.failNextInject(new Error("model unavailable"));
		await harness.runScheduled();

		await expect(receipt).rejects.toThrow("model unavailable");
		expect(harness.prompts).toEqual([]);
		expect(harness.queue.has("progress")).toBe(true);
		expect(harness.queue.has("result")).toBe(false);

		// The owner's retry re-enqueues the result; the retained progress still
		// precedes it in the same turn.
		harness.queue.enqueue<Entry>("result", { text: "result again" });
		await harness.runScheduled();
		expect(harness.prompts).toEqual([["progress", "result again"]]);
	});

	test("a rejected idle dispatch retries restored receipt-less entries on its own", async () => {
		vi.useFakeTimers();
		const harness = createHarness();
		harness.queue.register<Entry>("progress", { build: buildMessage });

		harness.queue.enqueue<Entry>("progress", { text: "stranded?" });
		harness.failNextInject(new Error("agent busy"));
		await harness.runScheduled();
		expect(harness.prompts).toEqual([]);
		expect(harness.queue.has("progress")).toBe(true);
		// Not a spin: the retry waits on a timer instead of rescheduling at once.
		expect(harness.scheduled).toHaveLength(0);

		vi.advanceTimersByTime(1_000);
		await harness.runScheduled();
		expect(harness.prompts).toEqual([["stranded?"]]);
		expect(harness.queue.has("progress")).toBe(false);
		await expect(harness.queue.idleFlushSettled()).resolves.toBeUndefined();
	});

	test("rejected idle dispatches stop retrying after a bounded number of attempts", async () => {
		vi.useFakeTimers();
		const harness = createHarness();
		harness.queue.register<Entry>("progress", { build: buildMessage });
		harness.queue.enqueue<Entry>("progress", { text: "unlucky" });

		let attempts = 0;
		for (;;) {
			harness.failNextInject(new Error("agent busy"));
			await harness.runScheduled();
			attempts += 1;
			vi.advanceTimersByTime(1_000);
			if (harness.scheduled.length === 0) break;
			if (attempts > 10) throw new Error("idle retry never stopped");
		}
		expect(attempts).toBe(4);
		expect(harness.queue.has("progress")).toBe(true);
		// Given up on timed retries, but the entry still rides along with the next arrival.
		await expect(harness.queue.idleFlushSettled()).resolves.toBeUndefined();
		harness.queue.enqueue<Entry>("progress", { text: "later" });
		await harness.runScheduled();
		expect(harness.prompts).toEqual([["unlucky\nlater"]]);
	});

	test("restored entries keep their order ahead of later arrivals", async () => {
		const harness = createHarness();
		harness.queue.register<Entry>("progress", { build: buildMessage });
		harness.queue.enqueue<Entry>("progress", { text: "older" });
		harness.failNextInject(new Error("model unavailable"));
		await harness.runScheduled();
		harness.queue.enqueue<Entry>("progress", { text: "newer" });
		await harness.runScheduled();
		expect(harness.prompts).toEqual([["older\nnewer"]]);
	});

	test("an aside discarded by the agent loop returns to the queue unless it was cleared meanwhile", () => {
		const harness = createHarness();
		harness.queue.register<Entry>("progress", { build: buildMessage });
		harness.setStreaming(true);

		harness.queue.enqueue<Entry>("progress", { text: "dropped mid-run" });
		const [thunk] = harness.queue.drainLazy();
		const message = thunk!() as CommittableAsideMessage;
		message[ASIDE_MESSAGE_DISCARD]?.(new Error("loop ended"));
		expect(harness.queue.has("progress")).toBe(true);

		const [again] = harness.queue.drainLazy();
		const rebuilt = again!() as CommittableAsideMessage;
		harness.queue.clear();
		rebuilt[ASIDE_MESSAGE_DISCARD]?.(new Error("loop ended after reset"));
		expect(harness.queue.has("progress")).toBe(false);
	});
});
