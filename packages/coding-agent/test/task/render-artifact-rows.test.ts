import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { SingleResult, TaskToolDetails } from "@oh-my-pi/pi-coding-agent/task";
import { taskToolRenderer } from "@oh-my-pi/pi-coding-agent/task/renderer";

// Regression for PR #11343 review: sanitizing the isolation artifact rows
// (shortenPath + width bound) dropped the `Patch:` / `Branch:` /
// `Nested patch:` labels, so co-displayed artifacts were indistinguishable.
// Labels must survive sanitization.
describe("task renderer: isolation artifact row labels", () => {
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

	function makeResult(overrides: Partial<SingleResult>): SingleResult {
		return {
			index: 0,
			id: "artifacts",
			agent: "task",
			agentSource: "bundled",
			task: "do work",
			assignment: "do work",
			description: "do work",
			exitCode: 0,
			output: "done",
			stderr: "",
			truncated: false,
			durationMs: 250,
			tokens: 0,
			requests: 0,
			...overrides,
		};
	}

	async function renderResultText(result: SingleResult): Promise<string> {
		const theme = (await getThemeByName("dark"))!;
		const details: TaskToolDetails = {
			projectAgentsDir: null,
			results: [result],
			totalDurationMs: 250,
		};
		const component = taskToolRenderer.renderResult(
			{ content: [{ type: "text", text: "" }], details },
			{ expanded: false, isPartial: false, spinnerFrame: 0 },
			theme,
		);
		return Bun.stripANSI(component.render(160).join("\n"));
	}

	it("keeps the Patch and Nested patch labels on sanitized artifact rows", async () => {
		const text = await renderResultText(
			makeResult({
				patchPath: "/home/user/.omp/artifacts/Worker.patch",
				nestedPatchPaths: ["/home/user/.omp/artifacts/Worker.nested-0-inner.patch"],
			}),
		);
		expect(text).toContain("Patch:");
		expect(text).toContain("Nested patch:");
	});

	it("keeps the Branch label on sanitized artifact rows", async () => {
		const text = await renderResultText(makeResult({ branchName: "omp/task/Worker" }));
		expect(text).toContain("Branch:");
	});

	it("hides the empty root Patch row for nested-only work", async () => {
		const text = await renderResultText(
			makeResult({
				patchPath: "/home/user/.omp/artifacts/Worker.patch",
				hasRootChanges: false,
				nestedPatchPaths: ["/home/user/.omp/artifacts/Worker.nested-0-inner.patch"],
			}),
		);
		expect(text).not.toContain("Patch:");
		expect(text).toContain("Nested patch:");
	});
});
