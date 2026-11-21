import { describe, expect, it } from "bun:test";
import { type ShellStepInput, ShellSteps, type ShellStream } from "@oh-my-pi/pi-tui/tools/shell-steps";
import { defaultShellVizPreferences } from "@oh-my-pi/pi-tui/tools/shell-viz";
import type { ShellTrace, ShellTraceNode, ShellVizPresentation, ShellVizSegment } from "@oh-my-pi/pi-wire";

const NOW = 1_000_000;

const node = (k: ShellTraceNode["k"], p?: number): ShellTraceNode => ({
	k,
	lo: 0,
	hi: 1,
	state: "running",
	...(p === undefined ? {} : { p }),
});

// `while :; do bench >> run.log; done | tail; echo done`:
// 0 and_or ─ 1 pipeline ─ 2 while ─ 3 bench (4 its redirect word), 5 tail · 6 echo
const TRACE: ShellTrace = {
	v: 1,
	seq: 3,
	t_ns: 0,
	script: "while :; do bench >> run.log; done | tail; echo done",
	units: [
		{
			line: 1,
			nodes: [
				node("and_or"),
				node("pipeline", 0),
				node("while", 1),
				node("simple", 2),
				node("word", 3),
				node("simple", 1),
				node("simple", 0),
			],
		},
	],
	history: [
		{ seq: 1, t_ns: 1, kind: "Output", text: "tail says\n", fd: 1, u: 0, n: 5 },
		{ seq: 2, t_ns: 2, kind: "Output", text: "done\n", fd: 1, u: 0, n: 6 },
	],
};

const segment = (text: string, executionNode?: string, node?: string): ShellVizSegment => ({
	text,
	...(executionNode ? { executionNode } : {}),
	...(node ? { node } : {}),
});

const PRESENTATION: ShellVizPresentation = {
	preferences: defaultShellVizPreferences(),
	rows: [
		{
			id: "r0",
			depth: 0,
			segments: [
				segment("while :; do "),
				segment("bench", "0:0:3"),
				segment(" >> run.log", "0:0:3", "0:0:4"),
				segment("; done | "),
				segment("tail", "0:0:5"),
				segment("; "),
				segment("echo done", "0:0:6"),
			],
			effects: [],
		},
	],
	original: [],
	output: "",
	executing: true,
	watches: [],
	timeline: { length: 0, cursor: 0, elapsedNs: 0, durationNs: 0 },
};

/** The same file reopened by two passes of the loop, the second one now. */
function runLogs(): ShellStream[] {
	return [1, 2].map(id => ({
		id: `file:${id}`,
		kind: "file",
		producer: "bench >> run.log",
		consumer: "/work/run.log",
		node: "0:0:3",
		bytes: id * 10,
		open: true,
		modified: NOW - (id === 1 ? 9_000 : 100),
		tail: () => `pass ${id}\n`,
	}));
}

function input(overrides: Partial<ShellStepInput> = {}): ShellStepInput {
	return {
		trace: TRACE,
		presentation: PRESENTATION,
		streams: runLogs(),
		output: "",
		settled: false,
		now: NOW,
		...overrides,
	};
}

describe("ShellSteps", () => {
	it("focuses every drawn segment of the step that writes the shown stream", () => {
		const view = new ShellSteps().show(input());
		expect(view.id).toBe("file:2");
		expect(view.pinned).toBe(false);
		expect(view.flowing).toBe(true);
		expect(view.focus).toEqual(["0:0:3"]);
	});

	it("numbers the instances of one file a loop reopens", () => {
		expect(new ShellSteps().show(input()).sources.map(source => source.label)).toEqual([
			"Output",
			"run.log #1",
			"run.log #2",
		]);
	});

	it("focuses the producer of the newest output while following the run's own output", () => {
		const view = new ShellSteps().show(input({ streams: [], output: "tail says\ndone\n", outputModified: NOW - 50 }));
		expect(view.id).toBe("out");
		expect(view.flowing).toBe(true);
		expect(view.focus).toEqual(["0:0:6"]);
		expect(new ShellSteps().show(input({ streams: [], output: "done\n", settled: true })).focus).toEqual([]);
	});

	it("names a pinned step without a stream by its command text and shows only its slice", () => {
		const steps = new ShellSteps();
		steps.select("0:0:5");
		const view = steps.show(input({ output: "tail says\ndone\n" }));
		expect(view).toMatchObject({ id: "step:0:0:5", label: "tail", text: "tail says\n", pinned: true });
		expect(view.focus).toEqual(["0:0:5"]);
	});

	it("unpins when any highlighted segment of the pinned step is clicked again", () => {
		const steps = new ShellSteps();
		steps.select("0:0:4");
		expect(steps.show(input()).focus).toEqual(["0:0:3"]);
		steps.select("0:0:3");
		expect(steps.pinned).toBe(false);
		// Another step is a new pin, not a release.
		steps.select("0:0:6");
		steps.select("0:0:5");
		expect(steps.pinned).toBe(true);
	});

	it("shows a settled run's own output, or its newest carrying stream when that is empty", () => {
		expect(new ShellSteps().show(input({ output: "done\n", settled: true })).id).toBe("out");
		const quiet = new ShellSteps().show(input({ settled: true }));
		expect(quiet).toMatchObject({ id: "file:2", open: false, flowing: false });
	});
});
