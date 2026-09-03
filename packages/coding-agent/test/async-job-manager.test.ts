import { afterEach, describe, expect, test, vi } from "bun:test";
import { scheduler } from "node:timers/promises";
import { AsyncJobError, AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";

async function waitForJobEviction(manager: AsyncJobManager, jobId: string): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (manager.getJob(jobId)) {
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for job eviction: ${jobId}`);
		await scheduler.yield();
	}
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
		await scheduler.yield();
	}
}

/** Resolve positive-duration sleeps immediately so grace-period waits don't cost real wall-clock time. */
function mockPositiveSleepsImmediate() {
	const realSleep = Bun.sleep.bind(Bun);
	return vi.spyOn(Bun, "sleep").mockImplementation((duration?: number | Date) => {
		if (typeof duration === "number" && duration > 0) return Promise.resolve();
		return realSleep(duration ?? 0);
	});
}

describe("AsyncJobManager", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("forwards progress updates and delivers completion", async () => {
		const progressEvents: Array<{ text: string; details?: Record<string, unknown> }> = [];
		const completions: Array<{ jobId: string; text: string }> = [];
		const manager = new AsyncJobManager({
			onJobComplete: async (jobId, text) => {
				completions.push({ jobId, text });
			},
		});

		const jobId = manager.register(
			"bash",
			"echo hi",
			async ({ reportProgress }) => {
				await reportProgress("running step", { async: { state: "running" } });
				return "final output";
			},
			{
				onProgress: async (text, details) => {
					progressEvents.push({ text, details });
				},
			},
		);

		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		expect(progressEvents).toEqual([{ text: "running step", details: { async: { state: "running" } } }]);
		expect(completions).toEqual([{ jobId, text: "final output" }]);
		expect(manager.getJob(jobId)?.status).toBe("completed");
	});

	test("swallows progress callback errors without failing the job", async () => {
		const completions: Array<{ jobId: string; text: string }> = [];
		const manager = new AsyncJobManager({
			onJobComplete: async (jobId, text) => {
				completions.push({ jobId, text });
			},
		});

		const jobId = manager.register(
			"task",
			"agent task",
			async ({ reportProgress }) => {
				await reportProgress("subagent started");
				return "task done";
			},
			{
				onProgress: async () => {
					throw new Error("progress renderer exploded");
				},
			},
		);

		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		expect(completions).toEqual([{ jobId, text: "task done" }]);
		expect(manager.getJob(jobId)?.status).toBe("completed");
	});

	test("delivers error text when run fails", async () => {
		const completions: Array<{ jobId: string; text: string }> = [];
		const manager = new AsyncJobManager({
			onJobComplete: async (jobId, text) => {
				completions.push({ jobId, text });
			},
		});

		const jobId = manager.register("bash", "bad command", async () => {
			throw new Error("command failed");
		});

		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		expect(completions).toEqual([{ jobId, text: "command failed" }]);
		expect(manager.getJob(jobId)?.status).toBe("failed");
		expect(manager.getJob(jobId)?.errorText).toBe("command failed");
	});

	test("retains structured output from a job body result", async () => {
		const completions: Array<{ jobId: string; text: string }> = [];
		const manager = new AsyncJobManager({
			onJobComplete: async (jobId, text) => {
				completions.push({ jobId, text });
			},
		});

		const jobId = manager.register("task", "agent task", async () => ({
			text: "task done",
			structured: { source: "caller", mode: "permissive", status: "valid", data: { count: 7 } },
		}));

		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		expect(completions).toEqual([{ jobId, text: "task done" }]);
		expect(manager.getJob(jobId)?.structured?.data).toEqual({ count: 7 });
	});

	test("keeps structured output for a delivery that only succeeds after the job row is evicted", async () => {
		let sinkCalls = 0;
		const delivered: Array<{ jobId: string; structured: unknown }> = [];
		const manager = new AsyncJobManager({
			retentionMs: 25,
			onJobComplete: async (jobId, _text, job) => {
				sinkCalls += 1;
				if (sinkCalls === 1) throw new Error("simulated delivery failure");
				delivered.push({ jobId, structured: job?.structured });
			},
		});

		const jobId = manager.register("task", "agent task", async () => ({
			text: "task done",
			structured: { source: "caller", mode: "permissive", status: "valid", data: { count: 7 } },
		}));

		await manager.waitForAll();
		await waitForJobEviction(manager, jobId);
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		// The job row is gone by the time the retried delivery lands, but the
		// delivery must still carry the structured payload it snapshotted at
		// enqueue time — not silently drop it because the row was evicted.
		expect(sinkCalls).toBe(2);
		expect(delivered).toEqual([
			{ jobId, structured: { source: "caller", mode: "permissive", status: "valid", data: { count: 7 } } },
		]);
	});

	test("preserves agentId in a delayed delivery rebuilt after eviction", async () => {
		// Regression: a collision-suffixed job id (e.g. `Foo-t1` -> `Foo-t1-2`)
		// still writes artifacts under the unsuffixed `agentId`. When the row
		// is evicted before a retried delivery lands, the delivery must be
		// rebuilt from a snapshot that still carries `agentId`, or the
		// reconstructed job falls back to the suffixed `jobId` and the
		// advertised `agent://` URL points at nothing on disk (PR #10625
		// review).
		let sinkCalls = 0;
		const delivered: Array<{ jobId: string; agentId: string | undefined }> = [];
		const manager = new AsyncJobManager({
			retentionMs: 25,
			onJobComplete: async (jobId, _text, job) => {
				sinkCalls += 1;
				if (sinkCalls === 1) throw new Error("simulated delivery failure");
				delivered.push({ jobId, agentId: job?.agentId });
			},
		});

		const jobId = manager.register("task", "agent task", async () => "task done", {
			id: "Foo-t1-2",
			agentId: "Foo-t1",
		});

		await manager.waitForAll();
		await waitForJobEviction(manager, jobId);
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		expect(sinkCalls).toBe(2);
		expect(delivered).toEqual([{ jobId: "Foo-t1-2", agentId: "Foo-t1" }]);
	});

	test("defers retained artifacts cleanup until this job's delivery settles", async () => {
		// Regression: job-row eviction runs on its own retention timer,
		// independent of delivery — a still-in-flight delivery sink (e.g. one
		// awaiting a yield-queue receipt) must not have its retained
		// artifacts deleted out from under it before the sink resolves (PR
		// #10625 review).
		const cleanupCalls: string[] = [];
		const deliveryGate = Promise.withResolvers<void>();
		const manager = new AsyncJobManager({
			retentionMs: 0,
			retainedArtifactsCleanupGraceMs: 0,
			onJobComplete: async () => {
				await deliveryGate.promise;
			},
		});

		const jobId = manager.register("task", "agent task", async () => "task done");
		const job = manager.getJob(jobId);
		job!.retainedArtifactsCleanup = async () => {
			cleanupCalls.push(jobId);
		};

		await manager.waitForAll();
		await waitForJobEviction(manager, jobId);

		// The job row is gone (retentionMs: 0), but the delivery sink is still
		// blocked on the gate — cleanup must not have run yet.
		await scheduler.yield();
		await scheduler.yield();
		expect(cleanupCalls).toEqual([]);

		deliveryGate.resolve();
		await manager.drainDeliveries({ timeoutMs: 2_000 });
		await waitForCondition(() => cleanupCalls.length > 0);

		expect(cleanupCalls).toEqual([jobId]);
	});

	test("waits out a grace period after delivery settles before cleanup, using the configured duration", async () => {
		// Regression: the settlement receipt resolves at `ASIDE_MESSAGE_COMMIT`
		// — when the follow-up is inserted into the transcript, but *before*
		// the next provider call that actually shows it to the model. Running
		// cleanup immediately on settlement raced ahead of the model's next
		// turn reading the advertised `agent://` pointer (PR #10625 review).
		const cleanupCalls: string[] = [];
		const sleepSpy = mockPositiveSleepsImmediate();
		const manager = new AsyncJobManager({
			retentionMs: 0,
			retainedArtifactsCleanupGraceMs: 45_000,
			onJobComplete: async () => {},
		});

		const jobId = manager.register("task", "agent task", async () => "task done");
		const job = manager.getJob(jobId);
		job!.retainedArtifactsCleanup = async () => {
			cleanupCalls.push(jobId);
		};

		await manager.waitForAll();
		await waitForJobEviction(manager, jobId);
		await manager.drainDeliveries({ timeoutMs: 2_000 });
		await waitForCondition(() => cleanupCalls.length > 0);

		expect(cleanupCalls).toEqual([jobId]);
		expect(sleepSpy.mock.calls.some(([duration]) => duration === 45_000)).toBe(true);
	});

	test("bypasses the retained-artifacts grace period during dispose", async () => {
		// Regression: dispose() previously ran retained-artifacts cleanup
		// through the full configured grace-period sleep even though every
		// delivery has already been drained/cancelled by that point —
		// leaking temp dirs for up to the grace window, or past process
		// exit since dispose does not await these cleanups (PR #10625
		// review).
		const cleanupCalls: string[] = [];
		const sleepSpy = mockPositiveSleepsImmediate();
		const manager = new AsyncJobManager({
			retainedArtifactsCleanupGraceMs: 45_000,
			onJobComplete: async () => {},
		});

		const jobId = manager.register("task", "agent task", async () => "task done");
		const job = manager.getJob(jobId);
		job!.retainedArtifactsCleanup = async () => {
			cleanupCalls.push(jobId);
		};

		await manager.waitForAll();
		await manager.dispose();
		await waitForCondition(() => cleanupCalls.length > 0);

		expect(cleanupCalls).toEqual([jobId]);
		expect(sleepSpy.mock.calls.some(([duration]) => duration === 45_000)).toBe(false);
	});

	test("bounds the wait for a hung delivery sink so retained artifacts cleanup still runs", async () => {
		// Regression: #waitForJobDeliverySettled loops forever awaiting an
		// in-flight delivery promise. A sink that never settles (e.g. a
		// yield-queue receipt whose owning session is gone) would leak the
		// retained temp directory for the process lifetime without a bound
		// (PR #10625 review).
		const cleanupCalls: string[] = [];
		const manager = new AsyncJobManager({
			retentionMs: 0,
			retainedArtifactsCleanupGraceMs: 0,
			retainedArtifactsCleanupMaxWaitMs: 20,
			onJobComplete: () => {},
		});
		manager.registerDeliverySink("Main", async () => {
			await Promise.withResolvers<never>().promise;
		});

		const jobId = manager.register("task", "agent task", async () => "task done", { ownerId: "Main" });
		const job = manager.getJob(jobId);
		job!.retainedArtifactsCleanup = async () => {
			cleanupCalls.push(jobId);
		};

		await manager.waitForAll();
		await waitForJobEviction(manager, jobId);
		await waitForCondition(() => cleanupCalls.length > 0, 2_000);

		expect(cleanupCalls).toEqual([jobId]);
	});

	test("fails the job but keeps structured output from AsyncJobError", async () => {
		const manager = new AsyncJobManager({
			onJobComplete: async () => {},
		});

		const jobId = manager.register("task", "agent task", async () => {
			throw new AsyncJobError("schema_violation: missing required fields: count", {
				source: "caller",
				mode: "strict",
				status: "invalid",
				error: "missing required fields: count",
				data: { summary: "ok" },
			});
		});

		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		const job = manager.getJob(jobId);
		expect(job?.status).toBe("failed");
		expect(job?.errorText).toBe("schema_violation: missing required fields: count");
		expect(job?.structured?.status).toBe("invalid");
	});

	test("cancels a running job by id", async () => {
		const completions: Array<{ jobId: string; text: string }> = [];
		const manager = new AsyncJobManager({
			onJobComplete: async (jobId, text) => {
				completions.push({ jobId, text });
			},
		});

		const jobId = manager.register("bash", "sleep", async ({ signal }) => {
			await new Promise<never>((_resolve, reject) => {
				signal.addEventListener(
					"abort",
					() => {
						reject(new Error("aborted"));
					},
					{ once: true },
				);
			});
			throw new Error("unreachable");
		});

		expect(manager.cancel(jobId)).toBe(true);
		expect(manager.cancel(jobId)).toBe(false);

		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		expect(manager.getJob(jobId)?.status).toBe("cancelled");
		expect(completions).toHaveLength(0);
	});

	test("bounds owner-job reap while preserving late settlement", async () => {
		const manager = new AsyncJobManager({ onJobComplete: async () => {} });
		const release = Promise.withResolvers<void>();
		const jobId = manager.register(
			"task",
			"ignores abort",
			async () => {
				await release.promise;
				return "late result";
			},
			{ ownerId: "owner" },
		);

		const reap = await manager.cancelAndReapOwnerJobs("owner", Date.now());

		expect(reap.settled).toBe(false);
		expect(reap.pendingJobIds).toEqual([jobId]);
		expect(manager.getJob(jobId)?.status).toBe("cancelled");

		release.resolve();
		await reap.completion;
		expect(manager.getJob(jobId)?.resultText).toBe("late result");
	});

	test("enforces maxRunningJobs cap", () => {
		const manager = new AsyncJobManager({
			maxRunningJobs: 1,
			onJobComplete: async () => {},
		});

		const firstJobId = manager.register("bash", "first", async ({ signal }) => {
			await new Promise<void>(resolve => {
				signal.addEventListener("abort", () => resolve(), { once: true });
			});
			return "done";
		});

		expect(() =>
			manager.register("bash", "second", async () => {
				return "second";
			}),
		).toThrow(/Background job limit reached/);

		manager.cancel(firstJobId);
	});

	test("queued jobs do not count toward the cap until markRunning", async () => {
		const manager = new AsyncJobManager({
			maxRunningJobs: 1,
			onJobComplete: async () => {},
		});

		const gate = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const queuedJobId = manager.register(
			"task",
			"queued",
			async ({ markRunning }) => {
				await gate.promise;
				markRunning();
				started.resolve();
				await release.promise;
				return "queued done";
			},
			{ queued: true },
		);

		// Queued job holds no slot: another job registers fine at cap 1.
		const runningJobId = manager.register("bash", "running", async ({ signal }) => {
			await new Promise<void>(resolve => {
				signal.addEventListener("abort", () => resolve(), { once: true });
			});
			return "done";
		});

		// Free the slot, then let the queued job start: it now occupies the slot.
		manager.cancel(runningJobId);
		gate.resolve();
		await started.promise;
		expect(() => manager.register("bash", "third", async () => "third")).toThrow(/Background job limit reached/);

		release.resolve();
		await manager.waitForAll();
		expect(manager.getJob(queuedJobId)?.status).toBe("completed");
	});

	test("evicts completed jobs after retention period", async () => {
		const manager = new AsyncJobManager({
			retentionMs: 25,
			onJobComplete: async () => {},
		});

		const jobId = manager.register("task", "short", async () => "done");
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		expect(manager.getJob(jobId)?.status).toBe("completed");
		await waitForJobEviction(manager, jobId);
		expect(manager.getJob(jobId)).toBeUndefined();
	});

	test("cancelAll does not clear retention timers for already completed jobs", async () => {
		let completedJobId = "";
		const completedDelivered = Promise.withResolvers<void>();
		const manager = new AsyncJobManager({
			retentionMs: 30,
			onJobComplete: async jobId => {
				if (jobId === completedJobId) completedDelivered.resolve();
			},
		});

		completedJobId = manager.register("task", "completed", async () => "done");
		const runningJobId = manager.register("bash", "running", async ({ signal }) => {
			await new Promise<void>(resolve => {
				signal.addEventListener("abort", () => resolve(), { once: true });
			});
			throw new Error("aborted");
		});

		await completedDelivered.promise;
		manager.cancelAll();
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		expect(manager.getJob(completedJobId)?.status).toBe("completed");
		expect(manager.getJob(runningJobId)?.status).toBe("cancelled");

		await Promise.all([waitForJobEviction(manager, completedJobId), waitForJobEviction(manager, runningJobId)]);
		expect(manager.getJob(completedJobId)).toBeUndefined();
		expect(manager.getJob(runningJobId)).toBeUndefined();
	});

	test("acknowledgeDeliveries suppresses pending retries for completed jobs", async () => {
		let failedJobId = "";
		let attempts = 0;
		const sentinelDelivered = Promise.withResolvers<void>();
		const firstAttempt = Promise.withResolvers<void>();
		const manager = new AsyncJobManager({
			onJobComplete: async jobId => {
				if (jobId !== failedJobId) {
					sentinelDelivered.resolve();
					return;
				}
				attempts += 1;
				firstAttempt.resolve();
				throw new Error("delivery failed");
			},
		});

		failedJobId = manager.register("task", "awaited-job", async () => "done");
		await manager.waitForAll();

		await firstAttempt.promise;
		while (!manager.hasPendingDeliveries()) await scheduler.yield();

		expect(manager.hasPendingDeliveries()).toBe(true);
		const removed = manager.acknowledgeDeliveries([failedJobId]);
		expect(removed).toBeGreaterThanOrEqual(1);

		const drained = await manager.drainDeliveries({ timeoutMs: 200 });
		expect(drained).toBe(true);
		expect(manager.hasPendingDeliveries()).toBe(false);

		const attemptsAfterAck = attempts;
		manager.register("task", "sentinel-job", async () => "sentinel");
		await manager.waitForAll();
		await sentinelDelivered.promise;
		expect(attempts).toBe(attemptsAfterAck);
	});

	test("dispose clears jobs and pending deliveries", async () => {
		const manager = new AsyncJobManager({
			onJobComplete: async () => {
				throw new Error("delivery failed");
			},
		});

		manager.register("bash", "will-complete", async () => "output");
		await manager.waitForAll();
		expect(manager.hasPendingDeliveries()).toBe(true);

		const drained = await manager.dispose({ timeoutMs: 25 });
		expect(drained).toBe(false);
		expect(manager.getAllJobs()).toHaveLength(0);
		expect(manager.hasPendingDeliveries()).toBe(false);
	});

	test("dispose honors timeout when a cancelled job never settles", async () => {
		const manager = new AsyncJobManager({
			onJobComplete: async () => {},
		});

		manager.register("bash", "ignores-abort", async () => {
			await Promise.withResolvers<never>().promise;
			return "unreachable";
		});

		const drained = await manager.dispose({ timeoutMs: 25 });

		expect(drained).toBe(false);
		expect(manager.getAllJobs()).toHaveLength(0);
	});

	test("starts queued deliveries while an earlier sink receipt is pending", async () => {
		const releaseDeliveries = Promise.withResolvers<void>();
		const bothStarted = Promise.withResolvers<void>();
		const started: string[] = [];
		const manager = new AsyncJobManager({});
		manager.registerDeliverySink("Main", async jobId => {
			started.push(jobId);
			if (started.length === 2) bothStarted.resolve();
			await releaseDeliveries.promise;
		});

		const firstId = manager.register("task", "first", async () => "first result", { ownerId: "Main" });
		const secondId = manager.register("task", "second", async () => "second result", { ownerId: "Main" });
		await manager.waitForAll();

		await bothStarted.promise;
		expect(started).toEqual([firstId, secondId]);

		releaseDeliveries.resolve();
		expect(await manager.drainDeliveries({ timeoutMs: 200 })).toBe(true);
	});

	test("scoped delivery drain returns once matching owner deliveries finish", async () => {
		let mainJobId = "";
		let releaseMainDelivery = (): void => {};
		let notifyMainDeliveryStarted = (): void => {};
		const mainDeliveryStarted = new Promise<void>(resolve => {
			notifyMainDeliveryStarted = resolve;
		});
		const mainDeliveryReleased = new Promise<void>(resolve => {
			releaseMainDelivery = resolve;
		});
		const mainDeliveryFinished = Promise.withResolvers<void>();
		const subagentCompletions: Array<{ jobId: string; text: string }> = [];
		const manager = new AsyncJobManager({ retentionMs: 0 });
		manager.registerDeliverySink("0-Main", async () => {
			notifyMainDeliveryStarted();
			await mainDeliveryReleased;
			mainDeliveryFinished.resolve();
		});
		manager.registerDeliverySink("3-AuthLoader", (jobId, text) => {
			subagentCompletions.push({ jobId, text });
		});

		mainJobId = manager.register("task", "main job", async () => "main result", { ownerId: "0-Main" });
		const targetJobId = manager.register("task", "subagent job", async () => "subagent result", {
			ownerId: "3-AuthLoader",
		});
		await manager.waitForAll();
		await mainDeliveryStarted;

		expect(manager.hasPendingDeliveries({ ownerId: "0-Main" })).toBe(true);
		const drained = await manager.drainDeliveries({ timeoutMs: 50, filter: { ownerId: "3-AuthLoader" } });

		expect(drained).toBe(true);
		expect(subagentCompletions).toEqual([{ jobId: targetJobId, text: "subagent result" }]);
		expect(manager.hasPendingDeliveries({ ownerId: "3-AuthLoader" })).toBe(false);

		expect(manager.acknowledgeDeliveries([mainJobId])).toBe(0);
		expect(manager.hasPendingDeliveries({ ownerId: "0-Main" })).toBe(false);
		releaseMainDelivery();
		await mainDeliveryFinished.promise;
		await manager.dispose();
	});

	test("scoped delivery drain times out while a matching delivery callback is in flight", async () => {
		let targetJobId = "";
		let releaseMainDelivery = (): void => {};
		let notifyMainDeliveryStarted = (): void => {};
		let releaseTargetDelivery = (): void => {};
		let notifyTargetDeliveryStarted = (): void => {};
		const mainDeliveryStarted = new Promise<void>(resolve => {
			notifyMainDeliveryStarted = resolve;
		});
		const mainDeliveryReleased = new Promise<void>(resolve => {
			releaseMainDelivery = resolve;
		});
		const targetDeliveryStarted = new Promise<void>(resolve => {
			notifyTargetDeliveryStarted = resolve;
		});
		const targetDeliveryReleased = new Promise<void>(resolve => {
			releaseTargetDelivery = resolve;
		});
		const completions: string[] = [];
		const manager = new AsyncJobManager({});
		manager.registerDeliverySink("0-Main", async () => {
			notifyMainDeliveryStarted();
			await mainDeliveryReleased;
		});
		manager.registerDeliverySink("3-AuthLoader", async jobId => {
			notifyTargetDeliveryStarted();
			await targetDeliveryReleased;
			completions.push(jobId);
		});

		manager.register("task", "main job", async () => "main result", { ownerId: "0-Main" });
		targetJobId = manager.register("task", "subagent job", async () => "subagent result", {
			ownerId: "3-AuthLoader",
		});
		await manager.waitForAll();
		await mainDeliveryStarted;

		const timedOut = await manager.drainDeliveries({ timeoutMs: 10, filter: { ownerId: "3-AuthLoader" } });
		await targetDeliveryStarted;

		expect(timedOut).toBe(false);
		expect(manager.hasPendingDeliveries({ ownerId: "3-AuthLoader" })).toBe(true);
		expect(completions).toEqual([]);

		releaseTargetDelivery();
		const drained = await manager.drainDeliveries({ timeoutMs: 200, filter: { ownerId: "3-AuthLoader" } });
		expect(drained).toBe(true);
		expect(completions).toEqual([targetJobId]);

		releaseMainDelivery();
		expect(await manager.drainDeliveries({ timeoutMs: 200 })).toBe(true);
	});

	test("cancelAll with ownerId only cancels matching jobs", async () => {
		const manager = new AsyncJobManager({
			onJobComplete: async () => {},
		});

		const hold = (signal: AbortSignal) =>
			new Promise<void>(resolve => {
				signal.addEventListener("abort", () => resolve(), { once: true });
			});

		const parentJobId = manager.register(
			"bash",
			"parent-job",
			async ({ signal }) => {
				await hold(signal);
				return "parent-cancelled";
			},
			{ ownerId: "0-Main" },
		);
		const subagentJobId = manager.register(
			"bash",
			"subagent-job",
			async ({ signal }) => {
				await hold(signal);
				return "subagent-cancelled";
			},
			{ ownerId: "3-AuthLoader" },
		);

		manager.cancelAll({ ownerId: "3-AuthLoader" });

		expect(manager.getJob(parentJobId)?.status).toBe("running");
		expect(manager.getJob(subagentJobId)?.status).toBe("cancelled");

		// Filtered query mirrors filtered cancel.
		expect(manager.getRunningJobs({ ownerId: "0-Main" }).map(j => j.id)).toEqual([parentJobId]);
		expect(manager.getRunningJobs({ ownerId: "3-AuthLoader" })).toEqual([]);
		expect(manager.getAllJobs({ ownerId: "0-Main" }).map(j => j.id)).toEqual([parentJobId]);

		// Unscoped cancelAll still cleans up everything.
		manager.cancelAll();
		await manager.waitForAll();
		expect(manager.getJob(parentJobId)?.status).toBe("cancelled");
	});

	test("routes owned deliveries to the owner's registered sink only", async () => {
		const mainDeliveries: string[] = [];
		const defaultDeliveries: string[] = [];
		const manager = new AsyncJobManager({
			onJobComplete: async jobId => {
				defaultDeliveries.push(jobId);
			},
		});
		manager.registerDeliverySink("Main", jobId => {
			mainDeliveries.push(jobId);
		});

		manager.register("bash", "owned", async () => "ok", { id: "owned-1", ownerId: "Main" });
		manager.register("bash", "unowned", async () => "ok", { id: "unowned-1" });
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 500 });

		expect(mainDeliveries).toEqual(["owned-1"]);
		expect(defaultDeliveries).toEqual(["unowned-1"]);
	});

	test("dead-letters an owned delivery when its owner has no live sink", async () => {
		const defaultDeliveries: string[] = [];
		const manager = new AsyncJobManager({
			onJobComplete: async jobId => {
				defaultDeliveries.push(jobId);
			},
		});
		const unregister = manager.registerDeliverySink("Sub", () => {});
		unregister();

		manager.register("bash", "orphan", async () => "orphan result", { id: "orphan-1", ownerId: "Sub" });
		await manager.waitForAll();
		const drained = await manager.drainDeliveries({ timeoutMs: 500 });

		// Dead-letter drops the delivery (drain settles) without misrouting it
		// into the default sink; the outcome stays readable on the job row.
		expect(drained).toBe(true);
		expect(defaultDeliveries).toEqual([]);
		expect(manager.getJob("orphan-1")?.resultText).toBe("orphan result");
	});

	test("waitForOwnerJobs settles cancelled jobs and skips suppressed ones on request", async () => {
		const manager = new AsyncJobManager({});
		manager.register(
			"bash",
			"hung",
			async ({ signal }) => {
				await new Promise<void>(resolve => {
					if (signal.aborted) return resolve();
					signal.addEventListener("abort", () => resolve(), { once: true });
				});
				return "stopped";
			},
			{ id: "hung-1", ownerId: "Sub" },
		);

		// Quiescence-barrier contract: a watched (suppressed) job can never
		// re-wake a run, so the filtered wait treats it as settled.
		manager.watchJobs(["hung-1"]);
		await expect(manager.waitForOwnerJobs("Sub", { excludeSuppressed: true })).resolves.toBe(true);

		// Teardown-reap contract: the unfiltered wait blocks until the
		// cancelled job's body actually finishes.
		const reap = manager.waitForOwnerJobs("Sub", { timeoutMs: 1_000 });
		manager.cancelAll({ ownerId: "Sub" });
		await expect(reap).resolves.toBe(true);
		expect(manager.getJob("hung-1")?.status).toBe("cancelled");
	});
});

describe("AsyncJobManager smart poll-wait escalation", () => {
	const newManager = () => new AsyncJobManager({ onJobComplete: async () => {} });

	test("first poll waits the ladder floor", () => {
		const m = newManager();
		expect(m.nextPollWaitMs("Main", 1_000)).toBe(5_000);
		// A fresh owner also starts at the floor.
		expect(m.nextPollWaitMs("Other", 1_000)).toBe(5_000);
	});

	test("back-to-back polls climb the ladder to the top rung", () => {
		const m = newManager();
		const owner = "Main";
		const t = 1_000;
		const waits: number[] = [];
		for (let i = 0; i < 6; i++) {
			// Same timestamp every time → zero gap → always escalates.
			waits.push(m.nextPollWaitMs(owner, t));
			m.recordPollWaitEnd(owner, t);
		}
		// Climbs the rungs, then saturates at the top.
		expect(waits).toEqual([5_000, 10_000, 30_000, 60_000, 300_000, 300_000]);
	});

	test("a quiet gap of a minute resets back to the floor", () => {
		const m = newManager();
		const owner = "Main";

		expect(m.nextPollWaitMs(owner, 0)).toBe(5_000);
		m.recordPollWaitEnd(owner, 0);

		// Still within the reset window (just under a minute) → keeps climbing.
		expect(m.nextPollWaitMs(owner, 59_999)).toBe(10_000);
		m.recordPollWaitEnd(owner, 60_000);

		// A full minute without polling resets the climb to the floor.
		expect(m.nextPollWaitMs(owner, 120_000)).toBe(5_000);
	});

	test("escalation is tracked independently per owner", () => {
		const m = newManager();
		const t = 1_000;

		m.nextPollWaitMs("A", t);
		m.recordPollWaitEnd("A", t);
		m.nextPollWaitMs("A", t);
		m.recordPollWaitEnd("A", t);

		// A fresh owner starts at the floor regardless of A's escalation.
		expect(m.nextPollWaitMs("B", t)).toBe(5_000);
		// A keeps climbing from where it left off.
		expect(m.nextPollWaitMs("A", t)).toBe(30_000);
	});
});
