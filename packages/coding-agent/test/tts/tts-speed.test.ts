import { describe, expect, test } from "bun:test";
import { resolveTtsSpeed } from "../../src/tts/models";

describe("resolveTtsSpeed", () => {
	test("passes in-range rates through and clamps out-of-range ones to the band edges", () => {
		expect(resolveTtsSpeed(1.3)).toBe(1.3);
		expect(resolveTtsSpeed(0.1)).toBe(0.5);
		expect(resolveTtsSpeed(0)).toBe(0.5);
		expect(resolveTtsSpeed(-2)).toBe(0.5);
		expect(resolveTtsSpeed(9)).toBe(2.5);
	});

	test("falls back to normal speed for missing or non-finite rates", () => {
		expect(resolveTtsSpeed(undefined)).toBe(1);
		expect(resolveTtsSpeed(Number.NaN)).toBe(1);
		expect(resolveTtsSpeed(Number.POSITIVE_INFINITY)).toBe(1);
	});
});
