import { afterEach, describe, expect, test } from "bun:test";
import {
	type AgentMessage,
	ASIDE_MESSAGE_COMMIT,
	ASIDE_MESSAGE_DISCARD,
	type CommittableAsideMessage,
} from "@oh-my-pi/pi-agent-core";
import { type AsyncJob, AsyncJobManager, type AsyncJobType } from "@oh-my-pi/pi-coding-agent/async";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import { YieldQueue } from "@oh-my-pi/pi-coding-agent/session/yield-queue";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { type CoordinationDetails, HubTool } from "../src/tools/hub";

type AsyncEntry = {
	jobId: string;
	result: string;
	job: AsyncJob | undefined;
	durationMs: number | undefined;
};

type AsyncDetails = {
	jobs: Array<{
		jobId: string;
		type?: AsyncJobType;
		label?: string;
		durationMs?: number;
	}>;
};

function buildAsyncMessage(entries: AsyncEntry[]): CustomMessage<AsyncDetails> | null {
	if (entries.length === 0) return null;
	return {
		role: "custom",
		customType: "async-result",
		content: entries.map(entry => entry.result).join("\n"),
		display: true,
		attribution: "agent",
		details: {
			jobs: entries.map(entry => ({
				jobId: entry.jobId,
				type: entry.job?.type,
				label: entry.job?.label,
				durationMs: entry.durationMs,
			})),
		},
		timestamp: 0,
	};
}

function asyncDetails(message: AgentMessage): AsyncDetails {
	if (message.role !== "custom") throw new Error(`Expected custom message, got ${message.role}`);
	return (message as CustomMessage<AsyncDetails>).details ?? { jobs: [] };
}

function createToolSession(asyncJobManager?: AsyncJobManager): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings: {
			get: (key: string) => (key === "async.pollWaitDuration" ? "5s" : undefined),
		},
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getAgentId: () => null,
		asyncJobManager,
	} as unknown as ToolSession;
}

function createHarness(initialStreaming: boolean) {
	let streaming = initialStreaming;
	/** Set to make `injectIdle` reject, as `Agent.prompt()` does on AgentBusyError. */
	let injectIdleError: Error | undefined;
	let unclaimedCount = 0;
	const followUps: AgentMessage[] = [];
	const prompts: AgentMessage[][] = [];
	const scheduledFlushes: Array<() => Promise<void>> = [];
	const queue = new YieldQueue({
		isStreaming: () => streaming,
		injectStreaming: message => {
			followUps.push(message);
		},
		injectIdle: async messages => {
			if (injectIdleError) throw injectIdleError;
			prompts.push(messages);
		},
		scheduleIdleFlush: run => {
			scheduledFlushes.push(run);
		},
		onIdleFlushUnclaimed: () => {
			unclaimedCount++;
		},
	});
	queue.register<AsyncEntry>("async-result", {
		isStale: entry => manager.isDeliverySuppressed(entry.jobId),
		build: buildAsyncMessage,
	});
	const manager = new AsyncJobManager({
		onJobComplete: (jobId, result, job) => {
			if (manager.isDeliverySuppressed(jobId)) return;
			queue.enqueue<AsyncEntry>("async-result", {
				jobId,
				result,
				job,
				durationMs: job ? Math.max(0, Date.now() - job.startTime) : undefined,
			});
		},
	});
	AsyncJobManager.setInstance(manager);
	return {
		manager,
		queue,
		followUps,
		prompts,
		scheduledFlushes,
		setStreaming: (value: boolean) => {
			streaming = value;
		},
		failIdleInjection: (error: Error) => {
			injectIdleError = error;
		},
		unclaimed: () => unclaimedCount,
	};
}

afterEach(async () => {
	const manager = AsyncJobManager.instance();
	if (manager) {
		await manager.dispose({ timeoutMs: 200 });
	}
	AsyncJobManager.resetForTests();
});

describe("async result yield queue delivery", () => {
	test("job poll acknowledgement suppresses already staged completion", async () => {
		const harness = createHarness(true);
		const jobId = harness.manager.register("bash", "race job", async () => "inline result");

		await harness.manager.waitForAll();
		expect(await harness.manager.drainDeliveries({ timeoutMs: 2_000 })).toBe(true);

		const tool = new HubTool(createToolSession(harness.manager));
		const result = await tool.execute("tool-call", { op: "wait", ids: [jobId] });
		expect((result.details as CoordinationDetails)?.jobs?.find(job => job.id === jobId)?.status).toBe("completed");

		await harness.queue.flush("streaming");

		expect(harness.followUps).toHaveLength(0);
	});

	test("multiple completions in one yield window become one follow-up", async () => {
		const harness = createHarness(true);
		const firstJobId = harness.manager.register("bash", "first", async () => "first result");
		const secondJobId = harness.manager.register("task", "second", async () => "second result");

		await harness.manager.waitForAll();
		expect(await harness.manager.drainDeliveries({ timeoutMs: 2_000 })).toBe(true);
		await harness.queue.flush("streaming");

		expect(harness.followUps).toHaveLength(1);
		const deliveredIds = asyncDetails(harness.followUps[0]!)
			.jobs.map(job => job.jobId)
			.sort();
		expect(deliveredIds).toEqual([firstJobId, secondJobId].sort());
	});

	test("idle completion prompts once after scheduled idle flush", async () => {
		const harness = createHarness(false);
		const jobId = harness.manager.register("bash", "idle job", async () => "idle result");

		await harness.manager.waitForAll();
		expect(await harness.manager.drainDeliveries({ timeoutMs: 2_000 })).toBe(true);

		expect(harness.scheduledFlushes).toHaveLength(1);
		expect(harness.prompts).toHaveLength(0);
		await harness.scheduledFlushes[0]!();

		expect(harness.prompts).toHaveLength(1);
		expect(harness.prompts[0]).toHaveLength(1);
		expect(asyncDetails(harness.prompts[0]![0]!).jobs.map(job => job.jobId)).toEqual([jobId]);
	});

	test("releases a canceled idle-flush latch for rescheduling", () => {
		const harness = createHarness(false);
		harness.queue.enqueue<AsyncEntry>("async-result", {
			jobId: "idle-retry",
			result: "retry",
			job: undefined,
			durationMs: undefined,
		});
		expect(harness.scheduledFlushes).toHaveLength(1);

		harness.queue.cancelIdleFlushScheduling();
		harness.queue.requestIdleFlush();

		expect(harness.scheduledFlushes).toHaveLength(2);
	});

	test("holds a streaming receipt until the aside enters live context", async () => {
		const harness = createHarness(true);
		const receipt = harness.queue.enqueueWithReceipt<AsyncEntry>("async-result", {
			jobId: "streaming-receipt",
			result: "done",
			job: undefined,
			durationMs: undefined,
		});
		let delivered = false;
		void receipt.then(() => {
			delivered = true;
		});
		const message = harness.queue.drainLazy()[0]?.();
		if (!message) throw new Error("Expected a lazy aside");

		await Promise.resolve();
		expect(delivered).toBe(false);
		(message as CommittableAsideMessage)[ASIDE_MESSAGE_COMMIT]?.();
		await receipt;
		expect(delivered).toBe(true);
	});

	test("rejects a streaming receipt when the agent discards its aside", async () => {
		const harness = createHarness(true);
		const receipt = harness.queue.enqueueWithReceipt<AsyncEntry>("async-result", {
			jobId: "discarded-receipt",
			result: "done",
			job: undefined,
			durationMs: undefined,
		});
		const message = harness.queue.drainLazy()[0]?.();
		if (!message) throw new Error("Expected a lazy aside");

		(message as CommittableAsideMessage)[ASIDE_MESSAGE_DISCARD]?.(new Error("deadline expired"));

		await expect(receipt).rejects.toThrow("deadline expired");
	});

	test("reports no idle deliverable when every queued entry is already suppressed", async () => {
		// `hasIdleDeliverable()` answers "will a flush start a turn?", and a caller
		// about to emit a terminal idle signal withholds it on a true. Presence is
		// the wrong question: `#build` drops suppressed entries, so a queue holding
		// only those flushes to nothing and starts no successor turn. Answering on
		// presence would withhold the terminal signal for a turn that never comes,
		// and no later one is emitted.
		const harness = createHarness(false);
		const jobId = harness.manager.register("bash", "acknowledged job", async () => "result");

		await harness.manager.waitForAll();
		expect(await harness.manager.drainDeliveries({ timeoutMs: 2_000 })).toBe(true);
		expect(harness.queue.has("async-result")).toBe(true);
		expect(harness.queue.hasIdleDeliverable()).toBe(true);

		// The foreground wait acknowledged it, so the entry is still queued but can
		// no longer be delivered.
		harness.manager.acknowledgeDeliveries([jobId]);
		expect(harness.queue.has("async-result")).toBe(true);
		expect(harness.queue.hasIdleDeliverable()).toBe(false);

		// And the flush agrees: nothing is injected, which is why the caller must
		// not have treated it as a pending continuation.
		await harness.queue.flush("idle");
		expect(harness.prompts).toHaveLength(0);
	});

	test("still reports an idle deliverable when one queued entry survives suppression", async () => {
		// The other direction: a partially stale batch DOES start a turn, so the
		// answer must be per-entry rather than "any kind is stale".
		const harness = createHarness(false);
		const suppressed = harness.manager.register("bash", "acknowledged job", async () => "gone");
		const live = harness.manager.register("bash", "live job", async () => "kept");

		await harness.manager.waitForAll();
		expect(await harness.manager.drainDeliveries({ timeoutMs: 2_000 })).toBe(true);

		harness.manager.acknowledgeDeliveries([suppressed]);
		expect(harness.queue.hasIdleDeliverable()).toBe(true);

		await harness.queue.flush("idle");
		expect(harness.prompts).toHaveLength(1);
		expect(asyncDetails(harness.prompts[0]![0]!).jobs.map(job => job.jobId)).toEqual([live]);
	});

	test("still schedules an idle flush for stale-only entries so their receipts settle", async () => {
		// Scheduling and continuation-classification are different questions.
		// `#build` is what rejects a stale entry and settles its receipt, so a
		// queue holding only stale entries still needs the pass — gating the
		// schedule on deliverability would leave the promise pending until some
		// unrelated live entry happened to arm another flush.
		const harness = createHarness(true);
		const receipt = harness.queue.enqueueWithReceipt<AsyncEntry>("async-result", {
			jobId: "stale-receipt",
			result: "done",
			job: undefined,
			durationMs: undefined,
		});
		let settled = false;
		void receipt.catch(() => {
			settled = true;
		});
		// Acknowledged before any flush ran: the entry can never be delivered.
		harness.manager.acknowledgeDeliveries(["stale-receipt"]);
		expect(harness.queue.hasIdleDeliverable()).toBe(false);

		// Streaming ended, so the queue is asked to arm its post-run pass.
		harness.setStreaming(false);
		harness.queue.requestIdleFlush();
		expect(harness.scheduledFlushes).toHaveLength(1);

		await harness.scheduledFlushes[0]!();
		await expect(receipt).rejects.toThrow(/stale/);
		expect(settled).toBe(true);
		// Nothing was injected: the pass exists to settle, not to start a turn.
		expect(harness.prompts).toHaveLength(0);
	});

	test("reports an idle flush unclaimed when the injection itself fails", async () => {
		// `injectIdle` rejects when another direct caller wins the scheduling race
		// and `Agent.prompt()` throws `AgentBusyError`. The catch discards the
		// entries, so no successor turn starts — exactly the state a fully-stale
		// drain leaves behind. Reporting the pass as claimed would strand a
		// terminal `agent_end` that was downgraded for one of these entries.
		const harness = createHarness(true);
		const receipt = harness.queue.enqueueWithReceipt<AsyncEntry>("async-result", {
			jobId: "busy-injection",
			result: "done",
			job: undefined,
			durationMs: undefined,
		});
		void receipt.catch(() => {});
		// Live, not stale: the entry survives `#build` and reaches the injection.
		expect(harness.queue.hasIdleDeliverable()).toBe(true);

		harness.failIdleInjection(new Error("Agent is busy"));
		harness.setStreaming(false);
		harness.queue.requestIdleFlush();
		expect(harness.scheduledFlushes).toHaveLength(1);

		await harness.scheduledFlushes[0]!();
		// No turn ran, and the pass said so.
		expect(harness.prompts).toHaveLength(0);
		expect(harness.unclaimed()).toBe(1);
	});
});
