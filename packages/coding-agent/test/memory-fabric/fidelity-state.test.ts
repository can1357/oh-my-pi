/**
 * Tests for the Adaptive-Fidelity Context State (ACF lane).
 *
 * Verifies the bounded working set is disabled-by-default, observe-only,
 * deterministic and fail-open, that protected items are never evicted or
 * summarized, that the token budget is enforced via summarize-then-evict, and
 * that the compact current-state view is exposed. Offline; no clock.
 */

import { describe, expect, it } from "bun:test";
import {
	currentFidelityState,
	type FidelityInputItem,
	planAdaptiveFidelityState,
	summarizeFidelityState,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/adaptive-fidelity/fidelity-state";

describe("adaptive-fidelity context state", () => {
	it("is disabled by default — inert", () => {
		const s = planAdaptiveFidelityState([{ id: "a", tokens: 100 }]);
		expect(s.enabled).toBe(false);
		expect(s.full).toEqual([]);
		expect(s.entries).toEqual([]);
		expect(s.mode).toBe("observe");
	});

	it("carries everything at full fidelity when it fits the budget", () => {
		const items: FidelityInputItem[] = [
			{ id: "a", tokens: 100 },
			{ id: "b", tokens: 100 },
		];
		const s = planAdaptiveFidelityState(items, { enabled: true, budget: 1000 });
		expect(s.full).toEqual(["a", "b"]);
		expect(s.summarized).toEqual([]);
		expect(s.evicted).toEqual([]);
		expect(s.used).toBe(200);
		expect(s.firingRate).toBe(1);
		expect(s.truncated).toBe(false);
	});

	it("summarizes lower-salience items under budget pressure before evicting", () => {
		const items: FidelityInputItem[] = [
			{ id: "hi", tokens: 80, relevance: 1, safety: 1 },
			{ id: "lo", tokens: 80, relevance: 0.1, summaryTokens: 20 },
		];
		// Budget fits hi at full (80) + lo summarized (20) = 100, but not lo full.
		const s = planAdaptiveFidelityState(items, { enabled: true, budget: 100 });
		expect(s.full).toEqual(["hi"]);
		expect(s.summarized).toEqual(["lo"]);
		expect(s.evicted).toEqual([]);
		expect(s.used).toBe(100);
		expect(s.truncated).toBe(true);
	});

	it("evicts when neither full nor summarized fit", () => {
		const items: FidelityInputItem[] = [
			{ id: "hi", tokens: 100, relevance: 1 },
			{ id: "lo", tokens: 100, relevance: 0.1, summaryTokens: 40 },
		];
		const s = planAdaptiveFidelityState(items, { enabled: true, budget: 100 });
		expect(s.full).toEqual(["hi"]);
		expect(s.summarized).toEqual([]);
		expect(s.evicted).toEqual(["lo"]);
		expect(s.truncated).toBe(true);
	});

	it("never evicts a protected item, even past budget", () => {
		const items: FidelityInputItem[] = [
			{ id: "safety", tokens: 500, protected: true },
			{ id: "filler", tokens: 500, relevance: 1 },
		];
		const s = planAdaptiveFidelityState(items, { enabled: true, budget: 100 });
		expect(s.full).toContain("safety");
		expect(s.evicted).not.toContain("safety");
		expect(s.overBudget).toBe(true);
		expect(s.truncated).toBe(true);
		expect(s.used).toBeGreaterThan(s.budget);
	});

	it("never summarizes a protected item", () => {
		const items: FidelityInputItem[] = [{ id: "p", tokens: 300, protected: true, summaryTokens: 10 }];
		const s = planAdaptiveFidelityState(items, { enabled: true, budget: 50 });
		expect(s.full).toEqual(["p"]);
		expect(s.summarized).toEqual([]);
		expect(s.used).toBe(300);
		expect(s.overBudget).toBe(true);
	});

	it("protected items sort ahead of higher-signal ordinary items", () => {
		const items: FidelityInputItem[] = [
			{ id: "ord", tokens: 10, safety: 1, relevance: 1, authority: 1 },
			{ id: "prot", tokens: 10, protected: true },
		];
		const s = planAdaptiveFidelityState(items, { enabled: true, budget: 1000 });
		expect(s.entries[0].id).toBe("prot");
		expect(s.entries[0].salience).toBe(1);
	});

	it("orders by salience desc, breaking ties by id asc (deterministic)", () => {
		const items: FidelityInputItem[] = [
			{ id: "b", tokens: 10, relevance: 0.5 },
			{ id: "a", tokens: 10, relevance: 0.5 },
			{ id: "z", tokens: 10, relevance: 0.9 },
		];
		const s = planAdaptiveFidelityState(items, { enabled: true, budget: 1000 });
		expect(s.entries.map(e => e.id)).toEqual(["z", "a", "b"]);
	});

	it("is deterministic — identical input yields identical state", () => {
		const items: FidelityInputItem[] = [
			{ id: "a", tokens: 60, relevance: 0.8 },
			{ id: "b", tokens: 60, relevance: 0.2, summaryTokens: 20 },
			{ id: "c", tokens: 60, relevance: 0.5 },
		];
		const a = planAdaptiveFidelityState(items, { enabled: true, budget: 120 });
		const b = planAdaptiveFidelityState(items, { enabled: true, budget: 120 });
		expect(a).toEqual(b);
	});

	it("computes firing rate as full / total", () => {
		const items: FidelityInputItem[] = [
			{ id: "a", tokens: 100, relevance: 1 },
			{ id: "b", tokens: 100, relevance: 0.1, summaryTokens: 100 },
		];
		// budget 100 -> a full (100), b cannot fit full or summarized -> evicted.
		const s = planAdaptiveFidelityState(items, { enabled: true, budget: 100 });
		expect(s.firingRate).toBeCloseTo(0.5, 5);
	});

	it("truncates the eligible set at maxItems (protected still kept)", () => {
		const items: FidelityInputItem[] = [
			{ id: "a", tokens: 10, relevance: 0.9 },
			{ id: "b", tokens: 10, relevance: 0.8 },
			{ id: "p", tokens: 10, protected: true },
		];
		const s = planAdaptiveFidelityState(items, { enabled: true, budget: 1000, maxItems: 1 });
		expect(s.full).toContain("p"); // protected bypasses the cap
		expect(s.full).toContain("a"); // highest-salience ordinary item
		expect(s.evicted).toContain("b"); // capped out
		expect(s.truncated).toBe(true);
	});

	it("drops structurally invalid and duplicate items", () => {
		const items = [
			{ id: "a", tokens: 10 },
			{ id: "a", tokens: 10 }, // duplicate id
			{ id: "", tokens: 10 }, // empty id
			{ id: "z", tokens: 0 }, // non-positive tokens
			{ id: "y", tokens: Number.NaN }, // NaN tokens
		] as FidelityInputItem[];
		const s = planAdaptiveFidelityState(items, { enabled: true, budget: 1000 });
		expect(s.full).toEqual(["a"]);
	});

	it("fail-open: bad input never throws, returns an empty enabled state", () => {
		const s = planAdaptiveFidelityState(undefined as unknown as FidelityInputItem[], { enabled: true });
		expect(s.enabled).toBe(true);
		expect(s.full).toEqual([]);
		expect(s.evicted).toEqual([]);
	});

	it("currentFidelityState exposes carried ids and expansion handles", () => {
		const items: FidelityInputItem[] = [
			{ id: "hi", tokens: 80, relevance: 1 },
			{ id: "lo", tokens: 80, relevance: 0.1, summaryTokens: 20 },
		];
		const s = planAdaptiveFidelityState(items, { enabled: true, budget: 100 });
		const view = currentFidelityState(s);
		expect(view.carried).toEqual(["hi", "lo"]);
		expect(view.expandHandles).toEqual(["lo"]);
		expect(view.budget).toBe(100);
		// disabled state yields an empty view
		expect(currentFidelityState(planAdaptiveFidelityState(items)).carried).toEqual([]);
	});

	it("summarizeFidelityState reports disabled and enabled states", () => {
		expect(summarizeFidelityState(planAdaptiveFidelityState([{ id: "a", tokens: 10 }]))).toBe("fidelity: disabled");
		const s = planAdaptiveFidelityState([{ id: "a", tokens: 10 }], { enabled: true, budget: 100 });
		expect(summarizeFidelityState(s)).toContain("full=1");
	});
});
