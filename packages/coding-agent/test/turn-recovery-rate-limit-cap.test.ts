import { describe, expect, it } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { isRotatableRateLimitCap } from "@oh-my-pi/pi-coding-agent/session/turn-recovery";

const MAX_DELAY_MS = 300_000;
const transient = AIError.create(AIError.Flag.Transient);
const usageLimit = AIError.create(AIError.Flag.UsageLimit);
const usageLimitTransient = AIError.create(AIError.Flag.UsageLimit, AIError.Flag.Transient);
const authFailed = AIError.create(AIError.Flag.AuthFailed);

describe("isRotatableRateLimitCap", () => {
	it("routes a transient rate-limit whose retry-after exceeds maxDelayMs into rotation", () => {
		// Anthropic tier weekly caps surface as a generic `rate_limit_error`
		// (classified Transient) with a multi-hour retry-after.
		expect(isRotatableRateLimitCap(transient, 60_690_000, MAX_DELAY_MS)).toBe(true);
	});

	it("leaves a genuine per-minute rate-limit as transient shed-and-backoff", () => {
		expect(isRotatableRateLimitCap(transient, 30_000, MAX_DELAY_MS)).toBe(false);
	});

	it("does not fire at exactly maxDelayMs (strictly greater)", () => {
		expect(isRotatableRateLimitCap(transient, MAX_DELAY_MS, MAX_DELAY_MS)).toBe(false);
	});

	it("does not fire without a parsed retry-after", () => {
		expect(isRotatableRateLimitCap(transient, undefined, MAX_DELAY_MS)).toBe(false);
	});

	it("defers to the existing usage-limit path when already flagged UsageLimit", () => {
		expect(isRotatableRateLimitCap(usageLimit, 60_690_000, MAX_DELAY_MS)).toBe(false);
		expect(isRotatableRateLimitCap(usageLimitTransient, 60_690_000, MAX_DELAY_MS)).toBe(false);
	});

	it("ignores non-transient errors", () => {
		expect(isRotatableRateLimitCap(authFailed, 60_690_000, MAX_DELAY_MS)).toBe(false);
		expect(isRotatableRateLimitCap(0, 60_690_000, MAX_DELAY_MS)).toBe(false);
	});

	it("is disabled when maxDelayMs is non-positive", () => {
		expect(isRotatableRateLimitCap(transient, 60_690_000, 0)).toBe(false);
	});
});
