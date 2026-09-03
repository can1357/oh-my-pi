/**
 * Codex usage parser regressions. The widget client (osx-widgets) keys spark
 * detection off `limit.id.includes("spark")`, so the parser MUST surface
 * `additional_rate_limits[].metered_feature == "codex_bengalfox"` (the upstream
 * codename for GPT-5.3-Codex-Spark) as separate `UsageLimit` entries with
 * `spark` in the id. If this contract breaks, both the TUI and the macOS
 * widget lose per-model visibility.
 */
import { describe, expect, it } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { codexRankingStrategy, openaiCodexUsageProvider } from "@oh-my-pi/pi-ai/usage/openai-codex";

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
		expect(main?.[0].scope).toEqual({ provider: "openai-codex", windowId: "5h", shared: true });
		expect(main?.[0].amount.usedFraction).toBeCloseTo(0.04, 5);
	});

	it("keeps an explicitly allowed Team window usable at 100% reported usage", async () => {
		const payload = makePayload();
		payload.plan_type = "team";
		payload.rate_limit.secondary_window.used_percent = 100;
		const report = await openaiCodexUsageProvider.fetchUsage(
			{
				provider: "openai-codex",
				credential: { type: "oauth", accessToken: accessTokenFixture, accountId: "acct-1", email: "u@example.com" },
			},
			{ fetch: fakeFetch(payload) },
		);

		const secondary = report?.limits.find(limit => limit.id === "openai-codex:secondary");
		expect(secondary?.amount.usedFraction).toBe(1);
		expect(secondary?.status).toBe("warning");
		expect(report?.metadata).toMatchObject({ planType: "team", allowed: true, limitReached: false });
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

	it("ignores non-canonical provider baseUrl overrides for wham/usage (#3679)", async () => {
		// Headroom + similar /responses proxies don't serve ChatGPT account
		// endpoints; without this fall-back `/usage show` 404s on the proxy.
		const requested: string[] = [];
		const fetchImpl: FetchImpl = (async (url: string | URL | Request) => {
			requested.push(typeof url === "string" ? url : url.toString());
			return new Response(JSON.stringify(makePayload()), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as FetchImpl;
		await openaiCodexUsageProvider.fetchUsage(
			{
				provider: "openai-codex",
				credential: { type: "oauth", accessToken: accessTokenFixture, accountId: "acct-1", email: "u@example.com" },
				baseUrl: "http://127.0.0.1:8787/v1",
			},
			{ fetch: fetchImpl },
		);
		expect(requested).toEqual(["https://chatgpt.com/backend-api/wham/usage"]);
	});

	it("keeps a canonical chatgpt.com baseUrl override (and adds /backend-api when missing)", async () => {
		const requested: string[] = [];
		const fetchImpl: FetchImpl = (async (url: string | URL | Request) => {
			requested.push(typeof url === "string" ? url : url.toString());
			return new Response(JSON.stringify(makePayload()), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as FetchImpl;
		await openaiCodexUsageProvider.fetchUsage(
			{
				provider: "openai-codex",
				credential: { type: "oauth", accessToken: accessTokenFixture, accountId: "acct-1", email: "u@example.com" },
				baseUrl: "https://chatgpt.com",
			},
			{ fetch: fetchImpl },
		);
		expect(requested).toEqual(["https://chatgpt.com/backend-api/wham/usage"]);
	});

	it("strips a streaming path from a canonical chatgpt.com baseUrl for wham/usage", async () => {
		// A Codex streaming baseUrl points at `/backend-api/codex/responses`; the
		// account endpoint still lives at `${origin}/backend-api/wham/usage`, so the
		// extra path must be dropped rather than yielding `.../codex/responses/wham/usage`.
		const requested: string[] = [];
		const fetchImpl: FetchImpl = (async (url: string | URL | Request) => {
			requested.push(typeof url === "string" ? url : url.toString());
			return new Response(JSON.stringify(makePayload()), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as FetchImpl;
		await openaiCodexUsageProvider.fetchUsage(
			{
				provider: "openai-codex",
				credential: { type: "oauth", accessToken: accessTokenFixture, accountId: "acct-1", email: "u@example.com" },
				baseUrl: "https://chatgpt.com/backend-api/codex/responses",
			},
			{ fetch: fetchImpl },
		);
		expect(requested).toEqual(["https://chatgpt.com/backend-api/wham/usage"]);
	});

	it("keeps a window with headroom usable when the account flag is set", async () => {
		// The account-level flag covers the whole account, so applying it to each
		// window marked one with real headroom as exhausted. This is the original
		// bug: the fixture below has `limit_reached: true` with the primary window
		// at 4%.
		const payload = makePayload();
		payload.rate_limit.limit_reached = true;
		const report = await openaiCodexUsageProvider.fetchUsage(
			{
				provider: "openai-codex",
				credential: { type: "oauth", accessToken: accessTokenFixture, accountId: "acct-1", email: "u@example.com" },
			},
			{ fetch: fakeFetch(payload) },
		);

		const primary = report?.limits.find(l => l.id === "openai-codex:primary");
		expect(primary).toBeDefined();
		expect(primary?.amount.usedFraction).toBeLessThan(1);
		expect(primary?.status).not.toBe("exhausted");
	});

	it("keeps each Spark window independent of the shared meter flag", async () => {
		const payload = makePayload();
		payload.additional_rate_limits[0].rate_limit.limit_reached = true;
		payload.additional_rate_limits[0].rate_limit.primary_window.used_percent = 17;
		payload.additional_rate_limits[0].rate_limit.secondary_window.used_percent = 100;
		const report = await openaiCodexUsageProvider.fetchUsage(
			{
				provider: "openai-codex",
				credential: { type: "oauth", accessToken: accessTokenFixture, accountId: "acct-1", email: "u@example.com" },
			},
			{ fetch: fakeFetch(payload) },
		);

		const primary = report?.limits.find(limit => limit.id === "openai-codex:spark:primary");
		const secondary = report?.limits.find(limit => limit.id === "openai-codex:spark:secondary");
		expect(primary?.status).toBe("ok");
		expect(secondary?.status).toBe("exhausted");
	});

	it("scopes a request to the meters it actually spends", async () => {
		const payload = makePayload();
		const report = await openaiCodexUsageProvider.fetchUsage(
			{
				provider: "openai-codex",
				credential: { type: "oauth", accessToken: accessTokenFixture, accountId: "acct-1", email: "u@example.com" },
			},
			{ fetch: fakeFetch(payload) },
		);
		const scope = codexRankingStrategy.scopeLimits;
		expect(scope).toBeDefined();

		const chatIds = (report ? (scope?.(report, { modelId: "gpt-5.3-codex" }) ?? []) : []).map(l => l.id);
		const sparkIds = (report ? (scope?.(report, { modelId: "gpt-5.3-codex-spark" }) ?? []) : []).map(l => l.id);

		// A chat request gates on the chat windows and never on the Spark meter.
		expect(chatIds).toContain("openai-codex:primary");
		expect(chatIds).toContain("openai-codex:secondary");
		expect(chatIds.some(id => id.includes("spark"))).toBe(false);

		// A Spark request gates only on the Spark meter.
		expect(sparkIds.some(id => id.includes("spark"))).toBe(true);
		expect(sparkIds).not.toContain("openai-codex:primary");
		expect(sparkIds).not.toContain("openai-codex:secondary");
	});

	it("backs off Spark and chat under separate scopes", () => {
		// A reactive `usage_limit_reached` must not persist a block the other meter
		// honours, or the request-level isolation above is undone on the reactive
		// path. "shared" stays in both lists because blocks written before scoping
		// meant "block everything".
		const chat = codexRankingStrategy.blockScope?.({ modelId: "gpt-5.3-codex" });
		const spark = codexRankingStrategy.blockScope?.({ modelId: "gpt-5.3-codex-spark" });
		expect(chat).not.toBe(spark);
		expect(codexRankingStrategy.blockScopes?.({ modelId: "gpt-5.3-codex" })).toEqual(["chat", "shared"]);
		expect(codexRankingStrategy.blockScopes?.({ modelId: "gpt-5.3-codex-spark" })).toEqual(["spark", "shared"]);
		// Reconciliation runs with no request context and must heal every scope.
		expect(codexRankingStrategy.blockScopes?.()).toEqual(["chat", "spark", "shared"]);
	});
});
