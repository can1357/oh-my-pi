import { describe, expect, it } from "bun:test";
import { applyCatalogDescriptionBudget } from "../src/catalog-budget";

describe("applyCatalogDescriptionBudget", () => {
	const entries = [
		{ name: "a", description: "AAAA", blocking: true },
		{ name: "b", description: "BBBB", blocking: false },
		{ name: "c", description: "CCCC", blocking: false },
	];

	it("retains every description when the budget is unlimited (-1)", () => {
		const result = applyCatalogDescriptionBudget(entries, -1);
		expect(result.map(entry => entry.description)).toEqual(["AAAA", "BBBB", "CCCC"]);
		expect(result.some(entry => entry.descriptionOmitted)).toBe(false);
	});

	it("retains every description when a positive budget fits all of them exactly", () => {
		const result = applyCatalogDescriptionBudget(entries, 12);
		expect(result.map(entry => entry.description)).toEqual(["AAAA", "BBBB", "CCCC"]);
		expect(result.some(entry => entry.descriptionOmitted)).toBe(false);
	});

	it("omits every description at budget zero while keeping names and other fields", () => {
		const result = applyCatalogDescriptionBudget(entries, 0);
		expect(result.map(entry => entry.name)).toEqual(["a", "b", "c"]);
		expect(result.map(entry => entry.description)).toEqual(["", "", ""]);
		expect(result.map(entry => entry.blocking)).toEqual([true, false, false]);
	});

	it("retains descriptions in order until the budget is exhausted, then name-only for the rest", () => {
		const result = applyCatalogDescriptionBudget(entries, 8);
		expect(result.map(entry => entry.description)).toEqual(["AAAA", "BBBB", ""]);
	});

	it("uses prefix semantics: once exhausted, later entries stay name-only even if they would fit", () => {
		const mixed = [
			{ name: "a", description: "AAAA" },
			{ name: "b", description: "BBBBBB" },
			{ name: "c", description: "C" },
		];
		const result = applyCatalogDescriptionBudget(mixed, 5);
		expect(result.map(entry => entry.description)).toEqual(["AAAA", "", ""]);
	});

	it("renders name-only from the first entry when it alone overspends the budget", () => {
		const result = applyCatalogDescriptionBudget(entries, 3);
		expect(result.map(entry => entry.description)).toEqual(["", "", ""]);
	});

	it("handles an empty catalogue", () => {
		expect(applyCatalogDescriptionBudget([], 5)).toEqual([]);
	});

	// Config values are unvalidated, so malformed budgets must fail open.
	it.each([
		["null", null],
		["undefined", undefined],
		["NaN", Number.NaN],
		["Infinity", Number.POSITIVE_INFINITY],
		["a string", "2000"],
		["another negative", -100],
	])("treats %s as unlimited rather than omitting descriptions", (_label, budget) => {
		const result = applyCatalogDescriptionBudget(entries, budget as number);
		expect(result.map(entry => entry.description)).toEqual(["AAAA", "BBBB", "CCCC"]);
	});
});
