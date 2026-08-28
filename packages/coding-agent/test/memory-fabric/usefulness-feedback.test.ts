/**
 * Tests for the usefulness feedback engine: delta scoring, Bayesian smoothing,
 * and deterministic contribution evaluation.
 */

import { describe, expect, it } from "bun:test";
import type { UsefulnessFeedbackEvent } from "@oh-my-pi/pi-coding-agent/memory-fabric/adaptive-fidelity/types";
import type { MemoryRecord } from "@oh-my-pi/pi-coding-agent/memory-fabric/types";
import { createMemoryRecord } from "@oh-my-pi/pi-coding-agent/memory-fabric/types";
import {
	ContributionEvaluator,
	type InjectionItem,
	SmoothedUsefulnessEstimator,
	type TurnExecutionTrace,
	UsefulnessFeedbackManager,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/usefulness-feedback";

function feedbackEvent(overrides?: Partial<UsefulnessFeedbackEvent>): UsefulnessFeedbackEvent {
	return {
		id: "fb_1",
		memoryId: "mem_1",
		sessionId: "session_1",
		turnId: "turn_1",
		rating: "useful",
		tokenCost: 120,
		latencyMs: 15,
		timestamp: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

function injection(overrides?: Partial<InjectionItem>): InjectionItem {
	return {
		memoryId: "mem_1",
		injectionId: "inj_1",
		rank: 1,
		lane: "insight",
		tokenCount: 120,
		score: 0.8,
		confidence: 0.7,
		verification: "observed",
		purpose: "insight",
		...overrides,
	};
}

function record(content: string, id = "mem_1"): MemoryRecord {
	return createMemoryRecord({
		id,
		type: "fact",
		projectId: "proj_1",
		content,
		sourceRefs: [],
	});
}

describe("UsefulnessFeedbackManager", () => {
	it("defaults unknown memories to 0.5", () => {
		const manager = new UsefulnessFeedbackManager();
		expect(manager.getUsefulnessScore("missing")).toBe(0.5);
		expect(manager.getSmoothedUsefulnessScore("missing")).toBe(0.5);
	});

	it("applies delta scoring per rating", () => {
		const manager = new UsefulnessFeedbackManager();
		manager.recordFeedback(feedbackEvent({ rating: "useful" }));
		expect(manager.getUsefulnessScore("mem_1")).toBeCloseTo(0.65, 10);
		manager.recordFeedback(feedbackEvent({ rating: "partially_used" }));
		expect(manager.getUsefulnessScore("mem_1")).toBeCloseTo(0.7, 10);
		manager.recordFeedback(feedbackEvent({ rating: "unhelpful" }));
		expect(manager.getUsefulnessScore("mem_1")).toBeCloseTo(0.5, 10);
	});

	it("clamps the delta score to [0, 1]", () => {
		const manager = new UsefulnessFeedbackManager();
		for (let i = 0; i < 10; i++) {
			manager.recordFeedback(feedbackEvent({ rating: "unhelpful" }));
		}
		expect(manager.getUsefulnessScore("mem_1")).toBe(0);
		for (let i = 0; i < 20; i++) {
			manager.recordFeedback(feedbackEvent({ rating: "useful" }));
		}
		expect(manager.getUsefulnessScore("mem_1")).toBe(1);
	});

	it("smoothed score uses Bayesian estimate once counts exist", () => {
		const manager = new UsefulnessFeedbackManager();
		manager.recordFeedback(feedbackEvent({ rating: "useful" }));
		// (5 * 0.5 + 1) / (5 + 1) = 3.5 / 6
		expect(manager.getSmoothedUsefulnessScore("mem_1")).toBeCloseTo(3.5 / 6, 10);
	});

	it("partially_used affects delta score but not smoothed counts", () => {
		const manager = new UsefulnessFeedbackManager();
		manager.recordFeedback(feedbackEvent({ rating: "partially_used" }));
		expect(manager.getUsefulnessScore("mem_1")).toBeCloseTo(0.55, 10);
		// No positive/negative counts recorded -> falls back to delta score.
		expect(manager.getSmoothedUsefulnessScore("mem_1")).toBeCloseTo(0.55, 10);
	});

	it("keeps an immutable copy of feedback events", () => {
		const manager = new UsefulnessFeedbackManager();
		manager.recordFeedback(feedbackEvent());
		const events = manager.getFeedbackEvents();
		expect(events).toHaveLength(1);
		events.pop();
		expect(manager.getFeedbackEvents()).toHaveLength(1);
	});
});

describe("SmoothedUsefulnessEstimator", () => {
	it("returns the prior with zero observations", () => {
		const estimator = new SmoothedUsefulnessEstimator();
		const { score, totalObservations } = estimator.estimate(0, 0);
		expect(score).toBeCloseTo(0.5, 10);
		expect(totalObservations).toBe(0);
	});

	it("moves toward evidence as observations accumulate", () => {
		const estimator = new SmoothedUsefulnessEstimator();
		// (5 * 0.5 + 10) / (5 + 10) = 12.5 / 15
		expect(estimator.estimate(10, 0).score).toBeCloseTo(12.5 / 15, 10);
		// (5 * 0.5 + 0) / (5 + 10) = 2.5 / 15
		expect(estimator.estimate(0, 10).score).toBeCloseTo(2.5 / 15, 10);
		expect(estimator.estimate(100, 0).score).toBeGreaterThan(0.95);
	});

	it("honors a custom prior", () => {
		const estimator = new SmoothedUsefulnessEstimator(0.8, 10);
		// (10 * 0.8 + 1) / (10 + 2) = 9 / 12
		expect(estimator.estimate(1, 1).score).toBeCloseTo(9 / 12, 10);
	});
});

describe("ContributionEvaluator", () => {
	const evaluator = new ContributionEvaluator();

	it("returns unknown with low confidence when no evidence exists", () => {
		const result = evaluator.evaluate(injection(), {});
		expect(result.outcome).toBe("unknown");
		expect(result.confidence).toBeCloseTo(0.2, 10);
		expect(result.evidence).toHaveLength(0);
	});

	it("explicit citation yields used at 0.8 confidence", () => {
		const trace: TurnExecutionTrace = { citedMemoryIds: ["mem_1"] };
		const result = evaluator.evaluate(injection(), trace);
		expect(result.outcome).toBe("used");
		expect(result.confidence).toBeCloseTo(0.8, 10);
	});

	it("procedure followed with file overlap yields partially_used", () => {
		const trace: TurnExecutionTrace = {
			followedProcedureStepIds: ["mem_1"],
			touchedFiles: ["src/a.ts"],
		};
		const result = evaluator.evaluate(injection({ purpose: "procedure" }), trace);
		expect(result.outcome).toBe("partially_used");
		expect(result.confidence).toBeCloseTo(0.7, 10);
	});

	it("failure prevention marks preventedKnownFailure", () => {
		const trace: TurnExecutionTrace = { preventedFailureSignatures: ["ECONNRESET"] };
		const result = evaluator.evaluate(injection(), trace, record("Retry on ECONNRESET before failing"));
		expect(result.outcome).toBe("partially_used");
		expect(result.preventedKnownFailure).toBe(true);
		expect(result.confidence).toBeCloseTo(0.75, 10);
	});

	it("rejection yields outdated only when nothing positive was observed", () => {
		const rejectedOnly = evaluator.evaluate(injection(), { rejectedMemoryIds: ["mem_1"] });
		expect(rejectedOnly.outcome).toBe("outdated");
		expect(rejectedOnly.confidence).toBeCloseTo(0.6, 10);

		const citedAndRejected = evaluator.evaluate(injection(), {
			citedMemoryIds: ["mem_1"],
			rejectedMemoryIds: ["mem_1"],
		});
		expect(citedAndRejected.outcome).toBe("used");
	});

	it("user correction overrides everything as contradicted", () => {
		const trace: TurnExecutionTrace = {
			citedMemoryIds: ["mem_1"],
			userCorrectedMemoryIds: ["mem_1"],
		};
		const result = evaluator.evaluate(injection(), trace);
		expect(result.outcome).toBe("contradicted");
		expect(result.confidence).toBeCloseTo(0.95, 10);
	});

	it("unnecessary work is deterministically unhelpful, never harmful", () => {
		const trace: TurnExecutionTrace = { unrelatedFileReads: ["legacy/old.ts"] };
		for (let i = 0; i < 25; i++) {
			const result = evaluator.evaluate(injection(), trace, record("See legacy/old.ts for details"));
			expect(result.outcome).toBe("unhelpful");
			expect(result.causedExtraWork).toBe(true);
			expect(result.confidence).toBeCloseTo(0.7, 10);
		}
	});

	it("unnecessary work does not downgrade a contradicted outcome", () => {
		const trace: TurnExecutionTrace = {
			userCorrectedMemoryIds: ["mem_1"],
			unrelatedFileReads: ["legacy/old.ts"],
		};
		const result = evaluator.evaluate(injection(), trace, record("See legacy/old.ts for details"));
		expect(result.outcome).toBe("contradicted");
		expect(result.causedExtraWork).toBe(true);
	});

	it("evaluateBatch maps records by id", () => {
		const items = [injection(), injection({ memoryId: "mem_2", injectionId: "inj_2" })];
		const trace: TurnExecutionTrace = { citedMemoryIds: ["mem_2"] };
		const records = [record("alpha", "mem_1"), record("beta", "mem_2")];
		const results = evaluator.evaluateBatch(items, trace, records);
		expect(results[0]?.outcome).toBe("unknown");
		expect(results[1]?.outcome).toBe("used");
	});
});
