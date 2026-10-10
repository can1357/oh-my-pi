import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { stableStringifyJson } from "@oh-my-pi/pi-utils";
import { type Goal } from "@oh-my-pi/pi-tui/tools/goal";
import type { UsageStatistics } from "../session/session-entries";

export interface GoalModeState {
	enabled: boolean;
	mode: "active" | "exiting";
	reason?: "completed";
	goal: Goal;
}

export type GoalRuntimeEvent =
	| { type: "goal_updated"; goal: Goal | null; state?: GoalModeState }
	| { type: "goal_continuation_requested"; prompt: string };

export type GoalTokenUsage = Pick<UsageStatistics, "input" | "output" | "cacheRead" | "cacheWrite">;

export type GoalBudgetSteering = "allowed" | "suppressed" | "deferred";
export type GoalTerminalMetricEmission = "emit" | "suppress";

/** Rebuild a persisted goal from `mode_change` data; undefined when the record is malformed. */
export function goalFromModeData(modeData: Record<string, unknown> | undefined): Goal | undefined {
	const goal = modeData?.goal;
	if (!goal || typeof goal !== "object") return undefined;
	const value = goal as Record<string, unknown>;
	if (
		typeof value.id !== "string" ||
		typeof value.objective !== "string" ||
		typeof value.status !== "string" ||
		typeof value.tokensUsed !== "number" ||
		typeof value.timeUsedSeconds !== "number" ||
		typeof value.createdAt !== "number" ||
		typeof value.updatedAt !== "number"
	) {
		return undefined;
	}
	return {
		id: value.id,
		objective: value.objective,
		status: value.status as Goal["status"],
		tokenBudget: typeof value.tokenBudget === "number" ? value.tokenBudget : undefined,
		tokensUsed: value.tokensUsed,
		timeUsedSeconds: value.timeUsedSeconds,
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
	};
}

/**
 * Digest of a turn's tool calls and results. Two continuation turns with the same
 * (or empty) activity made no progress, so automatic continuation stops.
 */
export function goalContinuationActivity(messages: readonly AgentMessage[]): string {
	const digests: string[] = [];
	const record = (value: unknown): void => {
		const serialized = stableStringifyJson(value);
		digests.push(`${serialized.length}:${Bun.hash(serialized).toString(16)}`);
	};
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "toolCall") record(["call", block.name, block.arguments]);
			}
		} else if (message.role === "toolResult") {
			record(["result", message.toolName, message.content, message.isError === true]);
		}
	}
	return digests.join(":");
}
