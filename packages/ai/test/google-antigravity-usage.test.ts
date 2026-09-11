/**
 * Antigravity usage provider contract tests. The merge logic
 * deduplicates per-model quota entries by (tier, windowId),
 * preserves reset times when bar data and window data come from
 * different model entries, and handles mixed-case tier names.
 */
import { describe, expect, it } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import type { UsageFetchContext, UsageFetchParams, UsageLimit } from "@oh-my-pi/pi-ai/usage";
import {
	antigravityRankingStrategy,
	antigravityUsageProvider,
	scopeAntigravityLimitsForModel,
} from "@oh-my-pi/pi-ai/usage/google-antigravity";

const accessTokenFixture = (() => {
	const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
	const body = Buffer.from(JSON.stringify({ sub: "user-fixture" })).toString("base64url");
	return `${header}.${body}.sig`;
})();

function makeCredential(overrides?: Partial<UsageFetchParams["credential"]>) {
	return {
		type: "oauth" as const,
		accessToken: accessTokenFixture,
		refreshToken: "refresh-fixture",
		expiresAt: Date.now() + 3600_000,
		projectId: "test-project",
		email: "test@example.com",
		accountId: "acct-1",
		...overrides,
	} satisfies UsageFetchParams["credential"];
}

function fakeFetch(json: unknown): FetchImpl {
	const fn = async () =>
		new Response(JSON.stringify(json), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	return fn;
}

function makeCtx(fetchImpl?: FetchImpl): UsageFetchContext {
	return { fetch: fetchImpl ?? fakeFetch({}) };
}

// ── helpers ──────────────────────────────────────────────────────────

function makeApiModel(
	displayName: string,
	quota: {
		remainingFraction?: number;
		resetTime?: string;
		tier?: string;
		windowId?: string;
		apiProvider?: string;
		modelProvider?: string;
	},
) {
	return {
		displayName,
		apiProvider: quota.apiProvider,
		modelProvider: quota.modelProvider,
		quotaInfo: {
			remainingFraction: quota.remainingFraction,
			resetTime: quota.resetTime,
			tier: quota.tier,
			windowId: quota.windowId,
		},
	};
}

// ── tests ────────────────────────────────────────────────────────────

describe("antigravity usage provider", () => {
	it("reports the official five-hour and weekly quota summary", async () => {
		const requestedUrls: string[] = [];
		const summary = {
			groups: [
				{
					displayName: "Gemini Models",
					buckets: [
						{
							bucketId: "gemini-weekly",
							displayName: "Weekly Limit Remaining",
							window: "weekly",
							remainingFraction: 0.88,
							resetTime: "2026-09-10T00:00:00Z",
						},
						{
							bucketId: "gemini-5h",
							displayName: "Five Hour Limit Remaining",
							window: "5h",
							remainingFraction: 0.59,
							resetTime: "2026-09-03T12:00:00Z",
						},
					],
				},
				{
					displayName: "Claude and GPT models",
					buckets: [
						{
							bucketId: "3p-weekly",
							displayName: "Weekly Limit Remaining",
							window: "weekly",
							remainingFraction: 1,
							resetTime: "2026-09-10T12:00:00Z",
						},
						{
							bucketId: "3p-5h",
							displayName: "Five Hour Limit Remaining",
							window: "5h",
							remainingFraction: 1,
							resetTime: "2026-09-03T15:00:00Z",
						},
					],
				},
			],
		};
		const fetchImpl: FetchImpl = async input => {
			requestedUrls.push(String(input));
			return new Response(JSON.stringify(summary), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};

		const report = await antigravityUsageProvider.fetchUsage!(
			{
				provider: "google-antigravity",
				credential: makeCredential(),
				signal: undefined,
			},
			makeCtx(fetchImpl),
		);

		expect(requestedUrls).toEqual(["https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary"]);
		expect(report?.limits).toHaveLength(6);

		const googleLimits = scopeAntigravityLimitsForModel(report!, { modelId: "gemini-3.8-flash" });
		const weekly = googleLimits.find(limit => limit.scope.windowId === "weekly");
		const fiveHour = googleLimits.find(limit => limit.scope.windowId === "5h");
		expect(weekly?.amount.usedFraction).toBeCloseTo(0.12);
		expect(weekly?.window?.durationMs).toBe(7 * 24 * 60 * 60 * 1000);
		expect(fiveHour?.amount.usedFraction).toBeCloseTo(0.41);
		expect(fiveHour?.window?.label).toBe("5 Hour");
		expect(fiveHour?.window?.durationMs).toBe(5 * 60 * 60 * 1000);

		const claudeLimits = scopeAntigravityLimitsForModel(report!, { modelId: "claude-sonnet-4-6" });
		const gptLimits = scopeAntigravityLimitsForModel(report!, { modelId: "gpt-oss-120b" });
		expect(claudeLimits).toHaveLength(2);
		expect(gptLimits).toHaveLength(2);
		expect(claudeLimits.every(limit => limit.scope.shared === true)).toBeTrue();
		expect(gptLimits.every(limit => limit.scope.shared === true)).toBeTrue();
	});

	it("merges two models with same tier into one limit", async () => {
		const payload = {
			models: {
				modelA: makeApiModel("Model A", {
					remainingFraction: 0.3,
					tier: "premium",
				}),
				modelB: makeApiModel("Model B", {
					remainingFraction: 0.5,
					tier: "premium",
				}),
			},
		};
		const report = await antigravityUsageProvider.fetchUsage!(
			{
				provider: "google-antigravity",
				credential: makeCredential(),
				signal: undefined,
			},
			makeCtx(fakeFetch(payload)),
		);
		expect(report).not.toBeNull();
		expect(report!.limits.length).toBe(1);
	});

	it("keeps the worst remainingFraction when merging same tier", async () => {
		const payload = {
			models: {
				modelA: makeApiModel("Model A", {
					remainingFraction: 0.1,
					tier: "premium",
				}),
				modelB: makeApiModel("Model B", {
					remainingFraction: 0.8,
					tier: "premium",
				}),
			},
		};
		const report = await antigravityUsageProvider.fetchUsage!(
			{
				provider: "google-antigravity",
				credential: makeCredential(),
				signal: undefined,
			},
			makeCtx(fakeFetch(payload)),
		);
		expect(report!.limits.length).toBe(1);
		expect(report!.limits[0]!.amount.remainingFraction).toBe(0.1);
	});

	it("merges mixed-case tier names under lowercased key", async () => {
		const payload = {
			models: {
				modelA: makeApiModel("Model A", {
					remainingFraction: 0.3,
					tier: "Default",
				}),
				modelB: makeApiModel("Model B", {
					remainingFraction: 0.6,
					tier: "default",
				}),
			},
		};
		const report = await antigravityUsageProvider.fetchUsage!(
			{
				provider: "google-antigravity",
				credential: makeCredential(),
				signal: undefined,
			},
			makeCtx(fakeFetch(payload)),
		);
		expect(report!.limits.length).toBe(1);
	});

	it("treats reset-only quota entries as exhausted and preserves reset time", async () => {
		const now = Date.now();
		const resetTime = new Date(now + 4 * 3600_000).toISOString();
		const payload = {
			models: {
				modelA: makeApiModel("Model A", {
					remainingFraction: 0.3,
					tier: "default",
				}),
				modelB: makeApiModel("Model B", {
					remainingFraction: undefined,
					tier: "default",
					resetTime,
				}),
			},
		};
		const report = await antigravityUsageProvider.fetchUsage!(
			{
				provider: "google-antigravity",
				credential: makeCredential(),
				signal: undefined,
			},
			makeCtx(fakeFetch(payload)),
		);
		expect(report!.limits.length).toBe(1);
		expect(report!.limits[0]!.amount.remainingFraction).toBe(0);
		expect(report!.limits[0]!.amount.usedFraction).toBe(1);
		expect(report!.limits[0]!.status).toBe("exhausted");
		expect(report!.limits[0]!.window).toBeDefined();
		expect(report!.limits[0]!.window!.resetsAt).toBeGreaterThan(now);
	});

	it("separates Google and Anthropic backend counters", async () => {
		const now = Date.now();
		const resetTime = new Date(now + 4 * 3600_000).toISOString();
		const payload = {
			models: {
				claude: makeApiModel("Claude", {
					remainingFraction: 1,
					modelProvider: "MODEL_PROVIDER_ANTHROPIC",
					apiProvider: "API_PROVIDER_ANTHROPIC_VERTEX",
				}),
				gemini: makeApiModel("Gemini", {
					remainingFraction: undefined,
					resetTime,
					modelProvider: "MODEL_PROVIDER_GOOGLE",
					apiProvider: "API_PROVIDER_GOOGLE_GEMINI",
				}),
			},
		};
		const report = await antigravityUsageProvider.fetchUsage!(
			{
				provider: "google-antigravity",
				credential: makeCredential(),
				signal: undefined,
			},
			makeCtx(fakeFetch(payload)),
		);
		expect(report!.limits.length).toBe(2);
		const googleLimit = report!.limits.find(limit => limit.label === "Usage (Google)");
		const anthropicLimit = report!.limits.find(limit => limit.label === "Usage (Anthropic)");
		expect(googleLimit?.amount.remainingFraction).toBe(0);
		expect(googleLimit?.status).toBe("exhausted");
		expect(anthropicLimit?.amount.remainingFraction).toBe(1);
		expect(anthropicLimit?.status).toBe("ok");
	});

	it("separates models with different windowIds in the same tier", async () => {
		const now = Date.now();
		const t1 = new Date(now + 5 * 3600_000).toISOString();
		const t2 = new Date(now + 24 * 3600_000).toISOString();
		const payload = {
			models: {
				modelA: makeApiModel("Model A", {
					remainingFraction: 0.3,
					tier: "premium",
					windowId: "5h",
					resetTime: t1,
				}),
				modelB: makeApiModel("Model B", {
					remainingFraction: 0.7,
					tier: "premium",
					windowId: "daily",
					resetTime: t2,
				}),
			},
		};
		const report = await antigravityUsageProvider.fetchUsage!(
			{
				provider: "google-antigravity",
				credential: makeCredential(),
				signal: undefined,
			},
			makeCtx(fakeFetch(payload)),
		);
		expect(report!.limits.length).toBe(2);
	});

	it("surfaces named daily and weekly quota windows as separate limits", async () => {
		const now = Date.now();
		const dailyReset = new Date(now + 12 * 3600_000).toISOString();
		const weeklyReset = new Date(now + 6 * 24 * 3600_000).toISOString();
		const payload = {
			models: {
				gemini: {
					displayName: "Gemini",
					modelProvider: "MODEL_PROVIDER_GOOGLE",
					quotaInfo: {
						remainingFraction: 0.8,
						resetTime: dailyReset,
						windowId: "WINDOW_DAILY",
					},
					weeklyQuotaInfo: { remainingFraction: 0.4, resetTime: weeklyReset },
				},
			},
		};
		const report = await antigravityUsageProvider.fetchUsage!(
			{
				provider: "google-antigravity",
				credential: makeCredential(),
				signal: undefined,
			},
			makeCtx(fakeFetch(payload)),
		);

		const daily = report!.limits.find(limit => limit.scope.windowId === "daily");
		const weekly = report!.limits.find(limit => limit.scope.windowId === "weekly");
		expect(report!.limits.length).toBe(2);
		expect(daily?.label).toBe("Usage (Google)");
		expect(daily?.window?.label).toBe("Daily");
		expect(daily?.window?.durationMs).toBe(24 * 60 * 60 * 1000);
		expect(daily?.amount.remainingFraction).toBe(0.8);
		expect(weekly?.label).toBe("Usage (Google)");
		expect(weekly?.window?.label).toBe("Weekly");
		expect(weekly?.window?.durationMs).toBe(7 * 24 * 60 * 60 * 1000);
		expect(weekly?.amount.remainingFraction).toBe(0.4);
	});
	it("drops unmetered autocomplete entries when the counter is weekly-exhausted", async () => {
		const now = Date.now();
		const weeklyReset = new Date(now + 5 * 24 * 3600_000).toISOString();
		const payload = {
			models: {
				"gemini-3-flash": makeApiModel("Gemini", {
					resetTime: weeklyReset,
					modelProvider: "MODEL_PROVIDER_GOOGLE",
				}),
				tab_flash_lite_preview: makeApiModel("Tab", {
					remainingFraction: 1,
					modelProvider: "MODEL_PROVIDER_GOOGLE",
				}),
			},
		};
		const report = await antigravityUsageProvider.fetchUsage!(
			{
				provider: "google-antigravity",
				credential: makeCredential(),
				signal: undefined,
			},
			makeCtx(fakeFetch(payload)),
		);

		expect(report!.limits).toHaveLength(1);
		expect(report!.limits[0]!.scope.windowId).toBe("weekly");
		expect(report!.limits[0]!.status).toBe("exhausted");
	});

	it("keeps near-reset unlabeled weekly windows separate from daily windows", async () => {
		const now = Date.now();
		const dailyReset = new Date(now + 5 * 3600_000).toISOString();
		const weeklyReset = new Date(now + 23 * 3600_000).toISOString();
		const payload = {
			models: {
				gemini: {
					displayName: "Gemini",
					modelProvider: "MODEL_PROVIDER_GOOGLE",
					quotaInfos: [
						{ remainingFraction: 0.9, resetTime: dailyReset },
						{ remainingFraction: 0.3, resetTime: weeklyReset },
					],
				},
			},
		};
		const report = await antigravityUsageProvider.fetchUsage!(
			{
				provider: "google-antigravity",
				credential: makeCredential(),
				signal: undefined,
			},
			makeCtx(fakeFetch(payload)),
		);

		const daily = report!.limits.find(limit => limit.scope.windowId === "daily");
		const weekly = report!.limits.find(limit => limit.scope.windowId === "weekly");
		expect(report!.limits).toHaveLength(2);
		expect(daily?.window?.label).toBe("Daily");
		expect(daily?.amount.remainingFraction).toBe(0.9);
		expect(weekly?.window?.label).toBe("Weekly");
		expect(weekly?.amount.remainingFraction).toBe(0.3);
	});

	it("normalizes 7 Day window ids to the weekly usage window", async () => {
		const payload = {
			models: {
				gemini: {
					displayName: "Gemini",
					modelProvider: "MODEL_PROVIDER_GOOGLE",
					quotaInfoByWindow: {
						WINDOW_7_DAY: { remainingFraction: 0.6 },
					},
				},
			},
		};
		const report = await antigravityUsageProvider.fetchUsage!(
			{
				provider: "google-antigravity",
				credential: makeCredential(),
				signal: undefined,
			},
			makeCtx(fakeFetch(payload)),
		);

		expect(report!.limits).toHaveLength(1);
		expect(report!.limits[0]!.scope.windowId).toBe("weekly");
		expect(report!.limits[0]!.window?.label).toBe("Weekly");
	});

	it("includes email and projectId in report metadata", async () => {
		const payload = {
			models: { m: makeApiModel("M", { remainingFraction: 1 }) },
		};
		const report = await antigravityUsageProvider.fetchUsage!(
			{
				provider: "google-antigravity",
				credential: makeCredential({
					email: "user@example.com",
					projectId: "proj-1",
				}),
				signal: undefined,
			},
			makeCtx(fakeFetch(payload)),
		);
		expect(report!.metadata?.email).toBe("user@example.com");
		expect(report!.metadata?.projectId).toBe("proj-1");
	});

	it("does not include email when credential has none", async () => {
		const payload = {
			models: { m: makeApiModel("M", { remainingFraction: 1 }) },
		};
		const report = await antigravityUsageProvider.fetchUsage!(
			{
				provider: "google-antigravity",
				credential: makeCredential({ email: undefined }),
				signal: undefined,
			},
			makeCtx(fakeFetch(payload)),
		);
		expect(report!.metadata?.email).toBeUndefined();
	});

	it("sorts limits by remainingFraction ascending (worst first)", async () => {
		const payload = {
			models: {
				modelA: makeApiModel("Model A", {
					remainingFraction: 0.9,
					tier: "high",
				}),
				modelB: makeApiModel("Model B", {
					remainingFraction: 0.2,
					tier: "low",
				}),
				modelC: makeApiModel("Model C", {
					remainingFraction: 0.5,
					tier: "mid",
				}),
			},
		};
		const report = await antigravityUsageProvider.fetchUsage!(
			{
				provider: "google-antigravity",
				credential: makeCredential(),
				signal: undefined,
			},
			makeCtx(fakeFetch(payload)),
		);
		expect(report!.limits.length).toBe(3);
		expect(report!.limits[0]!.amount.remainingFraction).toBe(0.2);
		expect(report!.limits[1]!.amount.remainingFraction).toBe(0.5);
		expect(report!.limits[2]!.amount.remainingFraction).toBe(0.9);
	});

	it("returns null when credential has no projectId", async () => {
		const report = await antigravityUsageProvider.fetchUsage!(
			{
				provider: "google-antigravity",
				credential: makeCredential({ projectId: undefined }),
				signal: undefined,
			},
			makeCtx(),
		);
		expect(report).toBeNull();
	});
});

describe("antigravity ranking strategy", () => {
	function makeLimit(remainingFraction: number, label = "Usage"): UsageLimit {
		const usedFraction = 1 - remainingFraction;
		return {
			id: `google-antigravity:${label.toLowerCase()}`,
			label,
			scope: { provider: "google-antigravity" },
			amount: {
				unit: "percent",
				remainingFraction,
				usedFraction,
				remaining: remainingFraction * 100,
				used: usedFraction * 100,
				limit: 100,
			},
			status: remainingFraction <= 0 ? "exhausted" : remainingFraction <= 0.1 ? "warning" : "ok",
		};
	}

	it("maps the most-pressured counter to primary and leaves secondary unset", () => {
		// fetchAntigravityUsage sorts ascending by remainingFraction, so a real
		// report's limits[0] is always the bottleneck. AuthStorage compares the
		// secondary ranking metrics before primary; leaving secondary unset makes
		// every Antigravity candidate tie there, so the bottleneck counter in
		// primary decides — otherwise [5%, 90%] remaining can beat [40%, 40%]
		// because the runner-up counter looks healthier.
		const report = {
			provider: "google-antigravity" as const,
			fetchedAt: Date.now(),
			limits: [makeLimit(0.05, "Anthropic"), makeLimit(0.4, "Google"), makeLimit(0.9, "OpenAI")],
		};
		const { primary, secondary } = antigravityRankingStrategy.findWindowLimits(report);
		expect(primary?.label).toBe("Anthropic");
		expect(secondary).toBeUndefined();
	});

	it("lets a weekly Antigravity quota become the ranking bottleneck", () => {
		const daily = makeLimit(0.8, "Google Daily");
		const weekly = makeLimit(0.2, "Google Weekly");
		daily.scope.windowId = "daily";
		daily.window = {
			id: "daily",
			label: "Daily",
			durationMs: 24 * 60 * 60 * 1000,
		};
		weekly.scope.windowId = "weekly";
		weekly.window = {
			id: "weekly",
			label: "Weekly",
			durationMs: 7 * 24 * 60 * 60 * 1000,
		};
		const report = {
			provider: "google-antigravity" as const,
			fetchedAt: Date.now(),
			limits: [weekly, daily],
		};

		const { primary, secondary } = antigravityRankingStrategy.findWindowLimits(report);
		expect(primary).toBe(weekly);
		expect(secondary).toBeUndefined();
	});

	it("returns undefined windows when the credential has no usage limits", () => {
		const report = {
			provider: "google-antigravity" as const,
			fetchedAt: Date.now(),
			limits: [],
		};
		const { primary, secondary } = antigravityRankingStrategy.findWindowLimits(report);
		expect(primary).toBeUndefined();
		expect(secondary).toBeUndefined();
	});

	it("uses a 24h window default for drain-rate normalisation", () => {
		// Antigravity's API exposes resetTime but not durationMs, so AuthStorage's
		// drain-rate calculator falls back to windowDefaults. The constant has to
		// match the daily quota Antigravity actually applies; if it drifts, two
		// credentials with identical headroom but different windowIds will be
		// ranked unfairly.
		expect(antigravityRankingStrategy.windowDefaults.primaryMs).toBe(24 * 60 * 60 * 1000);
		expect(antigravityRankingStrategy.windowDefaults.secondaryMs).toBe(24 * 60 * 60 * 1000);
	});
});
