import { describe, expect, it } from "bun:test";
import type { JobWidgetBlock, JobWidgetView } from "@oh-my-pi/pi-tui/tools/job-widget";
import {
	JobWidgetRuntime,
	type JobTextChunk,
	type JobTextSource,
	type JobWidgetSpec,
	type JobWidgetViewContext,
	validateJobWidgetSpec,
} from "../../src/job-widgets";

/** A source whose retained text and dropped prefix the test controls. */
class ScriptedSource implements JobTextSource {
	#text = "";
	#dropped = 0;
	open = true;

	constructor(
		readonly id: string,
		readonly label = id,
	) {}

	append(text: string): void {
		this.#text += text;
	}

	/** Forget the oldest `count` units, as a bounded tap or pipe does. */
	drop(count: number): void {
		this.#dropped += count;
		this.#text = this.#text.slice(count);
	}

	/** Retained units up to the end of the last `marker`. */
	offsetAfter(marker: string): number {
		return this.#text.lastIndexOf(marker) + marker.length;
	}

	read(from: number): JobTextChunk {
		const start = Math.max(from, this.#dropped);
		return {
			start,
			end: this.#dropped + this.#text.length,
			text: this.#text.slice(start - this.#dropped),
			open: this.open,
		};
	}
}

const START = 1_000_000;

function harness(spec: JobWidgetSpec | undefined, ...sources: ScriptedSource[]) {
	let now = START;
	const runtime = new JobWidgetRuntime(spec, START, () => now);
	return {
		runtime,
		advance(ms: number) {
			now += ms;
		},
		ingest(flush = false) {
			runtime.ingest(sources, flush);
		},
		/** The view of a command's job (its newest line may stand for the stage), or with `context`'s overrides. */
		view(context: Partial<JobWidgetViewContext> = {}): JobWidgetView {
			return runtime.view({ label: "bench job", lineStage: true, authoring: false, ...context });
		},
	};
}

function block<K extends JobWidgetBlock["kind"]>(view: JobWidgetView, kind: K): Extract<JobWidgetBlock, { kind: K }> {
	const found = view.blocks.find(candidate => candidate.kind === kind);
	if (!found) throw new Error(`no ${kind} block in ${JSON.stringify(view)}`);
	return found as Extract<JobWidgetBlock, { kind: K }>;
}

function validSpec(value: unknown): JobWidgetSpec {
	const checked = validateJobWidgetSpec(value);
	if (!checked.ok) throw new Error(checked.errors.join("\n"));
	return checked.spec;
}

describe("job widget derivation", () => {
	it("turns throughput lines into a spark with a target mark and a trending headline", () => {
		const spec = validSpec({
			title: "load test",
			rules: [{ from: "pipe:*", match: String.raw`^req \d+ rps=(?P<rps>[\d.]+)` }],
			blocks: [{ kind: "spark", field: "rps", label: "req/s", unit: "req/s", better: "higher", target: 60 }],
			headline: { field: "rps", agg: "last", unit: "req/s", better: "higher" },
		});
		const pipe = new ScriptedSource("pipe:1", "bench → tail -n 5");
		const out = new ScriptedSource("out");
		const h = harness(spec, pipe, out);
		pipe.append("warming up\nreq 1 rps=40\nreq 2 rps=48\n");
		// Rules read only pipes: the same line on `out` must not count twice.
		out.append("req 9 rps=999\n");
		h.ingest();
		pipe.append("req 8 rps=56\n");
		h.ingest();

		const view = h.view();
		expect(view.state).toBe("live");
		expect(view.headline).toEqual({ text: "56 req/s", trend: { text: "▲ 40%", tone: "success" } });
		const spark = block(view, "spark");
		expect(spark.values).toEqual([40, 48, 56]);
		expect(spark.last).toBe("56 req/s");
		expect(spark.marks).toEqual([{ value: 60, label: "target 60 req/s", tone: "muted" }]);
		// The domain covers the target the series has not reached yet, padded by 10% of the 40–60 range.
		expect(spark.min).toBeCloseTo(38);
		expect(spark.max).toBeCloseTo(62);
		// Without a stage rule, the stage is the newest line of the rules' sources no rule matched:
		// data lines would only repeat the blocks.
		expect(view.stage).toBe("warming up");
	});

	it("fits the spark's domain to the data so a narrow band of high values still shows its movement", () => {
		const sparkSpec = (bounds: { min?: number; max?: number } = {}) =>
			validSpec({
				title: "decode",
				rules: [{ from: "out", match: String.raw`tok=(?P<tok>[\d.]+)` }],
				blocks: [{ kind: "spark", field: "tok", label: "tok/s", ...bounds }],
			});
		const domain = (spec: JobWidgetSpec, lines: string) => {
			const out = new ScriptedSource("out");
			const h = harness(spec, out);
			out.append(lines);
			h.ingest();
			const { min, max } = block(h.view(), "spark");
			return [min, max];
		};
		// 160–186 tok/s: not 0–186, which would draw nearly equal columns.
		const [min, max] = domain(sparkSpec(), "tok=160\ntok=172\ntok=186\n");
		expect(min).toBeCloseTo(157.4);
		expect(max).toBeCloseTo(188.6);
		// A flat series pads by at least 1, and a non-negative series never dips below 0.
		expect(domain(sparkSpec(), "tok=0.4\ntok=0.4\n")).toEqual([0, 1.4]);
		// The spec's own bounds win.
		expect(domain(sparkSpec({ min: 0, max: 200 }), "tok=160\ntok=186\n")).toEqual([0, 200]);
	});

	it("reads BENCH lines into a headline and a lower-is-better latency stat", () => {
		const match = String.raw`^BENCH precision=(?P<prec>\S+) batch=(?P<batch>\d+) .*ms_per_step=(?P<ms>[\d.]+) tok_s_stream=(?P<tok>[\d.]+)`;
		const spec = validSpec({
			title: "decode bench",
			// One rule reads every number of the line into its own field.
			rules: [{ from: "out", match, key: "prec" }],
			blocks: [{ kind: "stat", items: [{ field: "ms", agg: "last", label: "step", unit: "ms", better: "lower" }] }],
			headline: { field: "tok", agg: "last", unit: "tok/s", key: "nvfp4" },
		});
		const out = new ScriptedSource("out");
		const h = harness(spec, out);
		out.append(
			[
				"BENCH precision=nvfp4 batch=1 seq=4096 warmup=3 ms_per_step=6.120 tok_s_stream=163.4",
				"BENCH precision=bf16 batch=1 seq=4096 warmup=3 ms_per_step=9.800 tok_s_stream=102.0",
				"BENCH precision=nvfp4 batch=1 seq=4096 warmup=3 ms_per_step=5.370 tok_s_stream=186.2",
				"",
			].join("\n"),
		);
		h.ingest();
		const view = h.view();
		// The keyed headline follows nvfp4 only, not bf16's later-but-slower line.
		expect(view.headline?.text).toBe("186 tok/s");
		// Every line was data: no stage line.
		expect(view.stage).toBeUndefined();
		// Across keys the latest step time is the last line's, and it fell from the first: progress.
		expect(block(view, "stat").items).toEqual([
			{ label: "step", text: "5.37 ms", trend: { text: "▼ 12%", tone: "success" } },
		]);
	});

	it("draws per-model eval results as bars and counts trials toward a total", () => {
		const finish = String.raw`^finish \S+ (?P<model>\S+) t\d+: reward=(?P<reward>[\d.]+) tests=(?P<passed>\d+)/(?P<all>\d+)`;
		const spec = validSpec({
			title: "eval · tests passed",
			rules: [{ from: "out", match: finish, key: "model", count: "trials" }],
			blocks: [
				{ kind: "bars", field: "passed", agg: "mean", label: "tests passed", max: 36, better: "higher" },
				{ kind: "meter", field: "trials", agg: "count", total: 9, label: "trials", unit: "trials" },
			],
		});
		const out = new ScriptedSource("out");
		const h = harness(spec, out);
		out.append(
			[
				"start bash openai-codex/gpt-6-luna t1",
				"finish bash openai-codex/gpt-6-luna t1: reward=1 tests=36/36 stop=done turns=7 52s",
				"finish bash anthropic/claude-sonnet-5 t1: reward=0 tests=20/36 stop=done turns=9 61s",
				"finish bash openai-codex/gpt-6-luna t2: reward=0 tests=27/36 stop=done turns=5 39s",
				"finish bash anthropic/claude-sonnet-5 t2: reward=1 tests=36/36 stop=done turns=8 47s",
				"",
			].join("\n"),
		);
		h.ingest();
		const view = h.view();
		expect(block(view, "bars")).toEqual({
			kind: "bars",
			label: "tests passed",
			max: 36,
			items: [
				// Provider prefixes drop while the model names stay unique.
				{ label: "gpt-6-luna", value: 31.5, text: "31.5", tone: "success" },
				{ label: "claude-sonnet-5", value: 28, text: "28" },
			],
		});
		expect(block(view, "meter")).toMatchObject({ value: 4 / 9, text: "4/9 trials" });
	});

	it("colours CI jobs by their latest status word", () => {
		const spec = validSpec({
			title: "CI",
			rules: [{ from: "*", match: String.raw`^(?P<mark>[✓✗*])\s+(?P<name>\S+)`, key: "name", text: "mark" }],
			blocks: [
				{ kind: "grid", field: "mark", label: "jobs", tones: { "✓": "success", "✗": "error", "*": "pending" } },
			],
		});
		const out = new ScriptedSource("out");
		const h = harness(spec, out);
		out.append("✓ lint (1m02s)\n✗ test-linux (4m11s)\n* build-macos\n");
		h.ingest();
		out.append("✓ build-macos (6m40s)\n");
		h.ingest();
		expect(block(h.view(), "grid").items).toEqual([
			{ label: "lint", text: "✓", tone: "success" },
			{ label: "test-linux", text: "✗", tone: "error" },
			{ label: "build-macos", text: "✓", tone: "success" },
		]);
	});

	it("keeps full keys when their last path segments would collide", () => {
		const spec = validSpec({
			title: "shards",
			rules: [{ from: "out", match: String.raw`^(?P<name>\S+) (?P<state>\w+)$`, key: "name" }],
			blocks: [{ kind: "grid", field: "state", label: "shards", tones: { ok: "success" } }],
		});
		const out = new ScriptedSource("out");
		const h = harness(spec, out);
		out.append("linux/test ok\nmacos/test running\n");
		h.ingest();
		// `state` is not marked `text`, but a capture holding no number is kept as text all the same.
		expect(block(h.view(), "grid").items.map(item => [item.label, item.text, item.tone])).toEqual([
			["linux/test", "ok", "success"],
			["macos/test", "running", "neutral"],
		]);
	});

	it("draws the newest points of a long series and counts every match toward the rate", () => {
		const spec = validSpec({
			title: "steps",
			rules: [{ from: "out", match: String.raw`^step (?P<step>\d+)` }],
			blocks: [
				{ kind: "spark", field: "step", label: "step" },
				{ kind: "stat", items: [{ field: "step", agg: "rate", label: "rate" }] },
			],
		});
		const out = new ScriptedSource("out");
		const h = harness(spec, out);
		// Two refreshes, past the point where the ring trims its oldest half.
		for (const [from, to] of [
			[1, 400],
			[401, 1000],
		]) {
			for (let step = from; step <= to; step++) out.append(`step ${step}\n`);
			h.advance(5_000);
			h.ingest();
		}
		const spark = block(h.view(), "spark");
		// 240 newest points (761–1000) in 48 buckets of 5: the first bucket's mean is 763.
		expect(spark.values).toHaveLength(48);
		expect(spark.values[0]).toBe(763);
		expect(spark.last).toBe("1000");
		// 1000 matches in a 10 s old job.
		expect(block(h.view(), "stat").items[0].text).toBe("100");
	});

	it("leaves out blocks with nothing to draw yet", () => {
		const spec = validSpec({
			title: "nextest",
			rules: [
				{ from: "out", match: String.raw`^\s*PASS \[`, count: "pass" },
				{ from: "out", match: String.raw`^\s*FAIL \[\s*[\d.]+s\] (?P<fail>.+)$`, text: "fail" },
				{ from: "out", match: String.raw`took (?P<ms>\d+)ms` },
			],
			blocks: [
				{ kind: "spark", field: "ms", label: "duration" },
				{ kind: "stat", items: [{ field: "pass", agg: "count", label: "passed" }] },
				{ kind: "text", field: "fail" },
			],
		});
		const out = new ScriptedSource("out");
		const h = harness(spec, out);
		h.ingest();
		// The stat always has something to say (0 passed); the spark and the failure line do not yet.
		expect(h.view().blocks).toEqual([{ kind: "stat", items: [{ label: "passed", text: "0" }] }]);
		out.append("        PASS [   0.012s] pi-natives line_match::tests::named_groups\n");
		out.append("        FAIL [   0.020s] pi-natives line_match::tests::invalid\n");
		h.ingest();
		expect(h.view().blocks.map(entry => entry.kind)).toEqual(["stat", "text"]);
	});

	it("shows a trend only where a value with a direction actually moved", () => {
		const spec = validSpec({
			title: "eval",
			rules: [{ from: "out", match: String.raw`^score=(?P<score>[\d.]+)` }],
			blocks: [
				{
					kind: "stat",
					items: [
						{ field: "score", agg: "last", label: "last", better: "higher" },
						{ field: "score", agg: "count", label: "runs", better: "higher" },
						{ field: "score", agg: "max", label: "best" },
					],
				},
			],
			headline: { field: "score", agg: "mean", better: "higher" },
		});
		const out = new ScriptedSource("out");
		const h = harness(spec, out);
		const trends = () => [h.view().headline?.trend, ...block(h.view(), "stat").items.map(item => item.trend)];
		out.append("score=25.8\n");
		h.ingest();
		// One point: nothing to compare.
		expect(trends()).toEqual([undefined, undefined, undefined, undefined]);
		out.append("score=25.8\n");
		h.ingest();
		// Two equal points: no `± 0%`.
		expect(trends()).toEqual([undefined, undefined, undefined, undefined]);
		out.append("score=30\n");
		h.ingest();
		// Only `last` with `better` trends; the mean headline, the count and the direction-less max do not.
		expect(trends()).toEqual([undefined, { text: "▲ 16%", tone: "success" }, undefined, undefined]);
	});

	it("joins lines split across reads and skips the line torn by a dropped prefix", () => {
		const spec = validSpec({
			title: "bench",
			// Unanchored on purpose: a torn `…una tok=186` would otherwise read as model `una`.
			rules: [{ from: "out", match: String.raw`(?P<model>\S+) tok=(?P<tok>[\d.]+)`, key: "model" }],
			blocks: [{ kind: "bars", field: "tok", agg: "last", label: "tok/s" }],
		});
		const out = new ScriptedSource("out");
		const h = harness(spec, out);
		out.append("BENCH gpt-6-luna tok=1");
		h.ingest();
		out.append("80\nBENCH gpt-6-sol tok=9");
		h.ingest();
		out.append("0\n");
		h.ingest();
		out.append("BENCH gpt-6-luna tok=186\nBENCH gpt-6-sol tok=95\n");
		out.drop(out.offsetAfter("BENCH gpt-6-l"));
		h.ingest();
		// The source closes mid-line: the final line still counts.
		out.append("BENCH gpt-6-luna tok=190");
		out.open = false;
		h.ingest();
		expect(block(h.view(), "bars").items.map(item => [item.label, item.value])).toEqual([
			["gpt-6-luna", 190],
			["gpt-6-sol", 95],
		]);
	});

	it("falls back to the last line and line rates before a spec exists", () => {
		const pipe = new ScriptedSource("pipe:1");
		const out = new ScriptedSource("out");
		const h = harness(undefined, out, pipe);
		expect(h.view()).toMatchObject({ title: "bench job", blocks: [], state: "fallback" });
		h.advance(10_000);
		pipe.append("compiling a\ncompiling b\n");
		out.append("\x1b[32mwarning: unused\x1b[0m\r\n");
		h.ingest();
		const view = h.view();
		// The pipe's line wins over the job's own output even though `out` arrived last.
		expect(view.stage).toBe("compiling b");
		expect(block(view, "stat").items).toEqual([
			{ label: "lines", text: "3" },
			{ label: "lines/s", text: "0.30" },
		]);
	});

	it("takes a subagent's stage from its own words, never from its tool results", () => {
		const spec = validSpec({
			title: "decode",
			rules: [{ from: "tools", match: String.raw`^BENCH tok_s=(?P<tok>[\d.]+)` }],
			blocks: [{ kind: "spark", field: "tok", label: "tok/s" }],
		});
		for (const installed of [undefined, spec]) {
			const tools = new ScriptedSource("tools");
			const h = harness(installed, tools);
			tools.append("» read src/decode.rs\n34:};\nBENCH tok_s=171\n423:\t\tstate: Alive,\n");
			h.ingest();
			expect(h.view({ lineStage: false }).stage).toBeUndefined();
			expect(h.view({ lineStage: false, stage: "fusing the quantize step" }).stage).toBe("fusing the quantize step");
		}
	});
});

describe("job widget aggregations", () => {
	const statSpec = (better?: "higher") =>
		validSpec({
			title: "agg",
			rules: [{ from: "out", match: String.raw`^ms=(?P<ms>-?[\d.,]+[kKMG]?)` }],
			blocks: [
				{
					kind: "stat",
					items: [
						{ field: "ms", agg: "last", label: "last", unit: "ms", ...(better ? { better } : {}) },
						{ field: "ms", agg: "count", label: "count" },
						{ field: "ms", agg: "rate", label: "rate" },
						{ field: "ms", agg: "change", label: "change" },
					],
				},
			],
		});
	const items = (view: JobWidgetView) => block(view, "stat").items.map(item => item.text);

	it("reports counts but no values for an empty field", () => {
		const h = harness(statSpec(), new ScriptedSource("out"));
		h.ingest();
		expect(items(h.view())).toEqual(["—", "0", "0", "—"]);
	});

	it("treats a single point as unchanged", () => {
		const out = new ScriptedSource("out");
		const h = harness(statSpec(), out);
		out.append("ms=1,250\n");
		h.advance(5_000);
		h.ingest();
		// Separators drop; one match in a 5 s old job is 0.2/s.
		expect(items(h.view())).toEqual(["1250 ms", "1", "0.20", "0%"]);
	});

	it("counts only the last minute toward the rate", () => {
		const out = new ScriptedSource("out");
		const h = harness(statSpec(), out);
		out.append("ms=1\n".repeat(30));
		h.advance(10_000);
		h.ingest();
		expect(items(h.view())[2]).toBe("3");
		h.advance(90_000);
		out.append("ms=2\n".repeat(6));
		h.ingest();
		expect(items(h.view()).slice(1, 3)).toEqual(["36", "0.10"]);
	});

	it("has no percent change from 0 but an absolute trend", () => {
		const out = new ScriptedSource("out");
		const h = harness(statSpec("higher"), out);
		out.append("ms=0\nms=1.5k\n");
		h.ingest();
		const [last, , , change] = block(h.view(), "stat").items;
		expect(last).toEqual({ label: "last", text: "1500 ms", trend: { text: "▲ 1500 ms", tone: "success" } });
		expect(change.text).toBe("—");
	});
});

describe("job widget spec validation", () => {
	const base = {
		title: "t",
		rules: [{ from: "out", match: String.raw`rps=(?P<rps>\d+)` }],
		blocks: [{ kind: "spark", field: "rps", label: "rps" }],
	};

	it("rejects a pattern Rust regex cannot compile, naming the rule", () => {
		const checked = validateJobWidgetSpec({ ...base, rules: [{ ...base.rules[0], match: "rps=(?P<rps>\\d+" }] });
		expect(checked.ok).toBe(false);
		if (!checked.ok) expect(checked.errors.join("\n")).toMatch(/^rules: pattern 0: /m);
	});

	it("rejects lookaround, which the linear-time engine does not support", () => {
		const checked = validateJobWidgetSpec({
			...base,
			rules: [{ ...base.rules[0], match: "(?<=rps=)(?P<rps>\\d+)" }],
		});
		expect(checked.ok).toBe(false);
	});

	it("rejects a block reading a field no rule feeds", () => {
		const checked = validateJobWidgetSpec({ ...base, blocks: [{ kind: "text", field: "phase" }] });
		expect(checked).toEqual({
			ok: false,
			errors: ['blocks[0] (text): unknown field "phase"; no rule has a group (?P<phase>…) or count "phase"'],
		});
	});

	it("rejects a numeric aggregation over a field that only counts matches", () => {
		const checked = validateJobWidgetSpec({
			...base,
			rules: [{ from: "out", match: "^done", count: "done" }],
			blocks: [{ kind: "stat", items: [{ field: "done", agg: "mean", label: "avg" }] }],
		});
		expect(checked).toEqual({
			ok: false,
			errors: [
				'blocks[0] (stat).items[0]: agg "mean" needs numbers, but field "done" only counts matches or keeps text',
			],
		});
	});

	it("draws a meter whose total is unknown as a stat instead of sending it back", () => {
		for (const total of [undefined, "<UNKNOWN>", null]) {
			const checked = validateJobWidgetSpec({
				...base,
				blocks: [{ kind: "meter", field: "rps", agg: "count", label: "requests", unit: "req", total }],
			});
			expect(checked).toEqual({
				ok: true,
				spec: {
					...base,
					blocks: [{ kind: "stat", items: [{ field: "rps", agg: "count", unit: "req", label: "requests" }] }],
				},
			});
		}
		// A numeric string is the total it spells.
		const checked = validateJobWidgetSpec({
			...base,
			blocks: [{ kind: "meter", field: "rps", agg: "count", label: "requests", total: "96" }],
		});
		expect(checked.ok && checked.spec.blocks[0]).toEqual({
			kind: "meter",
			field: "rps",
			agg: "count",
			total: 96,
			label: "requests",
		});
	});

	it("captures the whole match as a `text` group the pattern does not declare", () => {
		const spec = validSpec({
			title: "pip",
			rules: [{ from: "out", match: "^(?:Installing|Successfully installed)", text: "phase" }],
			blocks: [{ kind: "text", field: "phase" }],
		});
		expect(spec.rules[0].match).toBe("(?P<phase>^(?:Installing|Successfully installed))");
		const out = new ScriptedSource("out");
		const h = harness(spec, out);
		out.append("Collecting torch\nInstalling collected packages: torch\n");
		h.ingest();
		expect(block(h.view(), "text").text).toBe("Installing");
	});

	it("drops a `key` or `text` naming a group the pattern lacks, and rejects only a block that needed it", () => {
		// Nothing reads `done`: the rule still feeds `secs`.
		const unread = validateJobWidgetSpec({
			title: "build",
			rules: [{ from: "out", match: String.raw`^Finished .*in (?P<secs>[\d.]+)s`, text: "done", key: "profile" }],
			blocks: [{ kind: "spark", field: "secs", label: "s" }],
		});
		expect(unread.ok && unread.spec.rules).toEqual([
			{ from: "out", match: String.raw`^Finished .*in (?P<secs>[\d.]+)s` },
		]);
		// A grid on the missing `status` goes back to the author; the whole match would repeat the key.
		const read = validateJobWidgetSpec({
			title: "CI",
			rules: [{ from: "out", match: String.raw`^(?P<name>[^\t]+)\tpass\t`, key: "name", text: "status" }],
			blocks: [{ kind: "grid", field: "status", label: "jobs", tones: { pass: "success" } }],
		});
		expect(read).toEqual({
			ok: false,
			errors: [
				"rules[0]: feeds no field; name a group (?P<field>…) besides the key, or set `count`",
				'blocks[0] (grid): unknown field "status"; no rule has a group (?P<status>…) or count "status"',
			],
		});
	});

	it("cuts an overlong title and labels to fit instead of rejecting them", () => {
		const checked = validateJobWidgetSpec({
			...base,
			title: "loadtest · keep-alive pool · 256 connections · goal 2000 rps",
			blocks: [
				{
					kind: "spark",
					field: "rps",
					label: "requests per second over the whole run, all workers",
					unit: "requests/second",
				},
			],
		});
		expect(checked.ok).toBe(true);
		if (!checked.ok) return;
		expect(checked.spec.title).toBe("loadtest · keep-alive pool · 256 connections · …");
		expect(checked.spec.blocks[0]).toMatchObject({
			label: "requests per second over the whole run, all wor…",
			unit: "requests/se…",
		});
	});

	it("rejects a block key that names the key group instead of one of its values", () => {
		const checked = validateJobWidgetSpec({
			title: "bench",
			rules: [{ from: "out", match: String.raw`^BENCH model=(?P<model>\S+) tok=(?P<tok>[\d.]+)`, key: "model" }],
			blocks: [{ kind: "spark", field: "tok", label: "tok/s", key: "model" }],
		});
		expect(checked).toEqual({
			ok: false,
			errors: [
				'blocks[0] (spark).key: "model" is the name of the key group; set one of its values (one model, one job) or omit `key`',
			],
		});
	});

	it("rejects a rule that feeds no field and a group that cannot name one", () => {
		const checked = validateJobWidgetSpec({
			...base,
			rules: [
				...base.rules,
				{ from: "out", match: String.raw`^(?P<Model>\S+) done` },
				{ from: "out", match: "^done" },
			],
		});
		expect(checked).toEqual({
			ok: false,
			errors: [
				'rules[1].match: group "Model" names a field, so it must match ^[a-z][a-z0-9_]{0,23}$',
				"rules[2]: feeds no field; name a group (?P<field>…) besides the key, or set `count`",
			],
		});
	});

	it("rejects a number block over a group whose sample captures hold no number", () => {
		const spec = { ...base, rules: [{ from: "out", match: String.raw`rps=(?P<rps>\S+)` }] };
		expect(validateJobWidgetSpec(spec, [{ id: "out", lines: ["rps=n/a", "rps=pending"] }])).toEqual({
			ok: false,
			errors: [
				'blocks[0] (spark): field "rps" needs numbers, but its group captured "n/a" in the samples; capture only the digits',
			],
		});
		// One numeric capture among them is enough.
		expect(validateJobWidgetSpec(spec, [{ id: "out", lines: ["rps=n/a", "rps=56"] }]).ok).toBe(true);
	});

	it("rejects a spec whose rules match none of the lines the author saw", () => {
		const checked = validateJobWidgetSpec(base, [{ id: "out", lines: ["throughput 56/s"] }]);
		expect(checked.ok).toBe(false);
		// The same spec passes once a sample carries the line it targets.
		expect(validateJobWidgetSpec(base, [{ id: "out", lines: ["rps=56"] }]).ok).toBe(true);
	});

	it("rejects rules reading omp's tool-call markers in a subagent's tool results", () => {
		const tools = [{ id: "tools", lines: ["» bash run the bench", "BENCH tok_s=171", "» read src/decode.rs"] }];
		const counted = validateJobWidgetSpec(
			{
				title: "subagent",
				rules: [{ from: "tools", match: "^» ", count: "calls" }],
				blocks: [{ kind: "stat", items: [{ field: "calls", agg: "count", label: "tool calls" }] }],
			},
			tools,
		);
		expect(counted.ok).toBe(false);
		expect(counted.ok ? [] : counted.errors[0]).toMatch(/^rules\[0\]: matches `» <tool> <intent>` lines/);
		// The same marker text in a command's own output is just output.
		expect(
			validateJobWidgetSpec(
				{
					title: "log",
					rules: [{ from: "out", match: "^» (?P<step>.+)$", text: "step" }],
					blocks: [{ kind: "text", field: "step" }],
				},
				[{ id: "out", lines: ["» compile"] }],
			).ok,
		).toBe(true);
	});

	it("rejects a constant total or target that neither the job nor its output states", () => {
		const spec = (total: number, target: number) => ({
			...base,
			blocks: [
				{ kind: "spark", field: "rps", label: "req/s", target },
				{ kind: "meter", field: "rps", agg: "count", total, label: "ticks" },
			],
		});
		const samples = [{ id: "out", lines: ["rps=56 after 40 of 75 ticks"] }];
		expect(validateJobWidgetSpec(spec(100, 60), samples, "bench --rps")).toEqual({
			ok: false,
			errors: [
				"blocks[0] (spark).target: 60 appears nowhere in the job or its output; set a target only when the job states one",
				"blocks[1] (meter).total: 100 appears nowhere in the job or its output; read the total from a line (a value ref) or show the value as a stat",
			],
		});
		// The output states the total, the brief the goal (`1.2k` reads as 1200).
		expect(validateJobWidgetSpec(spec(75, 1200), samples, "bench --rps, goal 1.2k req/s").ok).toBe(true);
	});
});
