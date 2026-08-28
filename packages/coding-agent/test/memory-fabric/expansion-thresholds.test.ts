/**
 * Tests for expansion thresholds, risk overrides, and value gates.
 */

import { describe, expect, it } from "bun:test";
import type {
	ExpansionEvaluation,
	ExpansionThresholdConfig,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/expansion-thresholds";
import {
	DEFAULT_THRESHOLD_CONFIG,
	determineExpansionDecision,
	effectiveExpansionThreshold,
	PER_TRIGGER_THRESHOLDS,
	shouldInjectExpansion,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/expansion-thresholds";
import type { ExpansionSignals } from "@oh-my-pi/pi-coding-agent/memory-fabric/tiered-retrieval-types";

function signals(overrides?: Partial<ExpansionSignals>): ExpansionSignals {
	return {
		taskComplexity: 0,
		graphImpact: 0,
		retrievalConfidence: 1,
		retrievalCoverage: 1,
		contradictionCount: 0,
		unresolvedIssueCount: 0,
		repeatedFailureCount: 0,
		unfamiliarSymbolCount: 0,
		missingProcedureCount: 0,
		planBreadth: 0,
		currentContextSaturation: 0,
		isCrashRecovery: false,
		isCompactionRecovery: false,
		isExternalWrite: false,
		isDestructiveOperation: false,
		modelRequestedExpansion: false,
		userRequestedHistory: false,
		...overrides,
	};
}

function evaluation(overrides?: Partial<ExpansionEvaluation>): ExpansionEvaluation {
	return {
		triggerScore: 0.7,
		coverageBefore: 0.5,
		coverageAfter: 0.7,
		coverageGain: 0.2,
		confidenceBefore: 0.5,
		confidenceAfter: 0.6,
		confidenceGain: 0.1,
		newInformationRatio: 0.5,
		relevanceAverage: 0.7,
		estimatedUsefulTokens: 2000,
		proposedTokens: 3000,
		expectedUtilityGain: 0.2,
		...overrides,
	};
}

const budget = { remainingTokens: 10_000, expansionCount: 0 };

describe("effectiveExpansionThreshold", () => {
	it("lowers the threshold for high-risk operations", () => {
		expect(effectiveExpansionThreshold(0.65, { destructiveOperation: true })).toBeCloseTo(0.5);
		expect(effectiveExpansionThreshold(0.65, { externalWrite: true })).toBeCloseTo(0.55);
		expect(effectiveExpansionThreshold(0.65, { databaseMigration: true })).toBeCloseTo(0.53);
		expect(effectiveExpansionThreshold(0.65, { deployment: true })).toBeCloseTo(0.55);
		expect(effectiveExpansionThreshold(0.65, { crashRecovery: true })).toBeCloseTo(0.45);
		expect(effectiveExpansionThreshold(0.65, { contradictionPresent: true })).toBeCloseTo(0.5);
	});

	it("raises the threshold for trivial read-only tasks", () => {
		expect(effectiveExpansionThreshold(0.65, { simpleFileRead: true })).toBeCloseTo(0.75);
		expect(effectiveExpansionThreshold(0.65, { formattingRequest: true })).toBeCloseTo(0.8);
		expect(effectiveExpansionThreshold(0.65, { alreadyHighCoverage: true })).toBeCloseTo(0.75);
		expect(effectiveExpansionThreshold(0.65, { lowRemainingBudget: true })).toBeCloseTo(0.75);
	});

	it("clamps to [0.30, 0.90]", () => {
		expect(
			effectiveExpansionThreshold(0.65, {
				destructiveOperation: true,
				crashRecovery: true,
				contradictionPresent: true,
			}),
		).toBe(0.3);
		expect(
			effectiveExpansionThreshold(0.65, {
				simpleFileRead: true,
				formattingRequest: true,
				alreadyHighCoverage: true,
			}),
		).toBe(0.9);
	});
});

describe("PER_TRIGGER_THRESHOLDS", () => {
	it("orders trigger thresholds from most to least urgent", () => {
		expect(PER_TRIGGER_THRESHOLDS.userRequestedHistory.threshold).toBe(0.2);
		expect(PER_TRIGGER_THRESHOLDS.crashRecovery.threshold).toBe(0.3);
		expect(PER_TRIGGER_THRESHOLDS.crashRecovery.forcedTiers).toEqual(["L0", "L1", "L2"]);
		expect(PER_TRIGGER_THRESHOLDS.contradiction.forcedTiers).toEqual(["L4"]);
		expect(PER_TRIGGER_THRESHOLDS.normalLowConfidence.threshold).toBe(0.7);
	});
});

describe("shouldInjectExpansion (Stage 2 value gate)", () => {
	it("accepts a valuable expansion", () => {
		expect(shouldInjectExpansion(evaluation())).toBe(true);
	});

	it("rejects when the trigger score is below the active threshold", () => {
		expect(shouldInjectExpansion(evaluation({ triggerScore: 0.6 }))).toBe(false);
	});

	it("rejects oversized steps (maximumTokensPerStep is enforced)", () => {
		expect(shouldInjectExpansion(evaluation({ proposedTokens: 8001 }))).toBe(false);
		expect(shouldInjectExpansion(evaluation({ proposedTokens: 8000 }))).toBe(true);
	});

	it("rejects low new-information ratios", () => {
		expect(shouldInjectExpansion(evaluation({ newInformationRatio: 0.1 }))).toBe(false);
	});

	it("rejects when both coverage and confidence gains are too small", () => {
		expect(shouldInjectExpansion(evaluation({ coverageGain: 0.05, confidenceGain: 0.01 }))).toBe(false);
		expect(shouldInjectExpansion(evaluation({ coverageGain: 0.05, confidenceGain: 0.1 }))).toBe(true);
	});

	it("rejects low expected utility gain", () => {
		expect(shouldInjectExpansion(evaluation({ expectedUtilityGain: 0.01 }))).toBe(false);
	});

	it("honors a custom config", () => {
		const config: ExpansionThresholdConfig = { ...DEFAULT_THRESHOLD_CONFIG, maximumTokensPerStep: 1000 };
		expect(shouldInjectExpansion(evaluation({ proposedTokens: 2000 }), config)).toBe(false);
	});
});

describe("determineExpansionDecision", () => {
	it("refuses to expand without remaining budget", () => {
		const result = determineExpansionDecision(signals(), { remainingTokens: 100, expansionCount: 0 });
		expect(result.action).toBe("do-not-expand");
		expect(result.reason).toBe("No remaining memory budget.");
	});

	it("refuses after the per-turn step cap", () => {
		const result = determineExpansionDecision(signals(), { remainingTokens: 10_000, expansionCount: 4 });
		expect(result.action).toBe("do-not-expand");
		expect(result.reason).toBe("Maximum expansion steps per turn reached.");
	});

	it("refuses when the total expansion token budget is exhausted", () => {
		const result = determineExpansionDecision(signals(), {
			remainingTokens: 10_000,
			expansionCount: 1,
			usedExpansionTokens: 24_000,
		});
		expect(result.action).toBe("do-not-expand");
		expect(result.reason).toBe("Total expansion token budget for this turn is exhausted.");
	});

	it("forces urgent L0-L3 restore for crash recovery", () => {
		const result = determineExpansionDecision(signals({ isCrashRecovery: true }), budget);
		expect(result.action).toBe("expand-urgent");
		expect(result.tiers).toEqual(["L0", "L1", "L2", "L3"]);
		expect(result.score).toBe(1.0);
		expect(result.effectiveThreshold).toBe(0.3);
	});

	it("forces L4 evidence expansion for contradictions", () => {
		const result = determineExpansionDecision(signals({ contradictionCount: 1 }), budget);
		expect(result.action).toBe("expand");
		expect(result.tiers).toEqual(["L4"]);
		expect(result.score).toBe(0.85);
	});

	it("does not expand for calm signals", () => {
		const result = determineExpansionDecision(signals(), budget);
		expect(result.action).toBe("do-not-expand");
		expect(result.score).toBe(0);
	});

	it("retrieves silently in the shadow region", () => {
		// 0.16*1 + 0.14*1 + 0.14*(1-0.5) + 0.12*(1-0.5) = 0.16+0.14+0.07+0.06 = 0.43
		const result = determineExpansionDecision(
			signals({ taskComplexity: 1, graphImpact: 1, retrievalConfidence: 0.5, retrievalCoverage: 0.5 }),
			budget,
		);
		expect(result.score).toBeCloseTo(0.43);
		expect(result.action).toBe("retrieve-silently");
	});

	it("expands actively when the score meets the effective threshold", () => {
		// Base 0.43 + compaction 0.25 = 0.68 >= 0.65
		const result = determineExpansionDecision(
			signals({
				taskComplexity: 1,
				graphImpact: 1,
				retrievalConfidence: 0.5,
				retrievalCoverage: 0.5,
				isCompactionRecovery: true,
			}),
			budget,
		);
		expect(result.score).toBeCloseTo(0.68);
		expect(result.action).toBe("expand");
	});

	it("expands urgently above the urgent threshold", () => {
		// Base 0.43 + compaction 0.25 + userRequestedHistory 0.3 = 0.98
		const result = determineExpansionDecision(
			signals({
				taskComplexity: 1,
				graphImpact: 1,
				retrievalConfidence: 0.5,
				retrievalCoverage: 0.5,
				isCompactionRecovery: true,
				userRequestedHistory: true,
			}),
			budget,
		);
		expect(result.score).toBeCloseTo(0.98);
		expect(result.action).toBe("expand-urgent");
	});

	it("lowers the effective threshold for destructive operations", () => {
		// Base 0.43; destructive lowers threshold 0.65 -> 0.50, still above 0.43 => silent.
		// Add modelRequestedExpansion 0.2 => 0.63 >= 0.50 => expand.
		const risky = determineExpansionDecision(
			signals({
				taskComplexity: 1,
				graphImpact: 1,
				retrievalConfidence: 0.5,
				retrievalCoverage: 0.5,
				isDestructiveOperation: true,
				modelRequestedExpansion: true,
			}),
			budget,
		);
		expect(risky.effectiveThreshold).toBeCloseTo(0.5);
		expect(risky.action).toBe("expand");
	});

	it("raises the effective threshold when coverage is already high", () => {
		const result = determineExpansionDecision(
			signals({ taskComplexity: 1, graphImpact: 1, retrievalConfidence: 0.5, retrievalCoverage: 0.95 }),
			budget,
		);
		expect(result.effectiveThreshold).toBeCloseTo(0.75);
	});

	it("clamps out-of-range signal values", () => {
		const result = determineExpansionDecision(
			signals({ taskComplexity: 5, graphImpact: -3, retrievalConfidence: 2, retrievalCoverage: -1 }),
			budget,
		);
		// 0.16*1 + 0.14*0 + 0.14*(1-1) + 0.12*(1-0) = 0.28
		expect(result.score).toBeCloseTo(0.28);
		expect(result.action).toBe("do-not-expand");
	});
});
