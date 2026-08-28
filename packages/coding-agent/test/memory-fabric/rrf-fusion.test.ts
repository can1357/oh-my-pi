import { describe, expect, it } from "bun:test";
import type { FusedMemoryItem, RankedMemoryItem } from "@oh-my-pi/pi-coding-agent/memory-fabric/rrf-fusion";
import {
	applyQualityAdjustment,
	calculateRedundancyPenalty,
	choosePreferredVersion,
	classifyMemoryRelationship,
	DEFAULT_RRF_CONFIG,
	formatRRFExplanation,
	fuseWithRrf,
	getStatusWeight,
	getVerificationWeight,
	isAlreadyLoaded,
	isIdentityEquivalent,
	itemSatisfiesNeed,
	selectWithCoverage,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/rrf-fusion";

const K = DEFAULT_RRF_CONFIG.rankConstant;

function record(memoryId: string, overrides: Partial<RankedMemoryItem> = {}): RankedMemoryItem {
	return {
		memoryId,
		lane: "canonical",
		rank: 1,
		contentHash: `hash-${memoryId}`,
		type: "fact",
		tier: "L1",
		projectId: "project-a",
		verification: "tool-observed",
		status: "active",
		relevance: 1,
		freshness: 1,
		confidence: 1,
		usefulness: 1,
		scopeScore: 1,
		tokenEstimate: 100,
		sourceReferences: [],
		content: `content of ${memoryId}`,
		...overrides,
	};
}

function fused(memoryId: string, overrides: Partial<FusedMemoryItem> = {}): FusedMemoryItem {
	const candidate = overrides.candidate ?? record(memoryId);
	return {
		memoryId,
		candidate,
		rrfScore: 0.01,
		finalScore: 0.01,
		laneContributions: [],
		appearedInLanes: 1,
		...overrides,
	};
}

describe("fuseWithRrf", () => {
	it("scores on rank position rather than raw score", () => {
		// The lower-ranked item carries a far larger rawScore; RRF must ignore it.
		const result = fuseWithRrf([
			{
				lane: "canonical",
				items: [record("first", { rawScore: 0.01 }), record("second", { rawScore: 9999 })],
			},
		]);

		expect(result.map(r => r.memoryId)).toEqual(["first", "second"]);
		expect(result[0]!.rrfScore).toBeCloseTo(1 / (K + 1), 12);
		expect(result[1]!.rrfScore).toBeCloseTo(1 / (K + 2), 12);
	});

	it("accumulates contributions for a record present in several lanes", () => {
		const result = fuseWithRrf([
			{ lane: "canonical", items: [record("shared")] },
			{ lane: "graphify", items: [record("shared")] },
		]);

		expect(result).toHaveLength(1);
		expect(result[0]!.appearedInLanes).toBe(2);
		expect(result[0]!.rrfScore).toBeCloseTo(2 / (K + 1), 12);
		expect(result[0]!.laneContributions.map(c => c.lane)).toEqual(["canonical", "graphify"]);
	});

	it("lets cross-lane agreement outrank a single-lane top hit", () => {
		const result = fuseWithRrf([
			{ lane: "canonical", items: [record("solo"), record("agreed")] },
			{ lane: "graphify", items: [record("agreed")] },
		]);

		expect(result[0]!.memoryId).toBe("agreed");
	});

	it("applies per-lane weights", () => {
		const result = fuseWithRrf([{ lane: "memvid-temporal", items: [record("only")] }]);

		expect(result[0]!.rrfScore).toBeCloseTo(0.85 / (K + 1), 12);
		expect(result[0]!.laneContributions[0]!.weight).toBe(0.85);
	});

	it("honours an overridden rank constant and lane weight", () => {
		const result = fuseWithRrf([{ lane: "canonical", items: [record("only")] }], {
			rankConstant: 10,
			laneWeights: { canonical: 2 },
		});

		expect(result[0]!.rrfScore).toBeCloseTo(2 / 11, 12);
	});

	it("returns an empty list when every lane is empty", () => {
		expect(fuseWithRrf([{ lane: "canonical", items: [] }])).toEqual([]);
		expect(fuseWithRrf([])).toEqual([]);
	});

	it("keeps the better-verified version of a duplicated record", () => {
		const result = fuseWithRrf([
			{ lane: "canonical", items: [record("dup", { verification: "model-proposed" })] },
			{ lane: "graphify", items: [record("dup", { verification: "user-confirmed" })] },
		]);

		expect(result[0]!.candidate.verification).toBe("user-confirmed");
	});
});

describe("lane configuration", () => {
	it("weights exactly the supported lanes", () => {
		expect(Object.keys(DEFAULT_RRF_CONFIG.laneWeights).sort()).toEqual([
			"canonical",
			"graphify",
			"mempalace",
			"memvid-lexical",
			"memvid-temporal",
		]);
	});

	it("keeps every lane weight within a sane range", () => {
		for (const weight of Object.values(DEFAULT_RRF_CONFIG.laneWeights)) {
			expect(weight).toBeGreaterThan(0);
			expect(weight).toBeLessThanOrEqual(1);
		}
	});
});

describe("quality weights", () => {
	it("ranks verification levels strongest-first", () => {
		expect(getVerificationWeight("user-confirmed")).toBeGreaterThan(getVerificationWeight("test-observed"));
		expect(getVerificationWeight("test-observed")).toBeGreaterThan(getVerificationWeight("source-extracted"));
		expect(getVerificationWeight("source-extracted")).toBeGreaterThan(getVerificationWeight("tool-observed"));
		expect(getVerificationWeight("tool-observed")).toBeGreaterThan(getVerificationWeight("episode-derived"));
		expect(getVerificationWeight("episode-derived")).toBeGreaterThan(getVerificationWeight("model-proposed"));
	});

	it("zeroes out terminal record states", () => {
		expect(getStatusWeight("quarantined")).toBe(0);
		expect(getStatusWeight("tombstoned")).toBe(0);
		expect(getStatusWeight("active")).toBe(1);
	});

	it("ranks live states above retired ones", () => {
		expect(getStatusWeight("active")).toBeGreaterThan(getStatusWeight("candidate"));
		expect(getStatusWeight("candidate")).toBeGreaterThan(getStatusWeight("stale"));
		expect(getStatusWeight("stale")).toBeGreaterThan(getStatusWeight("archived"));
		expect(getStatusWeight("archived")).toBeGreaterThan(getStatusWeight("superseded"));
	});
});

describe("choosePreferredVersion", () => {
	it("prefers the stronger provenance", () => {
		const weak = record("x", { verification: "model-proposed", content: "a much longer body of text" });
		const strong = record("x", { verification: "user-confirmed", content: "short" });

		expect(choosePreferredVersion(weak, strong)).toBe(strong);
		expect(choosePreferredVersion(strong, weak)).toBe(strong);
	});

	it("falls back to the more complete body on equal provenance", () => {
		const brief = record("x", { content: "short" });
		const full = record("x", { content: "a considerably longer body" });

		expect(choosePreferredVersion(brief, full)).toBe(full);
	});
});

describe("applyQualityAdjustment", () => {
	it("suppresses a tombstoned record entirely", () => {
		const adjusted = applyQualityAdjustment(fused("x", { candidate: record("x", { status: "tombstoned" }) }));

		expect(adjusted.finalScore).toBe(0);
		expect(adjusted.rrfScore).toBe(0.01);
	});

	it("caps the cross-lane agreement boost at 1.15", () => {
		const manyLanes = applyQualityAdjustment(fused("x", { appearedInLanes: 50 }));
		const fourLanes = applyQualityAdjustment(fused("x", { appearedInLanes: 4 }));

		// tool-observed (1.05) * agreement boost; every other factor resolves to 1.
		expect(manyLanes.finalScore).toBeCloseTo(0.01 * 1.05 * 1.15, 12);
		expect(fourLanes.finalScore).toBeCloseTo(0.01 * 1.05 * 1.12, 12);
	});

	it("clamps out-of-range signals instead of amplifying them", () => {
		const sane = applyQualityAdjustment(fused("x"));
		const absurd = applyQualityAdjustment(
			fused("y", { candidate: record("y", { scopeScore: 99, freshness: 99, confidence: 99, usefulness: 99 }) }),
		);

		expect(absurd.finalScore).toBeCloseTo(sane.finalScore, 12);
	});

	it("penalises a narrower scope match", () => {
		const broad = applyQualityAdjustment(fused("x"));
		const narrow = applyQualityAdjustment(fused("y", { candidate: record("y", { scopeScore: 0.5 }) }));

		expect(narrow.finalScore).toBeLessThan(broad.finalScore);
	});
});

describe("selectWithCoverage", () => {
	it("respects the item ceiling", () => {
		const ranked = [fused("a"), fused("b"), fused("c")];

		expect(selectWithCoverage(ranked, [], 2, 10_000)).toHaveLength(2);
	});

	it("respects the token budget", () => {
		const ranked = [fused("a"), fused("b"), fused("c")];

		// Each record estimates 100 tokens, so a 250 budget admits two.
		expect(selectWithCoverage(ranked, [], 10, 250)).toHaveLength(2);
	});

	it("drops a record whose content hash is already selected", () => {
		const ranked = [
			fused("a", { candidate: record("a", { contentHash: "same" }) }),
			fused("b", { candidate: record("b", { contentHash: "same" }) }),
		];

		const selected = selectWithCoverage(ranked, [], 10, 10_000);

		expect(selected).toHaveLength(1);
		expect(selected[0]!.memoryId).toBe("a");
	});

	it("promotes a weaker record that covers an unmet need", () => {
		const strong = fused("strong", { finalScore: 0.5, candidate: record("strong", { type: "fact" }) });
		const weakButCovering = fused("covering", {
			finalScore: 0.1,
			candidate: record("covering", { type: "procedure" }),
		});

		const selected = selectWithCoverage(
			[strong, weakButCovering],
			[{ type: "procedure", required: true, priority: 5 }],
			1,
			10_000,
		);

		expect(selected[0]!.memoryId).toBe("covering");
	});

	it("stops cleanly when nothing fits the budget", () => {
		expect(selectWithCoverage([fused("a")], [], 10, 1)).toEqual([]);
	});

	it("never selects the same record twice", () => {
		const selected = selectWithCoverage([fused("a"), fused("b")], [], 10, 10_000);

		expect(new Set(selected.map(s => s.memoryId)).size).toBe(selected.length);
	});
});

describe("redundancy and needs", () => {
	it("treats identical bodies as fully redundant", () => {
		const a = fused("a", { candidate: record("a", { content: "identical body" }) });
		const b = fused("b", { candidate: record("b", { content: "identical body" }) });

		expect(calculateRedundancyPenalty(a, [b])).toBe(1);
	});

	it("charges a partial penalty for a repeated record type", () => {
		const a = fused("a", { candidate: record("a", { content: "one", type: "fact" }) });
		const b = fused("b", { candidate: record("b", { content: "two", type: "fact" }) });

		expect(calculateRedundancyPenalty(a, [b])).toBe(0.4);
	});

	it("charges nothing against an empty selection", () => {
		expect(calculateRedundancyPenalty(fused("a"), [])).toBe(0);
	});

	it("matches an explicit satisfiedBy list ahead of text matching", () => {
		const item = fused("a", { candidate: record("a", { type: "fact" }) });

		expect(itemSatisfiesNeed(item, { type: "fact", required: true, priority: 1, satisfiedBy: ["other"] })).toBe(
			false,
		);
		expect(itemSatisfiesNeed(item, { type: "fact", required: true, priority: 1, satisfiedBy: ["a"] })).toBe(true);
	});
});

describe("identity and duplication", () => {
	it("treats a shared content hash as identity equivalence", () => {
		expect(isIdentityEquivalent({ contentHash: "h1" }, { contentHash: "h1" })).toBe(true);
		expect(isIdentityEquivalent({ contentHash: "h1" }, { contentHash: "h2" })).toBe(false);
	});

	it("never equates two records on absent fields", () => {
		expect(isIdentityEquivalent({}, {})).toBe(false);
		expect(isIdentityEquivalent({ contentHash: "h1" }, {})).toBe(false);
	});

	it("detects a record already loaded by id, hash, or source evidence", () => {
		const candidate = record("a", { sourceReferences: ["src-1"] });

		expect(isAlreadyLoaded(candidate, new Set(["a"]), new Set())).toBe(true);
		expect(isAlreadyLoaded(candidate, new Set(), new Set(["hash-a"]))).toBe(true);
		expect(isAlreadyLoaded(candidate, new Set(["src-1"]), new Set())).toBe(true);
		expect(isAlreadyLoaded(candidate, new Set(["other"]), new Set(["other"]))).toBe(false);
	});

	it("separates identity equivalence from shared evidence", () => {
		const a = record("a", { sourceReferences: ["src-1"] });
		const b = record("b", { sourceReferences: ["src-1"] });
		const c = record("c", { sourceReferences: ["src-2"] });
		const twin = record("twin", { contentHash: "hash-a" });

		expect(classifyMemoryRelationship(a, b)).toBe("evidence-related");
		expect(classifyMemoryRelationship(a, c)).toBe("unrelated");
		expect(classifyMemoryRelationship(a, twin)).toBe("identity-equivalent");
	});
});

describe("formatRRFExplanation", () => {
	it("reports every lane contribution and quality factor", () => {
		const [item] = fuseWithRrf([
			{ lane: "canonical", items: [record("explained")] },
			{ lane: "memvid-temporal", items: [record("explained")] },
		]);

		const text = formatRRFExplanation(applyQualityAdjustment(item!));

		expect(text).toContain("Memory: explained");
		expect(text).toContain("Appeared in 2 lane(s):");
		expect(text).toContain("canonical rank 1");
		expect(text).toContain("memvid-temporal rank 1");
		expect(text).toContain("verification: 1.05 (tool-observed)");
		expect(text).toContain("status: 1.00 (active)");
	});
});
