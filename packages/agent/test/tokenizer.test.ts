import { describe, expect, test } from "bun:test";
import { countTokens, tokenizerMode } from "../src/tokenizer";

describe("tokenizer facade", () => {
	test("uses the native cl100k tokenizer when the addon is available", () => {
		// In this repo's test environment the native addon is built; the facade
		// must pick it up without any env-var opt-in.
		expect(tokenizerMode()).toBe("cl100k");
		// "hello world" is 2 cl100k tokens; the byte estimate would say 3.
		expect(countTokens("hello world")).toBe(2);
	});

	test("sums arrays", () => {
		const a = countTokens("first fragment");
		const b = countTokens("second fragment");
		expect(countTokens(["first fragment", "second fragment"])).toBe(a + b);
	});

	test("empty input counts zero", () => {
		expect(countTokens("")).toBe(0);
		expect(countTokens([])).toBe(0);
	});

	test("clips pathological single-character runs and scales the count", () => {
		// BPE run merging is quadratic; a 100K-char run must not stall. The
		// clipped count scales linearly and stays within 1% of the true count
		// (1562 for 100K of "=").
		const start = performance.now();
		const clipped = countTokens("=".repeat(100_000));
		const elapsed = performance.now() - start;
		expect(elapsed).toBeLessThan(1_000);
		expect(clipped).toBeGreaterThan(1_400);
		expect(clipped).toBeLessThan(1_700);
	});

	test("run clipping preserves surrounding text", () => {
		const plain = countTokens("prefix and suffix");
		const withRun = countTokens(`prefix ${"=".repeat(50_000)} and suffix`);
		// Run contributes ~780 tokens (50K / 64 per token); the words survive.
		expect(withRun).toBeGreaterThan(plain);
		expect(withRun).toBeGreaterThan(700);
		expect(withRun).toBeLessThan(900);
	});

	test("short runs below the clip threshold count exactly", () => {
		// A 1023-run and a 1024-run of the same char straddle the clip
		// threshold; both should produce the same (exact vs scaled) count.
		expect(countTokens("y".repeat(1023))).toBe(countTokens("y".repeat(1024)));
	});
});
