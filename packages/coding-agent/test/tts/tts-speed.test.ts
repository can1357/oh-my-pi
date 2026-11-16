import { describe, expect, test } from "bun:test";
import { resolveTtsSpeed, TTS_LOCAL_MODELS, ttsDurationDelta } from "../../src/tts/models";

describe("resolveTtsSpeed", () => {
	test("passes in-range rates through and clamps out-of-range ones to the band edges", () => {
		expect(resolveTtsSpeed(1.1)).toBe(1.1);
		expect(resolveTtsSpeed(0.1)).toBe(0.8);
		expect(resolveTtsSpeed(0)).toBe(0.8);
		expect(resolveTtsSpeed(-2)).toBe(0.8);
		expect(resolveTtsSpeed(9)).toBe(1.3);
	});

	test("maps speed onto the duration_delta curve, clamped to its endpoints", () => {
		const spec = TTS_LOCAL_MODELS[0]!;
		expect(ttsDurationDelta(spec, 0.5)).toBe(0.5);
		expect(ttsDurationDelta(spec, 2)).toBe(-0.5);
		expect(ttsDurationDelta(spec, 1)).toBe(0);
		expect(ttsDurationDelta(spec, 1.04)).toBeCloseTo(-0.05, 10);
	});

	test("falls back to normal speed for missing or non-finite rates", () => {
		expect(resolveTtsSpeed(undefined)).toBe(1);
		expect(resolveTtsSpeed(Number.NaN)).toBe(1);
		expect(resolveTtsSpeed(Number.POSITIVE_INFINITY)).toBe(1);
	});
});
