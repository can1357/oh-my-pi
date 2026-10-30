import { type AgentHubRegistry, MAIN_AGENT_ID } from "./agent-hub-types";

export interface RunningSubagentRegistrySource<T extends AgentHubRegistry = AgentHubRegistry> {
	agentRegistry: T;
}

export function getRunningSubagentBadgeRegistry<T extends AgentHubRegistry>(
	collabGuest: RunningSubagentRegistrySource<T> | undefined,
	localRegistry: T,
): T {
	return collabGuest?.agentRegistry ?? localRegistry;
}

export function getRunningSubagentBadgeAgentIds(registry: AgentHubRegistry): string[] {
	return registry
		.list()
		.filter(ref => ref.kind === "sub" && ref.status === "running")
		.map(ref => ref.id);
}

/**
 * Agents the Agent Hub roster can show (every registry ref but the main
 * session), whatever their status: finished, parked and killed subagents
 * stay inspectable after the last one stops running.
 */
export function getInspectableSubagentCount(registry: AgentHubRegistry): number {
	let count = 0;
	for (const ref of registry.list()) if (ref.id !== MAIN_AGENT_ID) count++;
	return count;
}
