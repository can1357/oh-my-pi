import type { UsageStatistics } from "../session/session-entries";

export type GoalStatus = "active" | "paused" | "budget-limited" | "complete" | "dropped";

export type GoalWayfindingOutcome = "succeeded" | "partial" | "failed" | "unexpected" | "blocked";

export interface GoalWaypoint {
	action: string;
	rationale: string;
	guidance?: string;
	successSignal?: string;
	replanIf?: string;
}

export interface GoalObservation {
	outcome: GoalWayfindingOutcome;
	summary: string;
}

export interface GoalWayfindingState {
	revision: number;
	focus?: string;
	waypoint: GoalWaypoint;
	lastObservation?: GoalObservation;
	blockers?: readonly string[];
	assumptions?: readonly string[];
}

export interface Goal {
	id: string;
	objective: string;
	status: GoalStatus;
	tokenBudget?: number;
	tokensUsed: number;
	timeUsedSeconds: number;
	createdAt: number;
	updatedAt: number;
	wayfinding?: GoalWayfindingState;
}

export interface GoalModeState {
	enabled: boolean;
	mode: "active" | "exiting";
	reason?: "completed";
	goal: Goal;
}

export interface GoalToolDetails {
	op: "create" | "get" | "update" | "complete" | "resume" | "drop";
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
