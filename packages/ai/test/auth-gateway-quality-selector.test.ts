import { describe, expect, it } from "bun:test";
import { qualitySelector } from "@oh-my-pi/pi-ai/auth-gateway/quality-selector";
import { RoutePerformanceStore } from "@oh-my-pi/pi-ai/auth-gateway/route-performance";
import type { RouteCandidate } from "@oh-my-pi/pi-ai/auth-gateway/selectors";

function record(store: RoutePerformanceStore, routeId: string, target: string, success: boolean): void {
	store.record({ routeId, target, success, durationMs: 100 });
}

function candidate(id: string): RouteCandidate {
	return { id };
}

describe("qualitySelector", () => {
	it("ranks higher success rate first", () => {
		const store = new RoutePerformanceStore();
		record(store, "r1", "low", true);
		record(store, "r1", "low", false);
		record(store, "r1", "high", true);
		record(store, "r1", "high", true);
		const ranked = qualitySelector(store, "r1").rank([candidate("low"), candidate("high")], {});
		expect(ranked.map(r => r.id)).toEqual(["high", "low"]);
		expect(ranked.map(r => r.score)).toEqual([1, 0.5]);
	});

	it("scores unknown targets 0.5 not 0 so untested is not dead", () => {
		const store = new RoutePerformanceStore();
		record(store, "r1", "failing", false);
		const ranked = qualitySelector(store, "r1").rank([candidate("failing"), candidate("untested")], {});
		expect(ranked.map(r => r.id)).toEqual(["untested", "failing"]);
		expect(ranked.map(r => r.score)).toEqual([0.5, 0]);
	});

	it("does not rank a lower success rate first (negative)", () => {
		const store = new RoutePerformanceStore();
		record(store, "r1", "low", true);
		record(store, "r1", "low", false);
		record(store, "r1", "low", false);
		record(store, "r1", "low", false);
		record(store, "r1", "high", true);
		record(store, "r1", "high", true);
		record(store, "r1", "high", true);
		record(store, "r1", "high", false);
		const ranked = qualitySelector(store, "r1").rank([candidate("low"), candidate("high")], {});
		expect(ranked[0]?.id).not.toBe("low");
		expect(ranked.map(r => r.id)).toEqual(["high", "low"]);
		expect(ranked[0]?.score).toBe(0.75);
		expect(ranked[1]?.score).toBe(0.25);
	});

	it("keeps equal-score input order (stable)", () => {
		const store = new RoutePerformanceStore();
		const ranked = qualitySelector(store, "r1").rank([candidate("a"), candidate("b"), candidate("c")], {});
		expect(ranked.map(r => r.id)).toEqual(["a", "b", "c"]);
		expect(ranked.map(r => r.score)).toEqual([0.5, 0.5, 0.5]);
	});

	it("does not use summaries from a different routeId", () => {
		const store = new RoutePerformanceStore();
		record(store, "other", "x", true);
		record(store, "other", "x", true);
		const ranked = qualitySelector(store, "r1").rank([candidate("x")], {});
		expect(ranked[0]?.score).toBe(0.5);
	});
});
