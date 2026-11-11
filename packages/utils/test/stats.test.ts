import { describe, expect, it } from "bun:test";
import { mean, nearestRank } from "../src/stats";

describe("nearestRank", () => {
	const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

	it("picks the smallest value with at least q of the sample at or below it", () => {
		expect(nearestRank(ten, 0.5)).toBe(5);
		expect(nearestRank(ten, 0.95)).toBe(10);
		expect(nearestRank(ten, 0.1)).toBe(1);
		expect(nearestRank(ten, 0.11)).toBe(2);
		expect(nearestRank([7, 9, 11], 0.5)).toBe(9);
	});

	it("clamps q to the sample", () => {
		expect(nearestRank(ten, 0)).toBe(1);
		expect(nearestRank(ten, 1)).toBe(10);
		expect(nearestRank(ten, 2)).toBe(10);
		expect(nearestRank(ten, -1)).toBe(1);
	});

	it("gives 0 for an empty sample", () => {
		expect(nearestRank([], 0.5)).toBe(0);
	});
});

describe("mean", () => {
	it("averages the sample, and gives 0 for an empty one", () => {
		expect(mean([1, 2, 6])).toBe(3);
		expect(mean([])).toBe(0);
	});
});
