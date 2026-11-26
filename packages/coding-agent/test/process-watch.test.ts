import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { type Judge, type JudgmentRequest, type JudgmentResult, tokenUsage } from "@oh-my-pi/pi-ai";
import type { AsyncJob } from "@oh-my-pi/pi-coding-agent/async";
import type { HostPressure } from "@oh-my-pi/pi-coding-agent/async/host-pressure";
import { ProcessWatch, registerProcessWatchDelivery } from "@oh-my-pi/pi-coding-agent/async/process-watch";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { YieldQueue } from "@oh-my-pi/pi-coding-agent/session/yield-queue";
import { PROCESS_WATCH_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/transcript/messages";

type Probabilities = Record<string, number>;

/** A judge answering for the jobs `running()` lists, as `answer(jobId)` says; records every request. */
class FakeJudge implements Judge {
	readonly label = "fake/judge";
	readonly requests: JudgmentRequest[] = [];
	answer: (jobId: string) => Probabilities = () => ({ progressing: 1 });
	/** Replaces the well-formed answer for a job when it returns one, as a judge past its type check might. */
	raw: (jobId: string) => unknown = () => undefined;
	fail = false;
	/** Never answers and ignores its abort signal, like a provider that hangs. */
	hang = false;

	constructor(readonly running: () => AsyncJob[]) {}

	async judge<Q extends JudgmentRequest["questions"]>(request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> {
		this.requests.push(request);
		if (this.fail) throw new Error("judge unavailable");
		if (this.hang) return Promise.withResolvers<JudgmentResult<Q>>().promise;
		const answers: Record<string, unknown> = {};
		for (const [i, running] of this.running().entries()) {
			const raw = this.raw(running.id);
			if (raw !== undefined) {
				answers[`p${i}`] = raw;
				continue;
			}
			const probabilities = this.answer(running.id);
			const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]![0];
			answers[`p${i}`] = { type: "choice", choice, probabilities, confidence: 1 };
		}
		return {
			api: "fake",
			provider: "fake",
			model: "judge",
			answers: answers as JudgmentResult<Q>["answers"],
			usage: tokenUsage(0, 0),
		};
	}
}

function job(id: string, command: string, output?: string): AsyncJob {
	const now = Date.now();
	return {
		id,
		type: "bash",
		status: "running",
		startTime: now,
		label: command,
		abortController: new AbortController(),
		promise: Promise.resolve(),
		process: { command, cwd: "/repo", pids: () => [] },
		...(output === undefined ? {} : { progressText: output, lastProgressAt: now }),
	};
}

/** Lets a look's judgment settle and the watch re-arm. */
async function flush(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

async function advance(seconds: number): Promise<void> {
	vi.advanceTimersByTime(seconds * 1000);
	await flush();
}

function drain(queue: YieldQueue): AgentMessage[] {
	return queue
		.drainLazy()
		.map(thunk => thunk())
		.filter((message): message is AgentMessage => message !== null);
}

describe("ProcessWatch", () => {
	let jobs: AsyncJob[];
	let judge: FakeJudge;
	let queue: YieldQueue;
	let watch: ProcessWatch;

	function start(overrides: Record<string, unknown> = {}, host?: HostPressure): void {
		const settings = Settings.isolated({ "async.processWatch.enabled": true, ...overrides });
		queue = new YieldQueue({
			isStreaming: () => true,
			injectIdle: async () => {},
			scheduleIdleFlush: () => {},
		});
		watch = new ProcessWatch({
			settings,
			runningJobs: () => jobs,
			judge: () => judge,
			recent: () => [{ role: "user", text: "run the integration suite" }],
			...(host ? { hostPressure: async () => host } : {}),
			notify: registerProcessWatchDelivery(queue, jobId => jobs.some(j => j.id === jobId)),
		});
		watch.poke();
	}

	beforeEach(() => {
		vi.useFakeTimers();
		jobs = [];
		judge = new FakeJudge(() => jobs);
	});

	afterEach(() => {
		watch?.dispose();
		vi.useRealTimers();
	});

	it("looks at each configured age, then at the repeat interval, with one ask covering every running job", async () => {
		jobs = [job("bg1", "bun test"), job("bg2", "bun run dev")];
		start({ "async.processWatch.schedule": [10, 20], "async.processWatch.everySeconds": 100 });

		await advance(9);
		expect(judge.requests).toHaveLength(0);
		await advance(1);
		expect(judge.requests).toHaveLength(1);
		expect(Object.keys(judge.requests[0]!.questions)).toEqual(["p0", "p1"]);
		await advance(10);
		expect(judge.requests).toHaveLength(2);
		await advance(99);
		expect(judge.requests).toHaveLength(2);
		await advance(1);
		expect(judge.requests).toHaveLength(3);
		await advance(100);
		expect(judge.requests).toHaveLength(4);
	});

	it("tells the agent once, at the next turn boundary, about a job judged stalled above the threshold", async () => {
		jobs = [job("bg1", "npm install", "fetching metadata"), job("bg2", "bun test", "12 pass")];
		judge.answer = id => (id === "bg1" ? { stalled: 0.7, progressing: 0.3 } : { progressing: 0.9, stalled: 0.1 });
		start();

		await advance(30);
		const messages = drain(queue);
		expect(messages).toHaveLength(1);
		const message = messages[0]!;
		expect(message.role === "custom" && message.customType).toBe(PROCESS_WATCH_MESSAGE_TYPE);
		const text = message.role === "custom" && typeof message.content === "string" ? message.content : "";
		expect(text).toContain("bg1");
		expect(text).toContain("looks stalled");
		expect(text).toContain("fetching metadata");
		expect(text).not.toContain("bg2");
		expect(drain(queue)).toHaveLength(0);
	});

	it("keeps only the latest look's notice when an earlier one was not delivered yet", async () => {
		jobs = [job("bg1", "bun run dev")];
		judge.answer = () => ({ stalled: 0.8, unclear: 0.2 });
		start();
		await advance(30);
		judge.answer = () => ({ ready: 0.9, unclear: 0.1 });
		await advance(30);

		const messages = drain(queue);
		expect(messages).toHaveLength(1);
		const text = messages[0]!.role === "custom" ? String(messages[0]!.content) : "";
		expect(text).toContain("looks up and ready");
		expect(text).not.toContain("looks stalled");
	});

	it("says nothing when the flagged share stays below the threshold", async () => {
		jobs = [job("bg1", "cargo build")];
		judge.answer = () => ({ stalled: 0.3, failing: 0.2, progressing: 0.5 });
		start();

		await advance(30);
		expect(judge.requests).toHaveLength(1);
		expect(drain(queue)).toHaveLength(0);
	});

	it("shows the judge the host snapshot and names host strain in a stall notice", async () => {
		const gib = 1024 ** 3;
		jobs = [job("bg1", "cargo build --release", "Compiling serde v1.0")];
		judge.answer = () => ({ stalled: 0.8, progressing: 0.2 });
		start(
			{},
			{
				cpu: { some: { avg10: 4, avg60: 3 } },
				memory: { some: { avg10: 40, avg60: 35 }, full: { avg10: 20, avg60: 15 } },
				io: { some: { avg10: 1, avg60: 1 } },
				memTotalBytes: 16 * gib,
				memAvailableBytes: 0.5 * gib,
				swapTotalBytes: 0,
				swapFreeBytes: 0,
				diskTotalBytes: 200 * gib,
				diskFreeBytes: 120 * gib,
			},
		);

		await advance(30);
		const state = judge.requests[0]!.state;
		const host = typeof state === "object" && !Array.isArray(state) && "host" in state ? state.host : undefined;
		expect(host).toEqual({
			psi: {
				cpu: { some10: 4, some60: 3 },
				memory: { some10: 40, some60: 35, full10: 20, full60: 15 },
				io: { some10: 1, some60: 1 },
			},
			memory_gib: { available: 0.5, total: 16 },
			swap_gib: { used: 0, total: 0 },
			disk_gib: { free: 120, total: 200 },
		});
		const messages = drain(queue);
		const text = messages[0]?.role === "custom" ? String(messages[0].content) : "";
		expect(text).toContain("The host shows memory pressure");
		expect(text).toContain("moving heavy work off this host");
	});

	it("honors a configured threshold", async () => {
		jobs = [job("bg1", "cargo build")];
		judge.answer = () => ({ stalled: 0.3, failing: 0.2, progressing: 0.5 });
		start({ "async.processWatch.threshold": 0.5 });

		await advance(30);
		expect(drain(queue)).toHaveLength(1);
	});

	it("names a job by id only in the question text, leaving its command to the redacted state", async () => {
		jobs = [job("bg1", "curl -H 'Authorization: Bearer secret-token' https://example.com")];
		start();

		await advance(30);
		const request = judge.requests[0]!;
		const question = request.questions.p0!;
		expect(question.instructions).toContain("bg1");
		expect(question.instructions).not.toContain("secret-token");
		expect(JSON.stringify(request.state)).toContain("secret-token");
	});

	it("skips a choice answer with no probabilities and still judges the other jobs", async () => {
		jobs = [job("bg1", "npm install"), job("bg2", "bun test")];
		judge.raw = id => (id === "bg1" ? { type: "choice", choice: "stalled", confidence: 1 } : undefined);
		judge.answer = () => ({ stalled: 0.9, progressing: 0.1 });
		start();

		await advance(30);
		const messages = drain(queue);
		expect(messages).toHaveLength(1);
		const text = messages[0]!.role === "custom" ? String(messages[0]!.content) : "";
		expect(text).toContain("bg2");
		expect(text).not.toContain("bg1");
	});

	it("skips a choice answer whose probabilities fall outside 0..1 or name no verdict", async () => {
		jobs = [job("bg1", "cargo build"), job("bg2", "make"), job("bg3", "bun test")];
		judge.raw = id =>
			id === "bg1"
				? { type: "choice", choice: "failing", probabilities: { failing: 2, progressing: -1 }, confidence: 1 }
				: id === "bg2"
					? { type: "choice", choice: "stalled", probabilities: { stalled: 0.7, bogus: 0.3 }, confidence: 1 }
					: undefined;
		judge.answer = () => ({ progressing: 0.9, stalled: 0.1 });
		start();

		await advance(30);
		expect(judge.requests).toHaveLength(1);
		expect(drain(queue)).toHaveLength(0);
	});

	it("stops watching a job once it finishes and drops its pending notice", async () => {
		jobs = [job("bg1", "sleep 100")];
		judge.answer = () => ({ stalled: 1 });
		start();

		await advance(30);
		expect(judge.requests).toHaveLength(1);
		jobs = [];
		await advance(30);
		expect(judge.requests).toHaveLength(1);
		expect(drain(queue)).toHaveLength(0);
	});

	it("withdraws an undelivered notice when the next look finds the job healthy", async () => {
		jobs = [job("bg1", "npm install", "fetching metadata")];
		judge.answer = () => ({ stalled: 0.9, progressing: 0.1 });
		start();
		await advance(30);
		judge.answer = () => ({ progressing: 0.9, stalled: 0.1 });
		await advance(30);

		expect(judge.requests).toHaveLength(2);
		expect(drain(queue)).toHaveLength(0);
	});

	it("bounds a look whose judge never answers and keeps looking on schedule", async () => {
		jobs = [job("bg1", "sleep 1000")];
		judge.hang = true;
		start();

		await advance(30);
		expect(judge.requests).toHaveLength(1);
		// The hung look times out 30 s later; its looks due by then count as come.
		await advance(30);
		judge.hang = false;
		judge.answer = () => ({ stalled: 1 });
		await advance(59);
		expect(judge.requests).toHaveLength(1);
		await advance(1);
		expect(judge.requests).toHaveLength(2);
		expect(drain(queue)).toHaveLength(1);
	});

	it("keeps the schedule of a job that started while a look was in flight", async () => {
		jobs = [job("bg1", "sleep 1000")];
		judge.hang = true;
		start();

		await advance(30);
		expect(judge.requests).toHaveLength(1);
		judge.hang = false;
		await advance(2);
		jobs = [...jobs, job("bg2", "bun test")];
		// The hung look times out with bg2 28 s old: its first look is still due at 30 s.
		await advance(28);
		expect(judge.requests).toHaveLength(1);
		await advance(2);
		expect(judge.requests).toHaveLength(2);
		expect(Object.keys(judge.requests[1]!.questions)).toEqual(["p0", "p1"]);
	});

	it("fails open: a judge error produces no notice and the next look still happens", async () => {
		jobs = [job("bg1", "sleep 100")];
		judge.fail = true;
		start();

		await advance(30);
		expect(judge.requests).toHaveLength(1);
		expect(drain(queue)).toHaveLength(0);
		await advance(30);
		expect(judge.requests).toHaveLength(2);
		expect(drain(queue)).toHaveLength(0);
	});

	it("asks nothing while the setting is off", async () => {
		jobs = [job("bg1", "sleep 100")];
		start({ "async.processWatch.enabled": false });

		await advance(120);
		expect(judge.requests).toHaveLength(0);
	});
});

describe("registerProcessWatchDelivery", () => {
	it("waits for the agent's next turn boundary instead of starting a turn between runs", () => {
		let idleFlushes = 0;
		const queue = new YieldQueue({
			isStreaming: () => false,
			injectIdle: async () => {},
			scheduleIdleFlush: () => {
				idleFlushes++;
			},
		});
		const notify = registerProcessWatchDelivery(queue, () => true);
		notify({ jobs: [{ jobId: "bg1", command: "bun run dev", ageMs: 60_000, verdict: "stalled" }] });
		queue.requestIdleFlush();

		expect(idleFlushes).toBe(0);
		// Still pending for the next boundary, and visible to `wait`.
		expect(queue.hasDeliverable(PROCESS_WATCH_MESSAGE_TYPE)).toBe(true);
		expect(drain(queue)).toHaveLength(1);
	});
});
