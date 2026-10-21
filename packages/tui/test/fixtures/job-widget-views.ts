/**
 * Realistic `JobWidgetView`s, shaped like the job-widgets runtime derives
 * them: a decode-throughput benchmark, a per-model eval, a CI run and a trial
 * sweep. Some text carries a tab and a colour escape, as raw job output does.
 */
import type { JobWidgetView } from "@oh-my-pi/pi-tui/tools/job-widget";

const UPDATED_AT = 1_760_000_000_000;

/** Decode tok/s over 32 runs, climbing toward a 200 tok/s target. */
export const DECODE_VALUES = Array.from({ length: 32 }, (_, i) => Math.round(150 + i * 1.15 + (i % 3) * 2));

export const decodeBench: JobWidgetView = {
	title: "verb-bench · decode throughput",
	stage: "nvfp4 b1\trun 32/48",
	headline: { text: "186 tok/s", label: "decode", trend: { text: "▲ 15%", tone: "success" } },
	blocks: [
		{
			kind: "spark",
			label: "tok/s · nvfp4 b1",
			values: DECODE_VALUES,
			min: 0,
			max: 220,
			marks: [{ value: 200, label: "target 200 tok/s", tone: "warning" }],
			last: "186 tok/s",
			tips: DECODE_VALUES.map((value, i) => `12:04:${String(i).padStart(2, "0")} · ${value} tok/s`),
		},
		{
			kind: "stat",
			items: [
				{ label: "p50", text: "41 ms" },
				{ label: "p99", text: "212 ms", trend: { text: "▼ 3.2%", tone: "success" } },
				{ label: "errors", text: "0", tone: "success" },
			],
		},
	],
	state: "live",
	updatedAt: UPDATED_AT,
};

export const modelEval: JobWidgetView = {
	title: "eval · tests passed per model",
	headline: { text: "71/90", label: "passed" },
	blocks: [
		{
			kind: "bars",
			label: "tests passed",
			max: 30,
			items: [
				{ label: "opus-4.5", value: 26, text: "26/30", tone: "success" },
				{ label: "gpt-5.1", value: 24, text: "24/30" },
				{ label: "gemini-3-pro", value: 21, text: "21/30", tone: "warning" },
			],
		},
	],
	state: "live",
	updatedAt: UPDATED_AT + 1_000,
};

export const ciRun: JobWidgetView = {
	title: "CI · pull/4821",
	stage: "\x1b[33mtest (macos-14)\x1b[0m running",
	blocks: [
		{
			kind: "grid",
			label: "jobs",
			items: [
				{ label: "lint", text: "passed", tone: "success" },
				{ label: "build", text: "passed", tone: "success" },
				{ label: "test (ubuntu)", text: "failed: 2 tests", tone: "error" },
				{ label: "test (macos-14)", text: "running", tone: "pending" },
				{ label: "docs", text: "queued", tone: "muted" },
			],
		},
	],
	state: "live",
	updatedAt: UPDATED_AT + 2_000,
};

export const trialSweep: JobWidgetView = {
	title: "ablation · 9 trials",
	headline: { text: "0.842", label: "best", trend: { text: "▲ 2.1%", tone: "success" } },
	blocks: [
		{ kind: "meter", label: "trials", value: 7 / 9, text: "7/9 trials" },
		{ kind: "text", text: "trial 8: lr=3e-4\twarmup=500 seed=7" },
	],
	state: "live",
	updatedAt: UPDATED_AT + 3_000,
};

export const FIXTURE_VIEWS = { decodeBench, modelEval, ciRun, trialSweep } as const;
