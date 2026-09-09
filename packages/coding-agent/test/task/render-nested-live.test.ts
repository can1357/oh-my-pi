import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AgentProgress, SingleResult, TaskToolDetails } from "@oh-my-pi/pi-coding-agent/task";
import { taskToolRenderer } from "@oh-my-pi/pi-coding-agent/task/renderer";
import { formatDuration, formatNumber } from "@oh-my-pi/pi-utils";

describe("task renderer: nested live rendering", () => {
	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		setThemeInstance(theme!);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	// Defends the live-rendering contract for the `task` tool: while a Level-1
	// subagent is still mid-flight, any nested `task` activity it has produced
	// (already-completed sub-calls in `extractedToolData.task`, plus the in-flight
	// snapshot in `inflightTaskDetails`) MUST surface in the parent's streaming
	// output — same way it surfaces in the finished result.

	function makeRunningProgress(overrides: Partial<AgentProgress>): AgentProgress {
		return {
			index: 0,
			id: "parent",
			agent: "task",
			agentSource: "bundled",
			status: "running",
			task: "parent assignment",
			assignment: "parent assignment",
			description: "Parent Level 1 work",
			recentTools: [],
			recentOutput: [],
			toolCount: 1,
			requests: 0,
			tokens: 1000,
			cost: 0,
			durationMs: 1234,
			...overrides,
		};
	}

	function makeCompletedSubResult(id: string, description: string): SingleResult {
		return {
			index: 0,
			id,
			agent: "task",
			agentSource: "bundled",
			task: "sub assignment",
			assignment: "sub assignment",
			description,
			exitCode: 0,
			output: "sub-final-output",
			stderr: "",
			truncated: false,
			durationMs: 500,
			tokens: 200,
			requests: 0,
		};
	}

	function makeRunningSubProgress(id: string, description: string): AgentProgress {
		return {
			index: 0,
			id,
			agent: "task",
			agentSource: "bundled",
			status: "running",
			task: "sub assignment",
			assignment: "sub assignment",
			description,
			recentTools: [],
			recentOutput: [],
			toolCount: 0,
			requests: 0,
			tokens: 0,
			cost: 0,
			durationMs: 0,
		};
	}

	async function render(progress: AgentProgress): Promise<string> {
		const theme = (await getThemeByName("dark"))!;
		const details: TaskToolDetails = {
			projectAgentsDir: null,
			results: [],
			totalDurationMs: 1234,
			progress: [progress],
		};
		const component = taskToolRenderer.renderResult(
			{ content: [{ type: "text", text: "Running 1 agents..." }], details },
			{ expanded: false, isPartial: true, spinnerFrame: 0 },
			theme,
		);
		return Bun.stripANSI(component.render(160).join("\n"));
	}

	it("renders completed nested task results stored in extractedToolData.task while parent is in-progress", async () => {
		const parent = makeRunningProgress({
			id: "Parent",
			recentTools: [{ tool: "task", args: "", endMs: Date.now() }],
			extractedToolData: {
				task: [
					{
						projectAgentsDir: null,
						results: [
							makeCompletedSubResult("Parent.AlphaSub", "Alpha child"),
							makeCompletedSubResult("Parent.BetaSub", "Beta child"),
						],
						totalDurationMs: 1000,
					} satisfies TaskToolDetails,
				],
			},
		});

		const text = await render(parent);

		// Parent label is intact.
		expect(text).toContain("Parent Level 1 work");
		// Both nested completed children labels surface (formatTaskId renders the
		// dotted hierarchy as a "Parent>AlphaSub" breadcrumb).
		expect(text).toContain("Alpha child");
		expect(text).toContain("Beta child");
		expect(text).toContain("Parent>AlphaSub");
		expect(text).toContain("Parent>BetaSub");
	});

	it("renders the in-flight nested task snapshot (progress[]) before the call ends", async () => {
		const inflight: TaskToolDetails = {
			projectAgentsDir: null,
			results: [],
			totalDurationMs: 0,
			progress: [
				makeRunningSubProgress("Parent.GammaSub", "Gamma child running"),
				makeRunningSubProgress("Parent.DeltaSub", "Delta child running"),
			],
		};
		const parent = makeRunningProgress({
			id: "Parent",
			currentTool: "task",
			currentToolStartMs: Date.now(),
			inflightTaskDetails: inflight,
		});

		const text = await render(parent);

		expect(text).toContain("Parent Level 1 work");
		expect(text).toContain("Gamma child running");
		expect(text).toContain("Delta child running");
		expect(text).toContain("Parent>GammaSub");
		expect(text).toContain("Parent>DeltaSub");
	});

	it("does not recurse forever when a nested task snapshot points at itself", async () => {
		const inflight: TaskToolDetails = {
			projectAgentsDir: null,
			results: [],
			totalDurationMs: 0,
			progress: [],
		};
		const child = makeRunningSubProgress("Parent.CycleSub", "Cycle child running");
		child.inflightTaskDetails = inflight;
		inflight.progress = [child];
		const parent = makeRunningProgress({
			id: "Parent",
			currentTool: "task",
			currentToolStartMs: Date.now(),
			inflightTaskDetails: inflight,
		});

		const text = await render(parent);

		expect(text).toContain("Cycle child running");
		expect(text).toContain("nested task progress already shown");
	});

	it("combines completed and in-flight nested snapshots in one tree", async () => {
		const parent = makeRunningProgress({
			currentTool: "task",
			extractedToolData: {
				task: [
					{
						projectAgentsDir: null,
						results: [makeCompletedSubResult("Parent.EpsilonSub", "Epsilon done")],
						totalDurationMs: 1000,
					} satisfies TaskToolDetails,
				],
			},
			inflightTaskDetails: {
				projectAgentsDir: null,
				results: [],
				totalDurationMs: 0,
				progress: [makeRunningSubProgress("Parent.ZetaSub", "Zeta running")],
			},
		});

		const text = await render(parent);

		expect(text).toContain("Epsilon done");
		expect(text).toContain("Zeta running");
		// Completed entry shows "done" badge, in-flight does not.
		const epsilonIdx = text.indexOf("Epsilon done");
		const zetaIdx = text.indexOf("Zeta running");
		// Completed entries are emitted before the in-flight snapshot.
		expect(epsilonIdx).toBeLessThan(zetaIdx);
	});

	it("formats running progress stats with tool icon, context window, and cost", async () => {
		const theme = (await getThemeByName("dark"))!;
		const text = await render(
			makeRunningProgress({
				toolCount: 19,
				contextTokens: 58_000,
				contextWindow: 272_000,
				cost: 2.1,
				durationMs: 0,
			}),
		);

		// Context now matches the status line gauge: 58000/272000 → 21.3%/272K.
		// Cost is separated by the theme dot separator, not a literal ".".
		const expectedStats = `${formatNumber(19)} ${theme.icon.extensionTool}${theme.sep.dot}21.3%/272K${theme.sep.dot}$2.10`;
		expect(text).toContain(expectedStats);
		expect(text).not.toContain("tools");
		expect(text).not.toContain("ctx");
		expect(text).not.toContain("Σ");
	});

	it("renders a static result header and static running task row", async () => {
		const theme = (await getThemeByName("dark"))!;
		const details: TaskToolDetails = {
			projectAgentsDir: null,
			results: [],
			totalDurationMs: 0,
			progress: [makeRunningProgress({ id: "Probe", description: "Investigate padding" })],
		};
		let now = 0;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const renderAt = (timeMs: number): string[] => {
			now = timeMs;
			const component = taskToolRenderer.renderResult(
				{ content: [{ type: "text", text: "Running 1 agents..." }], details },
				{ expanded: false, isPartial: true, spinnerFrame: 0 },
				theme,
			);
			return component.render(160).join("\n").split("\n");
		};
		const f0 = renderAt(0);
		const f1 = renderAt(700);
		const header0 = f0.find(l => Bun.stripANSI(l).includes("Task"))!;
		const header1 = f1.find(l => Bun.stripANSI(l).includes("Task"))!;
		const body0 = f0.find(l => Bun.stripANSI(l).includes("Probe"))!;
		const body1 = f1.find(l => Bun.stripANSI(l).includes("Probe"))!;
		// Header and per-agent body rows are static; only the tool header owns live animation.
		expect(header0).toBe(header1);
		expect(body0).toBe(body1);
		expect(Bun.stripANSI(body1)).toContain(`${theme.status.done} Probe: Investigate padding`);
	});

	it("wraps the completed run summary in bracket glyphs, dropping the Total: label", async () => {
		const theme = (await getThemeByName("dark"))!;
		const ok = makeCompletedSubResult("Alpha", "did the thing");
		const bad: SingleResult = { ...makeCompletedSubResult("Beta", "blew up"), exitCode: 1, error: "boom" };
		const details: TaskToolDetails = {
			projectAgentsDir: null,
			results: [ok, bad],
			totalDurationMs: 39_400,
		};
		const component = taskToolRenderer.renderResult(
			{ content: [{ type: "text", text: "2 agents completed" }], details },
			{ expanded: false, isPartial: false },
			theme,
		);
		const text = Bun.stripANSI(component.render(160).join("\n"));
		// Bash-style bracketed footer: dim bracket chrome wrapping colored counts,
		// with no "Total:" prefix between the bracket and the first count.
		const expected = `${theme.format.bracketLeft}1 succeeded${theme.sep.dot}1 failed${theme.sep.dot}${formatDuration(39_400)}${theme.format.bracketRight}`;
		expect(text).toContain(expected);
		expect(text).not.toContain("Total:");
	});
});
