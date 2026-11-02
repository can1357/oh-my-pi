import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { getThemeByName, setThemeInstance, type Theme } from "@oh-my-pi/pi-tui/theme";
import { renderCall, renderResult, taskCardAgentIds } from "@oh-my-pi/pi-tui/tools/task";
import { taskToolRenderer } from "@oh-my-pi/pi-tui/tools/task";
import type { AgentProgress, SingleResult, TaskParams, TaskToolDetails } from "@oh-my-pi/pi-tui/tools/task";

const strip = (lines: readonly string[]): string =>
	lines
		.join("\n")
		.replace(/\x1b\]8;[^\x1b\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-9;]*m/g, "");

const originalRowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");

function setViewportRows(rows: number): void {
	Object.defineProperty(process.stdout, "rows", { configurable: true, value: rows });
}

function restoreViewportRows(): void {
	if (originalRowsDescriptor) {
		Object.defineProperty(process.stdout, "rows", originalRowsDescriptor);
		return;
	}
	Reflect.deleteProperty(process.stdout, "rows");
}

function makeProgress(recentOutput: string[]): AgentProgress {
	return {
		index: 0,
		id: "NoisySubagent",
		agent: "task",
		agentSource: "bundled",
		status: "running",
		task: "produce noisy output",
		recentTools: [],
		recentOutput,
		toolCount: 1,
		requests: 1,
		tokens: 0,
		cost: 0,
		durationMs: 0,
	};
}

function makeParentWithNestedProgress(childCount: number): AgentProgress {
	const children = Array.from({ length: childCount }, (_, index): AgentProgress => ({
		...makeProgress([]),
		index,
		id: `Nested${index + 1}`,
		task: `nested child ${index + 1}`,
	}));
	return {
		...makeProgress([]),
		id: "Parent",
		task: "parent task",
		inflightTaskDetails: {
			projectAgentsDir: null,
			results: [],
			totalDurationMs: 1,
			progress: children,
		},
	};
}

function makeSingleResult(index: number, overrides?: Partial<SingleResult>): SingleResult {
	return {
		index,
		id: `Done${index + 1}`,
		agent: "task",
		agentSource: "bundled",
		task: `finished child ${index + 1}`,
		exitCode: 0,
		output: "ok",
		stderr: "",
		truncated: false,
		durationMs: 5,
		tokens: 0,
		requests: 1,
		...overrides,
	};
}

function makeParentWithNestedResults(childCount: number): TaskToolDetails {
	const nested: TaskToolDetails = {
		projectAgentsDir: null,
		// Failure on the LAST child in display order (equal durations, index tiebreak):
		// a plain head-of-list pick would elide it, so its visibility proves the
		// failure-first selection of `selectCollapsedResults`.
		results: Array.from({ length: childCount }, (_, index) =>
			makeSingleResult(index, index === childCount - 1 ? { exitCode: 1, error: "boom" } : undefined),
		),
		totalDurationMs: 1,
	};
	const parent = makeSingleResult(0, { id: "Parent", extractedToolData: { task: [nested] } });
	return { projectAgentsDir: null, results: [parent], totalDurationMs: 1 };
}

function renderResultText(details: TaskToolDetails, expanded: boolean, uiTheme: Theme): string {
	const component = renderResult(
		{ content: [{ type: "text", text: "Ran 1 agent" }], details },
		{ expanded, isPartial: false },
		uiTheme,
	);
	return strip(component.render(120));
}

function renderProgressText(progress: AgentProgress, expanded: boolean, uiTheme: Theme): string {
	const details: TaskToolDetails = {
		projectAgentsDir: null,
		results: [],
		totalDurationMs: 1,
		progress: [progress],
	};
	const component = renderResult(
		{ content: [{ type: "text", text: "Running 1 agent..." }], details },
		{ expanded, isPartial: true },
		uiTheme,
	);
	return strip(component.render(120));
}

describe("task live progress rendering", () => {
	let uiTheme: Theme;

	beforeAll(async () => {
		const loaded = await getThemeByName("dark");
		if (!loaded) throw new Error("theme unavailable");
		uiTheme = loaded;
		setThemeInstance(uiTheme);
	});

	afterEach(() => {
		restoreViewportRows();
	});

	it("caps subagent recent output with the viewport budget instead of a fixed six lines", () => {
		setViewportRows(40);
		const chronological = Array.from({ length: 8 }, (_, index) => `line ${index + 1}`);
		const text = renderProgressText(makeProgress([...chronological].reverse()), true, uiTheme);

		expect(text).toContain("line 1");
		expect(text).toContain("line 8");
		expect(text).not.toContain("more lines");
	});

	it("keeps the newest subagent output when the viewport cap truncates", () => {
		setViewportRows(24);
		const chronological = Array.from({ length: 8 }, (_, index) => `line ${index + 1}`);
		const text = renderProgressText(makeProgress([...chronological].reverse()), true, uiTheme);

		expect(text).toContain("… 3 earlier lines");
		expect(text).not.toContain("line 1");
		expect(text).not.toContain("line 3");
		expect(text).toContain("line 4");
		expect(text).toContain("line 8");
	});

	it("shows the extension routing note on async progress rows after completion", () => {
		setViewportRows(40);
		const progress = { ...makeProgress([]), status: "completed" as const, resolvedModelRoute: "pool b (quota)" };
		expect(renderProgressText(progress, false, uiTheme)).toContain("routed: pool b (quota)");
	});

	it("strips bash footer notices from expanded subagent recent output", () => {
		setViewportRows(40);
		const chronological = [
			"line 1",
			"line 2",
			"line 3",
			"line 4",
			"line 5",
			"line 6",
			"Wall time: 0.03 seconds",
			"[raw output: artifact://123]",
		];
		const progress = makeProgress([...chronological].reverse());

		const expandedText = renderProgressText(progress, true, uiTheme);
		expect(expandedText).toContain("line 1");
		expect(expandedText).toContain("line 6");
		expect(expandedText).not.toContain("Wall time:");
		expect(expandedText).not.toContain("raw output:");

		const collapsedText = renderProgressText(progress, false, uiTheme);
		expect(collapsedText).not.toContain("line 1");
		expect(collapsedText).not.toContain("raw output:");
	});
	it("sanitizes control sequences from expanded subagent recent output", () => {
		setViewportRows(40);
		const progress = makeProgress(["safe after \x1b[2Kclear", "raw\rprompt"]);

		const text = renderProgressText(progress, true, uiTheme);

		expect(text).toContain("safe after clear");
		expect(text).toContain("rawprompt");
		expect(text).not.toContain("\x1b[2K");
		expect(text).not.toContain("\r");
	});
	it("sanitizes control sequences from finalized subagent results", () => {
		const output = JSON.stringify({ "\x1b[2Kkey": "safe value" });
		const details: TaskToolDetails = {
			projectAgentsDir: null,
			results: [
				makeSingleResult(0, {
					id: "Final\x1b[2KAgent",
					description: "description\rtext",
					aborted: true,
					abortReason: "aborted \x1b[2Kreason",
					output,
				}),
			],
			totalDurationMs: 1,
		};

		const text = renderResultText(details, true, uiTheme);

		expect(text).toContain("FinalAgent");
		expect(text).toContain("descriptiontext");
		expect(text).toContain("aborted reason");
		expect(text).toContain("key");
		expect(text).not.toContain("\x1b[2K");
		expect(text).not.toContain("\r");
	});

	it("caps collapsed nested task progress at four rows plus an elision line", () => {
		setViewportRows(40);
		const text = renderProgressText(makeParentWithNestedProgress(6), false, uiTheme);

		expect(text).not.toContain("Nested1");
		expect(text).not.toContain("Nested2");
		expect(text).toContain("Nested3");
		expect(text).toContain("Nested4");
		expect(text).toContain("Nested5");
		expect(text).toContain("Nested6");
		expect(text).toContain("2 more agents");
	});

	it("shows every nested task progress row when expanded", () => {
		setViewportRows(40);
		const text = renderProgressText(makeParentWithNestedProgress(6), true, uiTheme);

		for (let index = 1; index <= 6; index++) {
			expect(text).toContain(`Nested${index}`);
		}
		expect(text).not.toContain("more agents");
	});

	it("caps collapsed finalized nested task results and keeps the failed child visible", () => {
		setViewportRows(40);
		const text = renderResultText(makeParentWithNestedResults(6), false, uiTheme);

		expect(text).toContain("Done6"); // failed child wins a slot despite sorting last
		expect(text).toContain("2 more agents");
		const visibleChildren = [1, 2, 3, 4, 5, 6].filter(index => text.includes(`Done${index}`));
		expect(visibleChildren).toHaveLength(4);
	});

	it("shows every finalized nested task result when expanded", () => {
		setViewportRows(40);
		const text = renderResultText(makeParentWithNestedResults(6), true, uiTheme);

		for (let index = 1; index <= 6; index++) {
			expect(text).toContain(`Done${index}`);
		}
		expect(text).not.toContain("more agents");
	});

	it("does not request spinner ticks for static partial progress", () => {
		expect("animatedPartialResult" in taskToolRenderer).toBe(false);
	});

	it("renders running progress identically across spinner frames", () => {
		const progress = makeProgress([]);
		const details: TaskToolDetails = {
			projectAgentsDir: null,
			results: [],
			totalDurationMs: 1,
			progress: [progress],
		};
		const render = (spinnerFrame: number) =>
			strip(
				renderResult(
					{ content: [{ type: "text", text: "Running 1 agent..." }], details },
					{ expanded: false, isPartial: true, spinnerFrame },
					uiTheme,
				).render(120),
			);

		expect(render(0)).toBe(render(1));
	});
});

describe("taskCardAgentIds", () => {
	function makeResult(id: string): SingleResult {
		return {
			index: 0,
			id,
			agent: "task",
			agentSource: "bundled",
			task: "do work",
			exitCode: 0,
			output: "done",
			stderr: "",
			truncated: false,
			durationMs: 1,
			tokens: 0,
			requests: 1,
		};
	}

	it("collects in-flight progress ids before any result settles", () => {
		const details: TaskToolDetails = {
			projectAgentsDir: null,
			results: [],
			totalDurationMs: 1,
			progress: [
				{ ...makeProgress([]), id: "LiveOne" },
				{ ...makeProgress([]), id: "LiveTwo" },
			],
		};
		expect(taskCardAgentIds(details)).toEqual(["LiveOne", "LiveTwo"]);
	});

	it("unions settled result ids and dedupes repeats", () => {
		const details: TaskToolDetails = {
			projectAgentsDir: null,
			results: [makeResult("DoneOne"), makeResult("DoneOne")],
			totalDurationMs: 1,
			progress: [{ ...makeProgress([]), id: "DoneOne" }],
		};
		expect(taskCardAgentIds(details)).toEqual(["DoneOne"]);
	});

	it("collects nested worker ids from extracted task snapshots", () => {
		const nested: TaskToolDetails = {
			projectAgentsDir: null,
			results: [makeResult("NestedDone")],
			totalDurationMs: 1,
			progress: [{ ...makeProgress([]), id: "NestedLive" }],
		};
		const inflight: TaskToolDetails = {
			projectAgentsDir: null,
			results: [],
			totalDurationMs: 1,
			progress: [{ ...makeProgress([]), id: "InflightLive" }],
		};
		const details: TaskToolDetails = {
			projectAgentsDir: null,
			results: [],
			totalDurationMs: 1,
			progress: [
				{
					...makeProgress([]),
					id: "Outer",
					extractedToolData: { task: [nested] },
					inflightTaskDetails: inflight,
				},
			],
		};
		expect(taskCardAgentIds(details)).toEqual(["Outer", "NestedDone", "NestedLive", "InflightLive"]);
	});

	it("ignores non-task shapes without throwing", () => {
		expect(taskCardAgentIds(undefined)).toEqual([]);
		expect(taskCardAgentIds(null)).toEqual([]);
		expect(taskCardAgentIds({ results: [{ id: 42 }, null, {}] })).toEqual([]);
	});
});

// Regression for the live batch-dispatch bug: a task card drew the shared
// `context` body TWICE (a flat-hybrid dispatch carries the batch `context`
// plus a top-level `task` echoing it; the task tool's lenient argument
// validation lets that key survive into render args), and a pure batch card
// had no per-task brief at all. The card must render the context section
// exactly once and surface the single batch item's `task` as the assignment.
describe("task card batch context and assignment briefs", () => {
	const CONTEXT =
		"# Live TUI render demo — visible task card for the user\nYou are a demo subagent. Do NOT edit any files. Only run `sleep` via bash and report progress in your final output.";
	const CONTEXT_BODY =
		"You are a demo subagent. Do NOT edit any files. Only run sleep via bash and report progress in your final output.";
	const DEMO_TASK =
		"Run three sequential `sleep 20` calls via the bash tool and report progress in your final output.";
	const DEMO_TASK_PLAIN =
		"Run three sequential sleep 20 calls via the bash tool and report progress in your final output.";

	const batchArgs = (overrides?: Partial<TaskParams>): TaskParams => ({
		context: CONTEXT,
		tasks: [
			{
				name: "TuiRenderDemo",
				effort: "lo",
				solutionSpace: "Mechanical demo run; nothing open-ended.",
				task: DEMO_TASK,
			},
		],
		...overrides,
	});

	function settledDetails(): TaskToolDetails {
		return {
			projectAgentsDir: null,
			results: [
				{
					index: 0,
					id: "TuiRenderDemo",
					agent: "task",
					agentSource: "bundled",
					task: DEMO_TASK,
					exitCode: 0,
					output: "TuiRenderDemo done, ~60s elapsed",
					stderr: "",
					truncated: false,
					durationMs: 61234,
					tokens: 0,
					requests: 4,
				},
			],
			totalDurationMs: 61234,
		};
	}

	function renderCard(args: TaskParams, uiTheme: Theme): string {
		setViewportRows(40);
		const component = renderResult(
			{ content: [{ type: "text", text: "1 agent completed" }], details: settledDetails() },
			{ expanded: false, isPartial: false },
			uiTheme,
			args,
		);
		return strip(component.render(150));
	}

	function countOccurrences(text: string, needle: string): number {
		return text.split(needle).length - 1;
	}

	let uiTheme: Theme;

	beforeAll(async () => {
		const loaded = await getThemeByName("dark");
		if (!loaded) throw new Error("theme unavailable");
		uiTheme = loaded;
		setThemeInstance(uiTheme);
	});

	afterEach(() => {
		restoreViewportRows();
	});

	it("renders a flat-hybrid `task` echoing the context body once, with the real batch task text", () => {
		const text = renderCard(batchArgs({ task: CONTEXT_BODY }), uiTheme);
		expect(countOccurrences(text, CONTEXT_BODY)).toBe(1);
		expect(text).toContain("Live TUI render demo — visible task card for the user");
		expect(text).toContain(DEMO_TASK_PLAIN);
	});

	it("surfaces tasks[0].task as the assignment for a single-task batch with no top-level task", () => {
		const text = renderCard(batchArgs(), uiTheme);
		expect(countOccurrences(text, CONTEXT_BODY)).toBe(1);
		expect(text).toContain(DEMO_TASK_PLAIN);
	});

	it("keeps a multi-task batch context-only, without lifting one item's task as the assignment", () => {
		const args = batchArgs();
		args.tasks = [
			...(args.tasks ?? []),
			{ name: "SecondDemo", task: "Second demo task body.", solutionSpace: "one fix: nothing open." },
		];
		const text = renderCard(args, uiTheme);
		expect(countOccurrences(text, CONTEXT_BODY)).toBe(1);
		expect(text).not.toContain(DEMO_TASK_PLAIN);
		expect(text).not.toContain("Second demo task body.");
	});

	it("keeps a distinct flat task beside the context without deduping", () => {
		const text = renderCard({ name: "SoloDemo", task: "Distinct assignment prose.", context: CONTEXT }, uiTheme);
		expect(countOccurrences(text, CONTEXT_BODY)).toBe(1);
		expect(text).toContain("Distinct assignment prose.");
	});

	it("renders the streaming call preview without the echoed context line", () => {
		setViewportRows(40);
		const component = renderCall(batchArgs({ task: CONTEXT_BODY }), { expanded: false, isPartial: true }, uiTheme);
		const text = strip(component.render(150));
		expect(countOccurrences(text, CONTEXT_BODY)).toBe(1);
		expect(text).toContain("Run three sequential `sleep 20` calls");
	});
});
