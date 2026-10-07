/**
 * Contract tests for the limit-reading helpers in `usage.ts`:
 * `resolveUsedFraction` (which `UsageAmount` fields decide a fraction) and the
 * status contract (`usageStatus`, `resolveUsageStatus`, `resolveLimitStatus`,
 * `aggregateUsageStatus`) that every surface classifies limits through.
 *
 * Fraction precedence: explicit fraction > used/limit > percent+used > inverted
 * remaining. The `remainingFraction` fallback was missing from the TUI's local
 * copy (PR #3317) — these tests pin all four paths so that regression can't
 * silently drop a case again.
 *
 * Status precedence: an explicit non-`unknown` status > used fraction >
 * absolute remaining > `unknown`. `unknown` in the enum means "not reported",
 * which is why it is treated as absent rather than as a verdict — the same
 * reading `AuthStorage`'s exhaustion check uses.
 */
import { describe, expect, it } from "bun:test";
import {
	aggregateUsageStatus,
	aggregateUsageStatuses,
	resolveLimitStatus,
	resolveUsageStatus,
	resolveUsedFraction,
	usageStatus,
	type UsageLimit,
	type UsageStatus,
} from "@oh-my-pi/pi-ai";

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

	it("precedence: used/limit beats remainingFraction", () => {
		const limit = makeLimit({ used: 10, limit: 200, remainingFraction: 0.9, unit: "tokens" });
		expect(resolveUsedFraction(limit)).toBeCloseTo(0.05);
	});
});

function statusLimit(amount: UsageLimit["amount"], status?: UsageStatus): UsageLimit {
	return { ...makeLimit(amount), ...(status === undefined ? {} : { status }) };
}

describe("usageStatus", () => {
	it("maps the used fraction to the shared warning boundary", () => {
		expect(usageStatus(undefined)).toBe("unknown");
		expect(usageStatus(0)).toBe("ok");
		expect(usageStatus(0.79)).toBe("ok");
		expect(usageStatus(0.9)).toBe("warning");
		expect(usageStatus(0.99)).toBe("warning");
		expect(usageStatus(1)).toBe("exhausted");
		expect(usageStatus(1.25)).toBe("exhausted");
	});

	it("honors a caller's earlier warning boundary", () => {
		expect(usageStatus(0.85, 0.8)).toBe("warning");
		expect(usageStatus(0.85)).toBe("ok");
	});

	it("reports missing data as unknown rather than healthy", () => {
		expect(usageStatus(undefined)).toBe("unknown");
	});
});

describe("resolveUsageStatus", () => {
	it("lets an explicit status win except when the meter proves exhaustion", () => {
		expect(resolveUsageStatus({ status: "exhausted", usedFraction: 0 })).toBe("exhausted");
		expect(resolveUsageStatus({ status: "ok", usedFraction: 1 })).toBe("exhausted");
		expect(resolveUsageStatus({ status: "warning", usedFraction: 1 })).toBe("exhausted");
		expect(resolveUsageStatus({ status: "warning", usedFraction: 0.1 })).toBe("warning");
	});

	it("treats an explicit unknown as unreported and infers from the fraction", () => {
		// The dismissed review finding: a provider that reports both `unknown`
		// and a spent fraction must not read as unknown on any surface.
		expect(resolveUsageStatus({ status: "unknown", usedFraction: 1 })).toBe("exhausted");
		expect(resolveUsageStatus({ status: "unknown", usedFraction: 0.95 })).toBe("warning");
		expect(resolveUsageStatus({ status: "unknown" })).toBe("unknown");
	});

	it("infers from an absolute remaining balance only when no fraction exists", () => {
		expect(resolveUsageStatus({ remaining: 100 })).toBe("ok");
		expect(resolveUsageStatus({ remaining: 0 })).toBe("exhausted");
		expect(resolveUsageStatus({ usedFraction: 0.5, remaining: 0 })).toBe("ok");
	});

	it("returns unknown when nothing was reported", () => {
		expect(resolveUsageStatus({})).toBe("unknown");
	});
});

describe("resolveLimitStatus", () => {
	it("derives the fraction from the limit's amount fields", () => {
		expect(resolveLimitStatus(statusLimit({ usedFraction: 1, unit: "percent" }))).toBe("exhausted");
		expect(resolveLimitStatus(statusLimit({ used: 90, limit: 100, unit: "tokens" }))).toBe("warning");
		expect(resolveLimitStatus(statusLimit({ used: 84, unit: "percent" }))).toBe("ok");
		expect(resolveLimitStatus(statusLimit({ remainingFraction: 0, unit: "requests" }))).toBe("exhausted");
	});

	it("falls back to a remaining-only balance", () => {
		expect(resolveLimitStatus(statusLimit({ remaining: 12, unit: "credits" }))).toBe("ok");
		expect(resolveLimitStatus(statusLimit({ remaining: 0, unit: "credits" }))).toBe("exhausted");
	});

	it("keeps a provider's own status", () => {
		expect(resolveLimitStatus(statusLimit({ usedFraction: 0.2, unit: "percent" }, "warning"))).toBe("warning");
	});
});

describe("aggregateUsageStatus", () => {
	it("reads a mixed group as warning, not as its worst member", () => {
		expect(aggregateUsageStatuses(["ok"])).toBe("ok");
		expect(aggregateUsageStatuses(["ok", "ok"])).toBe("ok");
		expect(aggregateUsageStatuses(["ok", "warning"])).toBe("warning");
		expect(aggregateUsageStatuses(["ok", "exhausted"])).toBe("warning");
		expect(aggregateUsageStatuses(["warning", "exhausted"])).toBe("warning");
		expect(aggregateUsageStatuses(["warning"])).toBe("warning");
		expect(aggregateUsageStatuses(["exhausted"])).toBe("exhausted");
		expect(aggregateUsageStatuses(["unknown"])).toBe("unknown");
		expect(aggregateUsageStatuses([])).toBe("unknown");
	});

	it("resolves each limit before aggregating, so omitted statuses still count", () => {
		const limits = [
			statusLimit({ usedFraction: 0.1, unit: "percent" }),
			statusLimit({ usedFraction: 1, unit: "percent" }),
		];
		expect(aggregateUsageStatus(limits)).toBe("warning");
		expect(aggregateUsageStatus([statusLimit({ usedFraction: 1, unit: "percent" })])).toBe("exhausted");
	});
});
