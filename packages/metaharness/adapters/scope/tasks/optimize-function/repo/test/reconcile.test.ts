import { expect, test } from "bun:test";
import { CATALOGUE, mangledNames } from "../src/catalogue";
import { reconcile } from "../src/reconcile";

test("a whole supplier feed maps onto the catalogue", () => {
	const feed = mangledNames(30, "typos", 23);
	const mapping = reconcile(feed, CATALOGUE);
	expect(mapping.size).toBe(new Set(feed).size);
	for (const name of mapping.values()) expect(CATALOGUE).toContain(name);
}, 60_000);

test("names nowhere near the catalogue are left out", () => {
	expect(reconcile(["garden hose", "office chair"], CATALOGUE).size).toBe(0);
}, 60_000);
