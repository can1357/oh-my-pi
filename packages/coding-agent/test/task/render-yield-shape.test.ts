import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AgentProgress, SingleResult, TaskToolDetails } from "@oh-my-pi/pi-coding-agent/task";
import { taskToolRenderer } from "@oh-my-pi/pi-coding-agent/task/renderer";

// Regression for #1987: when a subagent stores a non-array value in
// `extractedToolData.yield`, the renderer cast it to `Array<{ data }>` and
// then called `?.map`. Optional chaining only short-circuits on null/undefined,
// so a plain object made `.map` undefined and crashed the TUI with
// `TypeError: completeData?.map is not a function`. The renderer must tolerate
// both shapes (array and single object) without throwing, on both the live
// progress branch (`renderAgentProgress`) and the final result branch
// (`renderAgentResult`).
describe("task renderer: malformed yield slot (#1987)", () => {
	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		setThemeInstance(theme!);
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	const reviewVerdict = {
		overall_correctness: "correct",
		confidence: 0.92,
		explanation: "Looks good.",
	};

	function makeCompletedResult(extractedToolData: Record<string, unknown>): SingleResult {
		return {
			index: 0,
			id: "reviewer",
			agent: "reviewer",
			agentSource: "bundled",
			task: "review the patch",
			assignment: "review the patch",
			description: "review the patch",
			exitCode: 0,
			output: "",
			stderr: "",
			truncated: false,
			durationMs: 250,
			tokens: 100,
			requests: 0,
			// Cast deliberately: production typings declare `unknown[]`, but the
			// renderer must defend against a stray non-array value — that's
			// exactly what this regression test exercises.
			extractedToolData: extractedToolData as Record<string, unknown[]>,
		};
	}

	function makeCompletedProgress(extractedToolData: Record<string, unknown>): AgentProgress {
		return {
			index: 0,
			id: "reviewer",
			agent: "reviewer",
			agentSource: "bundled",
			status: "completed",
			task: "review the patch",
			assignment: "review the patch",
			description: "review the patch",
			recentTools: [],
			recentOutput: [],
			toolCount: 1,
			requests: 0,
			tokens: 100,
			cost: 0,
			durationMs: 250,
			extractedToolData: extractedToolData as Record<string, unknown[]>,
		};
	}

	async function renderResultText(extractedToolData: Record<string, unknown>): Promise<string> {
		const theme = (await getThemeByName("dark"))!;
		const details: TaskToolDetails = {
			projectAgentsDir: null,
			results: [makeCompletedResult(extractedToolData)],
			totalDurationMs: 250,
		};
		const component = taskToolRenderer.renderResult(
			{ content: [{ type: "text", text: "" }], details },
			{ expanded: false, isPartial: false, spinnerFrame: 0 },
			theme,
		);
		return Bun.stripANSI(component.render(160).join("\n"));
	}

	async function renderProgressText(extractedToolData: Record<string, unknown>): Promise<string> {
		const theme = (await getThemeByName("dark"))!;
		const details: TaskToolDetails = {
			projectAgentsDir: null,
			results: [],
			totalDurationMs: 250,
			progress: [makeCompletedProgress(extractedToolData)],
		};
		const component = taskToolRenderer.renderResult(
			{ content: [{ type: "text", text: "" }], details },
			{ expanded: false, isPartial: true, spinnerFrame: 0 },
			theme,
		);
		return Bun.stripANSI(component.render(160).join("\n"));
	}

	it("does not throw and still surfaces the verdict when yield is a single object (result branch)", async () => {
		const text = await renderResultText({
			yield: { data: reviewVerdict, status: "success" },
		});
		expect(text).toContain("correct");
	});

	it("does not throw and still surfaces the verdict when yield is a single object (progress branch)", async () => {
		const text = await renderProgressText({
			yield: { data: reviewVerdict, status: "success" },
		});
		expect(text).toContain("correct");
	});

	it("does not throw when yield is a non-object primitive (both branches)", async () => {
		// Primitives can't carry a verdict — renderer must drop them silently
		// instead of crashing.
		await expect(renderResultText({ yield: "not-an-array" })).resolves.toBeString();
		await expect(renderProgressText({ yield: 42 })).resolves.toBeString();
	});

	it("still renders the canonical array shape unchanged", async () => {
		const text = await renderResultText({
			yield: [{ data: reviewVerdict, status: "success" }],
		});
		expect(text).toContain("correct");
	});

	it("renders typed yield sections compactly in the result branch", async () => {
		const text = await renderResultText({
			yield: [
				{ type: ["summary"], data: "first note", status: "success" },
				{ type: ["summary", "details"], data: { ok: true }, status: "success" },
				{ type: "final", data: "done", status: "success" },
			],
		});

		expect(text).toContain("yield+[summary]");
		expect(text).toContain("yield+[summary, details]");
		expect(text).toContain("yield[final]");
		expect(text).toContain("done");
	});

	it("renders typed yield sections compactly in the progress branch", async () => {
		const text = await renderProgressText({
			yield: { type: ["notes"], useLastTurn: true, status: "success" },
		});

		expect(text).toContain("yield+[notes]");
		expect(text).toContain("last assistant turn");
	});

	it("renders reviewer results assembled from incremental yield sections", async () => {
		const text = await renderResultText({
			yield: [
				{
					type: ["findings"],
					data: {
						title: "Handle null response",
						body: "Null response reaches the formatter and crashes rendering.",
						priority: 1,
						confidence: 0.8,
						file_path: "src/review.ts",
						line_start: 42,
						line_end: 42,
					},
					status: "success",
				},
				{ type: ["overall_correctness"], data: "incorrect", status: "success" },
				{ type: ["explanation"], data: "One bug blocks approval.", status: "success" },
				{ type: ["confidence"], data: 0.8, status: "success" },
			],
		});

		expect(text).toContain("Patch is incorrect");
		expect(text).toContain("Findings:");
		expect(text).toContain("Handle null response");
	});
});
