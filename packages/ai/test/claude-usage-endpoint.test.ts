import { describe, expect, it } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import type { UsageFetchContext } from "@oh-my-pi/pi-ai/usage";
import { claudeProfilePlan, claudeRankingStrategy, claudeUsageProvider } from "@oh-my-pi/pi-ai/usage/claude";

const CANONICAL_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

const USAGE_PAYLOAD = {
	five_hour: { utilization: 17, resets_at: new Date(Date.now() + 60 * 60_000).toISOString() },
	seven_day: { utilization: 75, resets_at: new Date(Date.now() + 3 * 24 * 60 * 60_000).toISOString() },
	limits: [
		{
			kind: "weekly_scoped",
			percent: 100,
			resets_at: new Date(Date.now() + 3 * 24 * 60 * 60_000).toISOString(),
			scope: { model: { display_name: "Fable" } },
		},
	],
};

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function recordingFetch(handler: (url: string) => Response): { fetch: FetchImpl; urls: string[] } {
	const urls: string[] = [];
	const fetch = (async (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		urls.push(url);
		return handler(url);
	}) as FetchImpl;
	return { fetch, urls };
}

function plainUsageUrls(urls: readonly string[]): string[] {
	return urls.filter(url => {
		const parsed = new URL(url);
		return parsed.pathname.endsWith("/usage") && parsed.search === "";
	});
}

function params(baseUrl?: string) {
	return {
		provider: "anthropic" as const,
		credential: {
			type: "oauth" as const,
			accessToken: "oat-test",
			refreshToken: "refresh-test",
			accountId: "account_test",
			email: "user@example.com",
			expiresAt: Date.now() + 60_000,
		},
		...(baseUrl === undefined ? {} : { baseUrl }),
	};
}

function context(fetch: FetchImpl): UsageFetchContext {
	return { fetch, retryWait: async () => {} };
}

describe("claudeUsageProvider usage endpoint resolution", () => {
	it("falls back to the canonical endpoint when a custom baseUrl does not serve usage", async () => {
		const { fetch, urls } = recordingFetch(url =>
			url === CANONICAL_USAGE_URL ? jsonResponse(200, USAGE_PAYLOAD) : jsonResponse(404, { error: "not_found" }),
		);

		const report = await claudeUsageProvider.fetchUsage(
			params("https://gateway.example.com/claude/v1"),
			context(fetch),
		);

		expect(plainUsageUrls(urls)).toEqual(["https://gateway.example.com/claude/api/oauth/usage", CANONICAL_USAGE_URL]);
		expect(report?.metadata?.endpoint).toBe(CANONICAL_USAGE_URL);
		// The model-scoped weekly row is what rate-limit headers cannot refresh
		// unless the request itself hit that family — it must survive the fallback.
		expect(report?.limits.find(limit => limit.scope.tier === "fable")?.amount.usedFraction).toBe(1);
		expect(report?.limits.find(limit => limit.id === "anthropic:7d")?.amount.usedFraction).toBe(0.75);
	});

	it("keeps a custom baseUrl that does serve usage and never probes the canonical endpoint", async () => {
		const { fetch, urls } = recordingFetch(() => jsonResponse(200, USAGE_PAYLOAD));

		const report = await claudeUsageProvider.fetchUsage(params("https://mirror.example.com/v1"), context(fetch));

		expect(plainUsageUrls(urls)).toEqual(["https://mirror.example.com/api/oauth/usage"]);
		expect(report?.metadata?.endpoint).toBe("https://mirror.example.com/api/oauth/usage");
	});

	it("does not double-request when the configured baseUrl already resolves to the canonical endpoint", async () => {
		const { fetch, urls } = recordingFetch(() => jsonResponse(404, { error: "not_found" }));

		const report = await claudeUsageProvider.fetchUsage(params("https://api.anthropic.com/v1"), context(fetch));

		expect(report).toBeNull();
		expect(plainUsageUrls(urls)).toEqual([CANONICAL_USAGE_URL]);
	});

	it("keeps the request on a custom baseUrl that refuses the credential", async () => {
		const { fetch, urls } = recordingFetch(() => jsonResponse(401, { error: "unauthorized" }));

		const report = await claudeUsageProvider.fetchUsage(params("https://gateway.example.com/v1"), context(fetch));

		// A 401 is the configured host's answer about this account, not a missing
		// endpoint: moving the token to another destination is not ours to decide.
		expect(report).toBeNull();
		expect(plainUsageUrls(urls)).toEqual(["https://gateway.example.com/api/oauth/usage"]);
	});

	it("keeps the request on a custom baseUrl that fails transiently", async () => {
		const { fetch, urls } = recordingFetch(() => jsonResponse(503, { error: "unavailable" }));

		const report = await claudeUsageProvider.fetchUsage(params("https://gateway.example.com/v1"), context(fetch));

		expect(report).toBeNull();
		// Retried on the configured host only; the next poll tries it again.
		expect(plainUsageUrls(urls)).toEqual(
			Array.from({ length: 3 }, () => "https://gateway.example.com/api/oauth/usage"),
		);
	});

	it("falls back when a custom baseUrl answers 200 with an unrelated body", async () => {
		const { fetch, urls } = recordingFetch(url =>
			url === CANONICAL_USAGE_URL ? jsonResponse(200, USAGE_PAYLOAD) : jsonResponse(200, { hello: "world" }),
		);

		const report = await claudeUsageProvider.fetchUsage(params("https://gateway.example.com/v1"), context(fetch));

		expect(plainUsageUrls(urls)).toEqual([
			...Array.from({ length: 3 }, () => "https://gateway.example.com/api/oauth/usage"),
			CANONICAL_USAGE_URL,
		]);
		expect(report?.metadata?.endpoint).toBe(CANONICAL_USAGE_URL);
	});

	it("falls back when a custom baseUrl answers 200 with an SPA index page", async () => {
		const { fetch, urls } = recordingFetch(url =>
			url === CANONICAL_USAGE_URL
				? jsonResponse(200, USAGE_PAYLOAD)
				: new Response("<!doctype html><title>gateway</title>", {
						status: 200,
						headers: { "Content-Type": "text/html" },
					}),
		);

		const report = await claudeUsageProvider.fetchUsage(params("https://gateway.example.com/v1"), context(fetch));

		// A single probe is enough: an HTML 200 is not a usage endpoint having a
		// bad moment, so retrying it only delays the canonical fallback.
		expect(plainUsageUrls(urls)).toEqual(["https://gateway.example.com/api/oauth/usage", CANONICAL_USAGE_URL]);
		expect(report?.metadata?.endpoint).toBe(CANONICAL_USAGE_URL);
	});

	it("falls back when a custom baseUrl answers 200 with an empty body", async () => {
		const { fetch, urls } = recordingFetch(url =>
			url === CANONICAL_USAGE_URL ? jsonResponse(200, USAGE_PAYLOAD) : new Response("", { status: 200 }),
		);

		const report = await claudeUsageProvider.fetchUsage(params("https://gateway.example.com/v1"), context(fetch));

		expect(plainUsageUrls(urls)).toEqual(["https://gateway.example.com/api/oauth/usage", CANONICAL_USAGE_URL]);
		expect(report?.metadata?.endpoint).toBe(CANONICAL_USAGE_URL);
	});

	it("keeps retrying a truncated JSON body on the configured host", async () => {
		const { fetch, urls } = recordingFetch(
			() => new Response('{"five_hour":{"utiliz', { status: 200, headers: { "Content-Type": "application/json" } }),
		);

		const report = await claudeUsageProvider.fetchUsage(params("https://mirror.example.com/v1"), context(fetch));

		// A JSON content type that fails to parse is a damaged response from a host
		// that does serve usage — the request must not move.
		expect(report).toBeNull();
		expect(plainUsageUrls(urls)).toEqual(
			Array.from({ length: 3 }, () => "https://mirror.example.com/api/oauth/usage"),
		);
	});

	it("falls back on 501 without spending retries on it", async () => {
		const { fetch, urls } = recordingFetch(url =>
			url === CANONICAL_USAGE_URL
				? jsonResponse(200, USAGE_PAYLOAD)
				: jsonResponse(501, { error: "not_implemented" }),
		);

		const report = await claudeUsageProvider.fetchUsage(params("https://gateway.example.com/v1"), context(fetch));

		// 501 is a 5xx, but "not implemented" is permanent: absence must outrank
		// the generic transient classification.
		expect(plainUsageUrls(urls)).toEqual(["https://gateway.example.com/api/oauth/usage", CANONICAL_USAGE_URL]);
		expect(report?.metadata?.endpoint).toBe(CANONICAL_USAGE_URL);
	});
});

describe("claudeUsageProvider fast mode availability", () => {
	const FAST_MODE_URL = "https://api.anthropic.com/api/claude_code_penguin_mode";
	const offersFastMode = claudeRankingStrategy.tierGate?.({ serviceTier: "priority" });
	const answering = (status: number, body: unknown) =>
		recordingFetch(url => (url === FAST_MODE_URL ? jsonResponse(status, body) : jsonResponse(200, USAGE_PAYLOAD)));

	it("reads the account's entitlement from Claude's own availability check", async () => {
		const enabled = await claudeUsageProvider.fetchUsage(
			params(),
			context(answering(200, { enabled: true, disabled_reason: null }).fetch),
		);
		const disabled = await claudeUsageProvider.fetchUsage(
			params(),
			context(answering(200, { enabled: false, disabled_reason: "extra_usage_disabled" }).fetch),
		);

		expect(offersFastMode?.(enabled)).toBe(true);
		expect(offersFastMode?.(disabled)).toBe(false);
	});

	it("keeps the previous answer when the check fails, and has none without one", async () => {
		const { fetch } = answering(503, { error: "unavailable" });
		const previousReport = {
			provider: "anthropic" as const,
			fetchedAt: Date.now() - 60_000,
			limits: [],
			metadata: { fastMode: false },
		};

		const carried = await claudeUsageProvider.fetchUsage(params(), { ...context(fetch), previousReport });
		const fresh = await claudeUsageProvider.fetchUsage(params(), context(fetch));

		expect(offersFastMode?.(carried)).toBe(false);
		expect(offersFastMode?.(fresh)).toBeUndefined();
	});

	it("withdraws fast mode while the usage-credit cap is spent", async () => {
		const { fetch } = recordingFetch(url =>
			url === FAST_MODE_URL
				? jsonResponse(200, { enabled: true })
				: jsonResponse(200, {
						...USAGE_PAYLOAD,
						extra_usage: { is_enabled: true, monthly_limit: 5_000, used_credits: 5_000 },
					}),
		);

		const report = await claudeUsageProvider.fetchUsage(params(), context(fetch));

		expect(offersFastMode?.(report)).toBe(false);
	});

	it("leaves requests for other tiers unsteered", () => {
		expect(claudeRankingStrategy.tierGate?.({ serviceTier: "flex" })).toBeUndefined();
	});
});

describe("claudeUsageProvider subscription plan", () => {
	const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
	const profile = (type: string, tier: string) => ({
		organization: { organization_type: type, rate_limit_tier: tier },
	});

	it("labels plans by organization type with the rate-limit tier's multiplier", () => {
		expect(claudeProfilePlan(profile("claude_max", "default_claude_max_20x"))).toBe("Max 20x");
		expect(claudeProfilePlan(profile("claude_max", "default_claude_max_5x"))).toBe("Max 5x");
		expect(claudeProfilePlan(profile("claude_team", "default_claude_max_5x"))).toBe("Team 5x");
		expect(claudeProfilePlan(profile("constructor", "default_claude_max_5x"))).toBe("Max 5x");
		expect(claudeProfilePlan(profile("claude_max", "unrecognised"))).toBe("Max");
		expect(claudeProfilePlan(profile("claude_enterprise", "default_claude_zero"))).toBe("Enterprise");
		expect(claudeProfilePlan(profile("constructor", "default"))).toBeUndefined();
		expect(claudeProfilePlan({ uuid: "no-organization" })).toBeUndefined();
	});

	it("stamps the profile's plan on the report", async () => {
		const { fetch } = recordingFetch(url =>
			url === PROFILE_URL
				? jsonResponse(200, profile("claude_max", "default_claude_max_5x"))
				: jsonResponse(200, USAGE_PAYLOAD),
		);

		const report = await claudeUsageProvider.fetchUsage(params(), context(fetch));

		expect(report?.metadata?.subscriptionPlan).toBe("Max 5x");
	});

	it("keeps the previous report's plan when the profile probe fails, and reports none without one", async () => {
		const { fetch } = recordingFetch(url =>
			url === PROFILE_URL ? jsonResponse(500, { error: "boom" }) : jsonResponse(200, USAGE_PAYLOAD),
		);
		const previousReport = {
			provider: "anthropic" as const,
			fetchedAt: Date.now() - 60_000,
			limits: [],
			metadata: { subscriptionPlan: "Max 20x" },
		};

		const carried = await claudeUsageProvider.fetchUsage(params(), { ...context(fetch), previousReport });
		const fresh = await claudeUsageProvider.fetchUsage(params(), context(fetch));

		expect(carried?.metadata?.subscriptionPlan).toBe("Max 20x");
		expect(fresh?.metadata).not.toHaveProperty("subscriptionPlan");
	});

	it("lets a changed plan replace the previous report's", async () => {
		const { fetch } = recordingFetch(url =>
			url === PROFILE_URL
				? jsonResponse(200, profile("claude_max", "default_claude_max_20x"))
				: jsonResponse(200, USAGE_PAYLOAD),
		);
		const previousReport = {
			provider: "anthropic" as const,
			fetchedAt: Date.now() - 60_000,
			limits: [],
			metadata: { subscriptionPlan: "Max 5x" },
		};

		const report = await claudeUsageProvider.fetchUsage(params(), { ...context(fetch), previousReport });

		expect(report?.metadata?.subscriptionPlan).toBe("Max 20x");
	});
});
