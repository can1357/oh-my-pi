/**
 * Adaptive Context Fidelity (ACF) — shared types.
 *
 * Self-contained type surface for the adaptive-fidelity lane: task-need
 * classification, dynamic token budgets, progressive expansion triggers, and
 * usefulness feedback. Deliberately decoupled from the guardian and
 * persistence lanes — nothing here imports outside this directory.
 */

/** Coarse task categories that drive the base token budget. */
export type ContextNeedCategory = "trivial" | "normal" | "debugging" | "architecture" | "recovery" | "repository-wide";

/** Verification floor a satisfying memory must meet. */
export type NeedVerification = "observed" | "user-confirmed";

/** A concrete information need derived from the task category. */
export interface InformationNeed {
	id: string;
	category: ContextNeedCategory;
	topic: string;
	required: boolean;
	/** 0..1 — relative priority among the needs of one turn. */
	priority: number;
	minVerification: NeedVerification;
}

/** Minimal memory-record shape the contribution evaluator needs. */
export interface MemoryRecordLike {
	id: string;
	content: string;
}

/** Tunable budget configuration. All token values are model tokens. */
export interface AdaptiveBudgetConfig {
	/** Base budget for trivial tasks. Default 2500. */
	initialTokenBudget: number;
	/** Base budget for normal tasks. Default 3000. */
	normalTokenBudget: number;
	/** Base budget for debugging tasks. Default 6000. */
	debuggingTokenBudget: number;
	/** Base budget for architecture tasks. Default 12000. */
	architectureTokenBudget: number;
	/** Base budget for recovery tasks. Default 16000. */
	recoveryTokenBudget: number;
	/** Base budget for repository-wide tasks. Default 24000. */
	repoWideTokenBudget: number;
	/** Hard ceiling regardless of signals. Default 32000. */
	absoluteMaxTokens: number;
	/** Tokens granted per expansion step. Default 4000. */
	expansionStepTokens: number;
	/** Maximum expansion steps per turn. Default 4. */
	maxExpansions: number;
	/** Memory may consume at most this share of the context window. Default 20. */
	maxMemorySharePercent: number;
	/** Escape hatch: pin the budget to 700 tokens (legacy behaviour). */
	fallback700Tokens: boolean;
	/** Extra tokens granted at complexityScore = 1. Default 4000. */
	complexityAllowanceTokens?: number;
	/** Extra tokens granted at graphImpactScore = 1. Default 4000. */
	graphImpactAllowanceTokens?: number;
	/** Extra tokens per unresolved issue. Default 1000. */
	tokensPerUnresolvedIssue?: number;
	/** Cap on the unresolved-issue allowance. Default 8000. */
	maximumUnresolvedIssueAllowance?: number;
	/** Penalty scale for a high recent-contradiction rate. Default 1000. */
	contradictionPenaltyTokens?: number;
	/** Penalty scale when usefulness is trending low. Default 2000. */
	lowUsefulnessPenaltyTokens?: number;
	/** Floor the final budget never drops below. Default 500. */
	minimumTokens?: number;
}

/** Live signals that adjust the base budget up or down. */
export interface BudgetSignals {
	/** 0..1 — how complex the task looks. */
	complexityScore?: number;
	/** 0..1 — blast radius of the planned change in the code graph. */
	graphImpactScore?: number;
	/** Count of currently unresolved issues/errors. */
	unresolvedIssueCount?: number;
	/** 0..1 — how often recent memories contradicted each other. */
	recentContradictionRate?: number;
	/** 0..1 — moving average of memory usefulness feedback. */
	usefulnessMovingAverage?: number;
}

/** One recorded progressive-expansion step. */
export interface ProgressiveExpansionStep {
	stepIndex: number;
	mode: "shadow" | "active" | "urgent";
	triggerReason: string;
	triggerScore: number;
	tokenBudget: number;
	noveltyScore: number;
	informationGain: number;
	addedMemoryIds: string[];
}

/** Context tiers loaded progressively (cheapest first). */
export type ExpansionContextTier = "L0" | "L1" | "L2" | "L3" | "L4";

/** Why an automatic expansion fired. */
export type ExpansionTrigger =
	| "crash-recovery"
	| "compaction-recovery"
	| "memory-contradiction"
	| "low-retrieval-confidence"
	| "model-requested-detail"
	| "high-graph-impact"
	| "tool-specific-context"
	| "repeated-failure"
	| "user-requested-history";

/** A concrete request to load more context. Observe-only: a proposal, not an action. */
export interface ContextExpansionRequest {
	packetId: string;
	turnId: string;
	trigger: ExpansionTrigger;
	requestedTiers: ExpansionContextTier[];
	topics: string[];
	maximumAdditionalTokens: number;
	reason: string;
}

/** Immutable usefulness feedback for one injected memory. */
export interface UsefulnessFeedbackEvent {
	id: string;
	memoryId: string;
	sessionId: string;
	turnId: string;
	rating: "useful" | "partially_used" | "unhelpful";
	tokenCost: number;
	latencyMs: number;
	timestamp: string;
}
