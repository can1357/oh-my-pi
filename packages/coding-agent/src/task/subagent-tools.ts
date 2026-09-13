/**
 * Effective tool surface of a spawned subagent.
 *
 * One source of truth for the executor (which hands the list to the child
 * session) and the preflight (which must know what the child will be able to
 * run *before* anything is created).
 */
import type { AgentDefinition } from "./types";

export interface SubagentToolContext {
	/** Max recursion depth reached for the child: `task` is stripped. */
	atMaxDepth: boolean;
	/** Restricted sessions keep their explicit host tool list — no `hub`. */
	restrictToolNames?: boolean;
	/** Backends that resolve, deciding whether `exec` expands to `eval`. */
	evalBackends: { python?: boolean; js?: boolean };
}

/**
 * Resolve the tool names a spawned agent will actually be given.
 * `undefined` means the agent declared no `tools` key and therefore inherits
 * the host's full tool set.
 */
export function resolveSubagentToolNames(
	agent: Pick<AgentDefinition, "tools" | "spawns">,
	context: SubagentToolContext,
): string[] | undefined {
	let toolNames: string[] | undefined;
	if (agent.tools) {
		toolNames = agent.tools;
		// Auto-include task tool if spawns defined but task not in tools
		if (agent.spawns !== undefined && !toolNames.includes("task") && !context.atMaxDepth) {
			toolNames = [...toolNames, "task"];
		}
	}

	if (context.atMaxDepth && toolNames?.includes("task")) {
		toolNames = toolNames.filter(name => name !== "task");
	}
	// Ordinary agents retain the host's always-on collaboration capability.
	// Restricted sessions must not widen their explicit host tool list with hub.
	if (toolNames && !context.restrictToolNames && !toolNames.includes("hub")) {
		toolNames = [...toolNames, "hub"];
	}
	if (toolNames?.includes("exec")) {
		const expanded = toolNames.filter(name => name !== "exec");
		if (context.evalBackends.python || context.evalBackends.js) expanded.push("eval");
		expanded.push("bash");
		toolNames = Array.from(new Set(expanded));
	}
	return toolNames;
}
