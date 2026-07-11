/**
 * Codex usage parser regressions. The widget client (osx-widgets) keys spark
 * detection off `limit.id.includes("spark")`, so the parser MUST surface
 * `additional_rate_limits[].metered_feature == "codex_bengalfox"` (the upstream
 * codename for GPT-5.3-Codex-Spark) as separate `UsageLimit` entries with
 * `spark` in the id. If this contract breaks, both the TUI and the macOS
 * widget lose per-model visibility.
 */
import { describe, expect, it } from "bun:test";
import type { FetchImpl } from "@pk-nerdsaver-ai/pi-ai/types";
import { openaiCodexUsageProvider } from "@pk-nerdsaver-ai/pi-ai/usage/openai-codex";

const accessTokenFixture = (() => {
	const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
	const body = Buffer.from(
		JSON.stringify({
			"https://api.openai.com/auth": { chatgpt_account_id: "acct-fixture" },
			"https://api.openai.com/profile": { email: "fixture@example.com" },
		}),
	).toString("base64url");
	return `${header}.${body}.sig`;
})();

function makePayload() {
	return {
		plan_type: "pro",
		rate_limit: {
			allowed: true,
			limit_reached: false,
			primary_window: { used_percent: 4, limit_window_seconds: 17940, reset_at: 2_000_000_000 },
			secondary_window: { used_percent: 1, limit_window_seconds: 604740, reset_at: 2_000_500_000 },
		},
		additional_rate_limits: [
			{
				limit_name: "GPT-5.3-Codex-Spark",
				metered_feature: "codex_bengalfox",
				rate_limit: {
					allowed: true,
					limit_reached: false,
					primary_window: { used_percent: 17, limit_window_seconds: 18000, reset_at: 2_000_001_000 },
					secondary_window: { used_percent: 61, limit_window_seconds: 604800, reset_at: 2_000_600_000 },
				},
			},
		],
	};
}

function fakeFetch(payload: unknown): FetchImpl {
	const fn = async () =>
		new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
	return fn as unknown as typeof fetch;
}

describe("openai-codex usage parser", () => {
	it("emits primary + secondary limits from the main rate_limit block", async () => {
		const report = await openaiCodexUsageProvider.fetchUsage(
			{
				provider: "openai-codex",
				credential: { type: "oauth", accessToken: accessTokenFixture, accountId: "acct-1", email: "u@example.com" },
			},
			{ fetch: fakeFetch(makePayload()) },
		);
		expect(report).not.toBeNull();
		const main = report?.limits.filter(l => l.id === "openai-codex:primary" || l.id === "openai-codex:secondary");
		expect(main?.map(l => l.id)).toEqual(["openai-codex:primary", "openai-codex:secondary"]);
		expect(main?.[0].scope.tier).toBe("pro");
		expect(main?.[0].amount.usedFraction).toBeCloseTo(0.04, 5);
	});

	it("surfaces additional_rate_limits as spark UsageLimit entries the widget can detect", async () => {
		const report = await openaiCodexUsageProvider.fetchUsage(
			{
				provider: "openai-codex",
				credential: { type: "oauth", accessToken: accessTokenFixture, accountId: "acct-1", email: "u@example.com" },
			},
			{ fetch: fakeFetch(makePayload()) },
		);
		const spark = report?.limits.filter(l => l.id.includes("spark"));
		expect(spark?.map(l => l.id)).toEqual(["openai-codex:spark:primary", "openai-codex:spark:secondary"]);
		expect(spark?.[0].label).toBe("5 hours (Spark)");
		expect(spark?.[1].label).toBe("7 days (Spark)");
		expect(spark?.[0].scope.tier).toBe("spark");
		expect(spark?.[0].scope.modelId).toBe("GPT-5.3-Codex-Spark");
		expect(spark?.[0].amount.usedFraction).toBeCloseTo(0.17, 5);
		expect(spark?.[1].amount.usedFraction).toBeCloseTo(0.61, 5);
	});

	it("treats bengalfox codename as spark even without explicit limit_name", async () => {
		const payload = makePayload();
		payload.additional_rate_limits[0].limit_name = undefined as unknown as string;
		const report = await openaiCodexUsageProvider.fetchUsage(
			{
				provider: "openai-codex",
				credential: { type: "oauth", accessToken: accessTokenFixture, accountId: "acct-1", email: "u@example.com" },
			},
			{ fetch: fakeFetch(payload) },
		);
		const spark = report?.limits.find(l => l.id === "openai-codex:spark:primary");
		expect(spark).toBeTruthy();
		expect(spark?.scope.tier).toBe("spark");
	});

	it("returns a report even when only additional_rate_limits are present (no main rate_limit)", async () => {
		const payload = {
			plan_type: "pro",
			rate_limit: null,
			additional_rate_limits: [
				{
					limit_name: "GPT-5.3-Codex-Spark",
					metered_feature: "codex_bengalfox",
					rate_limit: {
						allowed: true,
						limit_reached: false,
						primary_window: { used_percent: 5, limit_window_seconds: 18000, reset_at: 2_000_000_000 },
					},
				},
			],
		};
		const report = await openaiCodexUsageProvider.fetchUsage(
			{
				provider: "openai-codex",
				credential: { type: "oauth", accessToken: accessTokenFixture, accountId: "acct-1", email: "u@example.com" },
			},
			{ fetch: fakeFetch(payload) },
		);
		expect(report).not.toBeNull();
		expect(report?.limits.map(l => l.id)).toEqual(["openai-codex:spark:primary"]);
	});

	it("surfaces rate_limit_reset_credits.available_count as report.resetCredits", async () => {
		const usagePayload = { ...makePayload(), rate_limit_reset_credits: { available_count: 1 } };
		const fetchImpl: FetchImpl = (async (url: string | URL | Request) => {
			const path = typeof url === "string" ? url : url.toString();
			// Return an empty credits list for the detail endpoint — the count
			// from /wham/usage should be synced from the live response.
			const body = path.includes("rate-limit-reset-credits") ? { available_count: 1, credits: [] } : usagePayload;
			return new Response(JSON.stringify(body), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as FetchImpl;
		const report = await openaiCodexUsageProvider.fetchUsage(
			{
				provider: "openai-codex",
				credential: { type: "oauth", accessToken: accessTokenFixture, accountId: "acct-1", email: "u@example.com" },
			},
			{ fetch: fetchImpl },
		);
		expect(report?.resetCredits).toEqual({ availableCount: 1 });
	});

	it("omits resetCredits when the account has no saved resets block", async () => {
		const report = await openaiCodexUsageProvider.fetchUsage(
			{
				provider: "openai-codex",
				credential: { type: "oauth", accessToken: accessTokenFixture, accountId: "acct-1", email: "u@example.com" },
			},
			{ fetch: fakeFetch(makePayload()) },
		);
		expect(report?.resetCredits).toBeUndefined();
	});
	it("populates resetCredits.credits with expiry dates when available_count > 0", async () => {
		const usagePayload = { ...makePayload(), rate_limit_reset_credits: { available_count: 2 } };
		const creditsPayload = {
			available_count: 2,
			credits: [
				{
					id: "RateLimitResetCredit_1",
					status: "available",
					granted_at: "2025-01-15T00:00:00Z",
					expires_at: "2025-02-14T00:00:00Z",
				},
				{
					id: "RateLimitResetCredit_2",
					status: "available",
					granted_at: "2025-01-20T00:00:00Z",
					expires_at: "2025-02-19T00:00:00Z",
				},
				{
					id: "RateLimitResetCredit_3",
					status: "redeemed",
					granted_at: "2025-01-01T00:00:00Z",
					expires_at: "2025-01-31T00:00:00Z",
				},
			],
		};
		const fetchImpl: FetchImpl = (async (url: string | URL | Request) => {
			const path = typeof url === "string" ? url : url.toString();
			const body = path.includes("rate-limit-reset-credits") ? creditsPayload : usagePayload;
			return new Response(JSON.stringify(body), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as FetchImpl;
		const report = await openaiCodexUsageProvider.fetchUsage(
			{
				provider: "openai-codex",
				credential: { type: "oauth", accessToken: accessTokenFixture, accountId: "acct-1", email: "u@example.com" },
			},
			{ fetch: fetchImpl },
		);
		expect(report?.resetCredits?.availableCount).toBe(2);
		// Redeemed credits are filtered out; only available ones surface
		expect(report?.resetCredits?.credits).toHaveLength(2);
		expect(report?.resetCredits?.credits?.[0]?.expiresAt).toBe("2025-02-14T00:00:00Z");
		expect(report?.resetCredits?.credits?.[1]?.expiresAt).toBe("2025-02-19T00:00:00Z");
	});

	it("does not call listCodexResetCredits when available_count is 0", async () => {
		const usagePayload = { ...makePayload(), rate_limit_reset_credits: { available_count: 0 } };
		let extraFetchCalls = 0;
		const fetchImpl: FetchImpl = (async (url: string | URL | Request) => {
			const path = typeof url === "string" ? url : url.toString();
			if (path.includes("rate-limit-reset-credits")) extraFetchCalls++;
			return new Response(JSON.stringify(usagePayload), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as FetchImpl;
		await openaiCodexUsageProvider.fetchUsage(
			{
				provider: "openai-codex",
				credential: { type: "oauth", accessToken: accessTokenFixture, accountId: "acct-1", email: "u@example.com" },
			},
			{ fetch: fetchImpl },
		);
		expect(extraFetchCalls).toBe(0);
	});
});
