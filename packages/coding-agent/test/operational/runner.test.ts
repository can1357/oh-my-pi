import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@pk-nerdsaver-ai/pi-utils";
import { DurableRunner, type JobExecutor, type NotificationRecord, OperationalStore } from "../../src/operational";

class TestClock {
	#now: number;
	constructor(start: number) {
		this.#now = start;
	}
	now = (): number => this.#now;
	set(value: number): void {
		this.#now = value;
	}
	advance(ms: number): void {
		this.#now += ms;
	}
}

class TestIds {
	#n = 0;
	next = (): string => {
		this.#n += 1;
		return `id-${this.#n}`;
	};
}

function rejectOnAbort(signal: AbortSignal): Promise<never> {
	const aborted = Promise.withResolvers<never>();
	signal.addEventListener("abort", () => aborted.reject(new DOMException("aborted", "AbortError")), { once: true });
	return aborted.promise;
}

describe("DurableRunner", () => {
	let tempDir: TempDir | undefined;
	let store: OperationalStore | undefined;
	const runners: DurableRunner[] = [];

	afterEach(async () => {
		for (const runner of runners.splice(0)) runner.dispose();
		store?.close();
		store = undefined;
		if (tempDir) {
			try {
				await tempDir.remove();
			} catch {
				// ignore cleanup races on Windows
			}
			tempDir = undefined;
		}
	});

	function openStore(clock?: TestClock, ids?: TestIds): OperationalStore {
		tempDir = TempDir.createSync("@omp-durable-runner-");
		const s = OperationalStore.open({
			dbPath: path.join(tempDir.path(), "operational.db"),
			now: clock?.now,
			createId: ids?.next,
			durability: "normal",
		});
		store = s;
		return s;
	}

	function createRunner(
		s: OperationalStore,
		executor: JobExecutor,
		options?: {
			clock?: TestClock;
			ids?: TestIds;
			workerId?: string;
			leaseMs?: number;
			pollIntervalMs?: number;
			notificationSink?: { notify: (n: NotificationRecord) => void | Promise<void> };
		},
	): DurableRunner {
		const runner = new DurableRunner({
			store: s,
			executor,
			workerId: options?.workerId ?? "worker-1",
			leaseMs: options?.leaseMs ?? 5_000,
			pollIntervalMs: options?.pollIntervalMs ?? 5,
			notificationSink: options?.notificationSink,
			now: options?.clock?.now,
			createId: options?.ids?.next,
		});
		runners.push(runner);
		return runner;
	}

	it("runs a successful executor and persists outcome + checkpoint", async () => {
		const clock = new TestClock(1_000);
		const s = openStore(clock);
		const runner = createRunner(
			s,
			async ctx => {
				expect(ctx.checkpoint).toBeNull();
				ctx.checkpointWrite({ step: 1 });
				ctx.heartbeat();
				return { ok: true };
			},
			{ clock },
		);

		const job = runner.enqueue({ type: "demo", payload: { n: 1 } });
		const done = await runner.runOnce();
		expect(done?.id).toBe(job.id);
		expect(done?.status).toBe("completed");
		expect(done?.result).toEqual({ ok: true });
		expect(s.getCheckpoint(job.id)?.data).toEqual({ step: 1 });

		const events = s.listEvents({ jobId: job.id });
		expect(events.some(e => e.kind === "job_state")).toBe(true);
		expect(events.some(e => e.kind === "outcome")).toBe(true);
	});

	it("records failing executor outcomes", async () => {
		const s = openStore();
		const runner = createRunner(s, async () => {
			throw new Error("boom");
		});
		const job = runner.enqueue({ type: "fail" });
		const done = await runner.runOnce();
		expect(done?.id).toBe(job.id);
		expect(done?.status).toBe("failed");
		expect(done?.error).toBe("boom");
	});

	it("materializes one job under concurrent due CAS", () => {
		const clock = new TestClock(10_000);
		const ids = new TestIds();
		const s = openStore(clock, ids);
		s.upsertSchedule({
			id: "sched-1",
			name: "due",
			cron: "0 * * * *",
			nextRunAt: 10_000,
			payload: { jobType: "tick", jobPayload: { from: "cron" } },
		});

		const a = s.materializeDueSchedule({
			scheduleId: "sched-1",
			expectedNextRunAt: 10_000,
			nextRunAt: 3_600_000 + 10_000,
			jobType: "tick",
			jobPayload: { from: "cron" },
			jobId: "job-a",
		});
		const b = s.materializeDueSchedule({
			scheduleId: "sched-1",
			expectedNextRunAt: 10_000,
			nextRunAt: 3_600_000 + 10_000,
			jobType: "tick",
			jobPayload: { from: "cron" },
			jobId: "job-b",
		});
		expect(a?.id).toBe("job-a");
		expect(b).toBeNull();
		expect(s.listJobs({ status: "queued" })).toHaveLength(1);
		expect(s.getSchedule("sched-1")?.nextRunAt).toBe(3_610_000);
	});

	it("advances recurring schedules through the runner", async () => {
		const clock = new TestClock(Date.UTC(2024, 0, 1, 0, 0, 0));
		const s = openStore(clock);
		s.upsertSchedule({
			id: "hourly",
			name: "hourly",
			cron: "0 * * * *",
			nextRunAt: clock.now(),
			payload: { jobType: "hourly", jobPayload: { x: 1 } },
		});
		const runner = createRunner(s, async () => ({ ran: true }), { clock });
		const done = await runner.runOnce();
		expect(done?.type).toBe("hourly");
		expect(done?.status).toBe("completed");
		expect(s.getSchedule("hourly")?.nextRunAt).toBe(Date.UTC(2024, 0, 1, 1, 0, 0));
	});

	it("recovers expired leases and re-runs with prior checkpoint", async () => {
		const clock = new TestClock(1_000);
		const s = openStore(clock);
		let attempts = 0;
		const runner = createRunner(
			s,
			async ctx => {
				attempts += 1;
				expect(ctx.checkpoint).toEqual({ cursor: 7 });
				return { recovered: true };
			},
			{ clock, leaseMs: 1_000 },
		);

		const job = runner.enqueue({ type: "recover" });
		const claimed = s.claimJob("dead-worker", 50);
		expect(claimed?.id).toBe(job.id);
		s.setCheckpoint(job.id, { cursor: 7 });
		clock.advance(100);

		const done = await runner.runOnce();
		expect(done?.status).toBe("completed");
		expect(done?.result).toEqual({ recovered: true });
		expect(attempts).toBe(1);
	});

	it("supports pause, resume, and cancel including abort of executing jobs", async () => {
		const s = openStore();

		const pausedQueued = createRunner(s, async () => ({ ok: true }), { workerId: "w-pause-queued" }).enqueue({
			type: "p",
			status: "paused",
		});
		expect(pausedQueued.status).toBe("paused");
		const probe = createRunner(s, async () => ({ ok: true }), { workerId: "w-probe" });
		expect(await probe.runOnce()).toBeNull();
		probe.resume(pausedQueued.id);
		expect(s.getJob(pausedQueued.id)?.status).toBe("queued");
		probe.cancel(pausedQueued.id);
		expect(s.getJob(pausedQueued.id)?.status).toBe("cancelled");

		const gate1 = Promise.withResolvers<void>();
		const cancelRunner = createRunner(
			s,
			async ctx => {
				await Promise.race([gate1.promise, rejectOnAbort(ctx.signal)]);
				return { ok: true };
			},
			{ workerId: "w-cancel" },
		);
		const runningJob = cancelRunner.enqueue({ type: "run" });
		const execPromise = cancelRunner.runOnce();
		await Bun.sleep(20);
		expect(s.getJob(runningJob.id)?.status).toBe("running");
		cancelRunner.cancel(runningJob.id);
		const cancelled = await execPromise;
		expect(cancelled?.status).toBe("cancelled");
		gate1.resolve();

		const gate2 = Promise.withResolvers<void>();
		const pauseRunner = createRunner(
			s,
			async ctx => {
				await Promise.race([gate2.promise, rejectOnAbort(ctx.signal)]);
				return { ok: true };
			},
			{ workerId: "w-pause" },
		);
		const pauseJob = pauseRunner.enqueue({ type: "pause-run" });
		const pauseExec = pauseRunner.runOnce();
		await Bun.sleep(20);
		expect(s.getJob(pauseJob.id)?.status).toBe("running");
		pauseRunner.pause(pauseJob.id);
		const paused = await pauseExec;
		expect(paused?.status).toBe("paused");
		pauseRunner.resume(pauseJob.id);
		expect(s.getJob(pauseJob.id)?.status).toBe("queued");
		gate2.resolve();
	});

	it("isolates notification sink failures from job outcome", async () => {
		const s = openStore();
		const runner = createRunner(s, async () => ({ ok: true }), {
			notificationSink: {
				notify: () => {
					throw new Error("sink down");
				},
			},
		});
		const job = runner.enqueue({ type: "notify" });
		const done = await runner.runOnce();
		expect(done?.status).toBe("completed");
		const notes = s.listNotifications();
		expect(notes.some(n => n.kind === "job_completed")).toBe(true);
		const events = s.listEvents({ jobId: job.id, kind: "outcome" });
		expect(
			events.some(e => {
				const payload = e.payload as { action?: string };
				return payload?.action === "notification_sink_error";
			}),
		).toBe(true);
	});

	it("stops runLoop when aborted", async () => {
		const s = openStore();
		const runner = createRunner(s, async () => null, { pollIntervalMs: 5 });
		const controller = new AbortController();
		const loop = runner.runLoop(controller.signal);
		await Bun.sleep(15);
		controller.abort();
		const stopped = await Promise.race([loop.then(() => true), Bun.sleep(100).then(() => false)]);
		expect(stopped).toBe(true);
	});
	it("requeues an in-flight job when the worker shuts down", async () => {
		const s = openStore();
		const started = Promise.withResolvers<void>();
		const runner = createRunner(s, async ctx => {
			ctx.checkpointWrite({ step: 2 });
			started.resolve();
			await rejectOnAbort(ctx.signal);
			return null;
		});
		const job = runner.enqueue({ type: "shutdown" });
		const controller = new AbortController();
		const execution = runner.runOnce(controller.signal);
		await started.promise;
		controller.abort();
		const interrupted = await execution;
		expect(interrupted?.status).toBe("queued");
		expect(s.getCheckpoint(job.id)?.data).toEqual({ step: 2 });
	});

	it("keeps executor result content out of trajectory events", async () => {
		const s = openStore();
		const runner = createRunner(s, async () => ({ secret: "sk-not-for-telemetry" }));
		const job = runner.enqueue({ type: "privacy" });
		await runner.runOnce();
		expect(s.getJob(job.id)?.result).toEqual({ secret: "sk-not-for-telemetry" });
		expect(JSON.stringify(s.listEvents({ jobId: job.id }))).not.toContain("sk-not-for-telemetry");
	});

	it("indexes completed durable jobs as searchable episodes", async () => {
		const s = openStore();
		const runner = createRunner(s, async () => ({ ok: true }));
		const job = runner.enqueue({
			type: "omp",
			payload: { prompt: "Refactor the authentication cache", cwd: "C:/work" },
		});
		await runner.runOnce();
		const episodes = s.searchEpisodes("authentication cache");
		expect(episodes).toHaveLength(1);
		expect(episodes[0]?.id).toBe(`job:${job.id}`);
		expect(episodes[0]?.metadata).toMatchObject({ jobId: job.id, status: "completed" });
	});

	it("aborts the owning executor after a different runner cancels it", async () => {
		const s = openStore();
		const started = Promise.withResolvers<void>();
		const owner = createRunner(
			s,
			async ctx => {
				started.resolve();
				while (!ctx.signal.aborted) {
					ctx.heartbeat();
					await Bun.sleep(5);
				}
				throw new DOMException("cancelled", "AbortError");
			},
			{ workerId: "owner" },
		);
		const controller = createRunner(s, async () => null, { workerId: "controller" });
		const job = owner.enqueue({ type: "cross-process" });
		const execution = owner.runOnce();
		await started.promise;
		controller.cancel(job.id);
		const cancelled = await execution;
		expect(cancelled?.status).toBe("cancelled");
		expect(s.getJob(job.id)?.status).toBe("cancelled");
	});

	it("replays terminal finalization and pending notifications", async () => {
		const s = openStore();
		const job = s.createJob({ type: "reconcile", payload: { prompt: "Reconcile task" } });
		s.claimJob("crashed-worker");
		s.transitionJob(job.id, { to: "completed", leaseOwner: "crashed-worker", result: { ok: true } });
		const delivered: string[] = [];
		const runner = createRunner(s, async () => null, {
			notificationSink: {
				notify: notification => {
					delivered.push(notification.id);
				},
			},
		});
		expect(await runner.runOnce()).toBeNull();
		expect(delivered).toHaveLength(1);
		expect(s.listNotifications()[0]?.read).toBe(true);
		expect(s.getEpisode(`job:${job.id}`)).not.toBeNull();
		expect(s.listEvents({ jobId: job.id, kind: "outcome" })).toHaveLength(1);
	});
});
