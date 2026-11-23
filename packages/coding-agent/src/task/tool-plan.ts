import type { Settings } from "../config/settings";
import type { ToolSession } from "../tools";
import { resolveEvalBackends } from "../tools/eval-backends";
import type { AgentDefinition } from "./types";

export interface SubagentToolPlanOptions {
	settings: Settings;
	/** Whether the run exposes `yield`; unstructured runs never do. */
	structured: boolean;
	/** The child sits at the recursion limit and cannot spawn further. */
	atMaxDepth: boolean;
	/** Restricted sessions own their explicit list and are never widened. */
	restrictToolNames: boolean;
}

/**
 * Effective built-in tool names a subagent session is created with, or
 * `undefined` when the agent profile does not restrict tools. The executor and
 * the `task` tool's `tools` validation share this so neither re-derives which
 * built-ins `spawns`, recursion depth, `exec` and `wait` add or remove.
 */
export function resolveSubagentToolNames(
	agent: Pick<AgentDefinition, "tools" | "spawns">,
	options: SubagentToolPlanOptions,
): string[] | undefined {
	const { settings, structured, atMaxDepth, restrictToolNames } = options;
	let toolNames: string[] | undefined;
	if (agent.tools) {
		toolNames = structured ? agent.tools : agent.tools.filter(name => name !== "yield");
		// Auto-include task tool if spawns defined but task not in tools
		if (agent.spawns !== undefined && !toolNames.includes("task") && !atMaxDepth) {
			toolNames = [...toolNames, "task"];
		}
	}

	if (atMaxDepth && toolNames?.includes("task")) {
		toolNames = toolNames.filter(name => name !== "task");
	}
	if (toolNames?.includes("exec")) {
		const backends = resolveEvalBackends({ settings } as ToolSession);
		const expanded = toolNames.filter(name => name !== "exec");
		if (backends.python || backends.js) expanded.push("eval");
		expanded.push("bash");
		toolNames = Array.from(new Set(expanded));
	}
	// Agents that can start background work (`task`, `bash`) need `wait` to block on it;
	// without it they `sleep`. Runs after `exec` expansion and the max-depth `task` strip.
	// `createTools` still drops it when no wake source (async/IRC/services) is enabled.
	if (
		toolNames &&
		!restrictToolNames &&
		!toolNames.includes("wait") &&
		(toolNames.includes("task") || toolNames.includes("bash"))
	) {
		toolNames = [...toolNames, "wait"];
	}
	return toolNames;
}
