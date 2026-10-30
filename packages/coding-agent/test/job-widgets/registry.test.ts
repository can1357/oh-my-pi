import { afterEach, describe, expect, it } from "bun:test";
import { AsyncJobManager, type AsyncJob } from "../../src/async/job-manager";
import { type JobWidgetAuthorRequest, JobWidgets, TextTap } from "../../src/job-widgets";

const REQ_SPEC = {
	title: "load test",
	rules: [{ from: "out", match: String.raw`^req \d+ rps=(?P<rps>[\d.]+)` }],
	blocks: [{ kind: "spark", field: "rps", label: "req/s" }],
	headline: { field: "rps", agg: "last", unit: "req/s" },
};

const STEP_SPEC = {
	title: "training",
	rules: [{ from: "out", match: String.raw`^step \d+ loss=(?P<loss>[\d.]+)` }],
	blocks: [{ kind: "spark", field: "loss", label: "loss" }],
	headline: { field: "loss", agg: "last" },
};

interface AuthorCall {
	request: JobWidgetAuthorRequest;
	answer: PromiseWithResolvers<unknown>;
}

/** An author whose answers the test hands out one call at a time. */
function scriptedAuthor() {
	const calls: AuthorCall[] = [];
	const author = (request: JobWidgetAuthorRequest): Promise<unknown> => {
		const answer = Promise.withResolvers<unknown>();
		calls.push({ request: structuredClone(request), answer });
		return answer.promise;
	};
	return { calls, author };
}

/** Lets the registry's awaited author promise settle and its follow-up run. */
async function settle(): Promise<void> {
	for (let round = 0; round < 5; round++) await Promise.resolve();
}

const managers: AsyncJobManager[] = [];

afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.dispose({ timeoutMs: 500 });
});

function startJob(manager: AsyncJobManager, label: string) {
	const tap = new TextTap("out", "stdout+stderr");
	const done = Promise.withResolvers<string>();
	const run = ({ signal }: { signal: AbortSignal }) => {
		signal.addEventListener("abort", () => done.resolve("cancelled"), { once: true });
		return done.promise;
	};
	const id = manager.register("bash", label, run, {
		widgetInputs: { sources: () => [tap], brief: () => ({ kind: "bash", command: label }) },
	});
	const job = manager.getJob(id) as AsyncJob;
	return { job, tap, finish: () => done.resolve("ok") };
}

/** A subagent's job whose `watch` hint the test sets, reading its `tools` tap. */
function startTask(manager: AsyncJobManager, id: string) {
	const tools = new TextTap("tools", "subagent tool calls");
	const brief: { watch?: string } = {};
	const done = Promise.withResolvers<string>();
	manager.register("task", id, () => done.promise, {
		id,
		widgetInputs: { sources: () => [tools], brief: () => ({ kind: "task", task: "tune decode", ...brief }) },
	});
	return { job: manager.getJob(id) as AsyncJob, tools, brief };
}

function setup(options: { maxInFlight?: number; enabled?: () => boolean; refreshMs?: number } = {}) {
	const manager = new AsyncJobManager({});
	managers.push(manager);
	// Jobs stamp their start with the real clock; the registry's clock runs ahead of it on demand.
	let offset = 0;
	const { calls, author } = scriptedAuthor();
	const widgets = new JobWidgets({ author, now: () => Date.now() + offset, minIngestMs: 0, ...options });
	return {
		manager,
		widgets,
		calls,
		advance(ms: number) {
			offset += ms;
		},
	};
}

describe("job widget registry", () => {
	it("aborts an in-flight spec request when widgets are disabled", async () => {
		let enabled = true;
		const signals: AbortSignal[] = [];
		const answers: PromiseWithResolvers<unknown>[] = [];
		const manager = new AsyncJobManager({});
		managers.push(manager);
		const widgets = new JobWidgets({
			enabled: () => enabled,
			authorAfterMs: 0,
			minIngestMs: 0,
			author: (_request, signal) => {
				const answer = Promise.withResolvers<unknown>();
				answers.push(answer);
				signals.push(signal);
				return answer.promise;
			},
		});
		const { job, tap } = startJob(manager, "bench");
		tap.append("req 1 rps=40\nreq 2 rps=48\nreq 3 rps=52\n");
		widgets.view(job);
		expect(signals).toHaveLength(1);

		enabled = false;
		expect(widgets.view(job)).toBeUndefined();
		expect(signals[0]?.aborted).toBe(true);
		answers[0]?.resolve(REQ_SPEC);
		await settle();
		enabled = true;
		expect(widgets.view(job)?.state).toBe("authoring");
		expect(signals).toHaveLength(2);
		answers[1]?.resolve({ skip: "no metric to chart" });
		await settle();
		expect(widgets.view(job)?.state).toBe("fallback");
	});

	it("retries a rejected spec once per attempt with the errors, and stops after three attempts", async () => {
		const { manager, widgets, calls, advance } = setup();
		const { job, tap } = startJob(manager, "bench");
		tap.append("req 1 rps=40\nreq 2 rps=48\nreq 3 rps=52\n");
		advance(15_000);
		const bad = { ...REQ_SPEC, blocks: [{ kind: "text", field: "phase" }] };
		for (let attempt = 0; attempt < 3; attempt++) {
			widgets.view(job);
			calls.at(-1)?.answer.resolve(bad);
			await settle();
			// The retry carries what was wrong with the first answer.
			expect(calls.at(-1)?.request.rejected?.errors).toEqual([
				'blocks[0] (text): unknown field "phase"; no rule has a group (?P<phase>…) or count "phase"',
			]);
			calls.at(-1)?.answer.resolve(bad);
			await settle();
		}
		expect(calls).toHaveLength(6);
		advance(60_000);
		expect(widgets.view(job)?.state).toBe("fallback");
		expect(calls).toHaveLength(6);
	});

	it("never asks again once the author declines a command's widget", async () => {
		const { manager, widgets, calls, advance } = setup();
		const { job, tap } = startJob(manager, "npm install");
		tap.append("added 12 packages\nadded 40 packages\naudited 812 packages\n");
		advance(15_000);
		widgets.view(job);
		calls[0].answer.resolve({ skip: "install log, no quantity to chart" });
		await settle();
		tap.append("found 0 vulnerabilities\n");
		advance(600_000);
		expect(widgets.view(job)?.state).toBe("fallback");
		expect(calls).toHaveLength(1);
	});

	it("asks for a subagent's widget only once it says what to watch, and again when that changes", async () => {
		const { manager, widgets, calls, advance } = setup();
		const { job, tools, brief } = startTask(manager, "Tuner");
		tools.append("» read src/decode.rs\n34:};\n» bash run the bench\nBENCH tok_s=162\n");
		advance(120_000);
		widgets.view(job);
		// Without a word from the subagent its tool results are file contents, not progress.
		expect(calls).toHaveLength(0);

		brief.watch = "the result of grep TODO";
		widgets.view(job);
		expect(calls[0].request.brief.watch).toBe("the result of grep TODO");
		calls[0].answer.resolve({ skip: "a search result is no progress" });
		await settle();
		widgets.view(job);
		expect(calls).toHaveLength(1);

		brief.watch = "BENCH lines, tok_s higher is better";
		widgets.view(job);
		expect(calls).toHaveLength(2);
	});

	it("keeps at most two spec requests in flight across jobs", () => {
		const { manager, widgets, calls, advance } = setup();
		const jobs = ["a", "b", "c"].map(label => startJob(manager, label));
		for (const { tap } of jobs) tap.append("one\ntwo\nthree\n");
		advance(15_000);
		for (const { job } of jobs) widgets.view(job);
		expect(calls.map(call => call.request.brief.command)).toEqual(["a", "b"]);
	});

	it("re-authors when the output stops matching and the data goes stale", async () => {
		const { manager, widgets, calls, advance } = setup();
		const { job, tap } = startJob(manager, "pipeline");
		tap.append("req 1 rps=40\nreq 2 rps=48\nreq 3 rps=52\n");
		advance(15_000);
		widgets.view(job);
		calls[0].answer.resolve(REQ_SPEC);
		await settle();
		expect(widgets.view(job)?.title).toBe("load test");

		// The job moves on to a phase the spec does not describe.
		for (let step = 1; step <= 199; step++) tap.append(`step ${step} loss=${(2 / step).toFixed(3)}\n`);
		advance(120_000);
		widgets.view(job);
		expect(calls).toHaveLength(1);
		tap.append("step 200 loss=0.010\n");
		widgets.view(job);
		expect(calls).toHaveLength(2);
		expect(calls[1].request.previous?.reason).toBe("no rule matched the last 200 lines");
		// While the replacement is written, the old spec keeps drawing.
		expect(widgets.view(job)?.state).toBe("live");

		calls[1].answer.resolve(STEP_SPEC);
		await settle();
		expect(widgets.view(job)).toMatchObject({ title: "training", headline: { text: "0.01" } });
	});

	describe("specs matching unrelated lines", () => {
		const GRID_SPEC = {
			title: "PR checks",
			rules: [{ from: "out", match: String.raw`^(?P<name>\S+)\s+(?P<status>\S+)`, key: "name", text: "status" }],
			blocks: [{ kind: "grid", field: "status", label: "checks", tones: { pass: "success", pending: "pending" } }],
		};
		const checks = (count: number) =>
			Array.from({ length: count }, (_, index) => `job${index % 4} ${index % 2 ? "pass" : "pending"}\n`).join("");
		const prose = (count: number) =>
			Array.from({ length: count }, (_, index) => `Rule${index} should hold for every module\n`).join("");

		it("sends back a spec whose rules fit the samples but not the whole output", async () => {
			const { manager, widgets, calls, advance } = setup();
			const { job, tap } = startJob(manager, "gh pr checks --watch");
			// The author sees the first 30 and the last 60 lines; the prose between them it never sees.
			tap.append(`${checks(30)}${prose(60)}${checks(60)}`);
			advance(15_000);
			widgets.view(job);
			calls[0].answer.resolve(GRID_SPEC);
			await settle();
			expect(calls).toHaveLength(2);
			expect(calls[1].request.rejected?.errors).toEqual([
				'field "status": split into 64 keys, more than the 48 it may draw; its key group captures words of lines that carry no data, so anchor the rule on the literal text of the lines that do',
				'blocks[0] (grid): 60 of 64 cells carry no status its tones name ("should", "should", "should"); capture the status word of status lines and name each status in `tones`',
			]);
			expect(widgets.view(job)?.state).toBe("authoring");
		});

		it("drops a live spec once new output makes it draw unrelated lines, and asks again with why", async () => {
			const { manager, widgets, calls, advance } = setup();
			const { job, tap } = startJob(manager, "gh pr checks --watch");
			tap.append(checks(8));
			advance(15_000);
			widgets.view(job);
			calls[0].answer.resolve(GRID_SPEC);
			await settle();
			expect(widgets.view(job)?.state).toBe("live");

			tap.append(prose(5));
			const view = widgets.view(job);
			expect(view?.blocks.some(entry => entry.kind === "grid")).toBe(false);
			expect(calls).toHaveLength(2);
			const rejected = calls[1].request.rejected;
			expect(JSON.parse(rejected?.answer ?? "null")).toEqual(GRID_SPEC);
			expect(rejected?.errors).toEqual([
				'blocks[0] (grid): 5 of 9 cells carry no status its tones name ("should", "should", "should"); capture the status word of status lines and name each status in `tones`',
			]);
		});
	});

	it("freezes a settled job's view after a final read and pushes changes to subscribers", async () => {
		const manager = new AsyncJobManager({});
		managers.push(manager);
		const widgets = new JobWidgets({ refreshMs: 10, minIngestMs: 0 });
		const { job, tap, finish } = startJob(manager, "build");
		widgets.view(job);
		const pushed = Promise.withResolvers<void>();
		const unsubscribe = widgets.subscribe(() => pushed.resolve());
		tap.append("compiling a\n");
		// The background refresh notices the new line without anyone calling view().
		await pushed.promise;
		expect(widgets.view(job)?.stage).toBe("compiling a");

		// A line still in progress when the job ends is flushed by the final read.
		tap.append("linked");
		finish();
		await job.promise;
		const frozen = widgets.view(job);
		expect(frozen?.stage).toBe("linked");
		tap.append("\nlate\n");
		expect(widgets.view(job)).toBe(frozen);
		unsubscribe();
	});
});
