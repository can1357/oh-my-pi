import { describe, expect, it } from "bun:test";
import { claudeCodeVersion } from "@oh-my-pi/pi-ai/providers/claude-code-fingerprint";
import type { UsageFetchContext, UsageLimit, UsageReport } from "@oh-my-pi/pi-ai/usage";
import { claudeRankingStrategy, claudeUsageProvider } from "@oh-my-pi/pi-ai/usage/claude";

function getHeaderCaseInsensitive(
	headers: Headers | Record<string, string | ReadonlyArray<string>> | string[][] | undefined,
	name: string,
): string | undefined {
	if (!headers) return undefined;
	const target = name.toLowerCase();

	if (headers instanceof Headers) {
		for (const [key, value] of headers.entries()) {
			if (key.toLowerCase() === target) return value;
		}
		return undefined;
	}

	if (Array.isArray(headers)) {
		const match = headers.find(([key]) => key.toLowerCase() === target);
		return match?.[1];
	}

	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === target) return String(value);
	}
	return undefined;
}

async function fetchClaudeUsageReport(payload: Record<string, unknown>): Promise<UsageReport | null> {
	const fetchMock = (async () => {
		return new Response(
			JSON.stringify({
				five_hour: { utilization: 42 },
				...payload,
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	}) as unknown as typeof fetch;

	return claudeUsageProvider.fetchUsage(
		{
			provider: "anthropic",
			credential: {
				type: "oauth",
				accessToken: "oat-test-access-token",
				accountId: "account_test",
				email: "user@example.com",
				expiresAt: Date.now() + 60_000,
			},
		},
		{ fetch: fetchMock },
	);
}

function money(amountMinor: number) {
	return { amount_minor: amountMinor, currency: "USD", exponent: 2 };
}

function legacyExtraUsage(usedCredits: number, monthlyLimit: number | null) {
	return {
		is_enabled: true,
		monthly_limit: monthlyLimit,
		used_credits: usedCredits,
		decimal_places: 2,
		currency: "USD",
	};
}

describe("claude usage request headers", () => {
	it("sends aligned anthropic fingerprint and bearer auth headers", async () => {
		const now = Date.now();
		const token = "oat-test-access-token";
		const calls: Array<{ input: string; init?: RequestInit }> = [];
		const fetchMock = (async (input: string | URL, init?: RequestInit) => {
			calls.push({ input: String(input), init });
			return new Response(
				JSON.stringify({
					five_hour: {
						utilization: 42,
						resets_at: new Date(now + 10 * 60 * 1000).toISOString(),
					},
				}),
				{
					status: 200,
					headers: {
						"Content-Type": "application/json",
						"anthropic-organization-id": "org_test",
					},
				},
			);
		}) as unknown as typeof fetch;

		const ctx: UsageFetchContext = {
			fetch: fetchMock,
		};

		await claudeUsageProvider.fetchUsage(
			{
				provider: "anthropic",
				credential: {
					type: "oauth",
					accessToken: token,
					accountId: "org_test",
					email: "user@example.com",
					expiresAt: now + 60_000,
				},
			},
			ctx,
		);

		expect(calls).toHaveLength(1);
		expect(calls[0]?.input).toBe("https://api.anthropic.com/api/oauth/usage");

		const headers = calls[0]?.init?.headers;
		expect(getHeaderCaseInsensitive(headers, "authorization")).toBe(`Bearer ${token}`);
		expect(getHeaderCaseInsensitive(headers, "user-agent")).toBe(`claude-cli/${claudeCodeVersion} (external, cli)`);

		const beta = getHeaderCaseInsensitive(headers, "anthropic-beta");
		const betaTokens = beta?.split(",").map(tokenValue => tokenValue.trim()) ?? [];
		expect(betaTokens).toContain("claude-code-20250219");
		expect(betaTokens).toContain("oauth-2025-04-20");
		expect(betaTokens).toContain("interleaved-thinking-2025-05-14");
		expect(betaTokens).toContain("redact-thinking-2026-02-12");
		expect(betaTokens).toContain("context-management-2025-06-27");
		expect(betaTokens).toContain("prompt-caching-scope-2026-01-05");
		expect(betaTokens).toContain("mid-conversation-system-2026-04-07");
		expect(betaTokens).toContain("advanced-tool-use-2025-11-20");
		expect(betaTokens).toContain("effort-2025-11-24");
		expect(betaTokens).toContain("extended-cache-ttl-2025-04-11");
	});

	it("does not invent reset timestamps when Claude omits them", async () => {
		const fetchMock = (async () => {
			return new Response(
				JSON.stringify({
					five_hour: { utilization: 42 },
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as unknown as typeof fetch;

		const report = await claudeUsageProvider.fetchUsage(
			{
				provider: "anthropic",
				credential: {
					type: "oauth",
					accessToken: "oat-test-access-token",
					expiresAt: Date.now() + 60_000,
				},
			},
			{ fetch: fetchMock },
		);

		expect(report?.limits[0]?.window?.resetsAt).toBeUndefined();
	});

	it("surfaces the Fable weekly scoped limit from the limits array as a tiered UsageLimit", async () => {
		const now = Date.now();
		const fiveHourReset = new Date(now + 5 * 60 * 60 * 1000).toISOString();
		const sevenDayReset = new Date(now + 3 * 24 * 60 * 60 * 1000).toISOString();
		const fableReset = new Date(now + 4 * 24 * 60 * 60 * 1000).toISOString();
		const fetchMock = (async () => {
			return new Response(
				JSON.stringify({
					five_hour: { utilization: 16, resets_at: fiveHourReset },
					seven_day: { utilization: 18, resets_at: sevenDayReset },
					seven_day_opus: null,
					seven_day_sonnet: null,
					limits: [
						{
							kind: "session",
							group: "session",
							percent: 16,
							severity: "normal",
							resets_at: fiveHourReset,
							scope: null,
							is_active: true,
						},
						{
							kind: "weekly_all",
							group: "weekly",
							percent: 18,
							severity: "normal",
							resets_at: sevenDayReset,
							scope: null,
							is_active: true,
						},
						{
							kind: "weekly_scoped",
							group: "weekly",
							percent: 28,
							severity: "normal",
							resets_at: fableReset,
							scope: { model: { display_name: "Fable", id: null }, surface: null },
							is_active: true,
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as unknown as typeof fetch;
		const ctx: UsageFetchContext = { fetch: fetchMock };

		const report = await claudeUsageProvider.fetchUsage(
			{
				provider: "anthropic",
				credential: {
					type: "oauth",
					accessToken: "oat-test-access-token",
					expiresAt: now + 60_000,
				},
			},
			ctx,
		);

		expect(report?.limits.map(limit => limit.id)).toEqual(["anthropic:5h", "anthropic:7d", "anthropic:7d:fable"]);
		const fable = report?.limits.find(limit => limit.id === "anthropic:7d:fable");
		expect(fable?.label).toBe("Claude 7 Day (Fable)");
		expect(fable?.scope.provider).toBe("anthropic");
		expect(fable?.scope.tier).toBe("fable");
		expect(fable?.scope.windowId).toBe("7d");
		expect(fable?.scope.shared).toBeUndefined();
		expect(fable?.window?.durationMs).toBe(7 * 24 * 60 * 60 * 1000);
		expect(fable?.window?.label).toBe("7 Day");
		expect(fable?.window?.resetsAt).toBe(Date.parse(fableReset));
		expect(fable?.amount.used).toBe(28);
		expect(fable?.amount.limit).toBe(100);
		expect(fable?.amount.remaining).toBe(72);
		expect(fable?.amount.remainingFraction).toBeCloseTo(0.72);
		expect(fable?.amount.unit).toBe("percent");
		expect(fable?.amount.usedFraction).toBeCloseTo(0.28);
		expect(fable?.status).toBe("ok");
		const weekly = report?.limits.find(limit => limit.id === "anthropic:7d");
		expect(weekly?.amount.used).toBe(18);
		expect(weekly?.scope.shared).toBe(true);
	});

	it("surfaces inactive scoped limits and skips unnamed ones", async () => {
		const now = Date.now();
		const futureReset = new Date(now + 4 * 24 * 60 * 60 * 1000).toISOString();
		const fetchMock = (async () => {
			return new Response(
				JSON.stringify({
					five_hour: { utilization: 16, resets_at: new Date(now + 5 * 60 * 60 * 1000).toISOString() },
					limits: [
						{
							// Anthropic marks only the currently binding limit
							// `is_active`; an idle scoped bucket still carries real
							// utilization and must render instead of "not reported".
							kind: "weekly_scoped",
							group: "weekly",
							percent: 5,
							severity: "normal",
							resets_at: futureReset,
							scope: { model: { display_name: "Fable", id: null }, surface: null },
							is_active: false,
						},
						{
							kind: "weekly_scoped",
							group: "weekly",
							percent: 40,
							resets_at: futureReset,
							scope: { model: null, surface: null },
							is_active: true,
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as unknown as typeof fetch;
		const ctx: UsageFetchContext = { fetch: fetchMock };

		const report = await claudeUsageProvider.fetchUsage(
			{
				provider: "anthropic",
				credential: {
					type: "oauth",
					accessToken: "oat-test-access-token",
					expiresAt: now + 60_000,
				},
			},
			ctx,
		);

		expect(report?.limits.map(limit => limit.id)).toEqual(["anthropic:5h", "anthropic:7d:fable"]);
		const fable = report?.limits.find(limit => limit.id === "anthropic:7d:fable");
		expect(fable?.amount.used).toBe(5);
		expect(fable?.window?.resetsAt).toBe(Date.parse(futureReset));
		expect(fable?.status).toBe("ok");
	});

	it("falls back to session and weekly_all entries when legacy buckets are absent", async () => {
		const now = Date.now();
		const fiveHourReset = new Date(now + 5 * 60 * 60 * 1000).toISOString();
		const sevenDayReset = new Date(now + 3 * 24 * 60 * 60 * 1000).toISOString();
		const calls: string[] = [];
		const fetchMock = (async (input: string | URL) => {
			calls.push(String(input));
			return new Response(
				JSON.stringify({
					limits: [
						{
							kind: "session",
							group: "session",
							percent: 16,
							severity: "normal",
							resets_at: fiveHourReset,
							scope: null,
							is_active: true,
						},
						{
							kind: "weekly_all",
							group: "weekly",
							percent: 18,
							severity: "normal",
							resets_at: sevenDayReset,
							scope: null,
							is_active: true,
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as unknown as typeof fetch;
		const ctx: UsageFetchContext = { fetch: fetchMock };

		const report = await claudeUsageProvider.fetchUsage(
			{
				provider: "anthropic",
				credential: {
					type: "oauth",
					accessToken: "oat-test-access-token",
					expiresAt: now + 60_000,
				},
			},
			ctx,
		);

		// Exactly one usage fetch: hasUsageData must accept a limits[]-only payload
		// instead of burning retries. The trailing /profile call is the expected
		// identity backfill for a payload/credential carrying no account identity.
		expect(calls.filter(url => url.endsWith("/usage"))).toEqual(["https://api.anthropic.com/api/oauth/usage"]);
		expect(report?.limits.map(limit => limit.id)).toEqual(["anthropic:5h", "anthropic:7d"]);
		const session = report?.limits.find(limit => limit.id === "anthropic:5h");
		const weekly = report?.limits.find(limit => limit.id === "anthropic:7d");
		expect(session?.scope.shared).toBe(true);
		expect(weekly?.scope.shared).toBe(true);
		expect(session?.amount.used).toBe(16);
		expect(weekly?.amount.used).toBe(18);
	});

	it("accepts an extra-only payload on the first usage fetch", async () => {
		const calls: string[] = [];
		const fetchMock = (async (input: string | URL) => {
			calls.push(String(input));
			return new Response(
				JSON.stringify({
					spend: {
						enabled: true,
						used: money(1_234),
						limit: null,
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as unknown as typeof fetch;

		const report = await claudeUsageProvider.fetchUsage(
			{
				provider: "anthropic",
				credential: {
					type: "oauth",
					accessToken: "oat-test-access-token",
					accountId: "account_test",
					email: "user@example.com",
					expiresAt: Date.now() + 60_000,
				},
			},
			{ fetch: fetchMock },
		);

		expect(calls.filter(url => url.endsWith("/usage"))).toEqual(["https://api.anthropic.com/api/oauth/usage"]);
		expect(report?.limits.map(limit => limit.id)).toEqual(["anthropic:extra"]);
		expect(report?.limits[0]?.amount).toEqual({ used: 12.34, unit: "usd" });
	});

	it("accepts a legacy-only extra payload on the first usage fetch", async () => {
		const calls: string[] = [];
		const fetchMock = (async (input: string | URL) => {
			calls.push(String(input));
			return new Response(
				JSON.stringify({
					extra_usage: {
						is_enabled: true,
						used_credits: 1_234,
						monthly_limit: 10_000,
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as unknown as typeof fetch;

		const report = await claudeUsageProvider.fetchUsage(
			{
				provider: "anthropic",
				credential: {
					type: "oauth",
					accessToken: "oat-test-access-token",
					accountId: "account_test",
					email: "user@example.com",
					expiresAt: Date.now() + 60_000,
				},
			},
			{ fetch: fetchMock },
		);

		expect(calls.filter(url => url.endsWith("/usage"))).toEqual(["https://api.anthropic.com/api/oauth/usage"]);
		expect(report?.limits.map(limit => limit.id)).toEqual(["anthropic:extra"]);
		expect(report?.limits[0]?.amount).toMatchObject({ used: 12.34, limit: 100, unit: "usd" });
	});
});

describe("claude extra usage", () => {
	function extraLimit(report: UsageReport | null): UsageLimit | undefined {
		return report?.limits.find(limit => limit.id === "anthropic:extra");
	}

	it("normalizes capped zero spend without inventing a reset window", async () => {
		const report = await fetchClaudeUsageReport({
			spend: {
				enabled: true,
				used: money(0),
				limit: money(50_000),
			},
		});

		expect(extraLimit(report)).toEqual({
			id: "anthropic:extra",
			label: "Claude Extra Usage",
			scope: {
				provider: "anthropic",
				windowId: "extra",
			},
			amount: {
				used: 0,
				limit: 500,
				remaining: 500,
				usedFraction: 0,
				remainingFraction: 1,
				unit: "usd",
			},
			status: "ok",
		});
	});

	it("computes capped spend fractions and the warning threshold from dollar amounts", async () => {
		const report = await fetchClaudeUsageReport({
			spend: {
				enabled: true,
				used: money(45_000),
				limit: money(50_000),
				percent: 0,
			},
		});

		const extra = extraLimit(report);
		expect(extra?.amount).toEqual({
			used: 450,
			limit: 500,
			remaining: 50,
			usedFraction: 0.9,
			remainingFraction: 0.1,
			unit: "usd",
		});
		expect(extra?.status).toBe("warning");
	});

	it("marks current spend at exactly the cap as exhausted", async () => {
		const report = await fetchClaudeUsageReport({
			spend: {
				enabled: true,
				used: money(50_000),
				limit: money(50_000),
			},
		});

		const extra = extraLimit(report);
		expect(extra?.amount.usedFraction).toBe(1);
		expect(extra?.amount.remainingFraction).toBe(0);
		expect(extra?.status).toBe("exhausted");
	});

	it("marks current spend above the cap as exhausted", async () => {
		const report = await fetchClaudeUsageReport({
			spend: {
				enabled: true,
				used: money(62_500),
				limit: money(50_000),
			},
		});

		const extra = extraLimit(report);
		expect(extra?.amount).toEqual({
			used: 625,
			limit: 500,
			remaining: 0,
			usedFraction: 1.25,
			remainingFraction: 0,
			unit: "usd",
		});
		expect(extra?.status).toBe("exhausted");
	});

	it("normalizes uncapped current spend without trusting the upstream percent", async () => {
		const report = await fetchClaudeUsageReport({
			spend: {
				enabled: true,
				used: money(12_345),
				limit: null,
				percent: 0,
			},
		});

		const extra = extraLimit(report);
		expect(extra?.amount).toEqual({
			used: 123.45,
			unit: "usd",
		});
		expect(extra).not.toHaveProperty("status");
	});

	it("honors the current spend exponent and case-insensitive USD currency", async () => {
		const report = await fetchClaudeUsageReport({
			spend: {
				enabled: true,
				used: {
					amount_minor: 12_345,
					currency: "usd",
					exponent: 3,
				},
				limit: null,
			},
		});

		expect(extraLimit(report)?.amount).toEqual({
			used: 12.345,
			unit: "usd",
		});
	});

	it("uses valid current spend instead of legacy extra_usage", async () => {
		const report = await fetchClaudeUsageReport({
			spend: {
				enabled: true,
				used: money(500),
				limit: money(1_000),
			},
			extra_usage: legacyExtraUsage(9_900, 10_000),
		});

		expect(extraLimit(report)?.amount).toEqual({
			used: 5,
			limit: 10,
			remaining: 5,
			usedFraction: 0.5,
			remainingFraction: 0.5,
			unit: "usd",
		});
	});

	it("treats disabled current spend as authoritative over valid legacy data", async () => {
		const report = await fetchClaudeUsageReport({
			spend: {
				enabled: false,
				used: money(500),
				limit: null,
			},
			extra_usage: legacyExtraUsage(9_900, 10_000),
		});

		expect(extraLimit(report)).toBeUndefined();
	});

	it.each([
		["non-object", "unavailable"],
		["non-true gate", { enabled: "yes", used: money(500), limit: null }],
		["invalid used", { enabled: true, used: { amount_minor: "invalid", currency: "USD", exponent: 2 }, limit: null }],
		["fractional used", { enabled: true, used: { amount_minor: 1.5, currency: "USD", exponent: 2 }, limit: null }],
		["negative used", { enabled: true, used: { amount_minor: -1, currency: "USD", exponent: 2 }, limit: null }],
		[
			"fractional exponent",
			{ enabled: true, used: { amount_minor: 500, currency: "USD", exponent: 1.5 }, limit: null },
		],
		["negative exponent", { enabled: true, used: { amount_minor: 500, currency: "USD", exponent: -1 }, limit: null }],
		["non-USD used", { enabled: true, used: { amount_minor: 500, currency: "EUR", exponent: 2 }, limit: null }],
		["missing used exponent", { enabled: true, used: { amount_minor: 500, currency: "USD" }, limit: null }],
		["missing used currency", { enabled: true, used: { amount_minor: 500, exponent: 2 }, limit: null }],
		["missing limit key", { enabled: true, used: money(500) }],
		[
			"invalid limit",
			{ enabled: true, used: money(500), limit: { amount_minor: "invalid", currency: "USD", exponent: 2 } },
		],
		["zero limit", { enabled: true, used: money(500), limit: money(0) }],
		["negative limit", { enabled: true, used: money(500), limit: money(-100) }],
		[
			"non-USD limit",
			{ enabled: true, used: money(500), limit: { amount_minor: 1_000, currency: "EUR", exponent: 2 } },
		],
	])("does not fall back when authoritative current spend is malformed: %s", async (_name, spend) => {
		const report = await fetchClaudeUsageReport({
			spend,
			extra_usage: legacyExtraUsage(1_234, 10_000),
		});

		expect(extraLimit(report)).toBeUndefined();
	});

	it.each([
		["absent", {}],
		["null", { spend: null }],
	])("falls back to legacy extra_usage only when current spend is %s", async (_name, current) => {
		const report = await fetchClaudeUsageReport({
			...current,
			extra_usage: legacyExtraUsage(1_234, 10_000),
		});

		const amount = extraLimit(report)?.amount;
		expect(amount).toMatchObject({
			used: 12.34,
			limit: 100,
			remaining: 87.66,
			unit: "usd",
		});
		expect(amount?.usedFraction).toBeCloseTo(0.1234);
		expect(amount?.remainingFraction).toBeCloseTo(0.8766);
	});

	it.each([
		[
			"unsafe used minor units",
			{
				enabled: true,
				used: { amount_minor: Number.MAX_SAFE_INTEGER + 1, currency: "USD", exponent: 2 },
				limit: null,
			},
		],
		[
			"unsafe used exponent",
			{
				enabled: true,
				used: { amount_minor: 1, currency: "USD", exponent: Number.MAX_SAFE_INTEGER + 1 },
				limit: null,
			},
		],
		[
			"non-finite used divisor",
			{ enabled: true, used: { amount_minor: 1, currency: "USD", exponent: 309 }, limit: null },
		],
		[
			"unsafe limit minor units",
			{
				enabled: true,
				used: money(1),
				limit: { amount_minor: Number.MAX_SAFE_INTEGER + 1, currency: "USD", exponent: 2 },
			},
		],
		[
			"unsafe limit exponent",
			{
				enabled: true,
				used: money(1),
				limit: { amount_minor: 1, currency: "USD", exponent: Number.MAX_SAFE_INTEGER + 1 },
			},
		],
	])("rejects unsafe or non-finite current money: %s", async (_name, spend) => {
		const report = await fetchClaudeUsageReport({ spend });
		expect(extraLimit(report)).toBeUndefined();
	});

	it("rejects capped current spend whose finite dollar amounts produce an infinite fraction", async () => {
		const report = await fetchClaudeUsageReport({
			spend: {
				enabled: true,
				used: {
					amount_minor: Number.MAX_SAFE_INTEGER,
					currency: "USD",
					exponent: 0,
				},
				limit: {
					amount_minor: 1,
					currency: "USD",
					exponent: 308,
				},
			},
		});

		expect(extraLimit(report)).toBeUndefined();
	});

	it("defaults the recorded legacy shape without currency or decimal_places to cents", async () => {
		const report = await fetchClaudeUsageReport({
			extra_usage: {
				is_enabled: true,
				monthly_limit: 10_000,
				used_credits: 1_234,
			},
		});

		const amount = extraLimit(report)?.amount;
		expect(amount).toMatchObject({
			used: 12.34,
			limit: 100,
			remaining: 87.66,
			unit: "usd",
		});
		expect(amount?.usedFraction).toBeCloseTo(0.1234);
		expect(amount?.remainingFraction).toBeCloseTo(0.8766);
	});

	it("honors non-default legacy decimal_places scaling", async () => {
		const report = await fetchClaudeUsageReport({
			extra_usage: {
				is_enabled: true,
				monthly_limit: 50_000,
				used_credits: 12_345,
				decimal_places: 3,
				currency: "usd",
			},
		});

		expect(extraLimit(report)?.amount).toEqual({
			used: 12.345,
			limit: 50,
			remaining: 37.655,
			usedFraction: 0.2469,
			remainingFraction: 0.7531,
			unit: "usd",
		});
	});

	it("normalizes uncapped legacy spend without fabricating a cap or status", async () => {
		const report = await fetchClaudeUsageReport({
			extra_usage: {
				is_enabled: true,
				monthly_limit: null,
				used_credits: 1_234,
			},
		});

		const extra = extraLimit(report);
		expect(extra?.amount).toEqual({ used: 12.34, unit: "usd" });
		expect(extra).not.toHaveProperty("status");
	});

	it.each([
		["disabled gate", { is_enabled: false, monthly_limit: 10_000, used_credits: 1_234 }],
		["non-true gate", { is_enabled: "yes", monthly_limit: 10_000, used_credits: 1_234 }],
		["missing monthly_limit", { is_enabled: true, used_credits: 1_234 }],
		["non-USD currency", { is_enabled: true, monthly_limit: 10_000, used_credits: 1_234, currency: "EUR" }],
		["invalid used", { is_enabled: true, monthly_limit: 10_000, used_credits: "invalid" }],
		["fractional used", { is_enabled: true, monthly_limit: 10_000, used_credits: 1.5 }],
		["unsafe used", { is_enabled: true, monthly_limit: 10_000, used_credits: Number.MAX_SAFE_INTEGER + 1 }],
		[
			"fractional decimal_places",
			{ is_enabled: true, monthly_limit: 10_000, used_credits: 1_234, decimal_places: 1.5 },
		],
		[
			"unsafe decimal_places",
			{ is_enabled: true, monthly_limit: 10_000, used_credits: 1_234, decimal_places: Number.MAX_SAFE_INTEGER + 1 },
		],
		[
			"non-finite decimal divisor",
			{ is_enabled: true, monthly_limit: 10_000, used_credits: 1_234, decimal_places: 309 },
		],
		["zero cap", { is_enabled: true, monthly_limit: 0, used_credits: 0 }],
		["negative cap", { is_enabled: true, monthly_limit: -100, used_credits: 0 }],
	])("rejects disabled or malformed legacy extra_usage: %s", async (_name, extra_usage) => {
		const report = await fetchClaudeUsageReport({ extra_usage });
		expect(extraLimit(report)).toBeUndefined();
	});
});

describe("claude ranking strategy", () => {
	function usageLimit(args: {
		id: string;
		windowId: "5h" | "7d";
		usedFraction: number;
		tier?: "fable";
		durationMs?: number;
		resetsAt?: number;
	}): UsageLimit {
		const used = args.usedFraction * 100;
		return {
			id: args.id,
			label:
				args.tier === "fable" ? "Claude 7 Day (Fable)" : `Claude ${args.windowId === "5h" ? "5 Hour" : "7 Day"}`,
			scope: {
				provider: "anthropic",
				windowId: args.windowId,
				...(args.tier ? { tier: args.tier } : { shared: true }),
			},
			window: {
				id: args.windowId,
				label: args.windowId === "5h" ? "5 Hour" : "7 Day",
				...(args.durationMs !== undefined ? { durationMs: args.durationMs } : {}),
				...(args.resetsAt !== undefined ? { resetsAt: args.resetsAt } : {}),
			},
			amount: {
				used,
				limit: 100,
				remaining: 100 - used,
				usedFraction: args.usedFraction,
				remainingFraction: 1 - args.usedFraction,
				unit: "percent",
			},
			status: "ok",
		};
	}

	function usageReportWithWeeklyCaps(args: { sharedWeeklyUsed: number; fableWeeklyUsed: number }): UsageReport {
		return {
			provider: "anthropic",
			fetchedAt: Date.now(),
			limits: [
				usageLimit({ id: "anthropic:5h", windowId: "5h", usedFraction: 0.2 }),
				usageLimit({ id: "anthropic:7d", windowId: "7d", usedFraction: args.sharedWeeklyUsed }),
				usageLimit({
					id: "anthropic:7d:fable",
					windowId: "7d",
					usedFraction: args.fableWeeklyUsed,
					tier: "fable",
				}),
				{
					id: "anthropic:extra",
					label: "Claude Extra Usage",
					scope: { provider: "anthropic", windowId: "extra" },
					amount: {
						used: 100,
						unit: "usd",
						limit: 100,
						remaining: 0,
						usedFraction: 1,
						remainingFraction: 0,
					},
					status: "exhausted",
				},
			],
		};
	}

	it("keeps capped extra usage display-only for ranking and gating", () => {
		const report = usageReportWithWeeklyCaps({ sharedWeeklyUsed: 0.18, fableWeeklyUsed: 0.64 });
		const windows = claudeRankingStrategy.findWindowLimits(report, { modelId: "claude-opus-4-8" });
		const scopeLimits = claudeRankingStrategy.scopeLimits;
		if (!scopeLimits) throw new Error("expected claude scopeLimits");

		expect(windows.primary?.id).toBe("anthropic:5h");
		expect(windows.secondary?.id).toBe("anthropic:7d");
		expect(scopeLimits(report, { modelId: "claude-opus-4-8" }).map(limit => limit.id)).toEqual([
			"anthropic:5h",
			"anthropic:7d",
		]);
	});

	it("scopes credential gating to shared umbrella limits plus the requested model tier", () => {
		const limits: UsageLimit[] = [
			{
				id: "anthropic:5h",
				label: "Claude 5 Hour",
				scope: { provider: "anthropic", windowId: "5h", shared: true },
				window: { id: "5h", label: "5 Hour" },
				amount: {
					used: 16,
					limit: 100,
					remaining: 84,
					usedFraction: 0.16,
					remainingFraction: 0.84,
					unit: "percent",
				},
				status: "ok",
			},
			{
				id: "anthropic:7d",
				label: "Claude 7 Day",
				scope: { provider: "anthropic", windowId: "7d", shared: true },
				window: { id: "7d", label: "7 Day" },
				amount: {
					used: 18,
					limit: 100,
					remaining: 82,
					usedFraction: 0.18,
					remainingFraction: 0.82,
					unit: "percent",
				},
				status: "ok",
			},
			{
				id: "anthropic:7d:fable",
				label: "Claude 7 Day (Fable)",
				scope: { provider: "anthropic", windowId: "7d", tier: "fable" },
				window: { id: "7d", label: "7 Day" },
				amount: {
					used: 28,
					limit: 100,
					remaining: 72,
					usedFraction: 0.28,
					remainingFraction: 0.72,
					unit: "percent",
				},
				status: "ok",
			},
		];
		const report: UsageReport = {
			provider: "anthropic",
			fetchedAt: Date.now(),
			limits,
		};

		const scopeLimits = claudeRankingStrategy.scopeLimits;
		if (!scopeLimits) throw new Error("expected claude scopeLimits");
		expect(scopeLimits(report).map(limit => limit.id)).toEqual(["anthropic:5h", "anthropic:7d"]);
		expect(scopeLimits(report, { modelId: "claude-opus-4-8" }).map(limit => limit.id)).toEqual([
			"anthropic:5h",
			"anthropic:7d",
		]);
		expect(scopeLimits(report, { modelId: "claude-fable-5" }).map(limit => limit.id)).toEqual([
			"anthropic:5h",
			"anthropic:7d",
		]);
		expect(claudeRankingStrategy.blockScope?.({ modelId: "claude-fable-5" })).toBe("tier:fable");
		expect(claudeRankingStrategy.blockScope?.({ modelId: "claude-mythos-5" })).toBe("tier:mythos");
		expect(claudeRankingStrategy.blockScope?.({ modelId: "claude-opus-4-8" })).toBeUndefined();
		expect(claudeRankingStrategy.blockScope?.({})).toBeUndefined();
	});

	it("uses the Fable weekly cap as secondary when it is more used than the shared weekly cap", () => {
		const report = usageReportWithWeeklyCaps({ sharedWeeklyUsed: 0.18, fableWeeklyUsed: 0.64 });

		const windows = claudeRankingStrategy.findWindowLimits(report, { modelId: "claude-fable-5" });

		expect(windows.secondary?.id).toBe("anthropic:7d:fable");
		expect(windows.secondary?.amount.usedFraction).toBe(0.64);
	});

	it("ranks the Fable weekly secondary by drain pressure instead of raw used fraction", () => {
		const now = Date.now();
		const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
		const hourMs = 60 * 60 * 1000;
		const report: UsageReport = {
			provider: "anthropic",
			fetchedAt: now,
			limits: [
				usageLimit({ id: "anthropic:5h", windowId: "5h", usedFraction: 0.2 }),
				usageLimit({
					id: "anthropic:7d",
					windowId: "7d",
					usedFraction: 0.4,
					durationMs: sevenDaysMs,
					resetsAt: now + 160 * hourMs,
				}),
				usageLimit({
					id: "anthropic:7d:fable",
					windowId: "7d",
					usedFraction: 0.9,
					tier: "fable",
					durationMs: sevenDaysMs,
					resetsAt: now + hourMs,
				}),
			],
		};

		const windows = claudeRankingStrategy.findWindowLimits(report, { modelId: "claude-fable-5" });

		expect(windows.secondary?.id).toBe("anthropic:7d");
		expect(windows.secondary?.amount.usedFraction).toBe(0.4);
	});

	it("keeps Fable weekly caps out of Opus and unscoped secondary ranking", () => {
		const report = usageReportWithWeeklyCaps({ sharedWeeklyUsed: 0.18, fableWeeklyUsed: 0.64 });

		expect(claudeRankingStrategy.findWindowLimits(report, { modelId: "claude-opus-4-8" }).secondary?.id).toBe(
			"anthropic:7d",
		);
		expect(claudeRankingStrategy.findWindowLimits(report).secondary?.id).toBe("anthropic:7d");
	});

	it("keeps the shared weekly cap as secondary for Fable when it is the more used cap", () => {
		const report = usageReportWithWeeklyCaps({ sharedWeeklyUsed: 0.74, fableWeeklyUsed: 0.31 });

		expect(claudeRankingStrategy.findWindowLimits(report, { modelId: "claude-fable-5" }).secondary?.id).toBe(
			"anthropic:7d",
		);
	});
});
