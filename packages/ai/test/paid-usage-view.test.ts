import { describe, expect, it } from "bun:test";
import type { AuthAccountPolicy, PaidUsageView } from "../src/auth/types";
import { classifyExtraUsage, describePaidUsage } from "../src/auth/usage-report";
import type { CredentialRankingStrategy, ExtraUsageState, UsageReport } from "../src/usage";
import { claudeRankingStrategy, parseClaudeUsagePayload } from "../src/usage/claude";
import { codexRankingStrategy, openaiCodexUsageProvider } from "../src/usage/openai-codex";
import type { FetchImpl } from "../src/types";

const NOW = Date.parse("2030-01-01T00:00:00.000Z");
const HOUR_MS = 60 * 60_000;
type PaidPolicy = Pick<AuthAccountPolicy, "extraUsageFloor" | "extraUsageBudget">;

function money(amount: number): { amount_minor: number; currency: "USD"; exponent: 2 } {
	return { amount_minor: Math.round(amount * 100), currency: "USD", exponent: 2 };
}

function claudeReport(args: {
	used?: number;
	cap?: number | null;
	enabled?: boolean;
	fetchedAt?: number;
}): UsageReport {
	const payload: Record<string, unknown> = {
		five_hour: { utilization: 100, resets_at: new Date(NOW + HOUR_MS).toISOString() },
		seven_day: { utilization: 100, resets_at: new Date(NOW + 7 * 24 * HOUR_MS).toISOString() },
	};
	if (args.enabled !== undefined || args.used !== undefined) {
		payload.spend = {
			enabled: args.enabled ?? true,
			used: money(args.used ?? 0),
			limit: args.cap === null || args.cap === undefined ? null : money(args.cap),
		};
	}
	const report = parseClaudeUsagePayload(
		payload,
		{ accountId: "claude-account" },
		"https://api.anthropic.com/api/oauth/usage",
		args.fetchedAt ?? NOW,
	);
	if (!report) throw new Error("Expected Claude usage report");
	return report;
}

async function codexReport(credits: Record<string, unknown> | undefined): Promise<UsageReport> {
	const payload: Record<string, unknown> = {
		plan_type: "pro",
		rate_limit: {
			allowed: false,
			limit_reached: true,
			primary_window: { used_percent: 100, limit_window_seconds: 3_600, reset_after_seconds: 3_600 },
			secondary_window: null,
		},
		additional_rate_limits: [],
		...(credits === undefined ? {} : { credits }),
		spend_control: { reached: false },
	};
	const fetchImpl = (async () =>
		new Response(JSON.stringify(payload), {
			status: 200,
			headers: { "content-type": "application/json" },
		})) as unknown as FetchImpl;
	const report = await openaiCodexUsageProvider.fetchUsage(
		{
			provider: "openai-codex",
			credential: { type: "oauth", accessToken: "test-token", accountId: "codex-account" },
		},
		{ fetch: fetchImpl },
	);
	if (!report) throw new Error("Expected Codex usage report");
	return report;
}

function paidView(args: {
	strategy: CredentialRankingStrategy;
	report: UsageReport;
	policy?: PaidPolicy;
	extraUsageBlockedUntil?: number;
	nowMs?: number;
}): PaidUsageView | undefined {
	return describePaidUsage({
		strategy: args.strategy,
		report: args.report,
		policy: args.policy,
		extraUsageBlockedUntil: args.extraUsageBlockedUntil,
		nowMs: args.nowMs ?? NOW,
	});
}

function requireView(view: PaidUsageView | undefined): PaidUsageView {
	if (!view) throw new Error("Expected paid usage view");
	return view;
}

describe("describePaidUsage", () => {
	it("1 reports capped Anthropic spend-cap headroom", () => {
		const view = requireView(
			paidView({ strategy: claudeRankingStrategy, report: claudeReport({ used: 190.74, cap: 200 }) }),
		);
		expect(view).toMatchObject({
			limitId: "anthropic:extra",
			unit: "usd",
			capacity: "spend-cap",
			state: "available",
			cap: 200,
			uncapped: false,
			boundBy: "provider",
			unbounded: false,
			asOf: NOW,
			stale: false,
		});
		expect(view.remaining).toBeCloseTo(9.26, 10);
		expect(view.headroom).toBeCloseTo(9.26, 10);
	});

	it("2 holds capped Anthropic spend at its floor", () => {
		const view = requireView(
			paidView({
				strategy: claudeRankingStrategy,
				report: claudeReport({ used: 190.74, cap: 200 }),
				policy: { extraUsageFloor: 10 },
			}),
		);
		expect(view).toMatchObject({ state: "past-floor", stop: "floor", floor: 10, floorIgnored: false, headroom: 0 });
	});

	it("3 reports an uncapped Anthropic budget", () => {
		const view = requireView(
			paidView({
				strategy: claudeRankingStrategy,
				report: claudeReport({ used: 350, cap: null }),
				policy: { extraUsageBudget: 400 },
			}),
		);
		expect(view).toMatchObject({
			state: "available",
			used: 350,
			uncapped: true,
			budget: 400,
			budgetLeft: 50,
			headroom: 50,
			boundBy: "budget",
			unbounded: false,
		});
	});

	it("4 holds an uncapped Anthropic account at its budget", () => {
		const view = requireView(
			paidView({
				strategy: claudeRankingStrategy,
				report: claudeReport({ used: 402.88, cap: null }),
				policy: { extraUsageBudget: 400 },
			}),
		);
		expect(view).toMatchObject({ state: "past-floor", stop: "budget", budgetLeft: 0, headroom: 0 });
	});

	it("5 leaves uncapped Anthropic spend unbounded without a policy", () => {
		const view = requireView(
			paidView({ strategy: claudeRankingStrategy, report: claudeReport({ used: 119.85, cap: null }) }),
		);
		expect(view).toMatchObject({ state: "available", used: 119.85, uncapped: true, unbounded: true });
		expect(view.headroom).toBeUndefined();
	});

	it("6 marks an uncapped floor as ignored", () => {
		const view = requireView(
			paidView({
				strategy: claudeRankingStrategy,
				report: claudeReport({ used: 119.85, cap: null }),
				policy: { extraUsageFloor: 10 },
			}),
		);
		expect(view).toMatchObject({ state: "available", floor: 10, floorIgnored: true, unbounded: true });
	});

	it("7 binds capped Anthropic spend by its floor before its budget", () => {
		const view = requireView(
			paidView({
				strategy: claudeRankingStrategy,
				report: claudeReport({ used: 150, cap: 200 }),
				policy: { extraUsageFloor: 10, extraUsageBudget: 400 },
			}),
		);
		expect(view).toMatchObject({
			state: "available",
			remaining: 50,
			floor: 10,
			budgetLeft: 250,
			headroom: 40,
			boundBy: "floor",
		});
	});

	it("8 binds capped Anthropic spend by its tighter budget", () => {
		const view = requireView(
			paidView({
				strategy: claudeRankingStrategy,
				report: claudeReport({ used: 150, cap: 200 }),
				policy: { extraUsageFloor: 10, extraUsageBudget: 160 },
			}),
		);
		expect(view).toMatchObject({ state: "available", budgetLeft: 10, headroom: 10, boundBy: "budget" });
	});

	it("9 reports Codex balance headroom above its floor", async () => {
		const report = await codexReport({ has_credits: true, balance: "489.25" });
		const view = requireView(
			paidView({
				strategy: codexRankingStrategy,
				report,
				policy: { extraUsageFloor: 200 },
				nowMs: report.fetchedAt,
			}),
		);
		expect(view).toMatchObject({
			limitId: "openai-codex:credits",
			unit: "credits",
			capacity: "balance",
			state: "available",
			remaining: 489.25,
			floor: 200,
			headroom: 289.25,
			boundBy: "floor",
		});
	});

	it("10 reports unlimited Codex credits as unbounded", async () => {
		const report = await codexReport({ has_credits: false, unlimited: true });
		const view = requireView(paidView({ strategy: codexRankingStrategy, report, nowMs: report.fetchedAt }));
		expect(view).toMatchObject({ state: "available", uncapped: true, unbounded: true, capacity: "balance" });
		expect(view.headroom).toBeUndefined();
	});

	it("11 reports Codex without credits as disabled", async () => {
		const report = await codexReport({ has_credits: false });
		const view = requireView(paidView({ strategy: codexRankingStrategy, report, nowMs: report.fetchedAt }));
		expect(view).toMatchObject({
			state: "unavailable",
			stop: "disabled",
			unit: "credits",
			capacity: "balance",
			headroom: 0,
		});
		expect(view.limitId).toBeUndefined();
	});

	it("12 reports disabled Anthropic paid usage", () => {
		const view = requireView(
			paidView({
				strategy: claudeRankingStrategy,
				report: claudeReport({ enabled: false, used: 0, cap: null }),
				policy: { extraUsageFloor: 10 },
			}),
		);
		expect(view).toMatchObject({ state: "unavailable", stop: "disabled", floor: 10, headroom: 0 });
	});

	it("13 leaves missing paid fields unreported", () => {
		expect(paidView({ strategy: claudeRankingStrategy, report: claudeReport({}) })).toBeUndefined();
	});

	it("14 reports a reached Anthropic provider cap", () => {
		const view = requireView(
			paidView({ strategy: claudeRankingStrategy, report: claudeReport({ used: 200, cap: 200 }) }),
		);
		expect(view).toMatchObject({
			state: "unavailable",
			stop: "cap-reached",
			used: 200,
			cap: 200,
			remaining: 0,
			headroom: 0,
		});
	});

	it("15 reports an empty Codex balance as provider-capped", async () => {
		const report = await codexReport({ has_credits: true, balance: "0" });
		const view = requireView(paidView({ strategy: codexRankingStrategy, report, nowMs: report.fetchedAt }));
		expect(view).toMatchObject({ state: "unavailable", stop: "cap-reached", remaining: 0, headroom: 0 });
	});

	it("16 holds uncapped Anthropic spend at a zero budget", () => {
		const view = requireView(
			paidView({
				strategy: claudeRankingStrategy,
				report: claudeReport({ used: 5, cap: null }),
				policy: { extraUsageBudget: 0 },
			}),
		);
		expect(view).toMatchObject({ state: "past-floor", stop: "budget", budget: 0, budgetLeft: 0, headroom: 0 });
	});

	it("17 holds a Codex balance with an unreported remaining value", async () => {
		const report = await codexReport({ has_credits: true });
		const view = requireView(
			paidView({ strategy: codexRankingStrategy, report, policy: { extraUsageFloor: 50 }, nowMs: report.fetchedAt }),
		);
		expect(view).toMatchObject({ state: "past-floor", stop: "floor-unreported", floor: 50, headroom: 0 });
	});

	it("18 holds a Codex balance when its spend cannot satisfy a budget", async () => {
		const report = await codexReport({ has_credits: true, balance: "100" });
		const view = requireView(
			paidView({
				strategy: codexRankingStrategy,
				report,
				policy: { extraUsageBudget: 50 },
				nowMs: report.fetchedAt,
			}),
		);
		expect(view).toMatchObject({ state: "past-floor", stop: "budget-unreported", budget: 50, headroom: 0 });
	});

	it("19 reports a provider refusal and its block deadline", () => {
		const blockedUntil = NOW + 3 * HOUR_MS;
		const view = requireView(
			paidView({
				strategy: claudeRankingStrategy,
				report: claudeReport({ used: 100, cap: 200 }),
				extraUsageBlockedUntil: blockedUntil,
			}),
		);
		expect(view).toMatchObject({ state: "unavailable", stop: "refused", blockedUntil, headroom: 0 });
	});

	it("20 marks an old full payload stale", () => {
		const payloadFetchedAt = NOW - 2 * HOUR_MS;
		const view = requireView(
			paidView({
				strategy: claudeRankingStrategy,
				report: claudeReport({ used: 190.74, cap: 200, fetchedAt: payloadFetchedAt }),
			}),
		);
		expect(view).toMatchObject({ asOf: payloadFetchedAt, stale: true });
	});

	it("21 leaves age unknown after a header merge without a payload stamp", () => {
		const report = claudeReport({ used: 190.74, cap: 200 });
		const metadata: Record<string, unknown> = { ...report.metadata, headersUpdatedAt: NOW };
		delete metadata.payloadFetchedAt;
		report.metadata = metadata;
		const view = requireView(paidView({ strategy: claudeRankingStrategy, report }));
		expect(view.asOf).toBeUndefined();
		expect(view.stale).toBe(false);
	});

	it("22 preserves a recent full-payload age", () => {
		const payloadFetchedAt = NOW - 4 * 60_000;
		const view = requireView(
			paidView({
				strategy: claudeRankingStrategy,
				report: claudeReport({ used: 190.74, cap: 200, fetchedAt: payloadFetchedAt }),
			}),
		);
		expect(view).toMatchObject({ asOf: payloadFetchedAt, stale: false });
	});
});

describe("classifyExtraUsage", () => {
	const state: ExtraUsageState = {
		enabled: true,
		exhausted: false,
		unit: "usd",
		used: 5,
		remaining: 50,
		uncapped: false,
		capacity: "spend-cap",
		limitId: "anthropic:extra",
	};

	it("uses disabled, cap, refusal, floor, then budget stop order", () => {
		expect(classifyExtraUsage({ extraUsage: { ...state, enabled: false, exhausted: true }, nowMs: NOW })).toEqual({
			extra: "unavailable",
			stop: "disabled",
		});
		expect(
			classifyExtraUsage({
				extraUsage: { ...state, exhausted: true },
				extraUsageBlockedUntil: NOW + HOUR_MS,
				nowMs: NOW,
			}),
		).toEqual({ extra: "unavailable", stop: "cap-reached" });
		expect(
			classifyExtraUsage({
				extraUsage: { ...state, remaining: 0 },
				extraUsageBlockedUntil: NOW + HOUR_MS,
				nowMs: NOW,
			}),
		).toEqual({ extra: "unavailable", stop: "refused" });
		expect(
			classifyExtraUsage({ extraUsage: { ...state, remaining: 0 }, policy: { extraUsageFloor: 10 }, nowMs: NOW }),
		).toEqual({ extra: "unavailable", stop: "cap-reached" });
		expect(
			classifyExtraUsage({
				extraUsage: { ...state, remaining: undefined },
				policy: { extraUsageFloor: 10 },
				nowMs: NOW,
			}),
		).toEqual({ extra: "past-floor", stop: "floor-unreported" });
		expect(
			classifyExtraUsage({
				extraUsage: { ...state, used: undefined },
				policy: { extraUsageBudget: 10 },
				nowMs: NOW,
			}),
		).toEqual({ extra: "past-floor", stop: "budget-unreported" });
	});
});
