/**
 * Context Utilization Tracking & Evaluation.
 *
 * Measures whether injected memory context actually helped task execution,
 * across four levels:
 *
 *   1. Record utilization  -- which injected records were used at all.
 *   2. Token utilization   -- how many injected tokens were useful.
 *   3. Need coverage       -- how many required information needs were met.
 *   4. Expansion efficiency -- whether progressive expansions paid off.
 *
 * Relationship to siblings:
 *   - `./usefulness-feedback` scores individual memories over time (Bayesian
 *     smoothing); this module scores one turn's context packet.
 *   - `./expansion-thresholds` gates a *candidate* expansion after scoring
 *     (post-flight); {@link preventExpansionLoop} here is the cheap
 *     *pre-flight* loop guard fed by the PREVIOUS expansion's results.
 *
 * Discipline: pure and deterministic (no clocks, no randomness, no IO);
 * imports only sibling types; identical inputs always produce identical
 * outputs.
 */

import type { ExpansionTrigger } from "./adaptive-fidelity/types";
import type { MemoryLane, MemoryTier } from "./tiered-retrieval-types";

/** Outcome categories for one injected memory item. */
export type UtilizationOutcome = "used" | "partially-used" | "ignored" | "contradicted" | "outdated" | "harmful";

/** Behavioral signals observed for a single injected memory item. */
export interface UtilizationSignals {
	explicitlyCited: boolean;
	procedureFollowed: boolean;
	recommendedFileTouched: boolean;
	recommendedToolUsed: boolean;
	recommendedValidationRun: boolean;
	recommendedValidationPassed: boolean;
	warningFollowed: boolean;
	userCorrected: boolean;
	agentRejected: boolean;
	causedExtraWork: boolean;
}

/** Utilization record for a single injected memory item. */
export interface ContextItemUtilization {
	packetId: string;
	memoryId: string;
	tier: MemoryTier;
	lane: MemoryLane;
	injectedTokens: number;
	outcome: UtilizationOutcome;
	signals: UtilizationSignals;
	utilizationConfidence: number;
	evaluatedAt: string;
}

/** Aggregate utilization for a context packet. */
export interface ContextPacketUtilization {
	packetId: string;
	turnId: string;
	taskId: string;

	totalInjectedTokens: number;
	utilizedTokens: number;
	weightedUtilizationRate: number;

	totalRecords: number;
	utilizedRecords: number;
	recordUtilizationRate: number;

	requiredNeeds: number;
	satisfiedNeeds: number;
	needCoverageRate: number;

	expansionCount: number;
	expandedTokens: number;
	expansionUtilizationRate: number;

	taskSucceeded?: boolean;
	testSucceeded?: boolean;
	knownFailureRepeated?: boolean;
}

/** Utilization record for a single progressive expansion. */
export interface ExpansionUtilization {
	expansionId: string;
	trigger: ExpansionTrigger;
	requestedTiers: MemoryTier[];

	injectedTokens: number;
	utilizedTokens: number;
	utilizationRate: number;

	newMemoryCount: number;
	duplicateMemoryCount: number;
	newInformationRatio: number;

	confidenceBefore: number;
	confidenceAfter: number;
	coverageBefore: number;
	coverageAfter: number;

	taskProgressObserved: boolean;
}

/** Tunables for utilization scoring. */
export interface UtilizationConfig {
	/** Token weight credited to partially-used records. Default 0.5. */
	partialUseWeight: number;
}

export const DEFAULT_UTILIZATION_CONFIG: UtilizationConfig = {
	partialUseWeight: 0.5,
};

/**
 * Calculate an item utilization score from observed behavioral signals.
 * Returns a score between -1 (harmful) and +1 (heavily used).
 */
export function calculateItemUtilizationScore(signals: UtilizationSignals): number {
	let score = 0;

	if (signals.explicitlyCited) score += 0.35;
	if (signals.procedureFollowed) score += 0.25;
	if (signals.recommendedFileTouched) score += 0.1;
	if (signals.recommendedToolUsed) score += 0.1;
	if (signals.recommendedValidationRun) score += 0.1;
	if (signals.recommendedValidationPassed) score += 0.2;
	if (signals.warningFollowed) score += 0.1;

	if (signals.userCorrected) score -= 0.8;
	if (signals.agentRejected) score -= 0.4;
	if (signals.causedExtraWork) score -= 0.3;

	return Math.max(-1, Math.min(score, 1));
}

/** Classify a utilization score into an outcome category. */
export function classifyUtilization(score: number): UtilizationOutcome {
	if (score >= 0.65) return "used";
	if (score >= 0.2) return "partially-used";
	if (score <= -0.6) return "harmful";
	if (score < 0) return "contradicted";
	return "ignored";
}

/** Observed agent actions during a turn, used to infer behavioral signals. */
export interface TurnActions {
	modelResponseText?: string;
	toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
	filesTouched?: string[];
	testsRun?: string[];
	testsPassed?: string[];
	userCorrectionText?: string;
}

/**
 * Infer behavioral signals from observed agent actions during a turn.
 *
 * Heuristic but deterministic: every signal is derived from substring
 * matching against the record content and the observed actions. Rejection
 * detection is response-wide (it cannot attribute "incorrect"/"outdated"
 * wording to one specific record), so treat `agentRejected` as a weak signal.
 */
export function inferSignalsFromBehavior(
	record: { id: string; content: string; sourceReferences?: string[] },
	actions: TurnActions,
): UtilizationSignals {
	const text = actions.modelResponseText?.toLowerCase() ?? "";
	const contentLower = record.content.toLowerCase();

	// Explicit citation: the record id, or a leading slice of its content.
	const explicitlyCited = Boolean(
		text.includes(record.id.toLowerCase()) ||
			(record.content.length > 20 && text.includes(contentLower.slice(0, 30))),
	);

	// Procedure followed: cited, acted on it, and the user did not correct.
	const procedureFollowed = Boolean(
		explicitlyCited && (actions.toolCalls?.length ?? 0) > 0 && !actions.userCorrectionText,
	);

	// File touched: a source ref or the record content names a touched file.
	const fileRefs = (record.sourceReferences ?? []).filter(r => r.startsWith("file:")).map(r => r.replace("file:", ""));
	const recommendedFileTouched = Boolean(
		actions.filesTouched?.some(f => fileRefs.includes(f) || contentLower.includes(f.toLowerCase())),
	);

	// Recommended tool used: the record content names an invoked tool.
	const recommendedToolUsed = Boolean(
		(actions.toolCalls?.length ?? 0) > 0 &&
			actions.toolCalls?.some(tc => contentLower.includes(tc.name.toLowerCase())),
	);

	// Validation run and passed: the record content names an executed test.
	const recommendedValidationRun = Boolean(
		(actions.testsRun?.length ?? 0) > 0 && actions.testsRun?.some(t => contentLower.includes(t.toLowerCase())),
	);
	const recommendedValidationPassed = Boolean(
		recommendedValidationRun && actions.testsPassed?.some(t => contentLower.includes(t.toLowerCase())),
	);

	// Warning heeded: the record carries a warning and a non-shell tool ran.
	const warningFollowed = Boolean(
		contentLower.includes("warning") && actions.toolCalls?.some(tc => tc.name !== "bash"),
	);

	const userCorrected = Boolean(actions.userCorrectionText && actions.userCorrectionText.length > 0);

	const agentRejected = Boolean(text.includes("incorrect") || text.includes("outdated") || text.includes("disregard"));

	const causedExtraWork = Boolean(userCorrected && (actions.toolCalls?.length ?? 0) > 5);

	return {
		explicitlyCited,
		procedureFollowed,
		recommendedFileTouched,
		recommendedToolUsed,
		recommendedValidationRun,
		recommendedValidationPassed,
		warningFollowed,
		userCorrected,
		agentRejected,
		causedExtraWork,
	};
}

/** Record utilization rate: used or partially-used records / total records. */
export function calculateRecordUtilizationRate(items: ContextItemUtilization[]): number {
	if (items.length === 0) return 0;
	const used = items.filter(i => i.outcome === "used" || i.outcome === "partially-used").length;
	return used / items.length;
}

/** Tokens credited as useful, weighting partial use by `partialUseWeight`. */
function usefulTokens(items: ContextItemUtilization[], partialUseWeight: number): number {
	return items.reduce((sum, item) => {
		if (item.outcome === "used") return sum + item.injectedTokens;
		if (item.outcome === "partially-used") return sum + item.injectedTokens * partialUseWeight;
		return sum;
	}, 0);
}

/** Token utilization rate: tokens from used records / total injected tokens. */
export function calculateTokenUtilizationRate(
	items: ContextItemUtilization[],
	config: UtilizationConfig = DEFAULT_UTILIZATION_CONFIG,
): number {
	const totalTokens = items.reduce((sum, i) => sum + i.injectedTokens, 0);
	if (totalTokens === 0) return 0;
	return Math.min(1, usefulTokens(items, config.partialUseWeight) / totalTokens);
}

/** Information-need coverage rate. Zero required needs count as covered. */
export function calculateNeedCoverageRate(requiredNeeds: number, satisfiedNeeds: number): number {
	if (requiredNeeds === 0) return 1;
	return Math.min(1, satisfiedNeeds / requiredNeeds);
}

/** Calculate aggregate context-packet utilization. */
export function calculatePacketUtilization(
	packetId: string,
	turnId: string,
	taskId: string,
	items: ContextItemUtilization[],
	needs: { required: number; satisfied: number },
	expansions: { count: number; tokens: number; utilizedTokens: number },
	outcomes?: { taskSucceeded?: boolean; testSucceeded?: boolean; knownFailureRepeated?: boolean },
	config: UtilizationConfig = DEFAULT_UTILIZATION_CONFIG,
): ContextPacketUtilization {
	const totalInjectedTokens = items.reduce((sum, i) => sum + i.injectedTokens, 0);
	const utilizedTokens = usefulTokens(items, config.partialUseWeight);

	const weightedUtilizationRate = totalInjectedTokens > 0 ? Math.min(1, utilizedTokens / totalInjectedTokens) : 0;
	const totalRecords = items.length;
	const utilizedRecords = items.filter(i => i.outcome === "used" || i.outcome === "partially-used").length;
	const recordUtilizationRate = totalRecords > 0 ? utilizedRecords / totalRecords : 0;

	const needCoverageRate = calculateNeedCoverageRate(needs.required, needs.satisfied);
	const expansionUtilizationRate =
		expansions.tokens > 0 ? Math.min(1, expansions.utilizedTokens / expansions.tokens) : 0;

	return {
		packetId,
		turnId,
		taskId,
		totalInjectedTokens,
		utilizedTokens,
		weightedUtilizationRate,
		totalRecords,
		utilizedRecords,
		recordUtilizationRate,
		requiredNeeds: needs.required,
		satisfiedNeeds: needs.satisfied,
		needCoverageRate,
		expansionCount: expansions.count,
		expandedTokens: expansions.tokens,
		expansionUtilizationRate,
		taskSucceeded: outcomes?.taskSucceeded,
		testSucceeded: outcomes?.testSucceeded,
		knownFailureRepeated: outcomes?.knownFailureRepeated,
	};
}

/**
 * New-information ratio for an expansion: items that are novel by BOTH id and
 * content hash / all items. A missing content hash counts as novel-by-hash.
 */
export function calculateNewInformationRatio(
	existingMemoryIds: ReadonlySet<string>,
	existingHashes: ReadonlySet<string>,
	newItems: Array<{ memoryId: string; contentHash?: string }>,
): number {
	if (newItems.length === 0) return 0;

	let novelCount = 0;
	for (const item of newItems) {
		const idNovel = !existingMemoryIds.has(item.memoryId);
		const hashNovel = !item.contentHash || !existingHashes.has(item.contentHash);
		if (idNovel && hashNovel) novelCount++;
	}

	return novelCount / newItems.length;
}

/** Everything needed to evaluate one expansion's utilization. */
export interface ExpansionUtilizationInput {
	expansionId: string;
	trigger: ExpansionTrigger;
	requestedTiers: MemoryTier[];
	/** Per-item utilization for the records this expansion injected. */
	items: ContextItemUtilization[];
	/** Memory ids already in context before the expansion. */
	existingMemoryIds: ReadonlySet<string>;
	/** Content hashes already in context before the expansion. */
	existingHashes: ReadonlySet<string>;
	/** The raw items the expansion returned, before dedupe. */
	rawItems: Array<{ memoryId: string; contentHash?: string }>;
	confidenceBefore: number;
	confidenceAfter: number;
	coverageBefore: number;
	coverageAfter: number;
	taskProgressObserved: boolean;
}

/** Evaluate one expansion's utilization. */
export function calculateExpansionUtilization(
	input: ExpansionUtilizationInput,
	config: UtilizationConfig = DEFAULT_UTILIZATION_CONFIG,
): ExpansionUtilization {
	const injectedTokens = input.items.reduce((sum, i) => sum + i.injectedTokens, 0);
	const utilized = usefulTokens(input.items, config.partialUseWeight);

	const utilizationRate = injectedTokens > 0 ? Math.min(1, utilized / injectedTokens) : 0;
	const newInformationRatio = calculateNewInformationRatio(
		input.existingMemoryIds,
		input.existingHashes,
		input.rawItems,
	);

	const newMemoryCount = input.rawItems.filter(i => !input.existingMemoryIds.has(i.memoryId)).length;
	const duplicateMemoryCount = input.rawItems.length - newMemoryCount;

	return {
		expansionId: input.expansionId,
		trigger: input.trigger,
		requestedTiers: input.requestedTiers,
		injectedTokens,
		utilizedTokens: utilized,
		utilizationRate,
		newMemoryCount,
		duplicateMemoryCount,
		newInformationRatio,
		confidenceBefore: input.confidenceBefore,
		confidenceAfter: input.confidenceAfter,
		coverageBefore: input.coverageBefore,
		coverageAfter: input.coverageAfter,
		taskProgressObserved: input.taskProgressObserved,
	};
}

/** State the pre-flight expansion loop guard inspects. */
export interface ExpansionLoopState {
	expansionCount: number;
	maximumExpansions: number;
	/** New-information ratio of the PREVIOUS expansion, when one happened. */
	lastExpansionNewInfoRatio?: number;
	/** Coverage gain of the PREVIOUS expansion, when one happened. */
	lastExpansionCoverageGain?: number;
	/** 0..1 similarity between this query and the prior turn's query. */
	repeatedQuerySimilarity?: number;
	remainingTokens: number;
	/** Minimum tokens required to attempt another step. Default 200. */
	minTokensForStep?: number;
}

/**
 * Pre-flight expansion loop guard.
 *
 * Blocks an expansion attempt BEFORE retrieval when the previous expansion
 * was unproductive or the query is a near-duplicate. The post-flight value
 * gate on a candidate's own results lives in `./expansion-thresholds`
 * (`shouldInjectExpansion`); the two are complementary, not duplicates.
 */
export function preventExpansionLoop(state: ExpansionLoopState): { allow: boolean; reason?: string } {
	const minStep = state.minTokensForStep ?? 200;

	if (state.expansionCount >= state.maximumExpansions) {
		return { allow: false, reason: "Maximum expansion count reached." };
	}

	if (state.remainingTokens < minStep) {
		return { allow: false, reason: "Insufficient remaining token budget." };
	}

	if (state.lastExpansionNewInfoRatio !== undefined && state.lastExpansionNewInfoRatio < 0.2) {
		return { allow: false, reason: "Previous expansion yielded less than 20% new information." };
	}

	if (state.lastExpansionCoverageGain !== undefined && state.lastExpansionCoverageGain < 0.05) {
		return { allow: false, reason: "Previous expansion coverage gain was under 5%." };
	}

	if (state.repeatedQuerySimilarity !== undefined && state.repeatedQuerySimilarity >= 0.92) {
		return { allow: false, reason: "Expansion query is 92%+ identical to prior turn query." };
	}

	return { allow: true };
}
