import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { type AgentDefinition, TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

const AGENTS: AgentDefinition[] = [
	{
		name: "task",
		description: "General-purpose task agent",
		systemPrompt: "You are a task agent.",
		source: "bundled",
	},
	{
		name: "lookout",
		description: "Shell-less researcher",
		systemPrompt: "You are a researcher.",
		tools: ["read", "grep", "yield"],
		source: "bundled",
	},
];

function createSession(): ToolSession {
	return {
		cwd: "/tmp/omp-agent-list-tools",
		hasUI: false,
		settings: Settings.isolated(),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	} as unknown as ToolSession;
}

function agentLine(description: string, name: string): string {
	const line = description.split("\n").find(entry => entry.startsWith(`- \`${name}\``));
	if (line === undefined) throw new Error(`agent ${name} missing from task description`);
	return line;
}

describe("task description agent tool grants", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("lists each restricted agent's tools so the spawner can see a missing shell", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: AGENTS, projectAgentsDir: null });
		const tool = await TaskTool.create(createSession());

		const restricted = agentLine(tool.description, "lookout");
		expect(restricted).toContain("read, grep");
		expect(restricted).not.toContain("yield");
		expect(restricted).not.toContain("bash");

		// Unrestricted agents get the full toolset; no grant is advertised.
		expect(agentLine(tool.description, "task")).not.toContain("tools:");
	});
});
