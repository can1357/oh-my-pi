/**
 * Tests for the Adaptive Context Budget Engine (ACF lane).
 *
 * Verifies deterministic task classification (specialized intents beat the
 * short-prompt heuristic), budget math (bonuses, penalties, share cap,
 * absolute max, minimum floor, 700-token escape hatch), the progressive
 * expansion value gate, usefulness feedback deltas + Bayesian smoothing, and
 * the fully deterministic contribution evaluator. Offline; no clock.
 */

import { describe, expect, it } from "bun:test";
import {
	AdaptiveBudgetCalculator,
	ContributionEvaluator,
	DEFAULT_ADAPTIVE_CONFIG,
	type InjectionItem,
	ProgressiveExpansionController,
	SmoothedUsefulnessEstimator,
	TaskClassifier,
	type TurnExecutionTrace,
	UsefulnessFeedbackManager,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/adaptive-fidelity/adaptive-budget";
import type { UsefulnessFeedbackEvent } from "@oh-my-pi/pi-coding-agent/memory-fabric/adaptive-fidelity/types";

function feedback(memoryId: string, rating: UsefulnessFeedbackEvent["rating"]): UsefulnessFeedbackEvent {
	return {
		id: `fb-${memoryId}-${rating}`,
		memoryId,
		sessionId: "sess-1",
		turnId: "turn-1",
		rating,
		tokenCost: 100,
		latencyMs: 5,
		timestamp: "2026-01-01T00:00:00.000Z",
	};
}

function injection(memoryId: string, purpose = "fact"): InjectionItem {
	return {
		memoryId,
		injectionId: `inj-${memoryId}`,
		rank: 1,
		lane: "semantic",
		tokenCount: 120,
		score: 0.9,
		confidence: 0.8,
		verification: "observed",
		purpose,
	};
}

describe("TaskClassifier", () => {
	it("classifies specialized intents before the short-prompt heuristic", () => {
		// All of these are shorter than 30 characters — length must not win.
		expect(TaskClassifier.classifyCategory("rollback now")).toBe("recovery");
		expect(TaskClassifier.classifyCategory("redesign api")).toBe("architecture");
		expect(TaskClassifier.classifyCategory("error")).toBe("debugging");
		expect(TaskClassifier.classifyCategory("tests fail")).toBe("debugging");
	});

	it("classifies each category from its keywords", () => {
		expect(TaskClassifier.classifyCategory("restore the last checkpoint")).toBe("recovery");
		expect(TaskClassifier.classifyCategory("plan the schema migration")).toBe("architecture");
		expect(TaskClassifier.classifyCategory("fix the crash in the parser")).toBe("debugging");
		expect(TaskClassifier.classifyCategory("rename this symbol across repo")).toBe("repository-wide");
	});

	it("falls back to trivial for short keyword-free prompts, normal otherwise", () => {
		expect(TaskClassifier.classifyCategory("hello")).toBe("trivial");
		expect(TaskClassifier.classifyCategory("update the readme with the new usage section")).toBe("normal");
	});

	it("recovery keywords outrank later categories in the same prompt", () => {
		expect(TaskClassifier.classifyCategory("rollback the buggy migration")).toBe("recovery");
	});

	it("generates category-specific information needs, always including task state", () => {
		const debugNeeds = TaskClassifier.generateInformationNeeds("debugging", "fix it");
		expect(debugNeeds.map(n => n.id)).toEqual(["need_task_state", "need_error_logs", "need_recent_edits"]);

		const archNeeds = TaskClassifier.generateInformationNeeds("architecture", "redesign");
		expect(archNeeds.map(n => n.id)).toEqual(["need_task_state", "need_decisions", "need_code_graph"]);
		expect(archNeeds[1].minVerification).toBe("user-confirmed");

		const recoveryNeeds = TaskClassifier.generateInformationNeeds("recovery", "restore");
		expect(recoveryNeeds.map(n => n.id)).toEqual(["need_task_state", "need_last_checkpoint"]);

		expect(TaskClassifier.generateInformationNeeds("trivial", "hi").map(n => n.id)).toEqual(["need_task_state"]);
	});
});

describe("AdaptiveBudgetCalculator", () => {
	it("returns the base budget per category with no signals", () => {
		const calc = new AdaptiveBudgetCalculator();
		expect(calc.calculateBudget("trivial")).toBe(2500);
		expect(calc.calculateBudget("normal")).toBe(3000);
		expect(calc.calculateBudget("debugging")).toBe(6000);
		expect(calc.calculateBudget("architecture")).toBe(12000);
		expect(calc.calculateBudget("recovery")).toBe(16000);
		expect(calc.calculateBudget("repository-wide")).toBe(24000);
	});

	it("honours the 700-token escape hatch unconditionally", () => {
		const calc = new AdaptiveBudgetCalculator({ fallback700Tokens: true });
		expect(calc.calculateBudget("recovery", 128000, { complexityScore: 1 })).toBe(700);
	});

	it("adds complexity and graph-impact allowances scaled by the signal", () => {
		const calc = new AdaptiveBudgetCalculator();
		expect(calc.calculateBudget("normal", 128000, { complexityScore: 1 })).toBe(7000);
		expect(calc.calculateBudget("normal", 128000, { complexityScore: 0.5 })).toBe(5000);
		expect(calc.calculateBudget("normal", 128000, { graphImpactScore: 1 })).toBe(7000);
	});

	it("caps the unresolved-issue allowance at 8000 tokens", () => {
		const calc = new AdaptiveBudgetCalculator();
		expect(calc.calculateBudget("normal", 128000, { unresolvedIssueCount: 3 })).toBe(6000);
		expect(calc.calculateBudget("normal", 128000, { unresolvedIssueCount: 50 })).toBe(11000);
	});

	it("subtracts contradiction and low-usefulness penalties", () => {
		const calc = new AdaptiveBudgetCalculator();
		// 6000 - round(1000 * 0.5 * 3) = 4500
		expect(calc.calculateBudget("debugging", 128000, { recentContradictionRate: 0.5 })).toBe(4500);
		// 6000 - round(2000 * (1 - 0.25)) = 4500; no penalty at or above 0.5
		expect(calc.calculateBudget("debugging", 128000, { usefulnessMovingAverage: 0.25 })).toBe(4500);
		expect(calc.calculateBudget("debugging", 128000, { usefulnessMovingAverage: 0.5 })).toBe(6000);
	});

	it("clamps signals to [0, 1] and ignores non-finite values", () => {
		const calc = new AdaptiveBudgetCalculator();
		expect(calc.calculateBudget("normal", 128000, { complexityScore: 5 })).toBe(7000);
		expect(calc.calculateBudget("normal", 128000, { complexityScore: -1 })).toBe(3000);
		expect(calc.calculateBudget("normal", 128000, { complexityScore: Number.NaN })).toBe(3000);
		expect(calc.calculateBudget("normal", 128000, { unresolvedIssueCount: Number.POSITIVE_INFINITY })).toBe(3000);
	});

	it("enforces the memory share cap of the context window", () => {
		const calc = new AdaptiveBudgetCalculator();
		// 20% of 10000 = 2000 < recovery base 16000
		expect(calc.calculateBudget("recovery", 10000)).toBe(2000);
		// Default window 128000 -> cap 25600, which repo-wide (24000) fits under.
		expect(calc.calculateBudget("repository-wide")).toBe(24000);
	});

	it("enforces the absolute max even for huge windows", () => {
		const calc = new AdaptiveBudgetCalculator();
		const budget = calc.calculateBudget("repository-wide", 1000000, { complexityScore: 1, graphImpactScore: 1 });
		expect(budget).toBe(32000);
	});

	it("never drops below the minimum-token floor", () => {
		const calc = new AdaptiveBudgetCalculator();
		// 3000 - round(1000 * 1 * 3) = 0 -> floored at 500.
		expect(calc.calculateBudget("normal", 128000, { recentContradictionRate: 1 })).toBe(500);
		const strict = new AdaptiveBudgetCalculator({ minimumTokens: 900 });
		expect(strict.calculateBudget("normal", 1000)).toBe(900);
	});
});

describe("ProgressiveExpansionController", () => {
	it("maps trigger scores onto the none/shadow/active/urgent ladder", () => {
		const ctl = new ProgressiveExpansionController();
		expect(ctl.evaluateExpansionTrigger("t", 0.41)).toBe("none");
		expect(ctl.evaluateExpansionTrigger("t", 0.42)).toBe("shadow");
		expect(ctl.evaluateExpansionTrigger("t", 0.65)).toBe("active");
		expect(ctl.evaluateExpansionTrigger("t", 0.82)).toBe("urgent");
	});

	it("gates expansion on step limit, budget, information gain, and novelty", () => {
		const ctl = new ProgressiveExpansionController();
		expect(ctl.shouldExecuteExpansion(DEFAULT_ADAPTIVE_CONFIG.maxExpansions, 1, 1, 0, 32000).allow).toBe(false);
		expect(ctl.shouldExecuteExpansion(0, 1, 1, 32000, 32000).allow).toBe(false);
		expect(ctl.shouldExecuteExpansion(0, 1, 0.14, 0, 32000).allow).toBe(false);
		expect(ctl.shouldExecuteExpansion(0, 0.19, 1, 0, 32000).allow).toBe(false);
		const approved = ctl.shouldExecuteExpansion(0, 0.2, 0.15, 0, 32000);
		expect(approved.allow).toBe(true);
		expect(approved.reason).toBe("Expansion approved by value gate");
	});

	it("records steps and returns a defensive copy", () => {
		const ctl = new ProgressiveExpansionController();
		ctl.recordStep({
			stepIndex: 0,
			mode: "shadow",
			triggerReason: "test",
			triggerScore: 0.5,
			tokenBudget: 4000,
			noveltyScore: 0.5,
			informationGain: 0.5,
			addedMemoryIds: ["m1"],
		});
		const steps = ctl.getSteps();
		expect(steps).toHaveLength(1);
		steps.pop();
		expect(ctl.getSteps()).toHaveLength(1);
	});
});

describe("SmoothedUsefulnessEstimator", () => {
	it("returns the neutral prior with no observations", () => {
		const est = new SmoothedUsefulnessEstimator();
		expect(est.estimate(0, 0).score).toBe(0.5);
	});

	it("applies Bayesian smoothing toward the prior", () => {
		const est = new SmoothedUsefulnessEstimator();
		// (5 * 0.5 + 1) / (5 + 1) = 0.58333…
		expect(est.estimate(1, 0).score).toBeCloseTo(3.5 / 6, 10);
		expect(est.estimate(0, 1).score).toBeCloseTo(2.5 / 6, 10);
		expect(est.estimate(1, 0).totalObservations).toBe(1);
	});
});

describe("UsefulnessFeedbackManager", () => {
	it("applies per-rating deltas from a 0.5 start, clamped to [0, 1]", () => {
		const mgr = new UsefulnessFeedbackManager();
		expect(mgr.getUsefulnessScore("m1")).toBe(0.5);
		mgr.recordFeedback(feedback("m1", "useful"));
		expect(mgr.getUsefulnessScore("m1")).toBeCloseTo(0.65, 10);
		mgr.recordFeedback(feedback("m1", "partially_used"));
		expect(mgr.getUsefulnessScore("m1")).toBeCloseTo(0.7, 10);
		for (let i = 0; i < 5; i++) mgr.recordFeedback(feedback("m1", "unhelpful"));
		expect(mgr.getUsefulnessScore("m1")).toBe(0);
		for (let i = 0; i < 10; i++) mgr.recordFeedback(feedback("m1", "useful"));
		expect(mgr.getUsefulnessScore("m1")).toBe(1);
	});

	it("smooths only over useful/unhelpful counts, falling back to the delta score", () => {
		const mgr = new UsefulnessFeedbackManager();
		mgr.recordFeedback(feedback("m2", "partially_used"));
		// partially_used is not a smoothing observation -> delta score returned.
		expect(mgr.getSmoothedUsefulnessScore("m2")).toBeCloseTo(0.55, 10);
		mgr.recordFeedback(feedback("m2", "useful"));
		expect(mgr.getSmoothedUsefulnessScore("m2")).toBeCloseTo(3.5 / 6, 10);
	});

	it("keeps an immutable event log and returns a defensive copy", () => {
		const mgr = new UsefulnessFeedbackManager();
		mgr.recordFeedback(feedback("m3", "useful"));
		const events = mgr.getFeedbackEvents();
		expect(events).toHaveLength(1);
		events.pop();
		expect(mgr.getFeedbackEvents()).toHaveLength(1);
	});
});

describe("ContributionEvaluator", () => {
	const evaluator = new ContributionEvaluator();

	it("returns unknown with low confidence when the trace says nothing", () => {
		const result = evaluator.evaluate(injection("m1"), {});
		expect(result.outcome).toBe("unknown");
		expect(result.confidence).toBe(0.2);
		expect(result.evidence).toEqual([]);
	});

	it("marks explicitly cited memories as used", () => {
		const result = evaluator.evaluate(injection("m1"), { citedMemoryIds: ["m1"] });
		expect(result.outcome).toBe("used");
		expect(result.confidence).toBe(0.8);
	});

	it("marks followed procedures with file overlap as partially used", () => {
		const trace: TurnExecutionTrace = { followedProcedureStepIds: ["m1"], touchedFiles: ["src/a.ts"] };
		const result = evaluator.evaluate(injection("m1", "procedure"), trace);
		expect(result.outcome).toBe("partially_used");
		expect(result.confidence).toBe(0.7);
	});

	it("flags prevented failures found in the record content", () => {
		const trace: TurnExecutionTrace = { preventedFailureSignatures: ["TS2307"] };
		const result = evaluator.evaluate(injection("m1"), trace, { id: "m1", content: "Watch out for TS2307 here" });
		expect(result.outcome).toBe("partially_used");
		expect(result.preventedKnownFailure).toBe(true);
	});

	it("marks rejected memories as outdated unless positive evidence exists", () => {
		expect(evaluator.evaluate(injection("m1"), { rejectedMemoryIds: ["m1"] }).outcome).toBe("outdated");
		const positive = evaluator.evaluate(injection("m1"), { citedMemoryIds: ["m1"], rejectedMemoryIds: ["m1"] });
		expect(positive.outcome).toBe("used");
	});

	it("deterministically marks unnecessary work as unhelpful — never harmful", () => {
		const trace: TurnExecutionTrace = { unrelatedFileReads: ["src/unrelated.ts"] };
		const record = { id: "m1", content: "mentions src/unrelated.ts explicitly" };
		for (let i = 0; i < 20; i++) {
			const result = evaluator.evaluate(injection("m1"), trace, record);
			expect(result.outcome).toBe("unhelpful");
			expect(result.causedExtraWork).toBe(true);
		}
	});

	it("lets a user correction win over every other signal", () => {
		const trace: TurnExecutionTrace = {
			citedMemoryIds: ["m1"],
			unrelatedFileReads: ["src/unrelated.ts"],
			userCorrectedMemoryIds: ["m1"],
		};
		const result = evaluator.evaluate(injection("m1"), trace, { id: "m1", content: "src/unrelated.ts" });
		expect(result.outcome).toBe("contradicted");
		expect(result.confidence).toBe(0.95);
	});

	it("evaluates batches by joining records on memory id", () => {
		const outcomes = evaluator.evaluateBatch(
			[injection("m1"), injection("m2")],
			{ citedMemoryIds: ["m1"], preventedFailureSignatures: ["E404"] },
			[{ id: "m2", content: "known E404 pitfall" }],
		);
		expect(outcomes[0].outcome).toBe("used");
		expect(outcomes[1].outcome).toBe("partially_used");
		expect(outcomes[1].preventedKnownFailure).toBe(true);
	});
});
