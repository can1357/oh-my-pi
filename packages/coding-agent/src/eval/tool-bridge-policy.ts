import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";

const evalBridgeCall = new AsyncLocalStorage<boolean>();

/** Carry the bridge origin through nested dispatch without marking concurrent direct calls. */
export function withEvalBridgeToolCall<T>(run: () => T): T {
	return evalBridgeCall.run(true, run);
}

export function isEvalBridgeToolCall(): boolean {
	return evalBridgeCall.getStore() === true;
}

/**
 * Checkpoint/rewind need direct toolResult events to commit session changes;
 * yield needs direct loop events to finalize the delegated task.
 */
export function isEvalBridgeToolCallable(tool: Pick<AgentTool, "name">): boolean {
	return tool.name !== "checkpoint" && tool.name !== "rewind" && tool.name !== "yield";
}
