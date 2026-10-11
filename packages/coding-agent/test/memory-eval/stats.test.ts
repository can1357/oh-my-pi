import { describe, expect, it } from "bun:test";
import { pairedBootstrap, verdict } from "../../bench/memory-eval/stats";

describe("memory-eval stats", () => {
	it("bootstrap is zero for identical arms and excludes zero for uniform wins", () => {
		expect(pairedBootstrap([0.5, 0.2], [0.5, 0.2])).toMatchObject({ meanDiff: 0, ciLow: 0, ciHigh: 0, ties: 2 });
		const r = pairedBootstrap(Array(50).fill(0), Array(50).fill(1));
		expect(r.ciLow).toBeGreaterThan(0);
		expect(pairedBootstrap([0, 1, 0], [1, 0, 1], { seed: 7 })).toEqual(
			pairedBootstrap([0, 1, 0], [1, 0, 1], { seed: 7 }),
		);
	});

	it("counts wins, ties, losses as b relative to a", () => {
		expect(pairedBootstrap([0, 1, 1], [1, 1, 0], { resamples: 100 })).toMatchObject({ wins: 1, ties: 1, losses: 1 });
	});

	it("rejects mismatched lengths", () => {
		expect(() => pairedBootstrap([1], [1, 2])).toThrow();
	});

	it("verdict rejects a win with a category regression", () => {
		const win = { meanDiff: 0.1, ciLow: 0.05, ciHigh: 0.15, wins: 9, ties: 0, losses: 1 };
		const loss = { meanDiff: -0.2, ciLow: -0.3, ciHigh: -0.1, wins: 0, ties: 0, losses: 5 };
		expect(verdict(win, { a: win })).toBe("helps");
		expect(verdict(win, { a: win, b: loss })).toBe("neutral");
	});

	it("verdict hurts mirrors helps and neutral spans zero", () => {
		const win = { meanDiff: 0.1, ciLow: 0.05, ciHigh: 0.15, wins: 9, ties: 0, losses: 1 };
		const loss = { meanDiff: -0.2, ciLow: -0.3, ciHigh: -0.1, wins: 0, ties: 0, losses: 5 };
		const flat = { meanDiff: 0, ciLow: -0.1, ciHigh: 0.1, wins: 1, ties: 0, losses: 1 };
		expect(verdict(loss, { a: loss })).toBe("hurts");
		expect(verdict(loss, { a: loss, b: win })).toBe("neutral");
		expect(verdict(flat, { a: flat })).toBe("neutral");
	});

	it("verdict is not blocked by a category whose CI straddles zero", () => {
		const win = { meanDiff: 0.1, ciLow: 0.05, ciHigh: 0.15, wins: 9, ties: 0, losses: 1 };
		const loss = { meanDiff: -0.2, ciLow: -0.3, ciHigh: -0.1, wins: 0, ties: 0, losses: 5 };
		const straddle = { meanDiff: 0, ciLow: -0.1, ciHigh: 0.1, wins: 1, ties: 0, losses: 1 };
		expect(verdict(win, { a: win, b: straddle })).toBe("helps");
		expect(verdict(loss, { a: loss, b: straddle })).toBe("hurts");
	});

	it("pins the percentile CI for a fixed input and seed", () => {
		const r = pairedBootstrap([0.2, 0.5, 0.1, 0.9, 0.4, 0.7, 0.3, 0.6], [0.5, 0.4, 0.3, 1, 0.2, 0.9, 0.3, 0.8], {
			seed: 3,
			resamples: 2000,
		});
		expect(r.meanDiff).toBeCloseTo(0.0875, 12);
		expect(r.ciLow).toBeCloseTo(-0.0375, 12);
		expect(r.ciHigh).toBeCloseTo(0.1875, 12);
		expect([r.wins, r.ties, r.losses]).toEqual([5, 1, 2]);
	});
});
