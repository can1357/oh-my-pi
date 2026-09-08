import { describe, expect, it } from "bun:test";
import { compareDisposition, isSelectable } from "../src/auth-gateway/candidate-disposition";

const ORDER = ["preferred", "eligible", "deprioritized", "last_resort", "blocked"] as const;

describe("compareDisposition", () => {
	it("preferred beats eligible", () => {
		expect(compareDisposition("preferred", "eligible")).toBeLessThan(0);
		expect(compareDisposition("eligible", "preferred")).toBeGreaterThan(0);
	});

	it("orders preferred < eligible < deprioritized < last_resort < blocked", () => {
		for (let i = 0; i < ORDER.length; i += 1) {
			for (let j = 0; j < ORDER.length; j += 1) {
				const cmp = compareDisposition(ORDER[i], ORDER[j]);
				if (i < j) {
					expect(cmp).toBeLessThan(0);
				} else if (i > j) {
					expect(cmp).toBeGreaterThan(0);
				} else {
					expect(cmp).toBe(0);
				}
			}
		}
	});

	it("does not use lexicographic string order (negative)", () => {
		// String compare ranks "eligible" before "preferred" and "blocked" before "eligible".
		expect("eligible" < "preferred").toBe(true);
		expect("blocked" < "eligible").toBe(true);
		expect(compareDisposition("preferred", "eligible")).toBeLessThan(0);
		expect(compareDisposition("eligible", "blocked")).toBeLessThan(0);
	});
});

describe("isSelectable", () => {
	it("is false only for blocked (negative)", () => {
		expect(isSelectable("blocked")).toBe(false);
	});

	it("treats last_resort as still selectable", () => {
		expect(isSelectable("last_resort")).toBe(true);
	});

	it("keeps preferred, eligible, and deprioritized selectable", () => {
		expect(isSelectable("preferred")).toBe(true);
		expect(isSelectable("eligible")).toBe(true);
		expect(isSelectable("deprioritized")).toBe(true);
	});
});
