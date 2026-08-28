/**
 * Tests for Progressive Expansion Triggers & Budget Utility (ACF lane).
 *
 * Verifies the eight-rule trigger ladder (contents, token caps, and priority
 * order), the `shouldExpand` convenience defaults, the five pure metric
 * helpers (including zero-division guards), and the composite / per-candidate
 * utility math. Offline; deterministic; no clock.
 */

import { describe, expect, it } from "bun:test";
import {
	AutomatedExpansionTrigger,
	BudgetUtilityCalculator,
	computeContextUtilization,
	computeHarmRate,
	computeMemoryPrecision,
	computeMemoryRecall,
	computeTokenUtilization,
	type ExpansionTurnState,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/adaptive-fidelity/expansion-triggers";

/** A fully quiet turn: no rule fires. */
function quietState(): ExpansionTurnState {
	return {
		isCrashRecovery: false,
		isCompactionRecovery: false,
		contradictionCount: 0,
		contradictionSubjects: [],
		nextToolType: "unknown",
		graphImpactScore: 0,
		targetFiles: [],
		repeatedFailureCount: 0,
		currentError: "",
		retrievalConfidence: 1.0,
		modelRequestedDetail: false,
		requestedTopics: [],
		packetId: "pkt-1",
		turnId: "turn-1",
	};
}

describe("AutomatedExpansionTrigger", () => {
	const trigger = new AutomatedExpansionTrigger();

	it("returns null for a quiet turn", () => {
		expect(trigger.determineAutomaticExpansion(quietState())).toBeNull();
	});

	it("fires crash recovery at highest priority with an 8000-token cap", () => {
		const req = trigger.determineAutomaticExpansion({
			...quietState(),
			isCrashRecovery: true,
			isCompactionRecovery: true,
			contradictionCount: 3,
		});
		expect(req?.trigger).toBe("crash-recovery");
		expect(req?.requestedTiers).toEqual(["L2", "L3"]);
		expect(req?.maximumAdditionalTokens).toBe(8000);
	});

	it("fires compaction recovery before contradiction", () => {
		const req = trigger.determineAutomaticExpansion({
			...quietState(),
			isCompactionRecovery: true,
			contradictionCount: 3,
		});
		expect(req?.trigger).toBe("compaction-recovery");
		expect(req?.maximumAdditionalTokens).toBe(6000);
	});

	it("fires contradiction with L4 evidence tiers and the conflicting subjects", () => {
		const req = trigger.determineAutomaticExpansion({
			...quietState(),
			contradictionCount: 2,
			contradictionSubjects: ["db schema", "api contract"],
		});
		expect(req?.trigger).toBe("memory-contradiction");
		expect(req?.requestedTiers).toEqual(["L4"]);
		expect(req?.topics).toEqual(["db schema", "api contract"]);
		expect(req?.maximumAdditionalTokens).toBe(6000);
	});

	it("fires low-retrieval-confidence only for 0 < confidence < 0.4", () => {
		const low = trigger.determineAutomaticExpansion({ ...quietState(), retrievalConfidence: 0.39 });
		expect(low?.trigger).toBe("low-retrieval-confidence");
		expect(low?.maximumAdditionalTokens).toBe(5000);
		// 0 means "no retrieval happened" — must not fire.
		expect(trigger.determineAutomaticExpansion({ ...quietState(), retrievalConfidence: 0 })).toBeNull();
		expect(trigger.determineAutomaticExpansion({ ...quietState(), retrievalConfidence: 0.4 })).toBeNull();
	});

	it("fires model-requested-detail with the requested topics", () => {
		const req = trigger.determineAutomaticExpansion({
			...quietState(),
			modelRequestedDetail: true,
			requestedTopics: ["auth flow"],
		});
		expect(req?.trigger).toBe("model-requested-detail");
		expect(req?.topics).toEqual(["auth flow"]);
		expect(req?.maximumAdditionalTokens).toBe(6000);
	});

	it("fires high-graph-impact only for edits at score >= 0.7", () => {
		const req = trigger.determineAutomaticExpansion({
			...quietState(),
			nextToolType: "edit",
			graphImpactScore: 0.7,
			targetFiles: ["src/core.ts"],
		});
		expect(req?.trigger).toBe("high-graph-impact");
		expect(req?.requestedTiers).toEqual(["L3"]);
		expect(req?.topics).toEqual(["src/core.ts"]);
		expect(req?.maximumAdditionalTokens).toBe(4000);
		expect(
			trigger.determineAutomaticExpansion({ ...quietState(), nextToolType: "edit", graphImpactScore: 0.69 }),
		).toBeNull();
		expect(
			trigger.determineAutomaticExpansion({ ...quietState(), nextToolType: "read", graphImpactScore: 1 }),
		).toBeNull();
	});

	it("fires tool-specific-context for bash/test/grep/search", () => {
		for (const tool of ["bash", "test", "grep", "search"]) {
			const req = trigger.determineAutomaticExpansion({ ...quietState(), nextToolType: tool });
			expect(req?.trigger).toBe("tool-specific-context");
			expect(req?.requestedTiers).toEqual(["L2"]);
			expect(req?.maximumAdditionalTokens).toBe(3000);
		}
	});

	it("fires repeated-failure at 2+ consecutive failures, including the current error", () => {
		expect(trigger.determineAutomaticExpansion({ ...quietState(), repeatedFailureCount: 1 })).toBeNull();
		const req = trigger.determineAutomaticExpansion({
			...quietState(),
			repeatedFailureCount: 2,
			currentError: "TS2307",
		});
		expect(req?.trigger).toBe("repeated-failure");
		expect(req?.requestedTiers).toEqual(["L2", "L4"]);
		expect(req?.topics).toContain("TS2307");
		expect(req?.maximumAdditionalTokens).toBe(6000);
	});

	it("shouldExpand defaults every optional signal to quiet", () => {
		expect(trigger.shouldExpand({ packetId: "p", turnId: "t" })).toBeNull();
		const req = trigger.shouldExpand({ packetId: "p", turnId: "t", isCrashRecovery: true });
		expect(req?.trigger).toBe("crash-recovery");
		expect(req?.packetId).toBe("p");
		expect(req?.turnId).toBe("t");
	});
});

describe("expansion metrics", () => {
	it("computes precision with a zero-division guard", () => {
		expect(computeMemoryPrecision(2, 4).precision).toBe(0.5);
		expect(computeMemoryPrecision(0, 0).precision).toBe(0);
	});

	it("computes recall with a zero-division guard", () => {
		expect(computeMemoryRecall(3, 4).recall).toBe(0.75);
		expect(computeMemoryRecall(0, 0).recall).toBe(0);
	});

	it("caps context utilization at 1", () => {
		expect(computeContextUtilization(50, 100).utilization).toBe(0.5);
		expect(computeContextUtilization(200, 100).utilization).toBe(1);
		expect(computeContextUtilization(10, 0).utilization).toBe(0);
	});

	it("computes token utilization as the memory share of all tokens", () => {
		expect(computeTokenUtilization(30, 70).tokenUtilization).toBe(0.3);
		expect(computeTokenUtilization(0, 0).tokenUtilization).toBe(0);
	});

	it("computes harm rate with a zero-division guard", () => {
		expect(computeHarmRate(1, 4).harmRate).toBe(0.25);
		expect(computeHarmRate(0, 0).harmRate).toBe(0);
	});
});

describe("BudgetUtilityCalculator", () => {
	it("sums the weighted metrics (all-ones sanity check)", () => {
		const allOnes = {
			taskSuccess: 1,
			validationSuccess: 1,
			memoryPrecision: 1,
			knownFailureAvoidance: 1,
			resumeQuality: 1,
			provenanceCoverage: 1,
			irrelevantContextRate: 1,
			unnecessaryToolRate: 1,
			latencyPenalty: 1,
			tokenCostPenalty: 1,
			userCorrectionRate: 1,
			falseMemoryInfluence: 1,
		};
		expect(BudgetUtilityCalculator.calculateUtility(allOnes)).toBeCloseTo(0.55, 10);
		expect(
			BudgetUtilityCalculator.calculateUtility({
				...allOnes,
				irrelevantContextRate: 0,
				unnecessaryToolRate: 0,
				latencyPenalty: 0,
				tokenCostPenalty: 0,
				userCorrectionRate: 0,
				falseMemoryInfluence: 0,
			}),
		).toBeCloseTo(0.8, 10);
	});

	it("ranks candidates by confidence/importance with verification adjustments", () => {
		expect(BudgetUtilityCalculator.calculateCandidateUtility({})).toBeCloseTo(0.5, 10);
		expect(
			BudgetUtilityCalculator.calculateCandidateUtility({
				confidence: 1,
				importance: 1,
				verification: "user-confirmed",
			}),
		).toBe(1);
		expect(
			BudgetUtilityCalculator.calculateCandidateUtility({
				confidence: 0.2,
				importance: 0.2,
				verification: "contradicted",
			}),
		).toBe(0);
	});
});
