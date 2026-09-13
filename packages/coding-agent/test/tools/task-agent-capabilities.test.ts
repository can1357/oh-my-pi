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
	it("classifies from the effective post-disallow tool set", () => {
		// `disallowedTools:` can strip a mutating tool, leaving a read-only
		// scope that the declared list alone would mark writable.
		const base: AgentDefinition = {
			name: "x",
			description: "x",
			systemPrompt: "x",
			source: "bundled",
		};
		expect(
			isReadOnlyAgent({
				...base,
				tools: ["read", "write"],
				disallowedTools: ["write"],
			}),
		).toBe(true);
		expect(
			isReadOnlyAgent({
				...base,
				tools: ["read", "write"],
				disallowedTools: ["mcp__*"],
			}),
		).toBe(false);
		expect(isReadOnlyAgent({ ...base, tools: ["read", "write"] })).toBe(false);
		// Deny-all without an allowlist strips every non-hidden tool at runtime:
		// the protocol-only child can mutate nothing, so it classifies read-only.
		expect(isReadOnlyAgent({ ...base, disallowedTools: ["*"] })).toBe(true);
	});
	it("expands the exec alias before classifying", () => {
		// `tools: [exec]` + both backends denied leaves the child with no
		// execution tool: classifying on the unexpanded alias would advertise
		// the agent as writable while the runtime spawn strips eval and bash.
		const base: AgentDefinition = {
			name: "x",
			description: "x",
			systemPrompt: "x",
			source: "bundled",
		};
		const execOnly: AgentDefinition = { ...base, tools: ["exec"] };
		// With backends available (runtime default), exec expands to eval+bash:
		// mutating, not read-only.
		expect(isReadOnlyAgent(execOnly)).toBe(false);
		expect(isReadOnlyAgent(execOnly, { python: true, js: true })).toBe(false);
		// Both concrete backends denied: no execution or mutation tool survives.
		expect(isReadOnlyAgent({ ...execOnly, disallowedTools: ["eval", "bash"] }, { python: true, js: true })).toBe(
			true,
		);
		// A deny on the alias itself blocks the whole expansion.
		expect(isReadOnlyAgent({ ...execOnly, disallowedTools: ["exec"] })).toBe(true);
		// Read-only companion tools keep the classification true.
		expect(
			isReadOnlyAgent(
				{ ...base, tools: ["read", "exec"], disallowedTools: ["eval", "bash"] },
				{ python: true, js: true },
			),
		).toBe(true);
	});
	it("mirrors the executor auto-adds before classifying", () => {
		// The spawn path auto-adds `task` when `spawns:` is defined, so an agent
		// with an empty allowlist + `spawns: "*"` can delegate to a writable
		// child — advertising it as READ-ONLY would direct investigation flows
		// at an agent that can mutate indirectly.
		const base: AgentDefinition = {
			name: "x",
			description: "x",
			systemPrompt: "x",
			source: "bundled",
		};
		expect(isReadOnlyAgent({ ...base, tools: [], spawns: "*" })).toBe(false);
		expect(isReadOnlyAgent({ ...base, tools: ["read"], spawns: "*" })).toBe(false);
		// Without `spawns:`, delegation is impossible and the read-only
		// classification holds (the auto-added task row never applies).
		expect(isReadOnlyAgent({ ...base, tools: [] })).toBe(true);
		expect(isReadOnlyAgent({ ...base, tools: ["read"] })).toBe(true);
		// The runtime does NOT auto-add `task` when the agent disallows it:
		// `tools: [read]` + `spawns: "*"` + `disallowedTools: [task]` spawns a
		// child that cannot delegate, so it stays read-only — re-adding `task`
		// after filtering would misreport the effective grant as writable.
		expect(isReadOnlyAgent({ ...base, tools: ["read"], spawns: "*", disallowedTools: ["task"] })).toBe(true);
		// Denying task on an otherwise-empty allowlist keeps the protocol-only
		// classification (the auto-add is suppressed, not filtered back in).
		expect(isReadOnlyAgent({ ...base, tools: [], spawns: "*", disallowedTools: ["task"] })).toBe(true);
		// Denying a different tool does not suppress the auto-add.
		expect(isReadOnlyAgent({ ...base, tools: ["read"], spawns: "*", disallowedTools: ["write"] })).toBe(false);
	});
	it("classifies an empty effective allowlist as read-only", () => {
		// An explicit `tools: []` is a hard allowlist (discovery preserves it):
		// the child can call no tool at all, so it must not be advertised as
		// writable. Same for an allowlist whose every tool is disallowed.
		const base: AgentDefinition = {
			name: "x",
			description: "x",
			systemPrompt: "x",
			source: "bundled",
		};
		expect(isReadOnlyAgent({ ...base, tools: [] })).toBe(true);
		expect(
			isReadOnlyAgent({
				...base,
				tools: ["write"],
				disallowedTools: ["write"],
			}),
		).toBe(true);
		// No allowlist at all still means full inheritance: unknown inherited
		// tools keep the fail-safe non-read-only classification.
		expect(isReadOnlyAgent({ ...base, disallowedTools: ["write"] })).toBe(false);
	});

	it("does not classify an agent declaring `hub` as read-only", () => {
		// `hub` resolves to exec approval for start/stop/restart, process-stdin
		// `send`, unrecognized ops and malformed params, so declaring it must
		// disqualify an agent from the read-only label surfaced to the model.
		const scout = agentByName(loadBundledAgents(), "scout");

		expect(isReadOnlyAgent({ ...scout, tools: ["read", "grep", "hub", "yield"] })).toBe(false);
		expect(isReadOnlyAgent({ ...scout, tools: ["hub"] })).toBe(false);

		// Guard against over-correcting: the positive case must still hold.
		expect(isReadOnlyAgent({ ...scout, tools: ["read", "grep", "yield"] })).toBe(true);
	});

	it("disables read summarization for scout, leaves other agents summarizing", () => {
		const agents = loadBundledAgents();

		expect(agentByName(agents, "scout").readSummarize).toBe(false);
		for (const name of ["task", "sonic", "reviewer"]) {
			expect(agentByName(agents, name).readSummarize).toBeUndefined();
		}
	});
	it("ships every bundled agent without prewalk; hand-off is opt-in via task.agentPrewalk", () => {
		const agents = loadBundledAgents();

		for (const name of ["task", "scout", "sonic", "reviewer", "security-reviewer"]) {
			expect(agentByName(agents, name).prewalk).toBeUndefined();
		}
	});
});
