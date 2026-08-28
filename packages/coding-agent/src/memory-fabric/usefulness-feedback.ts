/**
 * Usefulness Feedback, Smoothed Estimation & Contribution Evaluation
 *
 * Implements the self-improving feedback loop: immutable usefulness feedback
 * events, delta-based and Bayesian-smoothed per-memory usefulness scores, and
 * deterministic evaluation of what each injected memory actually contributed
 * to a turn.
 */

import type { UsefulnessFeedbackEvent } from "./adaptive-fidelity/types";
import type { MemoryRecord } from "./types";

/**
 * Observable execution evidence collected during a turn. Every field is a
 * concrete, auditable signal; contribution outcomes are derived only from
 * these observations.
 */
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

/**
 * Usefulness Feedback & Calibration Manager
 *
 * Records immutable feedback events and maintains two per-memory scores:
 * a fast delta-based score and a Bayesian-smoothed estimate that resists
 * overreacting to small sample counts.
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
			const pos = (this.#positiveCounts.get(event.memoryId) ?? 0) + 1;
			this.#positiveCounts.set(event.memoryId, pos);
		} else if (event.rating === "unhelpful") {
			const neg = (this.#negativeCounts.get(event.memoryId) ?? 0) + 1;
			this.#negativeCounts.set(event.memoryId, neg);
		}

		const currentScore = this.#usefulnessScores.get(event.memoryId) ?? 0.5;
		let delta = 0;
		if (event.rating === "useful") delta = 0.15;
		else if (event.rating === "partially_used") delta = 0.05;
		else if (event.rating === "unhelpful") delta = -0.2;

		const newScore = Math.max(0.0, Math.min(1.0, currentScore + delta));
		this.#usefulnessScores.set(event.memoryId, newScore);
	}

	getUsefulnessScore(memoryId: string): number {
		return this.#usefulnessScores.get(memoryId) ?? 0.5;
	}

	getSmoothedUsefulnessScore(memoryId: string): number {
		const pos = this.#positiveCounts.get(memoryId) ?? 0;
		const neg = this.#negativeCounts.get(memoryId) ?? 0;
		if (pos === 0 && neg === 0) {
			return this.#usefulnessScores.get(memoryId) ?? 0.5;
		}
		return this.#estimator.estimate(pos, neg).score;
	}

	getFeedbackEvents(): UsefulnessFeedbackEvent[] {
		return [...this.#feedbackEvents];
	}
}

/**
 * Smoothed Usefulness Estimator
 *
 * Estimates memory usefulness using a Bayesian smoothing approach
 * that balances observed positive/negative signals against a neutral prior.
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

	/**
	 * Estimate the usefulness score given positive and negative observations.
	 * Bayesian smoothing:
	 * (priorWeight * priorScore + positive) / (priorWeight + positive + negative)
	 */
	estimate(positiveCount: number, negativeCount: number): { score: number; totalObservations: number } {
		const totalObservations = positiveCount + negativeCount;
		const numerator = this.#priorWeight * this.#priorScore + positiveCount;
		const denominator = this.#priorWeight + totalObservations;
		const score = numerator / denominator;
		return { score, totalObservations };
	}
}

export interface ContributionOutcome {
	outcome: "used" | "partially_used" | "unknown" | "outdated" | "unhelpful" | "harmful" | "contradicted";
	confidence: number;
	evidence: Array<{
		type: string;
		description?: string;
	}>;
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
 * Deterministic contribution evaluator.
 *
 * Every outcome is derived from observable trace evidence; identical inputs
 * always produce identical outcomes. "harmful" is reserved for future
 * explicit harm evidence (e.g. a verified regression caused by following a
 * memory) — unnecessary work alone classifies as "unhelpful".
 */
export class ContributionEvaluator {
	evaluate(item: InjectionItem, trace: TurnExecutionTrace, record?: MemoryRecord): ContributionOutcome {
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
			const fileOverlap = !!trace.touchedFiles?.length;
			if (fileOverlap) {
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

		// User correction -> contradicted (highest priority)
		if (trace.userCorrectedMemoryIds?.includes(item.memoryId)) {
			evidence.push({ type: "user-correction" });
			outcome = "contradicted";
			confidence = Math.max(confidence, 0.95);
		}

		// Unnecessary work -> unhelpful (deterministic; never randomized)
		if (trace.unrelatedFileReads?.length && record) {
			for (const file of trace.unrelatedFileReads) {
				if (record.content.includes(file)) {
					evidence.push({ type: "unnecessary-work", description: file });
					causedExtraWork = true;
					if (outcome === "unknown" || outcome === "partially_used") {
						outcome = "unhelpful";
					}
					confidence = Math.max(confidence, 0.7);
				}
			}
		}

		return { outcome, confidence, evidence, preventedKnownFailure, causedExtraWork, memoryId: item.memoryId };
	}

	evaluateBatch(items: InjectionItem[], trace: TurnExecutionTrace, records: MemoryRecord[]): ContributionOutcome[] {
		const recordMap = new Map(records.map(r => [r.id, r]));
		return items.map(item => this.evaluate(item, trace, recordMap.get(item.memoryId)));
	}
}
