import { describe, expect, it } from "bun:test";
import { isReadOnlyAgent } from "@oh-my-pi/pi-coding-agent/task";
import { loadBundledAgents } from "@oh-my-pi/pi-coding-agent/task/agents";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";

function agentByName(agents: AgentDefinition[], name: string): AgentDefinition {
	const agent = agents.find(candidate => candidate.name === name);
	expect(agent).toBeDefined();
	return agent as AgentDefinition;
}

describe("task agent capability descriptions", () => {
	it("classifies bundled scout as the only read-only delegated agent", () => {
		const agents = loadBundledAgents();

		expect(isReadOnlyAgent(agentByName(agents, "scout"))).toBe(true);
		for (const name of ["task", "sonic", "reviewer"]) {
			expect(isReadOnlyAgent(agentByName(agents, name))).toBe(false);
		}
	});

	it("keeps read tools read-only while any exec-tier or unknown tool disqualifies the agent", () => {
		const scout = agentByName(loadBundledAgents(), "scout");

		expect(isReadOnlyAgent({ ...scout, tools: ["read", "grep", "yield"] })).toBe(true);
		expect(isReadOnlyAgent({ ...scout, tools: ["read", "grep", "bash"] })).toBe(false);
		// The removed built-in `wait` is now an unknown name: fail-safe, not read-only.
		expect(isReadOnlyAgent({ ...scout, tools: ["read", "grep", "wait"] })).toBe(false);
	});
});
