import { describe, expect, it } from "bun:test";

import {
	type ContextItemUtilization,
	calculateExpansionUtilization,
	calculateItemUtilizationScore,
	calculateNeedCoverageRate,
	calculateNewInformationRatio,
	calculatePacketUtilization,
	calculateRecordUtilizationRate,
	calculateTokenUtilizationRate,
	classifyUtilization,
	inferSignalsFromBehavior,
	preventExpansionLoop,
	type UtilizationSignals,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/utilization";

function signals(overrides: Partial<UtilizationSignals> = {}): UtilizationSignals {
	return {
		explicitlyCited: false,
		procedureFollowed: false,
		recommendedFileTouched: false,
		recommendedToolUsed: false,
		recommendedValidationRun: false,
		recommendedValidationPassed: false,
		warningFollowed: false,
		userCorrected: false,
		agentRejected: false,
		causedExtraWork: false,
		...overrides,
	};
}

function item(outcome: ContextItemUtilization["outcome"], tokens: number): ContextItemUtilization {
	return {
		packetId: "p1",
		memoryId: `m-${outcome}-${tokens}`,
		tier: "L1",
		lane: "canonical",
		injectedTokens: tokens,
		outcome,
		signals: signals(),
		utilizationConfidence: 0.8,
		evaluatedAt: "2026-01-01T00:00:00Z",
	};
}

describe("utilization", () => {
	it("scores positive and negative signals and clamps to [-1, 1]", () => {
		expect(calculateItemUtilizationScore(signals())).toBe(0);
		expect(calculateItemUtilizationScore(signals({ explicitlyCited: true, procedureFollowed: true }))).toBeCloseTo(
			0.6,
			5,
		);
		const allNegative = signals({ userCorrected: true, agentRejected: true, causedExtraWork: true });
		expect(calculateItemUtilizationScore(allNegative)).toBe(-1);
	});

	it("classifies scores into outcome bands", () => {
		expect(classifyUtilization(0.7)).toBe("used");
		expect(classifyUtilization(0.3)).toBe("partially-used");
		expect(classifyUtilization(0)).toBe("ignored");
		expect(classifyUtilization(-0.3)).toBe("contradicted");
		expect(classifyUtilization(-0.8)).toBe("harmful");
	});

	it("infers explicit citation from the record id in the response", () => {
		const inferred = inferSignalsFromBehavior(
			{ id: "D-142", content: "short" },
			{ modelResponseText: "Per D-142, the retry limit is 3.", toolCalls: [{ name: "edit", args: {} }] },
		);
		expect(inferred.explicitlyCited).toBe(true);
		expect(inferred.procedureFollowed).toBe(true);
	});

	it("marks user correction and rejects procedure-followed when corrected", () => {
		const inferred = inferSignalsFromBehavior(
			{ id: "D-1", content: "short" },
			{
				modelResponseText: "per d-1 ...",
				toolCalls: [{ name: "edit", args: {} }],
				userCorrectionText: "no, that is wrong",
			},
		);
		expect(inferred.userCorrected).toBe(true);
		expect(inferred.procedureFollowed).toBe(false);
	});

	it("detects touched files via file: source references", () => {
		const inferred = inferSignalsFromBehavior(
			{ id: "D-2", content: "unrelated", sourceReferences: ["file:src/a.ts"] },
			{ filesTouched: ["src/a.ts"] },
		);
		expect(inferred.recommendedFileTouched).toBe(true);
	});

	it("computes the record utilization rate", () => {
		const items = [item("used", 100), item("partially-used", 100), item("ignored", 100), item("harmful", 100)];
		expect(calculateRecordUtilizationRate(items)).toBeCloseTo(0.5, 5);
		expect(calculateRecordUtilizationRate([])).toBe(0);
	});

	it("weights partially-used tokens by the configured partial weight", () => {
		const items = [item("used", 100), item("partially-used", 100), item("ignored", 100)];
		expect(calculateTokenUtilizationRate(items)).toBeCloseTo(0.5, 5);
		expect(calculateTokenUtilizationRate(items, { partialUseWeight: 1 })).toBeCloseTo(2 / 3, 5);
		expect(calculateTokenUtilizationRate([])).toBe(0);
	});

	it("treats zero required needs as fully covered", () => {
		expect(calculateNeedCoverageRate(0, 0)).toBe(1);
		expect(calculateNeedCoverageRate(4, 2)).toBeCloseTo(0.5, 5);
		expect(calculateNeedCoverageRate(2, 5)).toBe(1);
	});

	it("aggregates packet utilization consistently", () => {
		const items = [item("used", 200), item("ignored", 200)];
		const packet = calculatePacketUtilization(
			"p1",
			"t1",
			"task1",
			items,
			{ required: 2, satisfied: 1 },
			{ count: 1, tokens: 100, utilizedTokens: 50 },
			{ taskSucceeded: true },
		);
		expect(packet.totalInjectedTokens).toBe(400);
		expect(packet.utilizedTokens).toBe(200);
		expect(packet.weightedUtilizationRate).toBeCloseTo(0.5, 5);
		expect(packet.recordUtilizationRate).toBeCloseTo(0.5, 5);
		expect(packet.needCoverageRate).toBeCloseTo(0.5, 5);
		expect(packet.expansionUtilizationRate).toBeCloseTo(0.5, 5);
		expect(packet.taskSucceeded).toBe(true);
	});

	it("requires novelty by BOTH id and content hash", () => {
		const ids = new Set(["m1"]);
		const hashes = new Set(["h1"]);
		const ratio = calculateNewInformationRatio(ids, hashes, [
			{ memoryId: "m1", contentHash: "h9" },
			{ memoryId: "m2", contentHash: "h1" },
			{ memoryId: "m3", contentHash: "h3" },
			{ memoryId: "m4" },
		]);
		expect(ratio).toBeCloseTo(0.5, 5);
		expect(calculateNewInformationRatio(ids, hashes, [])).toBe(0);
	});

	it("evaluates expansion utilization end to end", () => {
		const result = calculateExpansionUtilization({
			expansionId: "e1",
			trigger: "repeated-failure",
			requestedTiers: ["L2", "L4"],
			items: [item("used", 100), item("partially-used", 100)],
			existingMemoryIds: new Set(["m-old"]),
			existingHashes: new Set(),
			rawItems: [{ memoryId: "m-old" }, { memoryId: "m-new" }],
			confidenceBefore: 0.4,
			confidenceAfter: 0.7,
			coverageBefore: 0.5,
			coverageAfter: 0.8,
			taskProgressObserved: true,
		});
		expect(result.injectedTokens).toBe(200);
		expect(result.utilizedTokens).toBeCloseTo(150, 5);
		expect(result.utilizationRate).toBeCloseTo(0.75, 5);
		expect(result.newMemoryCount).toBe(1);
		expect(result.duplicateMemoryCount).toBe(1);
		expect(result.newInformationRatio).toBeCloseTo(0.5, 5);
	});

	it("blocks expansion loops on cap, budget, low novelty and duplicates", () => {
		const base = { expansionCount: 0, maximumExpansions: 4, remainingTokens: 5000 };
		expect(preventExpansionLoop(base).allow).toBe(true);
		expect(preventExpansionLoop({ ...base, expansionCount: 4 }).allow).toBe(false);
		expect(preventExpansionLoop({ ...base, remainingTokens: 100 }).allow).toBe(false);
		expect(preventExpansionLoop({ ...base, lastExpansionNewInfoRatio: 0.1 }).allow).toBe(false);
		expect(preventExpansionLoop({ ...base, lastExpansionCoverageGain: 0.01 }).allow).toBe(false);
		expect(preventExpansionLoop({ ...base, repeatedQuerySimilarity: 0.95 }).allow).toBe(false);
		expect(preventExpansionLoop({ ...base, lastExpansionNewInfoRatio: 0.5 }).allow).toBe(true);
	});
});
