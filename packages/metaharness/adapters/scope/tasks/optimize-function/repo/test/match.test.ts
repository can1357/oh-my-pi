import { expect, test } from "bun:test";
import { CATALOGUE } from "../src/catalogue";
import { bestMatch } from "../src/match";

const SHELF = CATALOGUE.slice(0, 120);

test("finds a misspelled name, ignoring case and outer whitespace", () => {
	expect(bestMatch("  stainles steel watr bottle small ", SHELF)).toEqual({
		name: "Stainless Steel Water Bottle Small",
		distance: 2,
	});
});

test("nothing within the distance budget is no match", () => {
	expect(bestMatch("garden hose", SHELF)).toBeNull();
	expect(bestMatch("Stainless Steel Water Bottle", SHELF, 3)).toBeNull();
});

test("a tie goes to the earlier name", () => {
	expect(bestMatch("Stainless Steel Water Bottle Set of 3", SHELF)?.name).toBe("Stainless Steel Water Bottle Set of 2");
});
