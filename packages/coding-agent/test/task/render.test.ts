import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "../../src/config/settings";
import { getThemeByName, setThemeInstance, type Theme } from "../../src/modes/theme/theme";
import { renderResult } from "../../src/task/render";
import { taskToolRenderer } from "../../src/task/renderer";
import type { AgentProgress, SingleResult, TaskToolDetails } from "../../src/task/types";

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
		await Settings.init({ inMemory: true });
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
