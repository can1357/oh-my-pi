/**
 * Progressive Expansion Triggers & Budget Utility (ACF lane).
 *
 * The pure decision core of progressive context expansion: given the state of
 * a turn, decide WHETHER more context should be loaded, WHICH tiers, and HOW
 * many additional tokens — as an observe-only proposal. The caller decides
 * whether to act on it; nothing here retrieves, reads disk, or mutates state.
 *
 * Trigger ladder (checked in priority order, first match wins):
 *   1. crash recovery            -> L2+L3, up to 8000 tokens
 *   2. compaction recovery       -> L2+L3, up to 6000 tokens
 *   3. memory contradiction      -> L4 evidence, up to 6000 tokens
 *   4. low retrieval confidence  -> L2+L3, up to 5000 tokens
 *   5. model requested detail    -> L2+L3, up to 6000 tokens
 *   6. high-graph-impact edit    -> L3, up to 4000 tokens
 *   7. tool-specific context     -> L2, up to 3000 tokens
 *   8. repeated failures (>= 2)  -> L2+L4, up to 6000 tokens
 *
 * Deterministic — no clocks, no randomness. Imports only sibling types.
 */

import type { ContextExpansionRequest } from "./types";

/** Everything the trigger ladder inspects about the current turn. */
export interface ExpansionTurnState {
	isCrashRecovery: boolean;
	isCompactionRecovery: boolean;
	contradictionCount: number;
	contradictionSubjects: string[];
	nextToolType: string;
	graphImpactScore: number;
	targetFiles: string[];
	repeatedFailureCount: number;
	currentError: string;
	/** 0..1; values <= 0 mean "no retrieval happened" and never trigger. */
	retrievalConfidence: number;
	modelRequestedDetail: boolean;
	requestedTopics: string[];
	packetId: string;
	turnId: string;
}

/** The simplified state accepted by `shouldExpand` (all optionals defaulted). */
export interface SimpleExpansionState {
	packetId: string;
	turnId: string;
	isCrashRecovery?: boolean;
	isCompactionRecovery?: boolean;
	contradictionCount?: number;
	nextToolType?: string;
	graphImpactScore?: number;
	targetFiles?: string[];
	repeatedFailureCount?: number;
}

/**
 * Automated Expansion Trigger.
 *
 * Determines when an automatic expansion should fire based on turn state.
 * Returns a proposal (`ContextExpansionRequest`) or null — never acts.
 */
export class AutomatedExpansionTrigger {
	/**
	 * Inspect the current turn state and return an expansion request if
	 * warranted, null otherwise. First matching rule wins.
	 */
	determineAutomaticExpansion(state: ExpansionTurnState): ContextExpansionRequest | null {
		// 1. Crash recovery: load full operational context.
		if (state.isCrashRecovery) {
			return {
				packetId: state.packetId,
				turnId: state.turnId,
				trigger: "crash-recovery",
				requestedTiers: ["L2", "L3"],
				topics: ["unresolved work", "previous failures", "validation"],
				maximumAdditionalTokens: 8000,
				reason: "Restore complete operational context after process recovery.",
			};
		}

		// 2. Compaction recovery.
		if (state.isCompactionRecovery) {
			return {
				packetId: state.packetId,
				turnId: state.turnId,
				trigger: "compaction-recovery",
				requestedTiers: ["L2", "L3"],
				topics: ["unfinished work", "checkpoint state"],
				maximumAdditionalTokens: 6000,
				reason: "Restore context after conversation compaction.",
			};
		}

		// 3. Contradiction: fetch evidence.
		if (state.contradictionCount > 0) {
			return {
				packetId: state.packetId,
				turnId: state.turnId,
				trigger: "memory-contradiction",
				requestedTiers: ["L4"],
				topics: state.contradictionSubjects,
				maximumAdditionalTokens: 6000,
				reason: "Retrieve supporting evidence for conflicting memories.",
			};
		}

		// 4. Low retrieval confidence (0 means "no retrieval" — never fires).
		if (state.retrievalConfidence < 0.4 && state.retrievalConfidence > 0) {
			return {
				packetId: state.packetId,
				turnId: state.turnId,
				trigger: "low-retrieval-confidence",
				requestedTiers: ["L2", "L3"],
				topics: state.requestedTopics,
				maximumAdditionalTokens: 5000,
				reason: `Low retrieval confidence (${state.retrievalConfidence.toFixed(2)}) - expanding search.`,
			};
		}

		// 5. Model requested detail.
		if (state.modelRequestedDetail) {
			return {
				packetId: state.packetId,
				turnId: state.turnId,
				trigger: "model-requested-detail",
				requestedTiers: ["L2", "L3"],
				topics: state.requestedTopics,
				maximumAdditionalTokens: 6000,
				reason: `Model requested additional detail on: ${state.requestedTopics.join(", ")}`,
			};
		}

		// 6. High-graph-impact edit.
		if (state.nextToolType === "edit" && state.graphImpactScore >= 0.7) {
			const files = state.targetFiles ?? [];
			return {
				packetId: state.packetId,
				turnId: state.turnId,
				trigger: "high-graph-impact",
				requestedTiers: ["L3"],
				topics: files,
				maximumAdditionalTokens: 4000,
				reason: `About to edit high-impact files: ${files.join(", ")}`,
			};
		}

		// 7. Tool-specific context (procedures before execution).
		if (["bash", "test", "grep", "search"].includes(state.nextToolType)) {
			return {
				packetId: state.packetId,
				turnId: state.turnId,
				trigger: "tool-specific-context",
				requestedTiers: ["L2"],
				topics: ["procedures", "commands", "known errors"],
				maximumAdditionalTokens: 3000,
				reason: `Load relevant procedures before ${state.nextToolType} execution.`,
			};
		}

		// 8. Repeated failures (2+ consecutive).
		if (state.repeatedFailureCount >= 2) {
			return {
				packetId: state.packetId,
				turnId: state.turnId,
				trigger: "repeated-failure",
				requestedTiers: ["L2", "L4"],
				topics: ["debugging", "failure context", state.currentError],
				maximumAdditionalTokens: 6000,
				reason: `${state.repeatedFailureCount} consecutive failures - expanding for debugging context`,
			};
		}

		// 9. User-requested history is an explicit action handled at the call
		//    site — it never fires automatically.

		return null;
	}

	/** Convenience wrapper: defaults every optional field to "no signal". */
	shouldExpand(state: SimpleExpansionState): ContextExpansionRequest | null {
		return this.determineAutomaticExpansion({
			isCrashRecovery: state.isCrashRecovery ?? false,
			isCompactionRecovery: state.isCompactionRecovery ?? false,
			contradictionCount: state.contradictionCount ?? 0,
			contradictionSubjects: [],
			nextToolType: state.nextToolType ?? "unknown",
			graphImpactScore: state.graphImpactScore ?? 0,
			targetFiles: state.targetFiles ?? [],
			repeatedFailureCount: state.repeatedFailureCount ?? 0,
			currentError: "",
			retrievalConfidence: 1.0,
			modelRequestedDetail: false,
			requestedTopics: [],
			packetId: state.packetId,
			turnId: state.turnId,
		});
	}
}

/** Precision of memory injection: relevant / injected. */
export interface MemoryPrecision {
	relevantInjected: number;
	totalInjected: number;
	precision: number;
}

/** Recall of memory injection: relevant injected / relevant available. */
export interface MemoryRecall {
	relevantInjected: number;
	totalRelevantAvailable: number;
	recall: number;
}

/** How much of the allocated budget was actually used (capped at 1). */
export interface ContextUtilization {
	usedTokens: number;
	allocatedTokens: number;
	utilization: number;
}

/** Memory tokens as a share of all tokens. */
export interface TokenUtilization {
	memoryTokens: number;
	nonMemoryTokens: number;
	tokenUtilization: number;
}

/** How often false memories influenced the outcome. */
export interface HarmRate {
	falseMemoryInfluenced: number;
	totalInfluenced: number;
	harmRate: number;
}

export function computeMemoryPrecision(relevantInjected: number, totalInjected: number): MemoryPrecision {
	return {
		relevantInjected,
		totalInjected,
		precision: totalInjected > 0 ? relevantInjected / totalInjected : 0,
	};
}

export function computeMemoryRecall(relevantInjected: number, totalRelevantAvailable: number): MemoryRecall {
	return {
		relevantInjected,
		totalRelevantAvailable,
		recall: totalRelevantAvailable > 0 ? relevantInjected / totalRelevantAvailable : 0,
	};
}

export function computeContextUtilization(usedTokens: number, allocatedTokens: number): ContextUtilization {
	return {
		usedTokens,
		allocatedTokens,
		utilization: allocatedTokens > 0 ? Math.min(1, usedTokens / allocatedTokens) : 0,
	};
}

export function computeTokenUtilization(memoryTokens: number, nonMemoryTokens: number): TokenUtilization {
	const total = memoryTokens + nonMemoryTokens;
	return {
		memoryTokens,
		nonMemoryTokens,
		tokenUtilization: total > 0 ? memoryTokens / total : 0,
	};
}

export function computeHarmRate(falseMemoryInfluenced: number, totalInfluenced: number): HarmRate {
	return {
		falseMemoryInfluenced,
		totalInfluenced,
		harmRate: totalInfluenced > 0 ? falseMemoryInfluenced / totalInfluenced : 0,
	};
}

/**
 * Budget Utility Calculator.
 *
 * Composite utility from run metrics (positive weights reward success and
 * precision; negative weights punish waste and harm) plus a per-candidate
 * utility used for ranking. Pure and deterministic.
 */
export function calculateUtility(metrics: {
	taskSuccess: number;
	validationSuccess: number;
	memoryPrecision: number;
	knownFailureAvoidance: number;
	resumeQuality: number;
	provenanceCoverage: number;
	irrelevantContextRate: number;
	unnecessaryToolRate: number;
	latencyPenalty: number;
	tokenCostPenalty: number;
	userCorrectionRate: number;
	falseMemoryInfluence: number;
}): number {
	return (
		0.3 * metrics.taskSuccess +
		0.15 * metrics.validationSuccess +
		0.12 * metrics.memoryPrecision +
		0.1 * metrics.knownFailureAvoidance +
		0.08 * metrics.resumeQuality +
		0.05 * metrics.provenanceCoverage +
		-0.06 * metrics.irrelevantContextRate +
		-0.04 * metrics.unnecessaryToolRate +
		-0.04 * metrics.latencyPenalty +
		-0.03 * metrics.tokenCostPenalty +
		-0.02 * metrics.userCorrectionRate +
		-0.06 * metrics.falseMemoryInfluence
	);
}

export function calculateCandidateUtility(record: {
	confidence?: number;
	importance?: number;
	verification?: string;
}): number {
	const conf = record.confidence ?? 0.5;
	const imp = record.importance ?? 0.5;
	let utility = conf * 0.6 + imp * 0.4;
	if (record.verification === "user-confirmed") utility += 0.2;
	if (record.verification === "contradicted") utility -= 0.5;
	return Math.max(0, Math.min(1, utility));
}

export const BudgetUtilityCalculator = {
	calculateUtility,
	calculateCandidateUtility,
};
