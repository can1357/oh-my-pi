/**
 * Contract tests for `resolveUsedFraction` — the shared helper that resolves a
 * used fraction (0..1) from whichever `UsageAmount` fields a provider populated.
 *
 * Precedence (from usage.ts): explicit fraction > used/limit > percent+used >
 * inverted remaining. The `remainingFraction` fallback was missing from the
 * TUI's local copy (PR #3317) — these tests pin all four paths so that
 * regression can't silently drop a case again.
 */
import { describe, expect, it } from "bun:test";
import { resolveUsedFraction, type UsageLimit } from "@oh-my-pi/pi-ai";

function makeLimit(amount: UsageLimit["amount"]): UsageLimit {
	return {
		id: "test",
		label: "Test limit",
		scope: { provider: "test" },
		amount,
	};
}

describe("resolveUsedFraction", () => {
	it("returns the explicit usedFraction when present, ignoring all other fields", () => {
		const limit = makeLimit({
			usedFraction: 0.75,
			used: 50,
			limit: 100,
			remainingFraction: 0.5,
			unit: "tokens",
		});
		expect(resolveUsedFraction(limit)).toBe(0.75);
	});

	it("computes used / limit when usedFraction is absent and limit > 0", () => {
		const limit = makeLimit({ used: 30, limit: 120, unit: "tokens" });
		expect(resolveUsedFraction(limit)).toBeCloseTo(0.25);
	});

	it("falls back to percent+used when used/limit is skipped because limit is 0", () => {
		const limit = makeLimit({ used: 5, limit: 0, unit: "percent" });
		// limit === 0 skips used/limit; percent+used should apply
		expect(resolveUsedFraction(limit)).toBe(0.05);
	});

	it("computes used / 100 for percent-unit amounts without usedFraction or used/limit", () => {
		const limit = makeLimit({ used: 84, unit: "percent" });
		expect(resolveUsedFraction(limit)).toBe(0.84);
	});

	it("does not use percent+used when unit is not percent", () => {
		const limit = makeLimit({ used: 84, unit: "tokens" });
		// Should fall through to remainingFraction or undefined
		expect(resolveUsedFraction(limit)).toBeUndefined();
	});

	it("computes 1 - remainingFraction when no other fields resolve", () => {
		const limit = makeLimit({ remainingFraction: 0.3, unit: "usd" });
		expect(resolveUsedFraction(limit)).toBeCloseTo(0.7);
	});

	it("clamps the remainingFraction fallback to 0 (no negative fractions)", () => {
		const limit = makeLimit({ remainingFraction: 1.5, unit: "usd" });
		expect(resolveUsedFraction(limit)).toBe(0);
	});

	it("returns undefined when no resolvable fields are populated", () => {
		const limit = makeLimit({ unit: "unknown" });
		expect(resolveUsedFraction(limit)).toBeUndefined();
	});

	it("preserves overage: usedFraction > 1 is returned as-is", () => {
		const limit = makeLimit({ usedFraction: 1.25, unit: "tokens" });
		expect(resolveUsedFraction(limit)).toBe(1.25);
	});

	it("returns 1 when remainingFraction is 0 (fully used)", () => {
		const limit = makeLimit({ remainingFraction: 0, unit: "requests" });
		expect(resolveUsedFraction(limit)).toBe(1);
	});

	it("precedence: usedFraction beats remainingFraction even when both are set", () => {
		const limit = makeLimit({ usedFraction: 0.4, remainingFraction: 0.4, unit: "tokens" });
		expect(resolveUsedFraction(limit)).toBe(0.4);
	});

	it("precedence: used/limit beats remainingFraction", () => {
		const limit = makeLimit({ used: 10, limit: 200, remainingFraction: 0.9, unit: "tokens" });
		expect(resolveUsedFraction(limit)).toBeCloseTo(0.05);
	});
});
