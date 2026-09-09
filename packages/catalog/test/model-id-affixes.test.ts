import { describe, expect, test } from "bun:test";
import {
	getBracketStrippedModelIdCandidates,
	getLongestModelLikeIdSegment,
	getModelLikeIdSegments,
	stripBracketedModelIdAffixes,
} from "@oh-my-pi/pi-catalog/identity/id";

describe("getModelLikeIdSegments", () => {
	test("keeps only family-prefixed segments that carry a digit, deduped", () => {
		expect(getModelLikeIdSegments("openrouter/anthropic/claude-3.5-sonnet")).toEqual(["claude-3.5-sonnet"]);
		// `random-text` lacks a family prefix; `claude` (no digit) is dropped.
		expect(getModelLikeIdSegments("random-text claude gemini-2")).toEqual(["gemini-2"]);
	});

	test("orders longest first with lexicographic tie-break", () => {
		expect(getModelLikeIdSegments("claude-3 claude-3-5-haiku claude-2")).toEqual([
			"claude-3-5-haiku",
			"claude-2",
			"claude-3",
		]);
	});

	test("normalizes whitespace and case before matching", () => {
		expect(getModelLikeIdSegments("  GLM-4.5-Air   GEMINI-2  ")).toEqual(["glm-4.5-air", "gemini-2"]);
	});

	test("returns empty for ids with no model-like segment", () => {
		expect(getModelLikeIdSegments("")).toEqual([]);
		expect(getModelLikeIdSegments("just some words")).toEqual([]);
	});
});

describe("getLongestModelLikeIdSegment", () => {
	test("matches getModelLikeIdSegments[0]", () => {
		const id = "[Kiro] claude-3 claude-3-5-sonnet";
		expect(getLongestModelLikeIdSegment(id)).toBe(getModelLikeIdSegments(id)[0]);
		expect(getLongestModelLikeIdSegment(id)).toBe("claude-3-5-sonnet");
	});

	test("is undefined when nothing matches", () => {
		expect(getLongestModelLikeIdSegment("vendor/unknown-tag")).toBeUndefined();
	});
});

describe("getBracketStrippedModelIdCandidates", () => {
	test("no brackets yields no candidates", () => {
		expect(getBracketStrippedModelIdCandidates("claude-opus-4-8")).toEqual([]);
	});

	test("strips leading reseller tag", () => {
		expect(getBracketStrippedModelIdCandidates("[Kiro] claude-opus-4-8")).toEqual(["claude-opus-4-8"]);
	});

	test("strips both ends first, then each side, in preference order", () => {
		expect(getBracketStrippedModelIdCandidates("[gcli转] gemini-3.1-pro-preview [假流]")).toEqual([
			"gemini-3.1-pro-preview",
			"gemini-3.1-pro-preview [假流]",
			"[gcli转] gemini-3.1-pro-preview",
		]);
	});

	test("supports full-width brackets", () => {
		expect(stripBracketedModelIdAffixes("【供应商】 deepseek-v3 【限时】")).toBe("deepseek-v3");
	});
});
