import { afterEach, describe, expect, test, vi } from "bun:test";
import {
	type AsyncJob,
	AsyncJobManager,
	type AsyncJobProgressDelivery,
	type AsyncJobProgressInfo,
	type AsyncJobProgressSink,
} from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ProgressBatcher, type ProgressReminder } from "@oh-my-pi/pi-coding-agent/async/progress-batcher";
import {
	type ProgressLine,
	ProgressLines,
	progressStreamProvenanceForText,
} from "@oh-my-pi/pi-coding-agent/async/progress-lines";

function heldJob(manager: AsyncJobManager, ownerId = "Main", progressDelivery: AsyncJobProgressDelivery = "ambient") {
	const gate = Promise.withResolvers<void>();
	const started = Promise.withResolvers<(text: string) => void>();
	const jobId = manager.register(
		"bash",
		"held",
		async ({ reportAgentProgress }) => {
			started.resolve(reportAgentProgress);
			await gate.promise;
			return "done";
		},
		{ ownerId, progressDelivery },
	);
	return { jobId, report: started.promise, release: gate.resolve };
}

interface RecordedProgress {
	jobId: string;
	text: string;
	seq: number;
	truncated?: boolean;
	suppressedEvents?: number;
	reminder?: ProgressReminder;
}

function recordingSink(): {
	sink: AsyncJobProgressSink;
	seen: RecordedProgress[];
} {
	const seen: RecordedProgress[] = [];
	return {
		sink: {
			deliver: (jobId, text, _job: AsyncJob, seq, info) => {
				const record: RecordedProgress = {
					jobId,
					text,
					seq,
					suppressedEvents: info.suppressedEvents,
					reminder: info.reminder,
				};
				if (info.truncated === true) record.truncated = true;
				seen.push(record);
			},
		},
		seen,
	};
}

describe("AsyncJobManager model progress", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	test("collects updates for 200 ms and flushes final progress before completion", async () => {
		vi.useFakeTimers();
		const manager = new AsyncJobManager({});
		const recorder = recordingSink();
		manager.registerProgressSink("Main", recorder.sink);
		const job = heldJob(manager);
		const report = await job.report;

		report("first");
		report("second");
		report("newest");
		expect(recorder.seen).toEqual([]);

		vi.advanceTimersByTime(199);
		expect(recorder.seen).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(recorder.seen).toEqual([
			{
				jobId: job.jobId,
				text: "first\nsecond\nnewest",
				seq: 1,
				suppressedEvents: undefined,
				reminder: undefined,
			},
		]);

		report("final before completion");
		job.release();
		await manager.waitForAll();
		expect(recorder.seen).toEqual([
			{
				jobId: job.jobId,
				text: "first\nsecond\nnewest",
				seq: 1,
				suppressedEvents: undefined,
				reminder: undefined,
			},
			{
				jobId: job.jobId,
				text: "final before completion",
				seq: 2,
				suppressedEvents: undefined,
				reminder: undefined,
			},
		]);
	});

	test("repeated empty progress reports remain deliverable and do not fail the job", async () => {
		vi.useFakeTimers();
		const manager = new AsyncJobManager({});
		const recorder = recordingSink();
		manager.registerProgressSink("Main", recorder.sink);
		const job = heldJob(manager);
		const report = await job.report;

		report("");
		report("");
		report("");
		vi.advanceTimersByTime(200);
		expect(recorder.seen).toEqual([
			{
				jobId: job.jobId,
				text: "",
				seq: 1,
				suppressedEvents: undefined,
				reminder: undefined,
			},
		]);

		job.release();
		await manager.waitForAll();
		expect(manager.getJob(job.jobId)?.status).toBe("completed");
	});

	test("retains the outer progress around a rate-limited middle", async () => {
		vi.useFakeTimers();
		const manager = new AsyncJobManager({});
		const recorder = recordingSink();
		manager.registerProgressSink("Main", recorder.sink);
		const job = heldJob(manager);
		const report = await job.report;

		for (let event = 1; event <= 21; event++) {
			report(`event-${event}`);
			vi.advanceTimersByTime(200);
		}

		expect(recorder.seen.at(-1)).toEqual({
			jobId: job.jobId,
			text: "event-12\nevent-20\nevent-21",
			seq: 21,
			truncated: true,
			suppressedEvents: 9,
			reminder: undefined,
		});

		job.release();
		await manager.waitForAll();
	});

	test("routes ambient events to the owning queue while idle and respects wait/ack suppression", async () => {
		vi.useFakeTimers();
		const manager = new AsyncJobManager({});
		const mine = recordingSink();
		const other = recordingSink();
		manager.registerProgressSink("Main", mine.sink);
		manager.registerProgressSink("Other", other.sink);
		const job = heldJob(manager);
		const report = await job.report;

		report("idle");
		vi.advanceTimersByTime(200);
		expect(mine.seen.map(item => item.text)).toEqual(["idle"]);
		expect(other.seen).toEqual([]);

		manager.watchJobs([job.jobId]);
		report("watched");
		vi.advanceTimersByTime(200);
		expect(mine.seen.map(item => item.text)).toEqual(["idle"]);
		manager.unwatchJobs([job.jobId]);
		report("resumed after watch");
		vi.advanceTimersByTime(200);
		expect(mine.seen.map(item => item.text)).toEqual(["idle", "resumed after watch"]);

		manager.acknowledgeDeliveries([job.jobId]);
		report("acknowledged");
		vi.advanceTimersByTime(200);
		expect(mine.seen.map(item => item.text)).toEqual(["idle", "resumed after watch"]);
		manager.resumeDeliveries([job.jobId]);
		report("resumed after acknowledge");
		vi.advanceTimersByTime(200);
		expect(mine.seen.map(item => item.text)).toEqual(["idle", "resumed after watch", "resumed after acknowledge"]);

		job.release();
		await manager.waitForAll();
	});

	test("delivers wake progress to an idle owner", async () => {
		vi.useFakeTimers();
		const manager = new AsyncJobManager({});
		const recorder = recordingSink();
		manager.registerProgressSink("Main", recorder.sink);
		const job = heldJob(manager, "Main", "wake");
		const report = await job.report;

		report("push while idle");
		vi.advanceTimersByTime(200);
		expect(recorder.seen).toEqual([
			{
				jobId: job.jobId,
				text: "push while idle",
				seq: 1,
				suppressedEvents: undefined,
				reminder: undefined,
			},
		]);

		job.release();
		await manager.waitForAll();
	});

	test("activation restores progress after suppression while delivery was disabled", async () => {
		vi.useFakeTimers();
		const manager = new AsyncJobManager({});
		const recorder = recordingSink();
		manager.registerProgressSink("Main", recorder.sink);
		const gate = Promise.withResolvers<void>();
		const started = Promise.withResolvers<(text: string) => void>();
		const jobId = manager.register(
			"bash",
			"delayed activation",
			async ({ reportAgentProgress }) => {
				started.resolve(reportAgentProgress);
				await gate.promise;
				return "done";
			},
			{ ownerId: "Main" },
		);
		const report = await started.promise;

		manager.watchJobs([jobId]);
		manager.unwatchJobs([jobId]);
		expect(manager.activateProgressDelivery(jobId, "wake")).toBe(true);
		report("after activation");
		vi.advanceTimersByTime(200);
		expect(recorder.seen.map(item => item.text)).toEqual(["after activation"]);

		gate.resolve();
		await manager.waitForAll();
	});

	test("waits for asynchronous final progress delivery before delivering completion", async () => {
		const start = Promise.withResolvers<void>();
		const progressStarted = Promise.withResolvers<void>();
		const releaseProgress = Promise.withResolvers<void>();
		const order: string[] = [];
		const manager = new AsyncJobManager({});
		manager.registerProgressSink("Main", {
			deliver: async () => {
				order.push("progress:start");
				progressStarted.resolve();
				await releaseProgress.promise;
				order.push("progress:end");
			},
		});
		manager.registerDeliverySink("Main", () => {
			order.push("completion");
		});
		const jobId = manager.register(
			"bash",
			"ordered",
			async ({ reportAgentProgress }) => {
				await start.promise;
				reportAgentProgress("final progress");
				return "done";
			},
			{ ownerId: "Main", progressDelivery: "wake" },
		);

		start.resolve();
		await progressStarted.promise;
		expect(manager.getJob(jobId)?.status).toBe("running");
		expect(order).toEqual(["progress:start"]);

		releaseProgress.resolve();
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });
		expect(order).toEqual(["progress:start", "progress:end", "completion"]);
	});

	test("sink failures are best-effort and do not block completion", async () => {
		const completions: string[] = [];
		const manager = new AsyncJobManager({});
		manager.registerProgressSink("Main", {
			deliver: async () => {
				throw new Error("sink failed");
			},
		});
		manager.registerDeliverySink("Main", (_jobId, text) => {
			completions.push(text);
		});

		const jobId = manager.register(
			"bash",
			"failure",
			async ({ reportAgentProgress }) => {
				reportAgentProgress("tick");
				return "complete";
			},
			{ ownerId: "Main", progressDelivery: "ambient" },
		);
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		expect(manager.getJob(jobId)?.status).toBe("completed");
		expect(completions).toEqual(["complete"]);
	});

	test("folds never-delivered leftover into completion for artifact-backed progress", async () => {
		vi.useFakeTimers();
		const manager = new AsyncJobManager({});
		const recorder = recordingSink();
		const completions: string[] = [];
		manager.registerProgressSink("Main", recorder.sink);
		manager.registerDeliverySink("Main", (_jobId, text) => {
			completions.push(text);
		});
		const gate = Promise.withResolvers<void>();
		const started = Promise.withResolvers<(text: string, info?: AsyncJobProgressInfo) => void>();
		const jobId = manager.register(
			"bash",
			"artifact backed",
			async ({ reportAgentProgress }) => {
				started.resolve(reportAgentProgress);
				await gate.promise;
				return "full result body";
			},
			{ ownerId: "Main", progressDelivery: "ambient" },
		);
		const report = await started.promise;

		report("delivered line", { artifactId: "42" });
		vi.advanceTimersByTime(200);
		expect(recorder.seen.map(item => item.text)).toEqual(["delivered line"]);

		report("leftover line", { artifactId: "42" });
		gate.resolve();
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		// The pending window folds into the completion instead of racing one
		// final progress batch ahead of the result.
		expect(recorder.seen).toHaveLength(1);
		const job = manager.getJob(jobId)!;
		expect(job.progressDeliveredCount).toBe(1);
		expect(job.progressArtifactId).toBe("42");
		expect(job.completionLeftover).toEqual({ text: "leftover line", truncated: false, suppressedEvents: undefined });
		expect(completions).toEqual(["full result body"]);
	});

	test("classifies cumulative raw provenance with split surrogate pairs as progress", async () => {
		vi.useFakeTimers();
		const manager = new AsyncJobManager({});
		const recorder = recordingSink();
		manager.registerProgressSink("Main", recorder.sink);
		const emoji = "😀";
		const terminalSource = `first ${emoji} batch\nsecond batch\n\n`;
		const terminalText = `${terminalSource}\nWall time: 1.23 seconds`;
		const gate = Promise.withResolvers<{ text: string; terminalTextSource: string }>();
		const reportedLines: ProgressLine[] = [];
		const samplerReady = Promise.withResolvers<ProgressLines>();
		const jobId = manager.register(
			"bash",
			"cumulative progress",
			async ({ reportAgentProgress }) => {
				const sampler = new ProgressLines(line => {
					reportedLines.push(line);
					reportAgentProgress(line.text, {
						artifactId: "cumulative-artifact",
						streamProvenance: line.streamProvenance,
					});
				});
				samplerReady.resolve(sampler);
				return gate.promise;
			},
			{ ownerId: "Main", progressDelivery: "ambient" },
		);
		const sampler = await samplerReady.promise;

		sampler.append(`first ${emoji[0]}`);
		sampler.append(`${emoji[1]} batch\n`);
		vi.advanceTimersByTime(200);
		expect(recorder.seen.map(item => item.text)).toEqual([`first ${emoji} batch`]);

		sampler.append("second batch\n\n");
		vi.advanceTimersByTime(200);
		expect(recorder.seen.map(item => item.text)).toEqual([`first ${emoji} batch`, "second batch"]);
		expect(reportedLines.at(-1)?.streamProvenance).toEqual(progressStreamProvenanceForText(terminalSource));

		gate.resolve({ text: terminalText, terminalTextSource: terminalSource });
		await manager.waitForAll();

		const job = manager.getJob(jobId)!;
		expect(job.progressDeliveredCount).toBe(2);
		expect(job.completionLeftover).toBeUndefined();
		expect(job.terminalTextProvenance).toBe("progress");
	});

	test("keeps terminal text visible when watched progress gaps cumulative provenance", async () => {
		vi.useFakeTimers();
		const manager = new AsyncJobManager({});
		const recorder = recordingSink();
		const completions: string[] = [];
		manager.registerProgressSink("Main", recorder.sink);
		manager.registerDeliverySink("Main", (_jobId, text) => {
			completions.push(text);
		});
		const beforeWatchSource = "before watch\n";
		const watchedSource = `${beforeWatchSource}watched\n`;
		const terminalSource = `${watchedSource}after watch\n`;
		const terminalText = `${terminalSource}\nWall time: 1.23 seconds`;
		const gate = Promise.withResolvers<{ text: string; terminalTextSource: string }>();
		const started = Promise.withResolvers<(text: string, info?: AsyncJobProgressInfo) => void>();
		const jobId = manager.register(
			"bash",
			"watched cumulative progress",
			async ({ reportAgentProgress }) => {
				started.resolve(reportAgentProgress);
				return gate.promise;
			},
			{ ownerId: "Main", progressDelivery: "ambient" },
		);
		const report = await started.promise;

		report("before watch", {
			artifactId: "watched-cumulative-artifact",
			streamProvenance: progressStreamProvenanceForText(beforeWatchSource),
		});
		vi.advanceTimersByTime(200);
		await Promise.resolve();
		expect(recorder.seen.map(item => item.text)).toEqual(["before watch"]);

		manager.watchJobs([jobId]);
		report("watched", {
			artifactId: "watched-cumulative-artifact",
			streamProvenance: progressStreamProvenanceForText(watchedSource),
		});
		vi.advanceTimersByTime(200);
		expect(recorder.seen.map(item => item.text)).toEqual(["before watch"]);

		manager.unwatchJobs([jobId]);
		report("after watch", {
			artifactId: "watched-cumulative-artifact",
			streamProvenance: progressStreamProvenanceForText(terminalSource),
		});
		vi.advanceTimersByTime(200);
		expect(recorder.seen.map(item => item.text)).toEqual(["before watch", "after watch"]);
		await Promise.resolve();

		gate.resolve({ text: terminalText, terminalTextSource: terminalSource });
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		const job = manager.getJob(jobId)!;
		expect(job.progressDeliveredCount).toBe(2);
		expect(job.terminalTextProvenance).toBe("terminal");
		expect(completions).toEqual([terminalText]);
	});

	test("keeps terminal text visible after a rejected progress delivery", async () => {
		vi.useFakeTimers();
		const manager = new AsyncJobManager({});
		const completions: string[] = [];
		const delivered: string[] = [];
		let deliveryAttempt = 0;
		manager.registerProgressSink("Main", {
			deliver: async (_jobId, text) => {
				deliveryAttempt += 1;
				if (deliveryAttempt === 1) throw new Error("synthetic progress delivery failure");
				delivered.push(text);
			},
		});
		manager.registerDeliverySink("Main", (_jobId, text) => {
			completions.push(text);
		});
		const firstSource = "first\n";
		const terminalSource = `${firstSource}second\n`;
		const terminalText = `${terminalSource}\nWall time: 1.23 seconds`;
		const gate = Promise.withResolvers<{ text: string; terminalTextSource: string }>();
		const started = Promise.withResolvers<(text: string, info?: AsyncJobProgressInfo) => void>();
		const jobId = manager.register(
			"bash",
			"rejected cumulative progress",
			async ({ reportAgentProgress }) => {
				started.resolve(reportAgentProgress);
				return gate.promise;
			},
			{ ownerId: "Main", progressDelivery: "ambient" },
		);
		const report = await started.promise;

		report("first", {
			artifactId: "rejected-cumulative-artifact",
			streamProvenance: progressStreamProvenanceForText(firstSource),
		});
		vi.advanceTimersByTime(200);
		await Promise.resolve();
		report("second", {
			artifactId: "rejected-cumulative-artifact",
			streamProvenance: progressStreamProvenanceForText(terminalSource),
		});
		vi.advanceTimersByTime(200);
		await Promise.resolve();
		expect(delivered).toEqual(["second"]);

		gate.resolve({ text: terminalText, terminalTextSource: terminalSource });
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		const job = manager.getJob(jobId)!;
		expect(job.progressDeliveredCount).toBe(1);
		expect(job.terminalTextProvenance).toBe("terminal");
		expect(completions).toEqual([terminalText]);
	});

	test("carries upstream suppression metadata into the delivered batch", async () => {
		vi.useFakeTimers();
		const manager = new AsyncJobManager({});
		const recorder = recordingSink();
		manager.registerProgressSink("Main", recorder.sink);
		const gate = Promise.withResolvers<void>();
		const started = Promise.withResolvers<(text: string, info?: AsyncJobProgressInfo) => void>();
		const jobId = manager.register(
			"bash",
			"pre-limited",
			async ({ reportAgentProgress }) => {
				started.resolve(reportAgentProgress);
				await gate.promise;
				return "done";
			},
			{ ownerId: "Main", progressDelivery: "ambient" },
		);
		const report = await started.promise;

		// Upstream batches arrive already rate-limited (e.g. broker monitor
		// windows); their suppression metadata must survive merge and delivery.
		report("window a", { suppressedEvents: 4, reminder: "chatty-monitor" });
		report("window b", { suppressedEvents: 2 });
		vi.advanceTimersByTime(200);

		expect(recorder.seen).toEqual([
			{
				jobId,
				text: "window a\nwindow b",
				seq: 1,
				truncated: true,
				suppressedEvents: 6,
				reminder: "chatty-monitor",
			},
		]);

		gate.resolve();
		await manager.waitForAll();
	});

	test("settlement waits for an in-flight progress delivery before completing", async () => {
		const order: string[] = [];
		const manager = new AsyncJobManager({});
		const firstDelivered = Promise.withResolvers<void>();
		const secondStarted = Promise.withResolvers<void>();
		const releaseSecond = Promise.withResolvers<void>();
		manager.registerProgressSink("Main", {
			deliver: async (_jobId, text) => {
				if (text === "first") {
					order.push("progress:first");
					firstDelivered.resolve();
					return;
				}
				order.push("progress:second:start");
				secondStarted.resolve();
				await releaseSecond.promise;
				order.push("progress:second:end");
			},
		});
		manager.registerDeliverySink("Main", () => {
			order.push("completion");
		});
		const gate = Promise.withResolvers<void>();
		const started = Promise.withResolvers<(text: string, info?: AsyncJobProgressInfo) => void>();
		const jobId = manager.register(
			"bash",
			"in-flight",
			async ({ reportAgentProgress }) => {
				started.resolve(reportAgentProgress);
				await gate.promise;
				return "done";
			},
			{ ownerId: "Main", progressDelivery: "ambient" },
		);
		const report = await started.promise;

		report("first", { artifactId: "9" });
		await firstDelivered.promise;
		report("second", { artifactId: "9" });
		await secondStarted.promise;

		gate.resolve();
		// Settlement must block on the in-flight delivery tail: drain a bounded
		// run of microtasks (the settle path is promise-only) and confirm the
		// job has not settled and no completion raced past the held delivery.
		let settled = false;
		void manager.getJob(jobId)?.promise.then(() => {
			settled = true;
		});
		for (let i = 0; i < 20; i++) await Promise.resolve();
		expect(settled).toBe(false);
		expect(order).toEqual(["progress:first", "progress:second:start"]);

		releaseSecond.resolve();
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });
		expect(order).toEqual(["progress:first", "progress:second:start", "progress:second:end", "completion"]);
		expect(manager.getJob(jobId)?.completionLeftover).toBeUndefined();
	}, 10_000);

	test("cancellation wins while successful settlement drains final progress", async () => {
		const manager = new AsyncJobManager({});
		const progressStarted = Promise.withResolvers<void>();
		const releaseProgress = Promise.withResolvers<void>();
		const completions: string[] = [];
		manager.registerProgressSink("Main", {
			deliver: async () => {
				progressStarted.resolve();
				await releaseProgress.promise;
			},
		});
		manager.registerDeliverySink("Main", (_jobId, text) => {
			completions.push(text);
		});
		const jobId = manager.register(
			"bash",
			"cancel successful settlement",
			async ({ reportAgentProgress }) => {
				reportAgentProgress("final progress", { artifactId: "success-artifact" });
				return "successful terminal text";
			},
			{ ownerId: "Main", progressDelivery: "wake" },
		);

		// The sink starts only when the resolved run flushes final progress, so
		// this gate deterministically places cancel() inside the settlement await.
		await progressStarted.promise;
		expect(manager.getJob(jobId)?.status).toBe("running");
		expect(manager.cancel(jobId)).toBe(true);
		releaseProgress.resolve();
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		expect(manager.getJob(jobId)?.status).toBe("cancelled");
		expect(manager.getJob(jobId)?.resultText).toBe("successful terminal text");
		expect(completions).toEqual([]);
	});

	test("cancellation wins while failed settlement drains final progress", async () => {
		const manager = new AsyncJobManager({});
		const progressStarted = Promise.withResolvers<void>();
		const releaseProgress = Promise.withResolvers<void>();
		const completions: string[] = [];
		manager.registerProgressSink("Main", {
			deliver: async () => {
				progressStarted.resolve();
				await releaseProgress.promise;
			},
		});
		manager.registerDeliverySink("Main", (_jobId, text) => {
			completions.push(text);
		});
		const jobId = manager.register(
			"bash",
			"cancel failed settlement",
			async ({ reportAgentProgress }) => {
				reportAgentProgress("final progress", { artifactId: "failure-artifact" });
				throw new Error("failed terminal text");
			},
			{ ownerId: "Main", progressDelivery: "wake" },
		);

		// As above, the held sink proves the failure continuation is awaiting
		// final progress settlement when cancellation transitions the job.
		await progressStarted.promise;
		expect(manager.getJob(jobId)?.status).toBe("running");
		expect(manager.cancel(jobId)).toBe(true);
		releaseProgress.resolve();
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		expect(manager.getJob(jobId)?.status).toBe("cancelled");
		expect(manager.getJob(jobId)?.errorText).toBe("failed terminal text");
		expect(completions).toEqual([]);
	});
	test("reused public ids isolate queued progress and stale eviction by job generation", async () => {
		vi.useFakeTimers();
		const manager = new AsyncJobManager({ retentionMs: 0, maxRunningJobs: 2 });
		const oldFirstStarted = Promise.withResolvers<void>();
		const releaseOldFirst = Promise.withResolvers<void>();
		const delivered: string[] = [];
		manager.registerProgressSink("Main", {
			deliver: async (_jobId, text) => {
				delivered.push(text);
				if (text !== "old first") return;
				oldFirstStarted.resolve();
				await releaseOldFirst.promise;
			},
		});

		const oldGate = Promise.withResolvers<void>();
		const oldStarted = Promise.withResolvers<(text: string, info?: AsyncJobProgressInfo) => void>();
		const oldId = manager.register(
			"bash",
			"old generation",
			async ({ reportAgentProgress }) => {
				oldStarted.resolve(reportAgentProgress);
				await oldGate.promise;
				return "old result";
			},
			{ id: "reuse", ownerId: "Main", progressDelivery: "wake" },
		);
		const oldJob = manager.getJob(oldId);
		const reportOld = await oldStarted.promise;
		reportOld("old first");
		vi.advanceTimersByTime(200);
		await oldFirstStarted.promise;
		reportOld("old second");
		vi.advanceTimersByTime(200);

		expect(manager.cancel(oldId)).toBe(true);
		expect(manager.getJob(oldId)).toBeUndefined();

		const newGate = Promise.withResolvers<void>();
		const newStarted = Promise.withResolvers<(text: string, info?: AsyncJobProgressInfo) => void>();
		const newId = manager.register(
			"bash",
			"new generation",
			async ({ reportAgentProgress }) => {
				newStarted.resolve(reportAgentProgress);
				await newGate.promise;
				return { text: "new progress", terminalTextSource: "new progress" };
			},
			{ id: "reuse", ownerId: "Main", progressDelivery: "wake" },
		);
		expect(newId).toBe(oldId);
		const newJob = manager.getJob(newId);
		const reportNew = await newStarted.promise;
		reportNew("new progress");
		vi.advanceTimersByTime(200);
		for (let iteration = 0; iteration < 5; iteration++) await Promise.resolve();
		expect(delivered).toEqual(["old first", "new progress"]);

		releaseOldFirst.resolve();
		oldGate.resolve();
		await oldJob?.promise;
		for (let iteration = 0; iteration < 5; iteration++) await Promise.resolve();
		expect(delivered).toEqual(["old first", "new progress"]);
		expect(oldJob?.progressDeliveredCount).toBeUndefined();
		expect(manager.getJob(newId)).toBe(newJob);

		newGate.resolve();
		await newJob?.promise;
		expect(newJob?.status).toBe("completed");
		expect(newJob?.progressDeliveredCount).toBe(1);
		expect(newJob?.terminalTextProvenance).toBe("progress");
	});

	test("flushes a synchronous pre-registration progress report before failure completion", async () => {
		const manager = new AsyncJobManager({});
		const recorder = recordingSink();
		manager.registerProgressSink("Main", recorder.sink);
		const jobId = manager.register(
			"bash",
			"synchronous failure",
			({ reportAgentProgress }) => {
				reportAgentProgress("reported before throw");
				throw new Error("synchronous failure");
			},
			{ ownerId: "Main", progressDelivery: "wake" },
		);

		await manager.waitForAll();
		expect(recorder.seen.map(item => item.text)).toEqual(["reported before throw"]);
		expect(manager.getJob(jobId)).toMatchObject({
			status: "failed",
			errorText: "synchronous failure",
			progressDeliveredCount: 1,
		});
	});

	test("progress settlement failures preserve successful and failed executor outcomes", async () => {
		const finish = vi.spyOn(ProgressBatcher.prototype, "finish");
		const successfulManager = new AsyncJobManager({});
		successfulManager.registerProgressSink("Main", { deliver: () => {} });
		finish.mockRejectedValueOnce(new Error("flush failed"));
		const successfulId = successfulManager.register(
			"bash",
			"successful settlement",
			async ({ reportAgentProgress }) => {
				reportAgentProgress("progress");
				return "executor result";
			},
			{ ownerId: "Main", progressDelivery: "wake" },
		);

		await successfulManager.waitForAll();
		expect(successfulManager.getJob(successfulId)).toMatchObject({
			status: "completed",
			resultText: "executor result",
			terminalTextProvenance: "terminal",
		});

		const failedManager = new AsyncJobManager({});
		failedManager.registerProgressSink("Main", { deliver: () => {} });
		finish.mockRejectedValueOnce(new Error("flush failed"));
		const failedId = failedManager.register(
			"bash",
			"failed settlement",
			async ({ reportAgentProgress }) => {
				reportAgentProgress("progress");
				throw new Error("executor failure");
			},
			{ ownerId: "Main", progressDelivery: "wake" },
		);

		await failedManager.waitForAll();
		expect(failedManager.getJob(failedId)).toMatchObject({
			status: "failed",
			errorText: "executor failure",
			terminalTextProvenance: "terminal",
		});
	});
});
