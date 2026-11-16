import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";

/** Xdev state of the session whose eval bridge started the current async chain. */
const evalBridgeCall = new AsyncLocalStorage<object>();

/**
 * Carry the bridge origin through nested dispatch without marking concurrent direct calls.
 * Keyed by the bridging session's xdev state so sessions started inside the call (in-process
 * subagents) keep their own device writes.
 */
export function withEvalBridgeToolCall<T>(origin: object | undefined, run: () => T): T {
	return origin ? evalBridgeCall.run(origin, run) : run();
}

export function isEvalBridgeToolCall(origin: object): boolean {
	return evalBridgeCall.getStore() === origin;
}

/**
 * Checkpoint/rewind need direct toolResult events to commit session changes;
 * yield needs direct loop events to finalize the delegated task.
 */
export function isEvalBridgeToolCallable(tool: Pick<AgentTool, "name">): boolean {
	return tool.name !== "checkpoint" && tool.name !== "rewind" && tool.name !== "yield";
}
