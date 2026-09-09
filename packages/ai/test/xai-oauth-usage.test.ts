import { describe, expect, it } from "bun:test";
import { buildXAICliBillingUrl } from "@oh-my-pi/pi-ai/oauth/xai-oauth";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import type { UsageFetchParams } from "@oh-my-pi/pi-ai/usage";
import { xaiOauthUsageProvider } from "@oh-my-pi/pi-ai/usage/xai-oauth";

const USER_ID = "cf12ecb5-cca4-4ba0-9f02-298071a2d052";

const accessTokenFixture = (() => {
	const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
	const body = Buffer.from(JSON.stringify({ sub: USER_ID })).toString("base64url");
	return `${header}.${body}.sig`;
})();

function makeBillingPayload(overrides?: Record<string, unknown>) {
	const periodEnd = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
	const periodStart = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
	return {
		config: {
			creditUsagePercent: 18,
			currentPeriod: {
				end: periodEnd,
				start: periodStart,
				type: "USAGE_PERIOD_TYPE_WEEKLY",
			},
			productUsage: [
				{ product: "GrokBuild", usagePercent: 16 },
				{ product: "Api", usagePercent: 2 },
			],
			...overrides,
		},
	};
}

/** Live unified-billing `?format=credits` body: weekly period, no percents. */
function makeUnifiedCreditsPayload() {
	return {
		config: {
			currentPeriod: {
				type: "USAGE_PERIOD_TYPE_WEEKLY",
				start: "2026-07-23T11:11:10.769917+00:00",
				end: "2026-07-30T11:11:10.769917+00:00",
			},
			onDemandCap: { val: 0 },
			onDemandUsed: { val: 0 },
			isUnifiedBillingUser: true,
			prepaidBalance: { val: 0 },
			topUpMethod: "TOP_UP_METHOD_SAVED_PAYMENT_METHOD",
			billingPeriodStart: "2026-07-23T11:11:10.769917+00:00",
			billingPeriodEnd: "2026-07-30T11:11:10.769917+00:00",
		},
	};
}

/** Default billing URL body for unified accounts (monthly included quota). */
function makeUnifiedMonthlyPayload(overrides?: Record<string, unknown>) {
	return {
		config: {
			monthlyLimit: { val: 15000 },
			used: { val: 10548 },
			onDemandCap: { val: 0 },
			billingPeriodStart: "2026-07-01T00:00:00+00:00",
			billingPeriodEnd: "2026-08-01T00:00:00+00:00",
			history: [],
			...overrides,
		},
	};
}

function makeCredential(overrides?: Partial<UsageFetchParams["credential"]>): UsageFetchParams["credential"] {
	return {
		type: "oauth",
		accessToken: accessTokenFixture,
		refreshToken: "refresh-fixture",
		expiresAt: Date.now() + 3_600_000,
		...overrides,
	};
}

function capturingFetch(payload: unknown): {
	fetch: FetchImpl;
	calls: Array<{ url: string; headers: Record<string, string>; redirect?: RequestInit["redirect"] }>;
} {
	const calls: Array<{ url: string; headers: Record<string, string>; redirect?: RequestInit["redirect"] }> = [];
	const fetch: FetchImpl = async (input, init) => {
		const headers: Record<string, string> = {};
		const raw = init?.headers;
		if (raw && typeof raw === "object" && !Array.isArray(raw)) {
			for (const [key, value] of Object.entries(raw as Record<string, string>)) {
				headers[key.toLowerCase()] = value;
			}
		}
		const url = String(input);
		calls.push({ url, headers, redirect: init?.redirect });
		if (url.includes("/oauth2/userinfo")) {
			return new Response(JSON.stringify({ sub: USER_ID, email: "user@example.com" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		return new Response(JSON.stringify(payload), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};
	return { fetch, calls };
}

/** Route credits vs default billing URLs to different live-shaped payloads. */
function dualBillingFetch(
	creditsPayload: unknown,
	monthlyPayload: unknown,
): {
	fetch: FetchImpl;
	calls: Array<{ url: string }>;
} {
	const calls: Array<{ url: string }> = [];
	const fetch: FetchImpl = async input => {
		const url = String(input);
		calls.push({ url });
		if (url.includes("/oauth2/userinfo")) {
			return new Response(JSON.stringify({ sub: USER_ID, email: "user@example.com" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		const payload = url.includes("format=credits") ? creditsPayload : monthlyPayload;
		if (payload === null) {
			return new Response("internal error", { status: 500 });
		}
		return new Response(JSON.stringify(payload), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};
	return { fetch, calls };
}

describe("xai-oauth usage provider", () => {
	it("accepts stored OAuth credentials but never shared API-key fallbacks", () => {
		expect(xaiOauthUsageProvider.supports?.({ provider: "xai-oauth", credential: makeCredential() })).toBe(true);
		expect(
			xaiOauthUsageProvider.supports?.({
				provider: "xai-oauth",
				credential: { type: "api_key", apiKey: accessTokenFixture },
			}),
		).toBe(false);
	});

	it("maps weekly credit and product usage with CLI-aligned billing headers", async () => {
		const { fetch, calls } = capturingFetch(makeBillingPayload());
		const report = await xaiOauthUsageProvider.fetchUsage(
			{ provider: "xai-oauth", credential: makeCredential() },
			{ fetch: fetch },
		);

		expect(report?.limits.map(limit => limit.id)).toEqual([
			"xai-oauth:credits:1w",
			"xai-oauth:product:grokbuild:1w",
			"xai-oauth:product:api:1w",
		]);
		expect(report?.limits[0]?.amount.usedFraction).toBeCloseTo(0.18, 5);
		expect(report?.metadata?.accountId).toBe(USER_ID);
		expect(report?.metadata?.email).toBe("user@example.com");
		expect(report?.metadata?.billingKind).toBe("weekly");

		const billingCall = calls.find(call => call.url.includes("/v1/billing"));
		expect(billingCall?.url).toBe(buildXAICliBillingUrl());
		expect(billingCall?.headers).toEqual({
			authorization: `Bearer ${accessTokenFixture}`,
			accept: "application/json",
			"x-xai-token-auth": "xai-grok-cli",
		});
		expect(billingCall?.redirect).toBe("error");
		// Non-unified weekly path must not issue a second default-format probe.
		expect(calls.filter(call => call.url.includes("/v1/billing"))).toHaveLength(1);
	});

	it("uses a stored email without an extra userinfo request", async () => {
		const { fetch, calls } = capturingFetch(makeBillingPayload());
		const report = await xaiOauthUsageProvider.fetchUsage(
			{
				provider: "xai-oauth",
				credential: makeCredential({ accountId: "stored-account", email: "stored@example.com" }),
			},
			{ fetch: fetch },
		);

		expect(report?.metadata?.accountId).toBe("stored-account");
		expect(report?.metadata?.email).toBe("stored@example.com");
		expect(calls.some(call => call.url.includes("/oauth2/userinfo"))).toBe(false);
	});

	it("maps a positive on-demand cap", async () => {
		const report = await xaiOauthUsageProvider.fetchUsage(
			{
				provider: "xai-oauth",
				credential: makeCredential(),
			},
			{ fetch: capturingFetch(makeBillingPayload({ onDemandCap: { val: 50 }, onDemandUsed: { val: 10 } })).fetch },
		);

		const onDemand = report?.limits.find(limit => limit.id === "xai-oauth:on-demand");
		expect(onDemand?.amount.used).toBe(10);
		expect(onDemand?.amount.limit).toBe(50);
		expect(onDemand?.amount.usedFraction).toBeCloseTo(0.2, 5);
	});

	it("still reports usage when the weekly period has just ended", async () => {
		const periodEnd = new Date(Date.now() - 60_000).toISOString();
		const periodStart = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
		const report = await xaiOauthUsageProvider.fetchUsage(
			{ provider: "xai-oauth", credential: makeCredential() },
			{
				fetch: capturingFetch(
					makeBillingPayload({
						currentPeriod: {
							end: periodEnd,
							start: periodStart,
							type: "USAGE_PERIOD_TYPE_WEEKLY",
						},
					}),
				).fetch,
			},
		);

		expect(report?.limits[0]?.id).toBe("xai-oauth:credits:1w");
		expect(report?.limits[0]?.window?.resetsAt).toBe(Date.parse(periodEnd));
	});
	it("rejects an expired weekly period when creditUsagePercent is omitted", async () => {
		const periodEnd = new Date(Date.now() - 60_000).toISOString();
		const periodStart = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
		const report = await xaiOauthUsageProvider.fetchUsage(
			{ provider: "xai-oauth", credential: makeCredential() },
			{
				fetch: capturingFetch({
					config: {
						currentPeriod: {
							end: periodEnd,
							start: periodStart,
							type: "USAGE_PERIOD_TYPE_WEEKLY",
						},
					},
				}).fetch,
			},
		);

		expect(report).toBeNull();
	});

	it("reports zero usage when weekly period is active but creditUsagePercent is omitted (fresh reset)", async () => {
		const periodEnd = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000).toISOString();
		const periodStart = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
		const report = await xaiOauthUsageProvider.fetchUsage(
			{ provider: "xai-oauth", credential: makeCredential() },
			{
				fetch: capturingFetch({
					config: {
						currentPeriod: {
							end: periodEnd,
							start: periodStart,
							type: "USAGE_PERIOD_TYPE_WEEKLY",
						},
						isUnifiedBillingUser: true,
						onDemandCap: { val: 0 },
						onDemandUsed: { val: 0 },
					},
				}).fetch,
			},
		);

		expect(report?.metadata?.billingKind).toBe("weekly");
		expect(report?.limits.map(limit => limit.id)).toEqual(["xai-oauth:credits:1w"]);
		const credits = report?.limits[0];
		expect(credits?.amount.used).toBe(0);
		expect(credits?.amount.limit).toBe(100);
		expect(credits?.amount.remaining).toBe(100);
		expect(credits?.amount.usedFraction).toBe(0);
		expect(credits?.amount.remainingFraction).toBe(1);
		expect(credits?.status).toBe("ok");
		expect(credits?.window?.resetsAt).toBe(Date.parse(periodEnd));
	});

	it("rejects inferred unified weekly usage when the monthly probe encounters a network error", async () => {
		const periodEnd = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000).toISOString();
		const periodStart = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
		const report = await xaiOauthUsageProvider.fetchUsage(
			{ provider: "xai-oauth", credential: makeCredential() },
			{
				fetch: dualBillingFetch(
					{
						config: {
							currentPeriod: {
								end: periodEnd,
								start: periodStart,
								type: "USAGE_PERIOD_TYPE_WEEKLY",
							},
							isUnifiedBillingUser: true,
						},
					},
					null,
				).fetch,
			},
		);

		expect(report).toBeNull();
	});
	it("rejects inferred unified weekly usage when monthly config has a positive limit but malformed fields", async () => {
		const periodEnd = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000).toISOString();
		const periodStart = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
		const report = await xaiOauthUsageProvider.fetchUsage(
			{ provider: "xai-oauth", credential: makeCredential() },
			{
				fetch: dualBillingFetch(
					{
						config: {
							currentPeriod: {
								end: periodEnd,
								start: periodStart,
								type: "USAGE_PERIOD_TYPE_WEEKLY",
							},
							isUnifiedBillingUser: true,
						},
					},
					{
						config: {
							isUnifiedBillingUser: true,
							monthlyLimit: { val: 15000 },
							// Missing 'used' and billingPeriod dates
						},
					},
				).fetch,
			},
		);

		expect(report).toBeNull();
	});

	it("rejects inferred unified weekly usage when monthly quota evidence is absent", async () => {
		const periodEnd = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000).toISOString();
		const periodStart = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
		const report = await xaiOauthUsageProvider.fetchUsage(
			{ provider: "xai-oauth", credential: makeCredential() },
			{
				fetch: dualBillingFetch(
					{
						config: {
							currentPeriod: {
								end: periodEnd,
								start: periodStart,
								type: "USAGE_PERIOD_TYPE_WEEKLY",
							},
							isUnifiedBillingUser: true,
						},
					},
					{ config: { isUnifiedBillingUser: true } },
				).fetch,
			},
		);

		expect(report).toBeNull();
	});

	it("falls back to monthly included quota when credits has no percent fields", async () => {
		const { fetch, calls } = dualBillingFetch(makeUnifiedCreditsPayload(), makeUnifiedMonthlyPayload());
		const report = await xaiOauthUsageProvider.fetchUsage(
			{
				provider: "xai-oauth",
				credential: makeCredential({ accountId: "stored-account", email: "stored@example.com" }),
			},
			{ fetch },
		);

		expect(calls.map(call => call.url)).toEqual([buildXAICliBillingUrl(), buildXAICliBillingUrl("")]);
		expect(report?.metadata?.billingKind).toBe("monthly");
		expect(report?.metadata?.endpoint).toBe(buildXAICliBillingUrl(""));
		expect(report?.metadata?.accountId).toBe("stored-account");
		expect(report?.metadata?.email).toBe("stored@example.com");
		expect(report?.limits.map(limit => limit.id)).toEqual(["xai-oauth:included:1mo"]);

		const included = report?.limits[0];
		expect(included?.label).toBe("SuperGrok Monthly Included");
		expect(included?.amount.used).toBe(10548);
		expect(included?.amount.limit).toBe(15000);
		expect(included?.amount.remaining).toBe(4452);
		expect(included?.amount.usedFraction).toBeCloseTo(10548 / 15000, 5);
		expect(included?.window?.id).toBe("1mo");
		expect(included?.window?.label).toBe("Monthly");
		expect(included?.window?.resetsAt).toBe(Date.parse("2026-08-01T00:00:00+00:00"));
		expect(included?.status).toBe("ok");
	});

	it("merges weekly credits with monthly included when unified account returns both", async () => {
		const creditsBoth = {
			config: {
				...makeUnifiedCreditsPayload().config,
				creditUsagePercent: 2,
				productUsage: [{ product: "Api", usagePercent: 2 }],
			},
		};
		const { fetch, calls } = dualBillingFetch(creditsBoth, makeUnifiedMonthlyPayload());
		const report = await xaiOauthUsageProvider.fetchUsage(
			{ provider: "xai-oauth", credential: makeCredential({ email: "stored@example.com" }) },
			{ fetch },
		);

		expect(calls.map(call => call.url)).toEqual([buildXAICliBillingUrl(), buildXAICliBillingUrl("")]);
		expect(report?.metadata?.billingKind).toBe("unified");
		expect(report?.limits.map(limit => limit.id)).toEqual([
			"xai-oauth:credits:1w",
			"xai-oauth:product:api:1w",
			"xai-oauth:included:1mo",
		]);
		expect(report?.limits[0]?.amount.usedFraction).toBeCloseTo(0.02, 5);
		expect(report?.limits[2]?.amount.used).toBe(10548);
		expect(report?.limits[2]?.amount.limit).toBe(15000);
	});

	it("maps unified monthly on-demand when the included quota payload carries a positive cap", async () => {
		const report = await xaiOauthUsageProvider.fetchUsage(
			{ provider: "xai-oauth", credential: makeCredential() },
			{
				fetch: dualBillingFetch(
					makeUnifiedCreditsPayload(),
					makeUnifiedMonthlyPayload({ onDemandCap: { val: 100 }, onDemandUsed: { val: 25 } }),
				).fetch,
			},
		);
		expect(report?.limits.map(limit => limit.id)).toEqual(["xai-oauth:included:1mo", "xai-oauth:on-demand"]);
		const onDemand = report?.limits.find(limit => limit.id === "xai-oauth:on-demand");
		expect(onDemand?.amount.used).toBe(25);
		expect(onDemand?.amount.limit).toBe(100);
		expect(onDemand?.amount.usedFraction).toBeCloseTo(0.25, 5);
	});

	it("returns null when both credits and monthly billing shapes are unusable", async () => {
		const creditsUnusable = { config: { isUnifiedBillingUser: true, onDemandCap: { val: 0 } } };
		const report = await xaiOauthUsageProvider.fetchUsage(
			{ provider: "xai-oauth", credential: makeCredential() },
			{
				fetch: dualBillingFetch(creditsUnusable, {
					config: { isUnifiedBillingUser: true, monthlyLimit: { val: 0 }, used: { val: 0 } },
				}).fetch,
			},
		);
		expect(report).toBeNull();
	});

	it("skips expired OAuth tokens and returns null for rejected billing", async () => {
		const expired = await xaiOauthUsageProvider.fetchUsage(
			{ provider: "xai-oauth", credential: makeCredential({ expiresAt: Date.now() - 1 }) },
			{ fetch: capturingFetch(makeBillingPayload()).fetch },
		);
		expect(expired).toBeNull();

		const denied: FetchImpl = async () => new Response("denied", { status: 403 });
		const report = await xaiOauthUsageProvider.fetchUsage(
			{ provider: "xai-oauth", credential: makeCredential() },
			{ fetch: denied },
		);
		expect(report).toBeNull();
	});
});
