import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { stableStringifyJson } from "@oh-my-pi/pi-utils";
import { type Goal } from "../tools/details/goal";
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

export type GoalBudgetSteering = "allowed" | "suppressed";
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

/** Journal custom-entry type carrying a compact goal usage counter update. */
export const GOAL_USAGE_ENTRY_TYPE = "goal_usage";

/** Persisted payload of a `goal_usage` journal entry. */
export interface GoalUsageEntryData {
	id: string;
	tokensUsed: number;
	timeUsedSeconds: number;
	updatedAt: number;
}

/** Compact counter snapshot for a usage-only flush. Callers persist it as a `goal_usage` entry. */
export function goalUsageEntryData(state: GoalModeState): GoalUsageEntryData {
	return {
		id: state.goal.id,
		tokensUsed: state.goal.tokensUsed,
		timeUsedSeconds: state.goal.timeUsedSeconds,
		updatedAt: state.goal.updatedAt,
	};
}

/**
 * Replay a `goal_usage` journal entry onto the current mode data. Returns the input
 * unchanged when there is no active goal, the entry targets a stale goal id, or the
 * payload is malformed. A stale id must not overwrite a newer goal's counters.
 */
export function mergeGoalUsage(
	modeData: Record<string, unknown> | undefined,
	data: unknown,
): Record<string, unknown> | undefined {
	const goal = modeData?.goal;
	if (!goal || typeof goal !== "object" || typeof data !== "object" || data === null) return modeData;
	const usage = data as Record<string, unknown>;
	const currentGoal = goal as Record<string, unknown>;
	if (
		typeof usage.id !== "string" ||
		usage.id !== currentGoal.id ||
		typeof usage.tokensUsed !== "number" ||
		!Number.isFinite(usage.tokensUsed) ||
		usage.tokensUsed < 0 ||
		typeof usage.timeUsedSeconds !== "number" ||
		!Number.isFinite(usage.timeUsedSeconds) ||
		usage.timeUsedSeconds < 0 ||
		typeof usage.updatedAt !== "number" ||
		!Number.isFinite(usage.updatedAt)
	) {
		return modeData;
	}
	return {
		...modeData,
		goal: {
			...currentGoal,
			tokensUsed: usage.tokensUsed,
			timeUsedSeconds: usage.timeUsedSeconds,
			updatedAt: usage.updatedAt,
		},
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
