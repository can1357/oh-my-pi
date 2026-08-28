/**
 * Tests for RRF capability seed fusion.
 */

import { describe, expect, it } from "bun:test";
import type { RankedCapabilityList } from "@oh-my-pi/pi-coding-agent/memory-fabric/capability-seed-fusion";
import {
	DEFAULT_SOURCE_WEIGHTS,
	formatSeedExplanation,
	fuseCapabilitySeeds,
	toSeedIds,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/capability-seed-fusion";

function list(source: RankedCapabilityList["source"], items: string[], needId?: string): RankedCapabilityList {
	return { source, items, needId };
}

describe("fuseCapabilitySeeds", () => {
	it("is inert when disabled", () => {
		const result = fuseCapabilitySeeds([list("lexical", ["a"])]);
		expect(result.enabled).toBe(false);
		expect(result.candidates).toEqual([]);
	});

	it("ranks candidates appearing in more sources higher (RRF fusion)", () => {
		const result = fuseCapabilitySeeds(
			[list("lexical", ["a", "b"]), list("semantic", ["a", "c"]), list("project", ["a"])],
			{ enabled: true },
		);
		expect(result.candidates[0]?.capabilityId).toBe("a");
		expect(result.candidates[0]?.appearedInSources).toBe(3);
	});

	it("computes RRF contributions as weight / (k + rank)", () => {
		const result = fuseCapabilitySeeds([list("lexical", ["a"])], { enabled: true, rankConstant: 60 });
		const c = result.candidates[0];
		expect(c?.rrfScore).toBeCloseTo(DEFAULT_SOURCE_WEIGHTS.lexical / 61, 10);
		expect(c?.contributions[0]?.rank).toBe(1);
	});

	it("skips unknown sources, malformed lists, and blank ids", () => {
		const lists = [
			{ source: "bogus", items: ["a"] },
			{ source: "lexical", items: "not-an-array" },
			list("semantic", ["", "  ", "b"]),
		] as unknown as RankedCapabilityList[];
		const result = fuseCapabilitySeeds(lists, { enabled: true });
		expect(result.candidates.map(c => c.capabilityId)).toEqual(["b"]);
	});

	it("dedupes repeated ids within one list (rank counted once)", () => {
		const result = fuseCapabilitySeeds([list("lexical", ["a", "a", "b"])], { enabled: true });
		expect(result.candidates.map(c => c.capabilityId)).toEqual(["a", "b"]);
		expect(result.candidates[1]?.contributions[0]?.rank).toBe(2);
	});

	it("honors rankWindow and topK limits", () => {
		const windowed = fuseCapabilitySeeds([list("lexical", ["a", "b", "c"])], { enabled: true, rankWindow: 2 });
		expect(windowed.candidates.map(c => c.capabilityId)).toEqual(["a", "b"]);

		const topped = fuseCapabilitySeeds([list("lexical", ["a", "b", "c"])], { enabled: true, topK: 1 });
		expect(topped.candidates).toHaveLength(1);
	});

	it("aggregates needIds from annotated lists", () => {
		const result = fuseCapabilitySeeds([list("lexical", ["a"], "need-1"), list("semantic", ["a"], "need-2")], {
			enabled: true,
		});
		expect(result.candidates[0]?.needIds.sort()).toEqual(["need-1", "need-2"]);
		expect(result.candidates[0]?.matchedNeedIds).toEqual(result.candidates[0]?.needIds);
	});

	it("boosts candidates with strong historical outcomes", () => {
		const base = fuseCapabilitySeeds([list("lexical", ["a", "b"])], { enabled: true });
		const boosted = fuseCapabilitySeeds([list("lexical", ["a", "b"])], {
			enabled: true,
			outcomeFeedback: { b: { successRate: 1, totalUses: 10 } },
		});
		const baseB = base.candidates.find(c => c.capabilityId === "b");
		const boostedB = boosted.candidates.find(c => c.capabilityId === "b");
		expect((boostedB?.rrfScore ?? 0) > (baseB?.rrfScore ?? 0)).toBe(true);
	});

	it("penalizes candidates with poor historical outcomes", () => {
		const base = fuseCapabilitySeeds([list("lexical", ["a"])], { enabled: true });
		const penalized = fuseCapabilitySeeds([list("lexical", ["a"])], {
			enabled: true,
			outcomeFeedback: { a: { successRate: 0, totalUses: 10 } },
		});
		expect((penalized.candidates[0]?.rrfScore ?? 0) < (base.candidates[0]?.rrfScore ?? 1)).toBe(true);
	});

	it("adds co-occurrence bonus scaled by confidence", () => {
		const result = fuseCapabilitySeeds([list("lexical", ["a", "b"])], {
			enabled: true,
			outcomeFeedback: { a: { successRate: 0.5, totalUses: 10, coOccurrenceBonus: { b: 1 } } },
		});
		const a = result.candidates.find(c => c.capabilityId === "a");
		// rate boost is neutral (0.5 success); co-bonus adds 0.02 * 1 * 1.
		expect(a?.rrfScore).toBeCloseTo(DEFAULT_SOURCE_WEIGHTS.lexical / 61 + 0.02, 10);
	});

	it("breaks score ties deterministically by capability id", () => {
		const result = fuseCapabilitySeeds([list("lexical", ["z"]), list("semantic", ["m"])], { enabled: true });
		expect(result.candidates.map(c => c.capabilityId)).toEqual(["m", "z"]);
	});

	it("fails open on hostile input (returns inert result, never throws)", () => {
		const result = fuseCapabilitySeeds(null as unknown as RankedCapabilityList[], { enabled: true });
		expect(result.mode).toBe("observe");
		expect(result.candidates).toEqual([]);
	});
});

describe("toSeedIds", () => {
	it("projects fused candidates to ordered ids", () => {
		const ids = toSeedIds([list("lexical", ["a", "b"]), list("semantic", ["b"])], { enabled: true });
		expect(ids).toEqual(["b", "a"]);
	});
});

describe("formatSeedExplanation", () => {
	it("renders score, sources, and needs", () => {
		const result = fuseCapabilitySeeds([list("lexical", ["a"], "need-1")], { enabled: true });
		const candidate = result.candidates[0];
		if (!candidate) throw new Error("expected a fused candidate");
		const text = formatSeedExplanation(candidate);
		expect(text).toContain("Capability: a");
		expect(text).toContain("lexical rank 1");
		expect(text).toContain("need-1");
	});

	it("fails safe to empty string on malformed candidate", () => {
		expect(formatSeedExplanation(null as never)).toBe("");
	});
});
