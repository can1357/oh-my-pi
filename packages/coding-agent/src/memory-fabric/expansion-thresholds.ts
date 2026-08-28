/**
 * Expansion Thresholds, Risk-Based Overrides & Value Gates
 *
 * Implements the scored decision regions (silent <0.42, shadow 0.42-0.64,
 * active 0.65-0.81, urgent >=0.82), two-stage evaluation (trigger probability
 * + expansion value test), risk overrides, and per-trigger tuning.
 *
 * This complements adaptive-fidelity/expansion-triggers.ts: that module
 * decides WHICH trigger fires (the trigger ladder); this module decides
 * WHETHER and HOW STRONGLY to act on a scored expansion opportunity.
 */

import type { ContextTier } from "./rrf-fusion";
import type { ExpansionSignals } from "./tiered-retrieval-types";

export type ExpansionDecisionAction = "do-not-expand" | "retrieve-silently" | "expand" | "expand-urgent";

export interface ExpansionDecisionResult {
	action: ExpansionDecisionAction;
	tiers?: ContextTier[];
	score: number;
	effectiveThreshold: number;
	reason: string;
}

export interface ExpansionEvaluation {
	triggerScore: number;

	coverageBefore: number;
	coverageAfter: number;
	coverageGain: number;

	confidenceBefore: number;
	confidenceAfter: number;
	confidenceGain: number;

	newInformationRatio: number;
	relevanceAverage: number;
	estimatedUsefulTokens: number;
	proposedTokens: number;

	expectedUtilityGain: number;
}

/**
 * Threshold configuration. Every field here is consumed by a check in this
 * module — budget caps that had no enforcement point were removed rather
 * than shipped as dead configuration.
 */
export interface ExpansionThresholdConfig {
	silentThreshold: number; // 0.42
	activeThreshold: number; // 0.65
	urgentThreshold: number; // 0.82

	minimumNewInformationRatio: number; // 0.20
	minimumCoverageGain: number; // 0.10
	minimumConfidenceGain: number; // 0.05
	minimumExpectedUtilityGain: number; // 0.05

	maximumStepsPerTurn: number; // 4
	maximumTokensPerStep: number; // 8000
	maximumTotalExpansionTokens: number; // 24000

	minimumRemainingBudgetTokens: number; // 500
}

export const DEFAULT_THRESHOLD_CONFIG: ExpansionThresholdConfig = {
	silentThreshold: 0.42,
	activeThreshold: 0.65,
	urgentThreshold: 0.82,

	minimumNewInformationRatio: 0.2,
	minimumCoverageGain: 0.1,
	minimumConfidenceGain: 0.05,
	minimumExpectedUtilityGain: 0.05,

	maximumStepsPerTurn: 4,
	maximumTokensPerStep: 8000,
	maximumTotalExpansionTokens: 24000,

	minimumRemainingBudgetTokens: 500,
};

export interface TriggerThresholdSetting {
	threshold: number;
	forcedTiers?: ContextTier[];
	preferredTiers?: ContextTier[];
}

export const PER_TRIGGER_THRESHOLDS: Record<string, TriggerThresholdSetting> = {
	crashRecovery: { threshold: 0.3, forcedTiers: ["L0", "L1", "L2"] },
	contradiction: { threshold: 0.4, forcedTiers: ["L4"] },
	userRequestedHistory: { threshold: 0.2, preferredTiers: ["L4"] },
	repeatedFailure: { threshold: 0.5, preferredTiers: ["L2", "L4"] },
	highGraphImpact: { threshold: 0.55, preferredTiers: ["L3"] },
	modelRequestedDetail: { threshold: 0.6 },
	normalLowConfidence: { threshold: 0.7 },
};

/**
 * Calculate effective expansion threshold by applying risk-based overrides.
 */
export function effectiveExpansionThreshold(
	baseThreshold: number,
	context: {
		destructiveOperation?: boolean;
		externalWrite?: boolean;
		databaseMigration?: boolean;
		deployment?: boolean;
		crashRecovery?: boolean;
		contradictionPresent?: boolean;
		simpleFileRead?: boolean;
		formattingRequest?: boolean;
		alreadyHighCoverage?: boolean;
		lowRemainingBudget?: boolean;
	},
): number {
	let threshold = baseThreshold;

	// Lower threshold for high-risk operations (more cautious, retrieve more)
	if (context.destructiveOperation) threshold -= 0.15;
	if (context.externalWrite) threshold -= 0.1;
	if (context.databaseMigration) threshold -= 0.12;
	if (context.deployment) threshold -= 0.1;
	if (context.crashRecovery) threshold -= 0.2;
	if (context.contradictionPresent) threshold -= 0.15;

	// Raise threshold for trivial/low-risk read-only tasks (less expansion)
	if (context.simpleFileRead) threshold += 0.1;
	if (context.formattingRequest) threshold += 0.15;
	if (context.alreadyHighCoverage) threshold += 0.1;
	if (context.lowRemainingBudget) threshold += 0.1;

	// Clamp to [0.30, 0.90]
	return Math.max(0.3, Math.min(0.9, threshold));
}

/**
 * Stage 2 Expansion-Value Gate test.
 * Determines whether candidate expansion is worth injecting.
 */
export function shouldInjectExpansion(
	evaluation: ExpansionEvaluation,
	config: ExpansionThresholdConfig = DEFAULT_THRESHOLD_CONFIG,
): boolean {
	if (evaluation.triggerScore < config.activeThreshold) {
		return false;
	}

	if (evaluation.proposedTokens > config.maximumTokensPerStep) {
		return false;
	}

	if (evaluation.newInformationRatio < config.minimumNewInformationRatio) {
		return false;
	}

	if (
		evaluation.coverageGain < config.minimumCoverageGain &&
		evaluation.confidenceGain < config.minimumConfidenceGain
	) {
		return false;
	}

	if (evaluation.expectedUtilityGain < config.minimumExpectedUtilityGain) {
		return false;
	}

	return true;
}

/** Per-turn expansion budget state consumed by determineExpansionDecision. */
export interface ExpansionBudgetState {
	/** Tokens still available in the overall memory budget. */
	remainingTokens: number;
	/** Expansion steps already taken this turn. */
	expansionCount: number;
	/** Tokens already spent on expansions this turn. Default: 0. */
	usedExpansionTokens?: number;
}

/**
 * Determine expansion decision based on signals, budget state, and the
 * scored decision regions.
 */
export function determineExpansionDecision(
	signals: ExpansionSignals,
	state: ExpansionBudgetState,
	config: ExpansionThresholdConfig = DEFAULT_THRESHOLD_CONFIG,
): ExpansionDecisionResult {
	if (state.remainingTokens < config.minimumRemainingBudgetTokens) {
		return {
			action: "do-not-expand",
			score: 0,
			effectiveThreshold: config.activeThreshold,
			reason: "No remaining memory budget.",
		};
	}

	if (state.expansionCount >= config.maximumStepsPerTurn) {
		return {
			action: "do-not-expand",
			score: 0,
			effectiveThreshold: config.activeThreshold,
			reason: "Maximum expansion steps per turn reached.",
		};
	}

	if ((state.usedExpansionTokens ?? 0) >= config.maximumTotalExpansionTokens) {
		return {
			action: "do-not-expand",
			score: 0,
			effectiveThreshold: config.activeThreshold,
			reason: "Total expansion token budget for this turn is exhausted.",
		};
	}

	// Deterministic overrides
	if (signals.isCrashRecovery) {
		return {
			action: "expand-urgent",
			tiers: ["L0", "L1", "L2", "L3"],
			score: 1.0,
			effectiveThreshold: 0.3,
			reason: "Crash recovery forces operational context restore.",
		};
	}

	if (signals.contradictionCount > 0) {
		return {
			action: "expand",
			tiers: ["L4"],
			score: 0.85,
			effectiveThreshold: 0.4,
			reason: "Supporting evidence is required for active contradictions.",
		};
	}

	// Calculate base expansion score
	let score = 0;
	score += 0.16 * Math.max(0, Math.min(1, signals.taskComplexity));
	score += 0.14 * Math.max(0, Math.min(1, signals.graphImpact));
	score += 0.14 * (1 - Math.max(0, Math.min(1, signals.retrievalConfidence)));
	score += 0.12 * (1 - Math.max(0, Math.min(1, signals.retrievalCoverage)));
	score += 0.1 * Math.min(signals.contradictionCount / 2, 1);
	score += 0.08 * Math.min(signals.repeatedFailureCount / 2, 1);
	score += 0.07 * Math.min(signals.unresolvedIssueCount / 5, 1);
	score += 0.06 * Math.min(signals.unfamiliarSymbolCount / 5, 1);
	score += 0.06 * Math.min(signals.missingProcedureCount / 3, 1);
	score += 0.04 * Math.max(0, Math.min(1, signals.planBreadth));
	score += 0.03 * Math.max(0, Math.min(1, signals.currentContextSaturation));

	if (signals.isCompactionRecovery) score += 0.25;
	if (signals.modelRequestedExpansion) score += 0.2;
	if (signals.userRequestedHistory) score += 0.3;

	const clampedScore = Math.min(score, 1.0);
	const scoreText = clampedScore.toFixed(2);

	const effectiveThreshold = effectiveExpansionThreshold(config.activeThreshold, {
		destructiveOperation: signals.isDestructiveOperation,
		externalWrite: signals.isExternalWrite,
		crashRecovery: signals.isCrashRecovery,
		contradictionPresent: signals.contradictionCount > 0,
		alreadyHighCoverage: signals.retrievalCoverage >= 0.9,
	});

	const thresholdText = effectiveThreshold.toFixed(2);
	const silentText = config.silentThreshold.toFixed(2);

	// Decision region evaluation
	if (clampedScore >= config.urgentThreshold) {
		return {
			action: "expand-urgent",
			score: clampedScore,
			effectiveThreshold,
			reason: `Urgent expansion score: ${scoreText}`,
		};
	}

	if (clampedScore >= effectiveThreshold) {
		return {
			action: "expand",
			score: clampedScore,
			effectiveThreshold,
			reason: `Active expansion score ${scoreText} meets threshold ${thresholdText}`,
		};
	}

	if (clampedScore >= config.silentThreshold) {
		return {
			action: "retrieve-silently",
			score: clampedScore,
			effectiveThreshold,
			reason: `Silent shadow score ${scoreText} in [${silentText}, ${thresholdText})`,
		};
	}

	return {
		action: "do-not-expand",
		score: clampedScore,
		effectiveThreshold,
		reason: `Expansion score ${scoreText} below silent threshold ${silentText}`,
	};
}
