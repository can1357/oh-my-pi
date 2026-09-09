import type { AgentDefinition } from "./types";

/** Resolve an agent's prewalk default, including the bundled task opt-in. */
export function resolveAgentPrewalkDefault(agent: AgentDefinition, taskPrewalk: boolean): boolean | string | undefined {
	return agent.prewalk ?? (taskPrewalk && agent.source === "bundled" && agent.name === "task" ? true : undefined);
}
