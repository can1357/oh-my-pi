/**
 * Tests for memory-informed capability ranking.
 */

import { describe, expect, it } from "bun:test";
import type { ExecutionCompleteBundle } from "@oh-my-pi/pi-coding-agent/memory-fabric/capability-bundle";
import type { FidelityPlan } from "@oh-my-pi/pi-coding-agent/memory-fabric/capability-fidelity";
import { rankBundle } from "@oh-my-pi/pi-coding-agent/memory-fabric/capability-ranking";

function bundle(included: string[]): ExecutionCompleteBundle {
	return {
		mode: "observe",
		seeds: included.slice(0, 1),
		included,
		prerequisites: [],
		validations: [],
		rollbacks: [],
		conflicts: [],
		missing: [],
		truncated: false,
		cycles: [],
	};
}

function planWith(assignments: Array<{ id: string; tier: "L0" | "L1" | "L2" | "L3" | "L4" }>): FidelityPlan {
	return {
		mode: "observe",
		enabled: true,
		assignments: assignments.map(a => ({ ...a, reason: "test" })),
		byTier: { L0: [], L1: [], L2: [], L3: [], L4: [] },
		riskFlags: [],
		recommendedExclusions: [],
	};
}

describe("rankBundle", () => {
	it("is inert when disabled", () => {
		const ranked = rankBundle(bundle(["a", "b"]));
		expect(ranked.enabled).toBe(false);
		expect(ranked.ranking).toEqual([]);
	});

	it("ranks by Laplace-smoothed reliability, neutral prior for no history", () => {
		const ranked = rankBundle(bundle(["novice", "veteran", "flaky"]), {
			enabled: true,
			history: {
				veteran: { successes: 9, failures: 1 }, // (9+1)/(9+1+2) ≈ 0.833
				flaky: { successes: 1, failures: 9 }, // (1+1)/(1+9+2) ≈ 0.167
				// novice: no history → (0+1)/(0+0+2) = 0.5
			},
		});
		expect(ranked.ranking.map(r => r.id)).toEqual(["veteran", "novice", "flaky"]);
		expect(ranked.ranking[1].reason).toContain("neutral prior");
	});

	it("tier priority dominates: an L0 item outranks a higher-scoring L3 item", () => {
		const ranked = rankBundle(bundle(["strong", "critical"]), {
			enabled: true,
			history: { strong: { successes: 100 }, critical: { failures: 100 } },
			plan: planWith([
				{ id: "strong", tier: "L3" },
				{ id: "critical", tier: "L0" },
			]),
		});
		expect(ranked.ranking.map(r => r.id)).toEqual(["critical", "strong"]);
	});

	it("keeps original bundle order on exact ties (stable)", () => {
		const ranked = rankBundle(bundle(["first", "second", "third"]), { enabled: true });
		expect(ranked.ranking.map(r => r.id)).toEqual(["first", "second", "third"]);
	});

	it("recency requires an injected clock: no clock, no recency", () => {
		const stats = { successes: 1, failures: 1, lastUsedTs: 1000 };
		const withoutClock = rankBundle(bundle(["a"]), {
			enabled: true,
			history: { a: stats },
			recencyWeight: 1,
		});
		expect(withoutClock.ranking[0].recency).toBe(0);

		const withClock = rankBundle(bundle(["a"]), {
			enabled: true,
			history: { a: stats },
			recencyWeight: 1,
			now: 1000, // zero age → full recency
		});
		expect(withClock.ranking[0].recency).toBe(1);
	});

	it("applies half-life decay to recency", () => {
		const halfLife = 1000;
		const ranked = rankBundle(bundle(["a"]), {
			enabled: true,
			history: { a: { lastUsedTs: 0 } },
			recencyWeight: 1,
			recencyHalfLifeMs: halfLife,
			now: halfLife, // exactly one half-life old
		});
		expect(ranked.ranking[0].recency).toBeCloseTo(0.5, 10);
	});

	it("adds a co-occurrence affinity bonus for included companions", () => {
		const ranked = rankBundle(bundle(["a", "b", "loner"]), {
			enabled: true,
			coOccurrenceMap: { a: { b: 5, notIncluded: 100 } },
			coOccurrenceWeight: 1,
		});
		const byId = new Map(ranked.ranking.map(r => [r.id, r]));
		// a gets the saturated bonus (5/5 = 1) only from included b; loner gets none.
		expect((byId.get("a") as { score: number }).score).toBeGreaterThan(
			(byId.get("loner") as { score: number }).score,
		);
		expect(ranked.ranking[0].id).toBe("a");
	});
});
