/**
 * Tests for the coverage-driven expansion builder and control loop diagnostics.
 */

import { describe, expect, it } from "bun:test";
import type { ContextCoverageReport } from "@oh-my-pi/pi-coding-agent/memory-fabric/contextual-coverage";
import {
	buildCoverageExpansion,
	calculateCoverageExpansionBudget,
	formatControlLoopExplanation,
	formatCoverageExplanation,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/coverage-expansion-builder";
import type { ExpansionDecisionResult } from "@oh-my-pi/pi-coding-agent/memory-fabric/expansion-thresholds";
import type { FusedMemoryItem, RankedMemoryItem } from "@oh-my-pi/pi-coding-agent/memory-fabric/rrf-fusion";

function report(overrides?: Partial<ContextCoverageReport>): ContextCoverageReport {
	return {
		packetId: "packet-1",
		totalNeeds: 5,
		requiredNeeds: 4,
		requiredCoverage: 0.5,
		weightedCoverage: 0.55,
		verificationCoverage: 0.4,
		provenanceCoverage: 0.6,
		freshnessCoverage: 0.3,
		satisfiedNeedIds: ["objective", "constraints"],
		partiallySatisfiedNeedIds: ["recent-changes"],
		unresolvedNeedIds: ["error-history", "prior-fixes"],
		contradictedNeedIds: [],
		recommendedExpansionTiers: ["L2", "L4"],
		recommendedQueries: ["error history for module", "prior fixes"],
		missingCriticalNeedIds: ["error-history"],
		criticalNeedsSatisfied: false,
		...overrides,
	};
}

function fusedItem(memoryId: string): FusedMemoryItem {
	const candidate: RankedMemoryItem = {
		memoryId,
		lane: "canonical",
		rank: 1,
		contentHash: `hash-${memoryId}`,
		type: "fact",
		tier: "L2",
		projectId: "project-1",
		verification: "tool-observed",
		status: "active",
		relevance: 0.8,
		freshness: 0.7,
		confidence: 0.9,
		usefulness: 0.6,
		scopeScore: 1,
		tokenEstimate: 120,
		sourceReferences: [],
		content: `content for ${memoryId}`,
	};
	return {
		memoryId,
		candidate,
		rrfScore: 0.016,
		finalScore: 0.014,
		appearedInLanes: 1,
		laneContributions: [{ lane: "canonical", rank: 1, weight: 1, contribution: 0.016 }],
	};
}

describe("calculateCoverageExpansionBudget", () => {
	it("scales the budget with the coverage deficit", () => {
		expect(calculateCoverageExpansionBudget(report({ requiredCoverage: 0.95 }))).toBe(3000);
		expect(calculateCoverageExpansionBudget(report({ requiredCoverage: 0.9 }))).toBe(3000);
		expect(calculateCoverageExpansionBudget(report({ requiredCoverage: 0.75 }))).toBe(6000);
		expect(calculateCoverageExpansionBudget(report({ requiredCoverage: 0.7 }))).toBe(6000);
		expect(calculateCoverageExpansionBudget(report({ requiredCoverage: 0.5 }))).toBe(8000);
	});
});

describe("buildCoverageExpansion", () => {
	it("builds a targeted request from coverage gaps", () => {
		const request = buildCoverageExpansion(report(), "turn-7");
		expect(request).not.toBeNull();
		expect(request?.packetId).toBe("packet-1");
		expect(request?.turnId).toBe("turn-7");
		expect(request?.trigger).toBe("low-retrieval-confidence");
		expect(request?.requestedTiers).toEqual(["L2", "L4"]);
		expect(request?.topics).toEqual(["error history for module", "prior fixes"]);
		expect(request?.maximumAdditionalTokens).toBe(8000);
		expect(request?.reason).toBe("Required context coverage is 0.50. Unresolved needs: error-history, prior-fixes");
	});

	it("is deterministic: the same report and turn produce the same request", () => {
		expect(buildCoverageExpansion(report(), "turn-7")).toEqual(buildCoverageExpansion(report(), "turn-7"));
	});

	it("returns null when coverage is satisfied", () => {
		const satisfied = report({
			requiredCoverage: 0.95,
			unresolvedNeedIds: [],
			missingCriticalNeedIds: [],
		});
		expect(buildCoverageExpansion(satisfied, "turn-1")).toBeNull();
	});

	it("still expands at high coverage when critical needs are missing", () => {
		const missingCritical = report({
			requiredCoverage: 0.95,
			unresolvedNeedIds: [],
			missingCriticalNeedIds: ["error-history"],
		});
		const request = buildCoverageExpansion(missingCritical, "turn-1");
		expect(request).not.toBeNull();
		expect(request?.maximumAdditionalTokens).toBe(3000);
	});

	it("returns null when no expansion tiers are recommended", () => {
		expect(buildCoverageExpansion(report({ recommendedExpansionTiers: [] }), "turn-1")).toBeNull();
	});
});

describe("formatCoverageExplanation", () => {
	it("formats a complete coverage report", () => {
		const text = formatCoverageExplanation(report());
		expect(text).toContain("Context Coverage Report [Packet: packet-1]");
		expect(text).toContain("Required coverage: 50.0% (2/4)");
		expect(text).toContain("Weighted coverage: 55.0%");
		expect(text).toContain("Verification coverage: 40.0%");
		expect(text).toContain("Provenance coverage: 60.0%");
		expect(text).toContain("Freshness coverage: 30.0%");
		expect(text).toContain("Satisfied needs: objective, constraints");
		expect(text).toContain("Partially satisfied needs: recent-changes");
		expect(text).toContain("Unresolved needs: error-history, prior-fixes");
		expect(text).toContain("Recommended expansion tiers: L2, L4");
		expect(text).not.toContain("Contradicted needs:");
	});

	it("reports 'none' when nothing is satisfied and shows contradictions", () => {
		const text = formatCoverageExplanation(report({ satisfiedNeedIds: [], contradictedNeedIds: ["constraints"] }));
		expect(text).toContain("Satisfied needs: none");
		expect(text).toContain("Contradicted needs: constraints");
	});
});

describe("formatControlLoopExplanation", () => {
	const decision: ExpansionDecisionResult = {
		action: "expand",
		tiers: ["L2", "L4"],
		score: 0.72,
		effectiveThreshold: 0.65,
		reason: "Active expansion score 0.72 meets threshold 0.65",
	};

	it("assembles the unified diagnostic with all sections", () => {
		const items = [fusedItem("m-1"), fusedItem("m-2")];
		const text = formatControlLoopExplanation(items, report(), decision);
		expect(text).toContain("CONTROL LOOP DIAGNOSTIC EXPLANATION");
		expect(text).toContain("Action Decision: EXPAND");
		expect(text).toContain("Reason: Active expansion score 0.72 meets threshold 0.65");
		expect(text).toContain("Score: 0.7200 | Threshold: 0.6500");
		expect(text).toContain("Target Tiers: L2, L4");
		expect(text).toContain("--- COVERAGE ANALYSIS ---");
		expect(text).toContain("Context Coverage Report [Packet: packet-1]");
		expect(text).toContain("--- RRF FUSED CANDIDATES (Top 2) ---");
		expect(text).toContain("Memory: m-1");
		expect(text).toContain("Memory: m-2");
	});

	it("caps the candidate section at the top five items", () => {
		const items = ["m-1", "m-2", "m-3", "m-4", "m-5", "m-6", "m-7"].map(fusedItem);
		const text = formatControlLoopExplanation(items, report(), decision);
		expect(text).toContain("(Top 5)");
		expect(text).toContain("Memory: m-5");
		expect(text).not.toContain("Memory: m-6");
	});

	it("omits the tier line when the decision carries no tiers", () => {
		const noTiers: ExpansionDecisionResult = { ...decision, tiers: undefined };
		const text = formatControlLoopExplanation([], report(), noTiers);
		expect(text).not.toContain("Target Tiers:");
		expect(text).toContain("(Top 0)");
	});
});
