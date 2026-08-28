/**
 * Adaptive Context Budget Engine (ACF lane).
 *
 * Task-need classification, dynamic token-budget calculation, progressive
 * expansion value-gating, and immutable usefulness feedback. Observe-only:
 * every class here computes decisions/telemetry — nothing executes retrieval,
 * mutates canonical stores, or touches the network or disk.
 *
 * Discipline (matches the rest of the memory-fabric lanes):
 *   - DETERMINISTIC: no clocks, no randomness — the same inputs always yield
 *     the same classification, budget, and outcome.
 *   - FAIL-SAFE MATH: signals are clamped to their documented ranges before
 *     use; non-finite values are treated as absent.
 *   - Imports only sibling types; additive (not wired into any index).
 */

import type {
	AdaptiveBudgetConfig,
	BudgetSignals,
	ContextNeedCategory,
	InformationNeed,
	MemoryRecordLike,
	ProgressiveExpansionStep,
	UsefulnessFeedbackEvent,
} from "./types";

/** What actually happened during a turn — the evaluator's evidence source. */
export interface TurnExecutionTrace {
	citedMemoryIds?: string[];
	followedProcedureStepIds?: string[];
	touchedFiles?: string[];
	ranTestIds?: string[];
	executedCommands?: string[];
	preventedFailureSignatures?: string[];
	rejectedMemoryIds?: string[];
	userCorrectedMemoryIds?: string[];
	unrelatedFileReads?: string[];
}

export const DEFAULT_ADAPTIVE_CONFIG: AdaptiveBudgetConfig = {
	initialTokenBudget: 2500,
	normalTokenBudget: 3000,
	debuggingTokenBudget: 6000,
	architectureTokenBudget: 12000,
	recoveryTokenBudget: 16000,
	repoWideTokenBudget: 24000,
	absoluteMaxTokens: 32000,
	expansionStepTokens: 4000,
	maxExpansions: 4,
	maxMemorySharePercent: 20,
	fallback700Tokens: false,
};

/** Clamp a signal to [0, 1]; non-finite values collapse to 0. */
function unit(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 0;
	if (value < 0) return 0;
	if (value > 1) return 1;
	return value;
}

/**
 * Task Intent & Information Need Classifier.
 *
 * Ordering matters and is deliberate: the specialized categories (recovery,
 * architecture, debugging, repository-wide) are checked BEFORE the trivial
 * short-prompt heuristic. A short prompt like "rollback now" or "redesign api"
 * is a recovery/architecture task, not a trivial one — length alone must
 * never override an explicit intent keyword.
 */
export function classifyCategory(taskPrompt: string): ContextNeedCategory {
	const text = (taskPrompt ?? "").toLowerCase();
	if (
		text.includes("restore") ||
		text.includes("recover") ||
		text.includes("rollback") ||
		text.includes("checkpoint")
	) {
		return "recovery";
	}
	if (
		text.includes("architect") ||
		text.includes("design") ||
		text.includes("refactor") ||
		text.includes("migration")
	) {
		return "architecture";
	}
	if (
		text.includes("fix") ||
		text.includes("bug") ||
		text.includes("error") ||
		text.includes("fail") ||
		text.includes("crash")
	) {
		return "debugging";
	}
	if (
		text.includes("across repo") ||
		text.includes("all files") ||
		text.includes("global search") ||
		text.includes("full codebase")
	) {
		return "repository-wide";
	}
	if (text.length < 30) return "trivial";
	return "normal";
}

export function generateInformationNeeds(category: ContextNeedCategory, _prompt: string): InformationNeed[] {
	const needs: InformationNeed[] = [
		{
			id: "need_task_state",
			category,
			topic: "active task state and objective",
			required: true,
			priority: 1.0,
			minVerification: "observed",
		},
	];

	if (category === "debugging") {
		needs.push(
			{
				id: "need_error_logs",
				category,
				topic: "error messages and stack traces",
				required: true,
				priority: 0.9,
				minVerification: "observed",
			},
			{
				id: "need_recent_edits",
				category,
				topic: "recently modified code files",
				required: false,
				priority: 0.7,
				minVerification: "observed",
			},
		);
	} else if (category === "architecture") {
		needs.push(
			{
				id: "need_decisions",
				category,
				topic: "architectural decisions and contracts",
				required: true,
				priority: 0.95,
				minVerification: "user-confirmed",
			},
			{
				id: "need_code_graph",
				category,
				topic: "symbol dependencies and class relationships",
				required: false,
				priority: 0.8,
				minVerification: "observed",
			},
		);
	} else if (category === "recovery") {
		needs.push({
			id: "need_last_checkpoint",
			category,
			topic: "last verified checkpoint state",
			required: true,
			priority: 1.0,
			minVerification: "observed",
		});
	}

	return needs;
}

export const TaskClassifier = {
	classifyCategory,
	generateInformationNeeds,
};

/**
 * Dynamic Adaptive Budget Calculator.
 *
 * Base budget per category, adjusted up by complexity / graph-impact /
 * unresolved-issue signals and down by contradiction / low-usefulness
 * signals, then clamped: min(preferred, share cap, absolute max) and floored
 * at `minimumTokens` (default 500). Signals are clamped to [0, 1] before use.
 */
export class AdaptiveBudgetCalculator {
	#config: AdaptiveBudgetConfig;

	constructor(config: Partial<AdaptiveBudgetConfig> = {}) {
		this.#config = { ...DEFAULT_ADAPTIVE_CONFIG, ...config };
	}

	calculateBudget(
		category: ContextNeedCategory,
		availableModelContextWindow = 128000,
		signals?: BudgetSignals,
	): number {
		if (this.#config.fallback700Tokens) return 700;

		let baseBudget: number;
		switch (category) {
			case "trivial":
				baseBudget = this.#config.initialTokenBudget;
				break;
			case "debugging":
				baseBudget = this.#config.debuggingTokenBudget;
				break;
			case "architecture":
				baseBudget = this.#config.architectureTokenBudget;
				break;
			case "recovery":
				baseBudget = this.#config.recoveryTokenBudget;
				break;
			case "repository-wide":
				baseBudget = this.#config.repoWideTokenBudget;
				break;
			default:
				baseBudget = this.#config.normalTokenBudget;
				break;
		}

		let preferred = baseBudget;

		if (signals) {
			const complexity = unit(signals.complexityScore);
			if (complexity > 0) {
				preferred += Math.round((this.#config.complexityAllowanceTokens ?? 4000) * complexity);
			}
			const graphImpact = unit(signals.graphImpactScore);
			if (graphImpact > 0) {
				preferred += Math.round((this.#config.graphImpactAllowanceTokens ?? 4000) * graphImpact);
			}
			const unresolved =
				typeof signals.unresolvedIssueCount === "number" && Number.isFinite(signals.unresolvedIssueCount)
					? Math.max(0, Math.floor(signals.unresolvedIssueCount))
					: 0;
			if (unresolved > 0) {
				preferred += Math.min(
					unresolved * (this.#config.tokensPerUnresolvedIssue ?? 1000),
					this.#config.maximumUnresolvedIssueAllowance ?? 8000,
				);
			}
			const contradictionRate = unit(signals.recentContradictionRate);
			if (contradictionRate > 0) {
				preferred -= Math.round((this.#config.contradictionPenaltyTokens ?? 1000) * contradictionRate * 3);
			}
			if (
				typeof signals.usefulnessMovingAverage === "number" &&
				Number.isFinite(signals.usefulnessMovingAverage) &&
				signals.usefulnessMovingAverage < 0.5
			) {
				preferred -= Math.round(
					(this.#config.lowUsefulnessPenaltyTokens ?? 2000) * (1 - unit(signals.usefulnessMovingAverage)),
				);
			}
		}

		const shareCap = Math.floor(availableModelContextWindow * (this.#config.maxMemorySharePercent / 100));
		const calculated = Math.min(preferred, shareCap, this.#config.absoluteMaxTokens);

		return Math.max(this.#config.minimumTokens ?? 500, calculated);
	}
}

/**
 * Progressive Expansion Controller — the value gate that decides whether an
 * expansion step is worth its tokens.
 */
export class ProgressiveExpansionController {
	#config: AdaptiveBudgetConfig;
	#steps: ProgressiveExpansionStep[] = [];

	constructor(config: Partial<AdaptiveBudgetConfig> = {}) {
		this.#config = { ...DEFAULT_ADAPTIVE_CONFIG, ...config };
	}

	evaluateExpansionTrigger(_triggerReason: string, triggerScore: number): "none" | "shadow" | "active" | "urgent" {
		if (triggerScore < 0.42) return "none";
		if (triggerScore < 0.65) return "shadow";
		if (triggerScore < 0.82) return "active";
		return "urgent";
	}

	shouldExecuteExpansion(
		stepIndex: number,
		noveltyScore: number,
		informationGain: number,
		currentTokens: number,
		maxBudget: number,
	): { allow: boolean; reason: string } {
		if (stepIndex >= this.#config.maxExpansions) {
			return { allow: false, reason: `Reached maximum expansion limit (${this.#config.maxExpansions})` };
		}
		if (currentTokens >= maxBudget) {
			return { allow: false, reason: `Current token usage (${currentTokens}) meets max budget (${maxBudget})` };
		}
		if (informationGain < 0.15) {
			return {
				allow: false,
				reason: `Information gain (${informationGain.toFixed(2)}) below minimum 0.15 gate threshold`,
			};
		}
		if (noveltyScore < 0.2) {
			return { allow: false, reason: `Novelty score (${noveltyScore.toFixed(2)}) below minimum 0.20 threshold` };
		}
		return { allow: true, reason: "Expansion approved by value gate" };
	}

	recordStep(step: ProgressiveExpansionStep): void {
		this.#steps.push(step);
	}

	getSteps(): ProgressiveExpansionStep[] {
		return [...this.#steps];
	}
}

/**
 * Smoothed Usefulness Estimator.
 *
 * Bayesian smoothing toward a neutral prior:
 * (priorWeight * priorScore + positive) / (priorWeight + positive + negative)
 */
export class SmoothedUsefulnessEstimator {
	static readonly DEFAULT_PRIOR_SCORE = 0.5;
	static readonly DEFAULT_PRIOR_WEIGHT = 5;

	#priorScore: number;
	#priorWeight: number;

	constructor(
		priorScore = SmoothedUsefulnessEstimator.DEFAULT_PRIOR_SCORE,
		priorWeight = SmoothedUsefulnessEstimator.DEFAULT_PRIOR_WEIGHT,
	) {
		this.#priorScore = priorScore;
		this.#priorWeight = priorWeight;
	}

	estimate(positiveCount: number, negativeCount: number): { score: number; totalObservations: number } {
		const totalObservations = positiveCount + negativeCount;
		const numerator = this.#priorWeight * this.#priorScore + positiveCount;
		const denominator = this.#priorWeight + totalObservations;
		const score = numerator / denominator;
		return { score, totalObservations };
	}
}

/**
 * Usefulness Feedback & Calibration Manager.
 *
 * Immutable event log plus two views: a fast delta-adjusted score
 * (useful +0.15, partially_used +0.05, unhelpful −0.2, clamped to [0, 1],
 * starting at 0.5) and a Bayesian-smoothed score once observations exist.
 */
export class UsefulnessFeedbackManager {
	#feedbackEvents: UsefulnessFeedbackEvent[] = [];
	#usefulnessScores = new Map<string, number>();
	#positiveCounts = new Map<string, number>();
	#negativeCounts = new Map<string, number>();
	#estimator = new SmoothedUsefulnessEstimator();

	recordFeedback(event: UsefulnessFeedbackEvent): void {
		this.#feedbackEvents.push(event);

		if (event.rating === "useful") {
			this.#positiveCounts.set(event.memoryId, (this.#positiveCounts.get(event.memoryId) ?? 0) + 1);
		} else if (event.rating === "unhelpful") {
			this.#negativeCounts.set(event.memoryId, (this.#negativeCounts.get(event.memoryId) ?? 0) + 1);
		}

		const currentScore = this.#usefulnessScores.get(event.memoryId) ?? 0.5;
		let delta = 0;
		if (event.rating === "useful") delta = 0.15;
		else if (event.rating === "partially_used") delta = 0.05;
		else if (event.rating === "unhelpful") delta = -0.2;

		this.#usefulnessScores.set(event.memoryId, Math.max(0.0, Math.min(1.0, currentScore + delta)));
	}

	getUsefulnessScore(memoryId: string): number {
		return this.#usefulnessScores.get(memoryId) ?? 0.5;
	}

	getSmoothedUsefulnessScore(memoryId: string): number {
		const pos = this.#positiveCounts.get(memoryId) ?? 0;
		const neg = this.#negativeCounts.get(memoryId) ?? 0;
		if (pos === 0 && neg === 0) return this.#usefulnessScores.get(memoryId) ?? 0.5;
		return this.#estimator.estimate(pos, neg).score;
	}

	getFeedbackEvents(): UsefulnessFeedbackEvent[] {
		return [...this.#feedbackEvents];
	}
}

export interface ContributionOutcome {
	outcome: "used" | "partially_used" | "unknown" | "outdated" | "unhelpful" | "harmful" | "contradicted";
	confidence: number;
	evidence: Array<{ type: string; description?: string }>;
	preventedKnownFailure: boolean;
	causedExtraWork: boolean;
	memoryId: string;
}

export interface InjectionItem {
	memoryId: string;
	injectionId: string;
	rank: number;
	lane: string;
	tokenCount: number;
	score: number;
	confidence: number;
	verification: string;
	purpose: string;
}

/**
 * Contribution Evaluator — infers what an injected memory actually did during
 * a turn from the execution trace. Fully deterministic: an unnecessary-work
 * signal always yields "unhelpful"; "harmful" is reserved for the one signal
 * that proves harm (a user correction, which maps to "contradicted" with its
 * own higher-priority rule). Never guesses between outcomes.
 */
export class ContributionEvaluator {
	evaluate(item: InjectionItem, trace: TurnExecutionTrace, record?: MemoryRecordLike): ContributionOutcome {
		const evidence: Array<{ type: string; description?: string }> = [];
		let outcome: ContributionOutcome["outcome"] = "unknown";
		let confidence = 0.2;
		let preventedKnownFailure = false;
		let causedExtraWork = false;

		// Explicit citation -> used
		if (trace.citedMemoryIds?.includes(item.memoryId)) {
			evidence.push({ type: "explicit-citation" });
			outcome = "used";
			confidence = Math.max(confidence, 0.8);
		}

		// Procedure followed with file overlap -> at least partially_used
		if (item.purpose === "procedure" && trace.followedProcedureStepIds?.includes(item.memoryId)) {
			if (trace.touchedFiles?.length) {
				evidence.push({ type: "procedure-followed", description: "Procedure step executed with file overlap" });
				if (outcome === "unknown") outcome = "partially_used";
				confidence = Math.max(confidence, 0.7);
			}
		}

		// Failure prevention signal
		if (trace.preventedFailureSignatures?.length && record) {
			const contentLower = record.content.toLowerCase();
			for (const sig of trace.preventedFailureSignatures) {
				if (contentLower.includes(sig.toLowerCase())) {
					evidence.push({ type: "failure-prevented", description: sig });
					preventedKnownFailure = true;
					if (outcome === "unknown") outcome = "partially_used";
					confidence = Math.max(confidence, 0.75);
				}
			}
		}

		// Agent rejection -> outdated (unless positive evidence overrides)
		if (trace.rejectedMemoryIds?.includes(item.memoryId)) {
			evidence.push({ type: "agent-rejection" });
			if (outcome === "unknown") {
				outcome = "outdated";
				confidence = Math.max(confidence, 0.6);
			}
		}

		// Unnecessary work -> unhelpful (deterministic; no coin-flips)
		if (trace.unrelatedFileReads?.length && record) {
			for (const file of trace.unrelatedFileReads) {
				if (record.content.includes(file)) {
					evidence.push({ type: "unnecessary-work", description: file });
					causedExtraWork = true;
					if (outcome === "unknown" || outcome === "partially_used") outcome = "unhelpful";
					confidence = Math.max(confidence, 0.7);
				}
			}
		}

		// User correction -> contradicted (highest priority, checked last so
		// it can never be overwritten by a weaker signal)
		if (trace.userCorrectedMemoryIds?.includes(item.memoryId)) {
			evidence.push({ type: "user-correction" });
			outcome = "contradicted";
			confidence = Math.max(confidence, 0.95);
		}

		return { outcome, confidence, evidence, preventedKnownFailure, causedExtraWork, memoryId: item.memoryId };
	}

	evaluateBatch(
		items: InjectionItem[],
		trace: TurnExecutionTrace,
		records: MemoryRecordLike[],
	): ContributionOutcome[] {
		const recordMap = new Map(records.map(r => [r.id, r]));
		return items.map(item => this.evaluate(item, trace, recordMap.get(item.memoryId)));
	}
}
