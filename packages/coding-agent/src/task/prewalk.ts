import { resolveAgentPrewalkPattern } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import { cfgTaskAgentPrewalk, cfgTaskPrewalk } from "./settings";
import type { AgentDefinition } from "./types";

/** Resolve an agent's prewalk default, including the bundled task opt-in. */
export function resolveAgentPrewalkDefault(agent: AgentDefinition, taskPrewalk: boolean): boolean | string | undefined {
	return agent.prewalk ?? (taskPrewalk && agent.source === "bundled" && agent.name === "task" ? true : undefined);
}

/** Prewalk target pattern a spawn of `agent` hands off to, or undefined when it runs without prewalk. */
export function agentPrewalkPattern(agent: AgentDefinition, settings: Settings): string | undefined {
	return resolveAgentPrewalkPattern({
		settingsOverride: cfgTaskAgentPrewalk.get(settings)[agent.name],
		agentPrewalk: resolveAgentPrewalkDefault(agent, cfgTaskPrewalk.get(settings)),
	});
}
