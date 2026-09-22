import type { AgentHubRegistry } from "./agent-hub-types";

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
