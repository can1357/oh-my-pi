import type { UsageStatistics } from "../session/session-entries";

export type GoalStatus = "active" | "paused" | "budget-limited" | "complete" | "dropped";

export interface Goal {
	id: string;
	objective: string;
	status: GoalStatus;
	tokenBudget?: number;
	tokensUsed: number;
	timeUsedSeconds: number;
	createdAt: number;
	updatedAt: number;
}

export interface GoalModeState {
	enabled: boolean;
	mode: "active" | "exiting";
	reason?: "completed";
	goal: Goal;
}

export interface GoalToolDetails {
	op: "create" | "get" | "complete" | "resume" | "drop";
	goal?: Goal | null;
	remainingTokens?: number | null;
	completionBudgetReport?: string | null;
}

export type GoalRuntimeEvent =
	| { type: "goal_updated"; goal: Goal | null; state?: GoalModeState }
	| { type: "goal_continuation_requested"; prompt: string };

export type GoalTokenUsage = Pick<UsageStatistics, "input" | "output" | "cacheRead" | "cacheWrite">;

export type GoalBudgetSteering = "allowed" | "suppressed";
export type GoalTerminalMetricEmission = "emit" | "suppress";
