import { describe, expect, it } from "bun:test";
import type { AuthAccountPolicy, ExtraUsageAllowance, UsageFundingTier } from "../src/auth/types";
import {
	assessFunding,
	currentUsageLimits,
	fundingTierAllowed,
	fundingTierRank,
	type FundingAssessment,
} from "../src/auth/usage-report";
import type { CredentialRankingStrategy, ExtraUsageState, UsageLimit, UsageReport } from "../src/usage";
import { ExtraUsageWithheldError, isExtraUsageWithheldMessage, isUsageLimit } from "../src/error";

const NOW = 1_700_000_000_000;
const RESET_AT = NOW + 60_000;

type ExtraUsagePolicy = Pick<AuthAccountPolicy, "extraUsageFloor" | "extraUsageBudget">;

function usageReport(usedFraction: number): UsageReport {
	const limit: UsageLimit = {
		id: "plan",
		label: "Plan allowance",
		scope: { provider: "anthropic" },
		window: { id: "plan", label: "Plan allowance", resetsAt: RESET_AT },
		amount: { usedFraction, unit: "percent" },
		status: usedFraction >= 1 ? "exhausted" : "ok",
	};
	return { provider: "anthropic", fetchedAt: NOW, limits: [limit] };
}

function extraState(overrides: Partial<ExtraUsageState> = {}): ExtraUsageState {
	return {
		enabled: true,
		exhausted: false,
		unit: "usd",
		used: 5,
		remaining: 50,
		uncapped: false,
		capacity: "spend-cap",
		limitId: "extra",
		...overrides,
	};
}

function strategy(extraUsage?: ExtraUsageState): CredentialRankingStrategy {
	const result: CredentialRankingStrategy = {
		findWindowLimits: report => ({ primary: report.limits[0] }),
		scopeLimits: report => report.limits,
		windowDefaults: { primaryMs: 60_000, secondaryMs: 60_000 },
	};
	if (extraUsage !== undefined) result.extraUsage = () => extraUsage;
	return result;
}

interface FundingCase {
	name: string;
	report: UsageReport | null;
	strategy?: CredentialRankingStrategy;
	policy?: ExtraUsagePolicy;
	extraUsageBlockedUntil?: number;
	expected: FundingAssessment | undefined;
}

const cases: readonly FundingCase[] = [
	{
		name: "fails open when the usage report is unknown",
		report: null,
		expected: undefined,
	},
	{
		name: "keeps an account with plan allowance in the allowance tier",
		report: usageReport(0.5),
		strategy: strategy(extraState({ enabled: false })),
		expected: { tier: "allowance", extra: "unavailable" },
	},
	{
		name: "keeps uncapped paid usage available below its budget",
		report: usageReport(1),
		strategy: strategy(extraState({ uncapped: true, used: 399, remaining: undefined })),
		policy: { extraUsageBudget: 400 },
		expected: { tier: "extra", extra: "available", allowanceResetsAt: RESET_AT },
	},
	{
		name: "moves uncapped paid usage past its budget into the floor tier",
		report: usageReport(1),
		strategy: strategy(extraState({ uncapped: true, used: 400, remaining: undefined })),
		policy: { extraUsageBudget: 400 },
		expected: { tier: "extra-past-floor", extra: "past-floor", allowanceResetsAt: RESET_AT },
	},
	{
		name: "moves capped paid usage at or below its floor into the floor tier",
		report: usageReport(1),
		strategy: strategy(extraState({ remaining: 5 })),
		policy: { extraUsageFloor: 10 },
		expected: { tier: "extra-past-floor", extra: "past-floor", allowanceResetsAt: RESET_AT },
	},
	{
		name: "fails closed when a capped account cannot report remaining capacity for its floor",
		report: usageReport(1),
		strategy: strategy(extraState({ remaining: undefined })),
		policy: { extraUsageFloor: 10 },
		expected: { tier: "extra-past-floor", extra: "past-floor", allowanceResetsAt: RESET_AT },
	},
	{
		name: "treats a live extra-usage block as spent",
		report: usageReport(1),
		strategy: strategy(extraState()),
		extraUsageBlockedUntil: NOW + 1,
		expected: { tier: "spent", extra: "unavailable", allowanceResetsAt: RESET_AT },
	},
	{
		name: "treats a missing paid-usage state as spent",
		report: usageReport(1),
		strategy: strategy(),
		expected: { tier: "spent", extra: "unavailable", allowanceResetsAt: RESET_AT },
	},
	{
		name: "treats disabled paid usage as spent",
		report: usageReport(1),
		strategy: strategy(extraState({ enabled: false })),
		expected: { tier: "spent", extra: "unavailable", allowanceResetsAt: RESET_AT },
	},
	{
		name: "treats exhausted paid usage as spent",
		report: usageReport(1),
		strategy: strategy(extraState({ exhausted: true })),
		expected: { tier: "spent", extra: "unavailable", allowanceResetsAt: RESET_AT },
	},
	{
		name: "treats capped paid usage with no remaining capacity as spent",
		report: usageReport(1),
		strategy: strategy(extraState({ remaining: 0 })),
		expected: { tier: "spent", extra: "unavailable", allowanceResetsAt: RESET_AT },
	},
	{
		name: "fails closed when a budget cannot read period spend",
		report: usageReport(1),
		strategy: strategy(extraState({ used: undefined })),
		policy: { extraUsageBudget: 10 },
		expected: { tier: "extra-past-floor", extra: "past-floor", allowanceResetsAt: RESET_AT },
	},
];

describe("assessFunding", () => {
	for (const testCase of cases) {
		it(testCase.name, () => {
			expect(
				assessFunding({
					report: testCase.report,
					strategy: testCase.strategy,
					context: { modelId: "claude-sonnet" },
					nowMs: NOW,
					policy: testCase.policy,
					extraUsageBlockedUntil: testCase.extraUsageBlockedUntil,
				}),
			).toEqual(testCase.expected);
		});
	}
});

describe("funding tier helpers", () => {
	it("orders allowance, paid usage, floor-held usage, and spent capacity", () => {
		const tiers: Array<UsageFundingTier | undefined> = [undefined, "allowance", "extra", "extra-past-floor", "spent"];
		expect(tiers.map(fundingTierRank)).toEqual([0, 0, 1, 2, 3]);
	});

	it("withholds only below-floor paid usage when the caller stops at the floor", () => {
		const toFloor: ExtraUsageAllowance = "to-floor";
		expect(fundingTierAllowed("extra-past-floor", toFloor)).toBe(false);
		expect(fundingTierAllowed("extra-past-floor", "past-floor")).toBe(true);
		expect(fundingTierAllowed("spent", toFloor)).toBe(true);
	});
});

describe("current funding windows", () => {
	it("A4 derives a Codex allowance reset from a credit-funded warning window", () => {
		const report = usageReport(1);
		report.limits[0] = { ...report.limits[0], status: "warning" };

		expect(
			assessFunding({
				report,
				strategy: strategy(extraState({ unit: "credits", used: undefined, remaining: 120 })),
				context: {},
				nowMs: NOW,
				policy: { extraUsageFloor: 200 },
			}),
		).toEqual({
			tier: "extra-past-floor",
			extra: "past-floor",
			allowanceResetsAt: RESET_AT,
		});
	});

	it("A6 ignores expired windows fetched before their reset but keeps fresh post-reset reports conservative", () => {
		const expiredResetAt = NOW - 60_000;
		const stale = usageReport(1);
		stale.fetchedAt = NOW - 10 * 60_000;
		stale.limits[0] = {
			...stale.limits[0],
			window: { id: "plan", label: "Plan allowance", resetsAt: expiredResetAt },
		};
		const paidAtFloor = strategy(extraState({ remaining: 5 }));

		expect(currentUsageLimits(stale.limits, stale.fetchedAt, NOW)).toEqual([]);
		expect(
			assessFunding({
				report: stale,
				strategy: paidAtFloor,
				context: {},
				nowMs: NOW,
				policy: { extraUsageFloor: 10 },
			}),
		).toEqual({ tier: "allowance", extra: "unavailable" });

		const refreshed = { ...stale, fetchedAt: NOW };
		expect(currentUsageLimits(refreshed.limits, refreshed.fetchedAt, NOW)).toEqual(refreshed.limits);
		expect(
			assessFunding({
				report: refreshed,
				strategy: paidAtFloor,
				context: {},
				nowMs: NOW,
				policy: { extraUsageFloor: 10 },
			}),
		).toMatchObject({ tier: "extra-past-floor", extra: "past-floor" });
	});
});

describe("ExtraUsageWithheldError", () => {
	it("routes withheld paid usage through the usage-limit classifier", () => {
		const error = new ExtraUsageWithheldError("anthropic", Date.now() + 10_000);

		expect(error.message).toMatch(
			/^Extra usage withheld: usage limit reached for anthropic: plan allowance is spent on every account and paid extra usage is at its floor retry-after-ms=\d+$/,
		);
		expect(isExtraUsageWithheldMessage({ errorMessage: error.message })).toBe(true);
		expect(isUsageLimit(error)).toBe(true);
		expect(isUsageLimit({ errorMessage: error.message })).toBe(true);
	});
});
