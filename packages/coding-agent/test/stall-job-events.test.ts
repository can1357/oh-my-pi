import { afterEach, describe, expect, test, vi } from "bun:test";
import { scheduler } from "node:timers/promises";
import { type AsyncJob, AsyncJobError, AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { logger } from "@oh-my-pi/pi-utils";

const managers: AsyncJobManager[] = [];

function createManager(options: ConstructorParameters<typeof AsyncJobManager>[0] = {}): AsyncJobManager {
	const manager = new AsyncJobManager(options);
	managers.push(manager);
	return manager;
}

async function waitForJobEviction(manager: AsyncJobManager, jobId: string): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (manager.getJob(jobId)) {
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for job eviction: ${jobId}`);
		await scheduler.yield();
	}
}

afterEach(async () => {
	vi.restoreAllMocks();
	for (const manager of managers.splice(0)) await manager.dispose({ timeoutMs: 0 });
});

describe("AsyncJobManager settled diagnostics events", () => {
	test("reports complete success metadata once before delivery", async () => {
		const order: string[] = [];
		const manager = createManager({
			onJobComplete: () => {
				order.push("delivery");
			},
		});
		const events: AsyncJob[] = [];
		let rowVisible = false;
		manager.onSettled(job => {
			rowVisible = manager.getJob(job.id) === job;
			order.push("settled");
			events.push({ ...job });
		});
		const structured = { source: "caller", mode: "permissive", status: "valid", data: { count: 7 } } as const;
		const jobId = manager.register(
			"task",
			"successful task",
			async ({ reportProgress }) => {
				await reportProgress("working", { step: 1 });
				return { text: "done", structured };
			},
			{ ownerId: "Main", agentId: "Worker" },
		);
		manager.registerDeliverySink("Main", () => {
			order.push("delivery");
		});
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		expect(rowVisible).toBe(true);
		expect(order).toEqual(["settled", "delivery"]);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			id: jobId,
			type: "task",
			status: "completed",
			label: "successful task",
			ownerId: "Main",
			agentId: "Worker",
			resultText: "done",
			structured,
			latestDetails: { step: 1 },
		});
		expect(events[0].endTime).toBeGreaterThanOrEqual(events[0].startTime);
		expect(events[0].progressAt).toBeGreaterThanOrEqual(events[0].startTime);
	});

	test("reports final error and structured output when a body fails", async () => {
		const delivered: string[] = [];
		const manager = createManager({
			onJobComplete: (_id, text) => {
				delivered.push(text);
			},
		});
		const events: AsyncJob[] = [];
		manager.onSettled(job => {
			events.push({ ...job });
		});
		const structured = { source: "caller", mode: "permissive", status: "invalid", error: "bad output" } as const;
		const jobId = manager.register("eval", "failed cell", async () => {
			throw new AsyncJobError("cell failed", structured);
		});
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ id: jobId, status: "failed", errorText: "cell failed", structured });
		expect(events[0].endTime).toBeGreaterThanOrEqual(events[0].startTime);
		expect(delivered).toEqual(["cell failed"]);
	});

	test("observes a synchronous body throw while the row still exists", async () => {
		const manager = createManager();
		const events: AsyncJob[] = [];
		let rowVisible = false;
		manager.onSettled(job => {
			rowVisible = manager.getJob(job.id) === job;
			events.push({ ...job });
		});
		const jobId = manager.register("bash", "synchronous failure", () => {
			throw new Error("start failed");
		});
		await manager.waitForAll();
		expect(rowVisible).toBe(true);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ id: jobId, status: "failed", errorText: "start failed" });
	});

	for (const outcome of ["resolve", "reject"] as const) {
		test(`cancellation emits only when the body actually ${outcome}s`, async () => {
			const delivered: string[] = [];
			const manager = createManager({
				onJobComplete: id => {
					delivered.push(id);
				},
			});
			const gate = Promise.withResolvers<string>();
			const events: AsyncJob[] = [];
			manager.onSettled(job => {
				events.push({ ...job });
			});
			const jobId = manager.register("bash", "slow abort", () => gate.promise);
			const job = manager.getJob(jobId)!;
			expect(manager.cancel(jobId)).toBe(true);
			expect(job.abortController.signal.aborted).toBe(true);
			expect(job.status).toBe("cancelled");
			expect(job.endTime).toBeUndefined();
			await Promise.resolve();
			expect(events).toEqual([]);
			expect(manager.cancel(jobId)).toBe(false);
			if (outcome === "resolve") gate.resolve("late result");
			else gate.reject(new Error("abort acknowledged"));
			await job.promise;
			await manager.drainDeliveries({ timeoutMs: 2_000 });

			expect(events).toHaveLength(1);
			expect(events[0]).toMatchObject({ id: jobId, status: "cancelled" });
			expect(events[0].endTime).toBeGreaterThanOrEqual(job.startTime);
			if (outcome === "resolve") expect(events[0].resultText).toBe("late result");
			else expect(events[0].errorText).toBe("abort acknowledged");
			expect(delivered).toEqual([]);
		});
	}

	test("cancelAll does not emit before body settlement", async () => {
		const manager = createManager();
		const gate = Promise.withResolvers<string>();
		const events: AsyncJob[] = [];
		manager.onSettled(job => {
			events.push({ ...job });
		});
		const jobId = manager.register("task", "cancel all", () => gate.promise);
		manager.cancelAll();
		await Promise.resolve();
		expect(events).toEqual([]);
		gate.resolve("done");
		await manager.waitForAll();
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ id: jobId, status: "cancelled", resultText: "done" });
	});

	test("watched and acknowledged deliveries neither suppress nor repeat settlement events", async () => {
		const delivered: string[] = [];
		const manager = createManager({
			onJobComplete: id => {
				delivered.push(id);
			},
		});
		const events: string[] = [];
		manager.onSettled(job => {
			events.push(job.id);
		});
		const watched = manager.register("task", "watched", async () => "watched result");
		const acknowledged = manager.register("eval", "acknowledged", async () => "recovered result");
		manager.watchJobs([watched]);
		manager.acknowledgeDeliveries([acknowledged]);
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });
		expect(events).toEqual([watched, acknowledged]);
		expect(delivered).toEqual([]);
		manager.unwatchJobs([watched]);
		await manager.drainDeliveries({ timeoutMs: 2_000 });
		expect(delivered).toEqual([watched]);
		expect(events).toEqual([watched, acknowledged]);
	});

	for (const consumption of ["sink", "snapshot"] as const) {
		test(`retained copies survive short ${consumption}-consumed row eviction`, async () => {
			const manager = createManager({
				retentionMs: 60_000,
				consumedResultEvictionMs: 0,
				...(consumption === "sink" ? { onJobComplete: () => {} } : {}),
			});
			const snapshots: Readonly<Pick<AsyncJob, "id" | "status" | "endTime" | "resultText">>[] = [];
			let rowVisible = false;
			manager.onSettled(job => {
				rowVisible = manager.getJob(job.id) === job;
				snapshots.push(
					Object.freeze({
						id: job.id,
						status: job.status,
						endTime: job.endTime,
						resultText: job.resultText,
					}),
				);
			});
			const jobId = manager.register("bash", "consumed", async () => "saved result");
			await manager.waitForAll();
			await manager.drainDeliveries({ timeoutMs: 2_000 });
			if (consumption === "snapshot") expect(manager.consumeJobResults([jobId])).toBe(1);
			await waitForJobEviction(manager, jobId);

			expect(rowVisible).toBe(true);
			expect(manager.getJob(jobId)).toBeUndefined();
			expect(snapshots).toHaveLength(1);
			expect(Object.isFrozen(snapshots[0])).toBe(true);
			expect(snapshots[0]).toMatchObject({ id: jobId, status: "completed", resultText: "saved result" });
			expect(snapshots[0].endTime).toEqual(expect.any(Number));
		});
	}

	for (const release of ["before", "after"] as const) {
		test(`foreground release ${release} settlement cannot lose or repeat the event`, async () => {
			const delivered: string[] = [];
			const manager = createManager({
				onJobComplete: id => {
					delivered.push(id);
				},
			});
			const gate = Promise.withResolvers<string>();
			const events: AsyncJob[] = [];
			let rowVisible = false;
			manager.onSettled(job => {
				rowVisible = manager.getJob(job.id) === job;
				events.push({ ...job });
			});
			const jobId = manager.register("bash", "foreground", () => gate.promise, { foreground: true });
			const job = manager.getJob(jobId)!;
			if (release === "before") manager.releaseForegroundJob(jobId);
			expect(events).toEqual([]);
			gate.resolve("foreground result");
			await job.promise;
			if (release === "after") manager.releaseForegroundJob(jobId);
			await manager.drainDeliveries({ timeoutMs: 2_000 });

			expect(rowVisible).toBe(true);
			expect(manager.getJob(jobId)).toBeUndefined();
			expect(events).toHaveLength(1);
			expect(events[0]).toMatchObject({
				id: jobId,
				foreground: true,
				status: "completed",
				resultText: "foreground result",
			});
			expect(delivered).toEqual([]);
		});
	}

	test("isolates throwing and rejecting observers without blocking peers, delivery, or eviction", async () => {
		const warnings = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const delivered: string[] = [];
		const manager = createManager({
			consumedResultEvictionMs: 0,
			onJobComplete: id => {
				delivered.push(id);
			},
		});
		manager.onSettled(() => {
			throw new Error("broken synchronous observer");
		});
		manager.onSettled(async () => {
			throw new Error("broken asynchronous observer");
		});
		const events: string[] = [];
		manager.onSettled(job => {
			events.push(job.id);
		});
		const jobId = manager.register("eval", "healthy body", async () => "done");
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });
		await waitForJobEviction(manager, jobId);

		expect(events).toEqual([jobId]);
		expect(delivered).toEqual([jobId]);
		expect(manager.getJob(jobId)).toBeUndefined();
		expect(warnings).toHaveBeenCalledTimes(2);
	});

	test("unsubscribe is idempotent and excludes later jobs without replaying old events", async () => {
		const manager = createManager();
		const events: string[] = [];
		const unsubscribe = manager.onSettled(job => {
			events.push(job.id);
		});
		const first = manager.register("eval", "first", async () => "first");
		await manager.waitForAll();
		unsubscribe();
		unsubscribe();
		manager.register("eval", "second", async () => "second");
		await manager.waitForAll();
		expect(events).toEqual([first]);
		const lateEvents: string[] = [];
		manager.onSettled(job => {
			lateEvents.push(job.id);
		});
		expect(lateEvents).toEqual([]);
		const third = manager.register("eval", "third", async () => "third");
		await manager.waitForAll();
		expect(lateEvents).toEqual([third]);
	});

	test("progressAt advances without a sink and remains available at settlement", async () => {
		const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
		const manager = createManager();
		const gate = Promise.withResolvers<string>();
		let reportProgress: ((text: string) => Promise<void>) | undefined;
		let settledProgressAt: number | undefined;
		manager.onSettled(job => {
			settledProgressAt = job.progressAt;
		});
		const jobId = manager.register("bash", "progress timestamps", ctx => {
			reportProgress = ctx.reportProgress;
			return gate.promise;
		});
		expect(manager.getJob(jobId)?.progressAt).toBeUndefined();
		now.mockReturnValue(1_100);
		await reportProgress!("first");
		expect(manager.getJob(jobId)?.progressAt).toBe(1_100);
		now.mockReturnValue(1_200);
		await reportProgress!("second");
		expect(manager.getJob(jobId)?.progressAt).toBe(1_200);
		now.mockReturnValue(1_300);
		gate.resolve("done");
		await manager.waitForAll();
		expect(settledProgressAt).toBe(1_200);
		expect(manager.getJob(jobId)?.endTime).toBe(1_300);
	});
});
