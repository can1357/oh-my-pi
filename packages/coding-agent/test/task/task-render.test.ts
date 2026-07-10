import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { RenderResultOptions } from "@pk-nerdsaver-ai/pi-agent-core";
import { resetSettingsForTest, Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { getThemeByName } from "@pk-nerdsaver-ai/pi-coding-agent/modes/theme/theme";
import { taskToolRenderer } from "@pk-nerdsaver-ai/pi-coding-agent/task/render";
import type { AgentProgress, SingleResult, TaskToolDetails } from "@pk-nerdsaver-ai/pi-coding-agent/task/types";

function progress(overrides: Partial<AgentProgress> = {}): AgentProgress {
	return {
		index: 0,
		id: "RecoveryWorker",
		agent: "task",
		agentSource: "bundled",
		status: "running",
		task: "repair the assignment",
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 0,
		tokens: 0,
		cost: 0,
		durationMs: 0,
		...overrides,
	};
}

function result(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id: "RecoveryWorker",
		agent: "task",
		agentSource: "bundled",
		task: "repair the assignment",
		exitCode: 0,
		output: "typed result",
		stderr: "",
		truncated: false,
		durationMs: 10,
		tokens: 0,
		requests: 0,
		...overrides,
	};
}

async function render(details: TaskToolDetails, isPartial: boolean): Promise<string> {
	const theme = await getThemeByName("dark");
	if (!theme) throw new Error("dark theme unavailable");
	const options: RenderResultOptions = { expanded: false, isPartial, spinnerFrame: 0 };
	return Bun.stripANSI(
		taskToolRenderer
			.renderResult({ content: [{ type: "text", text: "" }], details }, options, theme)
			.render(160)
			.join("\n"),
	);
}

describe("task structured recovery rendering", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("renders typed recovery and verification fields for live progress without parsing error strings", async () => {
		const details: TaskToolDetails = {
			projectAgentsDir: null,
			results: [],
			totalDurationMs: 0,
			progress: [
				progress({
					recoveryAttempt: 2,
					recoveryTier: "mid",
					recoveryProvider: "siliconflow",
					failureClass: "spawn_transport",
					nextRecoveryAction: "retry",
					assignmentVerificationStatus: "verifying",
					recentOutput: ["opaque failure text with no recovery metadata"],
				}),
			],
		};

		const rendered = await render(details, true);
		expect(rendered).toContain("attempt 2");
		expect(rendered).toContain("tier mid");
		expect(rendered).toContain("provider siliconflow");
		expect(rendered).toContain("failure spawn_transport");
		expect(rendered).toContain("next retry");
		expect(rendered).toContain("verification verifying");
	});

	it("renders typed recovery and verification fields for final results independently of error text", async () => {
		const details: TaskToolDetails = {
			projectAgentsDir: null,
			results: [
				result({
					exitCode: 1,
					error: "unstructured provider failure",
					recoveryAttempt: 3,
					recoveryTier: "frontier",
					recoveryProvider: "openrouter",
					failureClass: "acceptance",
					nextRecoveryAction: "stop",
					assignmentVerificationStatus: "verification_failed",
				}),
			],
			totalDurationMs: 10,
		};

		const rendered = await render(details, false);
		expect(rendered).toContain("attempt 3");
		expect(rendered).toContain("tier frontier");
		expect(rendered).toContain("provider openrouter");
		expect(rendered).toContain("failure acceptance");
		expect(rendered).toContain("next stop");
		expect(rendered).toContain("verification verification_failed");
	});
});
