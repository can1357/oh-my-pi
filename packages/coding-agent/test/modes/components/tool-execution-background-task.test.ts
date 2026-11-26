import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentProgress, SingleResult, TaskToolDetails } from "@oh-my-pi/pi-coding-agent/task/task-details";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import type { ToolCall } from "../../../src/ui/transcript/tool-block";
import { toolCall, toolCallText } from "../../helpers/tool-text";

function progressEntry(description: string): AgentProgress {
	return {
		index: 0,
		id: "Anna",
		agent: "scout",
		agentSource: "bundled",
		status: "running",
		task: "investigate the auth flow",
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

function asyncSnapshot(description: string): {
	content: Array<{ type: string; text: string }>;
	details: TaskToolDetails;
} {
	return {
		content: [{ type: "text", text: "Background job started" }],
		details: {
			projectAgentsDir: null,
			results: [],
			totalDurationMs: 0,
			progress: [progressEntry(description)],
			async: { state: "running", jobId: "job-1", type: "task" },
		},
	};
}

function finalSnapshot(output: string): {
	content: Array<{ type: string; text: string }>;
	details: TaskToolDetails;
} {
	const result: SingleResult = {
		index: 0,
		id: "Anna",
		agent: "scout",
		agentSource: "bundled",
		task: "investigate the auth flow",
		exitCode: 0,
		output,
		stderr: "",
		truncated: false,
		durationMs: 1234,
		tokens: 10,
		requests: 1,
	};
	return {
		content: [{ type: "text", text: output }],
		details: {
			projectAgentsDir: null,
			results: [result],
			totalDurationMs: 1234,
			async: { state: "completed", jobId: "job-1", type: "task" },
		},
	};
}

function makeCall(): ToolCall {
	return toolCall({
		name: "task",
		args: { agent: "scout", id: "Anna", description: "scout auth", assignment: "investigate the auth flow" },
	});
}

const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

describe("task tool card detached lifecycle", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true, cwd: process.cwd() });
	});

	it("keeps accepting live progress snapshots until settlement", () => {
		const call = makeCall();
		call.updateResult(asyncSnapshot("initial progress"), true);
		call.updateResult(asyncSnapshot("latest progress"), true);

		const rendered = toolCallText(call, 100);
		expect(rendered).toContain("latest progress");
		expect(rendered).not.toContain("initial progress");
	});

	it("applies the terminal result after live progress", () => {
		const call = makeCall();
		call.updateResult(asyncSnapshot("scouting the auth flow"), true);
		call.updateResult(finalSnapshot("found it in src/auth.ts"), false);

		expect(toolCallText(call, 100)).toContain("found it in src/auth.ts");
	});
});
