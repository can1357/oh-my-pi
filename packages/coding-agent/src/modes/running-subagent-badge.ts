import { AgentRegistry } from "../registry/agent-registry";

export interface RunningSubagentRegistrySource {
	agentRegistry: AgentRegistry;
}

export function getRunningSubagentBadgeRegistry(collabGuest: RunningSubagentRegistrySource | undefined): AgentRegistry {
	return collabGuest?.agentRegistry ?? AgentRegistry.global();
}

export function getRunningSubagentBadgeAgentIds(registry: AgentRegistry): string[] {
	return registry
		.list()
		.filter(ref => ref.kind === "sub" && ref.status === "running")
		.map(ref => ref.id);
}
