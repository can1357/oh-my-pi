import { describe, expect, it } from "bun:test";
import { planContextMap } from "../src/chrome/context-map";

describe("context map occupancy", () => {
	it("chooses the largest overlap and distinguishes a split cell from 70-percent coverage", () => {
		const cells = planContextMap(
			[
				{ id: "system", tokens: 7 },
				{ id: "tools", tokens: 8 },
				{ id: "free", tokens: 25 },
			],
			40,
			4,
			1,
		);
		expect(cells).toEqual([
			{ id: "system", full: true },
			{ id: "tools", full: false },
			{ id: "free", full: true },
			{ id: "free", full: true },
		]);
	});
	it("clamps over-window segments without scaling their identities or retaining a negative free region", () => {
		expect(
			planContextMap(
				[
					{ id: "system", tokens: 75 },
					{ id: "tools", tokens: 75 },
					{ id: "free", tokens: -50 },
				],
				100,
				4,
				1,
			),
		).toEqual([
			{ id: "system", full: true },
			{ id: "system", full: true },
			{ id: "system", full: true },
			{ id: "tools", full: true },
		]);
	});
	it("rejects unknown capacity or unusable geometry", () => {
		for (const [window, cols, rows] of [
			[0, 16, 16],
			[Number.NaN, 16, 16],
			[100, 0, 16],
			[100, 16, -1],
			[100, 1.5, 16],
		])
			expect(planContextMap([{ id: "free", tokens: 100 }], window!, cols!, rows!)).toEqual([]);
	});
});
