import { beforeAll, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AgentProgress, SingleResult, TaskToolDetails } from "@oh-my-pi/pi-coding-agent/task/types";
import type { TUI } from "@oh-my-pi/pi-tui";

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

function makeComponent(): ToolExecutionComponent {
	const ui = { requestRender: vi.fn(), requestComponentRender: vi.fn() } as unknown as TUI;
	return new ToolExecutionComponent(
		"task",
		{ agent: "scout", id: "Anna", description: "scout auth", assignment: "investigate the auth flow" },
		{},
		undefined,
		ui,
	);
}

describe("ToolExecutionComponent detached task lifecycle", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		await initTheme();
	});

	it("keeps accepting live progress snapshots until settlement", () => {
		const component = makeComponent();
		component.updateResult(asyncSnapshot("initial progress"), true);
		component.updateResult(asyncSnapshot("latest progress"), true);

		const rendered = stripVTControlCharacters(component.render(100).join("\n"));
		expect(rendered).toContain("latest progress");
		expect(rendered).not.toContain("initial progress");
	});

	it("applies the terminal result after live progress", () => {
		const component = makeComponent();
		component.updateResult(asyncSnapshot("scouting the auth flow"), true);
		component.updateResult(finalSnapshot("found it in src/auth.ts"), false);

		const rendered = stripVTControlCharacters(component.render(100).join("\n"));
		expect(rendered).toContain("found it in src/auth.ts");
	});
});
