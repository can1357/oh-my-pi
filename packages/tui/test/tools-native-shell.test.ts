import { beforeAll, describe, expect, it } from "bun:test";
import type { TspKind, TspSpan } from "@oh-my-pi/pi-wire";
import { BashExecutionComponent } from "../src/chat/bash-execution";
import { ToolExecutionComponent } from "../src/chat/tool-execution";
import type { DescribeContext, NativeChild, NativeNode } from "../src/native/node";
import { bashToolRenderer, formatExitCodeNotice, formatWallTimeNotice } from "../src/tools/bash";
import { type EvalCellResult, evalToolRenderer } from "../src/tools/eval";
import type { RenderResultOptions } from "../src/tools/renderer";
import { getThemeByName, setThemeInstance } from "../src/theme";
import type { TUI } from "../src/tui";

const done: RenderResultOptions = { expanded: false, isPartial: false };
// 1×1 transparent PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

function isNode(child: NativeChild): child is NativeNode {
	return "k" in child;
}

function nodes(children: readonly NativeChild[] | undefined): NativeNode[] {
	return (children ?? []).filter(isNode);
}

function collect(children: readonly NativeChild[] | undefined, kind: string): NativeNode[] {
	const out: NativeNode[] = [];
	for (const child of nodes(children)) {
		if (child.k === kind) out.push(child);
		out.push(...collect(child.c, kind));
	}
	return out;
}

function props(n: NativeNode | undefined): Record<string, unknown> {
	return (n?.p ?? {}) as Record<string, unknown>;
}

function role(n: NativeNode | undefined): string | undefined {
	return props(n).role as string | undefined;
}

function spansText(n: NativeNode | undefined): string {
	return ((props(n).spans as TspSpan[] | undefined) ?? []).map(s => s.t).join("");
}

/** A run box's sections as `kind:role`, in order. */
function sections(box: NativeNode | undefined): string[] {
	return nodes(box?.c).map(child => `${child.k}:${role(child) ?? ""}`);
}

/** The foot a consumer reads: state word and tone, time (age / stopped), facts text. */
function foot(box: NativeNode | undefined) {
	const row = nodes(box?.c).find(child => role(child) === "omp.run.foot");
	if (!row) return undefined;
	const parts = nodes(row.c);
	const state = parts.find(part => role(part) === "omp.run.state");
	const time = parts.find(part => role(part) === "omp.run.time");
	const facts = parts.find(part => role(part) === "omp.run.facts");
	return {
		state: spansText(state),
		tone: props(state).tone,
		time: time ? { age: props(time).age, stopped: props(time).stopped } : undefined,
		facts: facts ? (props(facts).spans as TspSpan[]) : undefined,
	};
}

function cx(kinds: readonly TspKind[]): DescribeContext {
	return { cols: 100, reduceMotion: false, dark: true, supports: kind => kinds.includes(kind), feature: () => true };
}

describe("bash native run box", () => {
	it("names the intent in the head and draws command, output and settled foot in one box", () => {
		const view = bashToolRenderer.describeResult(
			{
				content: [{ type: "text", text: `built\n\n${formatWallTimeNotice(1500)}` }],
				details: { wallTimeMs: 1500, timeoutSeconds: 300 },
			},
			{ ...done, elapsedMs: 1720 },
			{ command: "make", env: { CI: "1" }, i: "Building the project" },
		);
		expect(view.tool).toMatchObject({ target: "Building the project", targetKind: "text", command: 'CI="1" make' });
		expect(view.preview).toBe("children");
		const [box, ...rest] = nodes(view.body);
		expect(rest).toEqual([]);
		expect(role(box)).toBe("omp.run");
		expect(box?.key).toBe("run");
		expect(props(box).tone).toBeUndefined();
		expect(sections(box)).toEqual(["code:omp.tool.bash.command", "ansi:omp.tool.bash.output", "row:omp.run.foot"]);
		const [input, output] = nodes(box?.c);
		expect(props(input)).toMatchObject({ text: 'CI="1" make', wrap: true, preview: { lines: 6 } });
		expect(props(output)).toMatchObject({ text: "built", follow: true, preview: { lines: 10 } });
		// The measured wall time wins over the component's clock once settled.
		expect(foot(box)).toMatchObject({ state: "Done", tone: "success", time: { age: 1500, stopped: 1500 } });
	});

	it("has no target without an intent and no foot before the command starts", () => {
		const view = bashToolRenderer.describeCall(
			{ command: "make test", __partialJson: '{"env":{"CI":"1"},"command":"make test' },
			{ expanded: false, isPartial: true },
		);
		expect(view.tool?.target).toBeUndefined();
		expect(view.tool?.command).toBe('CI="1" make test');
		const box = nodes(view.body)[0];
		expect(sections(box)).toEqual(["code:omp.tool.bash.command"]);
		expect(String(props(nodes(box?.c)[0]).text)).toBe('CI="1" make test');

		const started = bashToolRenderer.describeCall(
			{ command: "sleep 30" },
			{ expanded: false, isPartial: true, executionStarted: true, elapsedMs: 400 },
		);
		expect(foot(nodes(started.body)[0])).toMatchObject({
			state: "Running",
			tone: "pending",
			time: { age: 400, stopped: undefined },
		});
		const cancelled = bashToolRenderer.describeCall(
			{ command: "sleep 30" },
			{ expanded: false, isPartial: true, executionStarted: true, elapsedMs: 900, cancelled: true },
		);
		expect(foot(nodes(cancelled.body)[0])).toMatchObject({ state: "Cancelled", time: { age: 900, stopped: 900 } });
	});

	it("keeps a running call's clock live", () => {
		const view = bashToolRenderer.describeResult(
			{ content: [{ type: "text", text: "line 1" }], details: {} },
			{ expanded: false, isPartial: true, executionStarted: true, elapsedMs: 2500 },
			{ command: "make" },
		);
		expect(foot(nodes(view.body)[0])).toMatchObject({ state: "Running", time: { age: 2500, stopped: undefined } });
	});

	it("maps exit, timeout, spawn failure and background jobs to the foot state and box tone", () => {
		const settle = (text: string, details: Record<string, unknown>, isError: boolean) => {
			const view = bashToolRenderer.describeResult(
				{ content: [{ type: "text", text }], details, isError },
				{ ...done, elapsedMs: 5000 },
				{ command: "job" },
			);
			const box = nodes(view.body)[0];
			return { view, box, foot: foot(box), output: String(props(collect(box?.c, "ansi")[0]).text) };
		};

		const failed = settle(`boom\n\n${formatExitCodeNotice(2)}`, { exitCode: 2, wallTimeMs: 300 }, true);
		expect(failed.view.tool?.exit).toBe(2);
		expect(failed.output).toBe("boom");
		expect(props(failed.box).tone).toBe("error");
		expect(failed.foot).toMatchObject({ state: "exit 2", tone: "error", time: { stopped: 300 } });

		const spawn = settle("bash: not found", {}, true);
		expect(props(spawn.box).tone).toBe("error");
		expect(spawn.foot).toMatchObject({ state: "Failed", tone: "error", time: { stopped: 5000 } });

		const timedOut = settle("partial", { timedOut: true, timeoutSeconds: 5 }, true);
		expect(timedOut.view.tool?.note).toBe("timed out");
		expect(timedOut.view.tool?.exit).toBeUndefined();
		expect(props(timedOut.box).tone).toBe("warning");
		expect(timedOut.foot).toMatchObject({ state: "Timed out", tone: "warning" });

		const background = settle("started", { async: { state: "running", jobId: "bg_3", type: "bash" } }, false);
		expect(props(background.box).tone).toBeUndefined();
		expect(background.foot).toMatchObject({ state: "In background", tone: "pending", time: undefined });
		expect(background.foot?.facts?.map(s => s.t).join("")).toBe("Job bg_3");
	});

	it("moves service state, artifact and truncation notices into the foot facts", () => {
		const view = bashToolRenderer.describeResult(
			{
				content: [{ type: "text", text: "tail" }],
				details: {
					service: { name: "web", state: "running", ready: true, timedOut: false },
					meta: {
						truncation: {
							direction: "head",
							truncatedBy: "lines",
							totalLines: 900,
							totalBytes: 9000,
							outputLines: 100,
							outputBytes: 1000,
							shownRange: { start: 801, end: 900 },
						},
					},
				},
			},
			done,
			{ command: "serve" },
		);
		const facts = foot(nodes(view.body)[0])?.facts ?? [];
		expect(facts[0]).toEqual({ t: "Service web · running · ready", s: "muted" });
		expect(facts.at(-1)?.s).toBe("warning");
		expect(facts.at(-1)?.t).toContain("900");
	});

	it("attaches result images below the box", () => {
		const ui = { requestRender: () => {}, requestComponentRender: () => {}, resetDisplay: () => {} };
		const tool = new ToolExecutionComponent("bash", { command: "plot" }, { showImages: true }, undefined, ui);
		try {
			tool.updateResult(
				{
					content: [
						{ type: "text", text: "ok" },
						{ type: "image", data: PNG, mimeType: "image/png" } as { type: string; text?: string },
					],
					details: {},
				},
				false,
			);
			const described = tool.describe(cx(["tool", "ansi", "code", "image"]));
			expect(props(described).preview).toBe("children");
			expect(props(described).command).toBe("plot");
			expect(nodes(described.c).map(child => role(child) ?? child.k)).toEqual(["omp.run", "image"]);
		} finally {
			tool.dispose();
		}
	});
});

describe("eval native run boxes", () => {
	const cell = (overrides: Partial<EvalCellResult>): EvalCellResult => ({
		index: 0,
		code: "print(1)",
		language: "python",
		output: "",
		status: "complete",
		...overrides,
	});

	it("draws one box per cell with the call's notice in the last cell's foot", () => {
		const view = evalToolRenderer.describeResult(
			{
				content: [{ type: "text", text: "" }],
				details: {
					cells: [cell({ code: "x = 1\nprint(x)\n\n", output: "1", durationMs: 120 })],
					notice: "Fell back to python",
				},
			},
			done,
		);
		expect(view.preview).toBe("children");
		const [box, ...rest] = nodes(view.body);
		expect(rest).toEqual([]);
		expect(box?.key).toBe("cell-0");
		// A single cell has no caption; its source keeps no trailing blank line.
		expect(sections(box)).toEqual(["code:omp.tool.eval.input", "ansi:omp.tool.eval.output", "row:omp.run.foot"]);
		expect(props(nodes(box?.c)[0])).toMatchObject({ text: "x = 1\nprint(x)", wrap: false, preview: { lines: 6 } });
		expect(props(nodes(box?.c)[1])).toMatchObject({ follow: true, preview: { lines: 10 } });
		expect(foot(box)).toMatchObject({ state: "Done", tone: "success", time: { age: 120, stopped: 120 } });
		expect(foot(box)?.facts).toEqual([{ t: "Fell back to python", s: "muted" }]);
	});

	it("captions several cells, tints only the failed one and caps folded status lines", () => {
		const events = Array.from({ length: 11 }, (_, i) => ({ op: "step", n: i }));
		const describeCells = (options: RenderResultOptions) =>
			nodes(
				evalToolRenderer.describeResult(
					{
						content: [{ type: "text", text: "" }],
						details: {
							cells: [
								cell({ index: 0, title: "Load", output: "ok", durationMs: 1000 }),
								cell({ index: 1, title: "Fit", output: "Traceback", status: "error", durationMs: 500 }),
								cell({ index: 2, title: "Plot", status: "running", statusEvents: events }),
								cell({ index: 3, title: "Save", status: "pending" }),
							],
							meta: {
								truncation: {
									direction: "tail",
									truncatedBy: "bytes",
									totalLines: 10,
									totalBytes: 99_999,
									outputLines: 10,
									outputBytes: 50_000,
								},
							},
						},
					},
					options,
				).body,
			);

		const folded = describeCells({ expanded: false, isPartial: true, executionStarted: true, elapsedMs: 4000 });
		expect(folded.map(box => spansText(nodes(box.c)[0]))).toEqual(["1/4 Load", "2/4 Fit", "3/4 Plot", "4/4 Save"]);
		expect(folded.map(box => props(box).tone)).toEqual([undefined, "error", undefined, undefined]);
		expect(foot(folded[1])).toMatchObject({ state: "Failed", tone: "error", time: { stopped: 500 } });
		// The running cell's clock is the call's minus the cells that finished before it.
		expect(foot(folded[2])).toMatchObject({ state: "Running", time: { age: 2500, stopped: undefined } });
		// A cell that never started has no foot; the call's truncation joins the last cell that ran.
		expect(foot(folded[3])).toBeUndefined();
		expect(foot(folded[2])?.facts?.map(s => s.s)).toEqual(["warning"]);

		const status = nodes(folded[2]?.c).find(child => role(child) === "omp.run.status");
		const lines = nodes(status?.c);
		expect(lines).toHaveLength(9);
		expect(spansText(lines[0])).toBe("3 earlier");
		expect(spansText(lines[1])).toContain("n=3");
		expect(spansText(lines.at(-1))).toContain("n=10");

		const expanded = describeCells({ expanded: true, isPartial: true, executionStarted: true, elapsedMs: 4000 });
		const allLines = nodes(nodes(expanded[2]?.c).find(child => role(child) === "omp.run.status")?.c);
		expect(allLines).toHaveLength(11);
		expect(spansText(allLines[0])).toContain("n=0");
	});

	it("counts status events dropped from a cell's log in the earlier line", () => {
		const statusLines = (expanded: boolean) => {
			const [box] = nodes(
				evalToolRenderer.describeResult(
					{
						content: [{ type: "text", text: "" }],
						details: {
							cells: [
								cell({
									statusEvents: Array.from({ length: 10 }, (_, i) => ({ op: "step", n: i })),
									statusEventsElided: 500,
								}),
							],
						},
					},
					{ expanded, isPartial: false },
				).body,
			);
			return nodes(nodes(box?.c).find(child => role(child) === "omp.run.status")?.c).map(spansText);
		};

		const folded = statusLines(false);
		expect(folded).toHaveLength(9);
		expect(folded[0]).toBe("502 earlier");
		expect(folded[1]).toContain("n=2");

		const expanded = statusLines(true);
		expect(expanded).toHaveLength(11);
		expect(expanded[0]).toBe("500 earlier");
		expect(expanded[1]).toContain("n=0");
	});

	it("puts older details' whole output and foot under the call's last cell", () => {
		const view = evalToolRenderer.describeResult(
			{ content: [{ type: "text", text: "a\nb" }], isError: true },
			{ ...done, elapsedMs: 800 },
			{ cells: [{ code: "x = 1" }, { code: "raise" }] },
		);
		const [first, last] = nodes(view.body);
		expect(sections(first)).toEqual(["text:omp.run.caption", "code:omp.tool.eval.input"]);
		expect(sections(last)).toEqual([
			"text:omp.run.caption",
			"code:omp.tool.eval.input",
			"ansi:omp.tool.eval.output",
			"row:omp.run.foot",
		]);
		expect(props(last).tone).toBe("error");
		expect(foot(last)).toMatchObject({ state: "Failed", time: { stopped: 800 } });
	});

	it("renders console.table values without losing surrounding output", () => {
		const table = [
			"┌─────────┬────┬─────┐",
			"│ (index) │ a  │  b  │",
			"├─────────┼────┼─────┤",
			"│    0    │ 1  │ 'x' │",
			"│    1    │ 22 │     │",
			"└─────────┴────┴─────┘",
		].join("\n");
		const view = evalToolRenderer.describeResult(
			{
				content: [{ type: "text", text: "" }],
				details: {
					cells: [cell({ code: "console.table(rows)", language: "js", output: `before\n${table}\nafter` })],
				},
			},
			done,
		);
		expect(collect(view.body, "ansi").map(output => props(output).text)).toEqual(["before", "after"]);
		const tableNode = collect(view.body, "table")[0];
		if (tableNode?.k !== "table") throw new Error("Expected a native table");
		expect(tableNode.p?.cols.map(col => col.head)).toEqual(["", "a", "b"]);
		expect(tableNode.p?.rows.map(row => Object.values(row.cells))).toEqual([
			["0", "1", "'x'"],
			["1", "22", ""],
		]);
	});
});

describe("user shell runs", () => {
	const ui = { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI;

	beforeAll(async () => {
		setThemeInstance((await getThemeByName("dark"))!);
	});

	it("draw one run box under a you / not-sent head, images below it", () => {
		const run = new BashExecutionComponent("ls -la", ui, true);
		run.appendOutput("a\nb");
		run.setComplete(1, false, { images: [{ type: "image", data: PNG, mimeType: "image/png" }], showImages: false });
		const described = run.describe(cx(["tool", "ansi", "code"]));
		expect(described.k).toBe("tool");
		const p = props(described);
		expect(p.target).toBeUndefined();
		expect(p.command).toBe("ls -la");
		expect(p.preview).toBe("children");
		expect(p.collapsed).toBe(true);
		expect((p.badges as { text: string }[]).map(badge => badge.text)).toEqual(["you", "not sent"]);
		const [box, image] = nodes(described.c);
		expect(role(box)).toBe("omp.run");
		expect(props(box).tone).toBe("error");
		expect(sections(box)).toEqual(["code:omp.tool.bash.command", "ansi:omp.tool.bash.output", "row:omp.run.foot"]);
		expect(props(nodes(box?.c)[1])).toMatchObject({ follow: true, preview: { lines: 10 } });
		expect(foot(box)).toMatchObject({ state: "exit 1", tone: "error" });
		expect(foot(box)?.time?.stopped).toBeNumber();
		expect(image?.k).toBe("text");
		expect(run.describe(cx(["card", "ansi"])).k).toBe("card");
	});
});
