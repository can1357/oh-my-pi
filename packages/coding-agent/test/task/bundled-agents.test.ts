import { afterEach, describe, expect, it } from "bun:test";
import { loadBundledAgents, clearBundledAgentsCache } from "@pk-nerdsaver-ai/pi-coding-agent/task/agents";
import type { AgentDefinition } from "@pk-nerdsaver-ai/pi-coding-agent/task/types";

describe("bundled agents contract", () => {
	afterEach(() => {
		clearBundledAgentsCache();
	});

	function agentByName(agents: AgentDefinition[], name: string): AgentDefinition {
		const agent = agents.find(a => a.name === name);
		expect(agent, `agent "${name}" not found in bundled agents`).toBeDefined();
		return agent!;
	}

	const NEW_AGENTS = ["mr-worker", "mr-reducer", "tot-reasoner"] as const;

	it("loadBundledAgents includes the three new bundled agents", () => {
		const agents = loadBundledAgents();
		for (const name of NEW_AGENTS) {
			expect(agents.some(a => a.name === name), `expected "${name}" to be in bundled agents`).toBe(true);
		}
	});

	it("each new agent has a non-empty description", () => {
		const agents = loadBundledAgents();
		for (const name of NEW_AGENTS) {
			const agent = agentByName(agents, name);
			expect(typeof agent.description === "string" && agent.description.length > 0).toBe(true);
		}
	});

	it("each new agent has a non-empty systemPrompt", () => {
		const agents = loadBundledAgents();
		for (const name of NEW_AGENTS) {
			const agent = agentByName(agents, name);
			expect(typeof agent.systemPrompt === "string" && agent.systemPrompt.length > 0).toBe(true);
		}
	});

	it("mr-worker and mr-reducer have a parsed output schema with a findings property", () => {
		const agents = loadBundledAgents();
		for (const name of ["mr-worker", "mr-reducer"]) {
			const agent = agentByName(agents, name);
			expect(agent.output, `expected "${name}" to have an output schema`).toBeDefined();
			const output = agent.output as Record<string, unknown>;
			expect(
				output && typeof output === "object" && "properties" in output,
				`expected "${name}" output to have a "properties" key`,
			).toBe(true);
			const properties = (output as Record<string, unknown>).properties as Record<string, unknown> | undefined;
			expect(
				properties && "findings" in properties,
				`expected "${name}" output.properties to have a "findings" field`,
			).toBe(true);
		}
	});

	it("tot-reasoner tools include read but not edit, write, or bash", () => {
		const agents = loadBundledAgents();
		const tot = agentByName(agents, "tot-reasoner");
		expect(tot.tools, "tot-reasoner should have tools").toBeDefined();
		const tools = tot.tools!;

		expect(tools.map(t => t.toLowerCase())).toContain("read");
		expect(tools.map(t => t.toLowerCase())).not.toContain("edit");
		expect(tools.map(t => t.toLowerCase())).not.toContain("write");
		expect(tools.map(t => t.toLowerCase())).not.toContain("bash");
	});
});
