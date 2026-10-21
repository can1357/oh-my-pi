import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

const AGENTS = [
	{
		name: "task",
		description: "General-purpose task agent",
		systemPrompt: "You are a task agent.",
		source: "bundled" as const,
	},
];

function createSession(cwd: string, enableEffort: boolean): ToolSession {
	return {
		cwd,
		hasUI: false,
		settings: Settings.isolated({ "task.enableEffort": enableEffort }),
		effectiveExtensionRoots: () => ({ explicit: [], mode: "merge", configured: [], configuredLevel: "user" }),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	} as unknown as ToolSession;
}

describe("task tool effort guidance", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("tells the model to default to lo and reserve hi for open solution spaces when effort is enabled", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: AGENTS, projectAgentsDir: null });

		const tool = await TaskTool.create(createSession("/tmp/omp-effort-guidance-on", true));

		expect(tool.description).toContain("Default `lo` for lookups, mechanical edits, and known fixes");
		expect(tool.description).toContain("Use `hi` only when `solutionSpace` names genuinely open choices");
	});

	it("omits the effort guidance when the effort field is not exposed", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: AGENTS, projectAgentsDir: null });

		const tool = await TaskTool.create(createSession("/tmp/omp-effort-guidance-off", false));

		expect(tool.description).not.toContain("`effort`");
		expect(tool.description).not.toContain("Use `hi` only");
	});
});
