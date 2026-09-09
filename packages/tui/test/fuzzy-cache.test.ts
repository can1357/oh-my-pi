import { describe, expect, it } from "bun:test";
import { fuzzyMatch, fuzzyRank, resetFuzzyIndexCache } from "@oh-my-pi/pi-tui/fuzzy";

describe("fuzzy index cache", () => {
	it("produces identical ordering whether the cache is cold or warm", () => {
		const items = [
			"openai/gpt-4o",
			"openai/gpt-4o-mini",
			"openai/gpt-4-turbo",
			"openai/o3",
			"anthropic/claude-3.5-sonnet",
			"anthropic/claude-4-opus",
			"google/gemini-2.5-pro",
		];
		resetFuzzyIndexCache();
		const cold = fuzzyRank(items, "gpt 4o", item => item).map(result => result.item);
		// Second pass reuses the now-cached per-text indices; the result must be byte-for-byte identical.
		const warm = fuzzyRank(items, "gpt 4o", item => item).map(result => result.item);
		expect(warm).toEqual(cold);
	});

	it("matches long candidate texts (cache bypass) deterministically", () => {
		const longText = `openai/gpt-4o ${"x".repeat(5000)}`;
		resetFuzzyIndexCache();
		const first = fuzzyMatch("gpt4", longText);
		const second = fuzzyMatch("gpt4", longText);
		expect(first).toEqual(second);
		expect(first.matches).toBe(true);
	});
});

describe("fuzzyRank empty-normalized query", () => {
	it("still calls getText for every item when the query normalizes to empty", () => {
		const seen: string[] = [];
		const items = ["alpha", "beta", "gamma"];
		const out = fuzzyRank(items, "!!!", item => {
			seen.push(item);
			return item;
		});
		// A non-blank query that normalizes to empty matches everything with score 0,
		// and must still invoke getText per item (preserving callback side effects).
		expect(seen).toEqual(items);
		expect(out.map(result => result.item)).toEqual(items);
		expect(out.every(result => result.score === 0)).toBe(true);
	});
});
