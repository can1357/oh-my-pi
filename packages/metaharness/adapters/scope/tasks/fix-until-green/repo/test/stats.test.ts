import { expect, test } from "bun:test";
import { median } from "../src/stats";

test("median", () => {
	expect(median([3, 1, 2])).toBe(2);
	expect(median([10, 9, 2])).toBe(9);
	expect(median([4, 1, 3, 2])).toBe(2.5);
	const input = [3, 1, 2];
	median(input);
	expect(input).toEqual([3, 1, 2]);
	expect(() => median([])).toThrow("empty");
});
