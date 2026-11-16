import type { AgentTool } from "@oh-my-pi/pi-agent-core";

/**
 * Checkpoint/rewind need direct toolResult events to commit session changes;
 * yield needs direct loop events to finalize the delegated task.
 */
export function isEvalBridgeToolCallable(tool: Pick<AgentTool, "name">): boolean {
	return tool.name !== "checkpoint" && tool.name !== "rewind" && tool.name !== "yield";
}
