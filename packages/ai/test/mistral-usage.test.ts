import { describe, expect, it } from "bun:test";

import { AuthStorage, type AuthCredentialStore, type StoredAuthCredential } from "@oh-my-pi/pi-ai/auth-storage";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import type { UsageFetchContext, UsageLimit, UsageProvider, UsageReport } from "@oh-my-pi/pi-ai/usage";
import { mistralRankingStrategy, mistralUsageProvider } from "@oh-my-pi/pi-ai/usage/mistral";
import { defaultRankingStrategy, defaultUsageProvider } from "@oh-my-pi/pi-ai/usage/registry";

// Live `/v1/billing/*` answers for a Mistral Education (EDU) plan key.
const EDU_BUDGET = {
	vibe_budget: {
		usage_percentage: 6.0,
		initial_budget: 150.0,
		currency: "USD",
		reset_at: "2026-12-01T00:00:00Z",
		payg_enabled: false,
	},
	api_budget: {
		usage_percentage: 0.0,
		initial_budget: 15.0,
		currency: "USD",
		reset_at: "2026-12-01T00:00:00Z",
		payg_enabled: false,
	},
	usage_percentage: 0.0,
	initial_budget: 15.0,
	currency: "USD",
	reset_at: "2026-12-01T00:00:00Z",
};
const EDU_SUBSCRIPTION = { plan_name: "EDU", payg_enabled: false, vibe_payg_enabled: false, enterprise: false };

type Route = { status: number; body: unknown };

type Seen = { url: string; authorization: string | null };

function makeCtx(routes: { budget: Route; subscription: Route }, seen: Seen[] = []): UsageFetchContext {
	const fetch: FetchImpl = async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		seen.push({ url, authorization: new Headers(init?.headers).get("authorization") });
		const route = url.endsWith("/billing/budget") ? routes.budget : routes.subscription;
		return new Response(JSON.stringify(route.body), { status: route.status });
	};
	return { fetch };
}

function fetchUsage(ctx: UsageFetchContext, baseUrl?: string): Promise<UsageReport | null> {
	return mistralUsageProvider.fetchUsage(
		{ provider: "mistral", credential: { type: "api_key", apiKey: "mistral-key" }, baseUrl },
		ctx,
	);
}

function makeStore(rows: StoredAuthCredential[]): AuthCredentialStore {
	const cache = new Map<string, { value: string; expiresAtSec: number }>();
	return {
		close() {},
		listAuthCredentials: provider => rows.filter(row => provider === undefined || row.provider === provider),
		updateAuthCredential() {},
		async deleteAuthCredential() {
			return false;
		},
		tryDisableAuthCredentialIfMatches: () => false,
		replaceAuthCredentials: async () => rows,
		upsertAuthCredential: async () => rows,
		async deleteAuthCredentials() {},
		getCredentialBlock: () => undefined,
		getCache(key) {
			const entry = cache.get(key);
			return entry && entry.expiresAtSec * 1000 > Date.now() ? entry.value : null;
		},
		setCache(key, value, expiresAtSec) {
			cache.set(key, { value, expiresAtSec });
		},
		cleanExpiredCache() {},
	};
}

describe("mistral usage provider", () => {
	it("reports the Vibe Code and API monthly budgets in dollars with the plan title", async () => {
		const seen: Seen[] = [];
		const report = await fetchUsage(
			makeCtx(
				{ budget: { status: 200, body: EDU_BUDGET }, subscription: { status: 200, body: EDU_SUBSCRIPTION } },
				seen,
			),
			"https://api.mistral.ai/v1/",
		);

		expect(seen.map(request => request.url).sort()).toEqual([
			"https://api.mistral.ai/v1/billing/budget",
			"https://api.mistral.ai/v1/billing/subscription",
		]);
		expect(seen.every(request => request.authorization === "Bearer mistral-key")).toBe(true);
		expect(report?.metadata?.planType).toBe("Student");
		expect(report?.limits.map(limit => limit.label)).toEqual(["Vibe Code", "API"]);

		const vibe = report!.limits[0]!;
		expect(vibe.amount).toMatchObject({ used: 9, limit: 150, remaining: 141, usedFraction: 0.06, unit: "usd" });
		expect(vibe.status).toBe("ok");
		expect(vibe.window?.resetsAt).toBe(Date.parse("2026-12-01T00:00:00Z"));
	});

	it("uses the canonical /v1 routes for a missing, blank, or host-only base URL", async () => {
		const urls: string[] = [];
		for (const baseUrl of [undefined, "   ", "https://api.mistral.ai"]) {
			const seen: Seen[] = [];
			await fetchUsage(
				makeCtx(
					{ budget: { status: 200, body: EDU_BUDGET }, subscription: { status: 200, body: EDU_SUBSCRIPTION } },
					seen,
				),
				baseUrl,
			);
			urls.push(...seen.map(request => request.url));
		}
		expect(urls).toEqual([
			"https://api.mistral.ai/v1/billing/budget",
			"https://api.mistral.ai/v1/billing/subscription",
			"https://api.mistral.ai/v1/billing/budget",
			"https://api.mistral.ai/v1/billing/subscription",
			"https://api.mistral.ai/v1/billing/budget",
			"https://api.mistral.ai/v1/billing/subscription",
		]);
	});

	it("stops at an exhausted allowance only without pay-as-you-go", async () => {
		const overBudget = {
			vibe_budget: { usage_percentage: 105, initial_budget: 150, currency: "USD", reset_at: "2026-12-01T00:00:00Z" },
			api_budget: { usage_percentage: 0, initial_budget: 0, currency: "USD", reset_at: "2026-12-01T00:00:00Z" },
		};
		const capped = await fetchUsage(
			makeCtx({
				budget: { status: 200, body: overBudget },
				subscription: { status: 200, body: EDU_SUBSCRIPTION },
			}),
		);
		// The budget omits payg_enabled, so the subscription's vibe_payg_enabled decides.
		const billed = await fetchUsage(
			makeCtx({
				budget: { status: 200, body: overBudget },
				subscription: { status: 200, body: { ...EDU_SUBSCRIPTION, vibe_payg_enabled: true } },
			}),
		);
		// An explicit per-budget false outranks the subscription flag.
		const budgetOptOut = await fetchUsage(
			makeCtx({
				budget: {
					status: 200,
					body: { ...overBudget, vibe_budget: { ...overBudget.vibe_budget, payg_enabled: false } },
				},
				subscription: { status: 200, body: { ...EDU_SUBSCRIPTION, vibe_payg_enabled: true } },
			}),
		);
		// PAYG enabled under the allowance stays quiet: the note only explains overage.
		const belowAllowance = await fetchUsage(
			makeCtx({
				budget: {
					status: 200,
					body: { ...EDU_BUDGET, vibe_budget: { ...EDU_BUDGET.vibe_budget, payg_enabled: true } },
				},
				subscription: { status: 200, body: EDU_SUBSCRIPTION },
			}),
		);

		// A zero API allowance is no budget at all, not an exhausted one.
		expect(capped?.limits.map(limit => limit.id)).toEqual(["mistral:vibe:monthly"]);
		expect(capped?.limits[0]?.status).toBe("exhausted");
		expect(billed?.limits[0]?.status).toBe("warning");
		expect(billed?.limits[0]?.notes).toEqual(["pay-as-you-go past the allowance"]);
		expect(budgetOptOut?.limits[0]?.status).toBe("exhausted");
		expect(belowAllowance?.limits[0]?.notes).toBeUndefined();
	});

	it("uses the subscription pay-as-you-go flag for the API budget", async () => {
		const overApi = {
			vibe_budget: { usage_percentage: 0, initial_budget: 0, currency: "USD", reset_at: "2026-12-01T00:00:00Z" },
			api_budget: {
				usage_percentage: 120,
				initial_budget: 15,
				currency: "USD",
				reset_at: "2026-12-01T00:00:00Z",
				payg_enabled: true,
			},
		};
		const planFlagOff = await fetchUsage(
			makeCtx({
				budget: { status: 200, body: overApi },
				subscription: { status: 200, body: EDU_SUBSCRIPTION },
			}),
		);
		const planFlagOn = await fetchUsage(
			makeCtx({
				budget: { status: 200, body: overApi },
				subscription: { status: 200, body: { ...EDU_SUBSCRIPTION, payg_enabled: true } },
			}),
		);

		// `BudgetDetail.payg_enabled` is only meaningful for the Vibe budget, so the
		// API budget follows the subscription's plan-level flag.
		expect(planFlagOff?.limits[0]?.status).toBe("exhausted");
		expect(planFlagOn?.limits[0]?.status).toBe("warning");
	});

	it("shows no usage when the key may not read the organization's budget", async () => {
		const report = await fetchUsage(
			makeCtx({
				budget: { status: 403, body: { detail: "Forbidden" } },
				subscription: { status: 200, body: EDU_SUBSCRIPTION },
			}),
		);
		expect(report).toBeNull();
	});

	it("rejects a revoked key so the cached report is purged instead of re-served", async () => {
		const ctx = makeCtx({
			budget: { status: 401, body: { detail: "Invalid API Key" } },
			subscription: { status: 401, body: { detail: "Invalid API Key" } },
		});
		await expect(fetchUsage(ctx)).rejects.toMatchObject({ status: 401 });
	});

	it("keeps the budget when the subscription read fails, and names a non-USD currency", async () => {
		const report = await fetchUsage(
			makeCtx({
				budget: {
					status: 200,
					body: {
						vibe_budget: {
							usage_percentage: 40,
							initial_budget: 300,
							currency: "EUR",
							reset_at: "2026-12-01T00:00:00Z",
						},
						api_budget: {
							usage_percentage: 0,
							initial_budget: 0,
							currency: "EUR",
							reset_at: "2026-12-01T00:00:00Z",
						},
					},
				},
				subscription: { status: 500, body: {} },
			}),
		);

		expect(report?.metadata?.planType).toBeUndefined();
		expect(report?.limits).toHaveLength(1);
		expect(report?.limits[0]?.amount).toMatchObject({ used: 40, limit: 100, usedFraction: 0.4, unit: "percent" });
		expect(report?.limits[0]?.notes).toEqual(["300 EUR monthly budget"]);
	});

	it("shows the plan title when the organization has no allowance", async () => {
		const noAllowance = {
			vibe_budget: { usage_percentage: 0, initial_budget: 0, currency: "USD", reset_at: "2026-12-01T00:00:00Z" },
			api_budget: { usage_percentage: 0, initial_budget: 0, currency: "USD", reset_at: "2026-12-01T00:00:00Z" },
		};
		const report = await fetchUsage(
			makeCtx({
				budget: { status: 200, body: noAllowance },
				subscription: { status: 200, body: { plan_name: "FREE" } },
			}),
		);
		const withoutPlan = await fetchUsage(
			makeCtx({
				budget: { status: 200, body: noAllowance },
				subscription: { status: 500, body: {} },
			}),
		);

		expect(report?.limits).toEqual([]);
		expect(report?.metadata?.planType).toBe("Free");
		expect(withoutPlan).toBeNull();
	});

	it("strips terminal control characters from the currency and plan name", async () => {
		const report = await fetchUsage(
			makeCtx({
				budget: {
					status: 200,
					body: {
						vibe_budget: {
							usage_percentage: 10,
							initial_budget: 300,
							currency: "EU\u001b[31mR",
							reset_at: "2026-12-01T00:00:00Z",
						},
					},
				},
				subscription: { status: 200, body: { plan_name: "TEAM\u0007" } },
			}),
		);
		const emptyCurrency = await fetchUsage(
			makeCtx({
				budget: {
					status: 200,
					body: {
						vibe_budget: {
							usage_percentage: 10,
							initial_budget: 300,
							currency: "\u001b[31m",
							reset_at: "2026-12-01T00:00:00Z",
						},
					},
				},
				subscription: { status: 200, body: { plan_name: "TEAM" } },
			}),
		);

		expect(report?.metadata?.planType).toBe("Team");
		expect(report?.limits[0]?.notes).toEqual(["300 EUR monthly budget"]);
		expect(emptyCurrency?.limits[0]?.notes).toEqual(["300 (unknown currency) monthly budget"]);
	});

	it("keeps a Vibe sign-in key healthy when only the API allowance is exhausted", async () => {
		const limits: UsageLimit[] = [
			{
				id: "mistral:vibe:monthly",
				label: "Vibe Code",
				scope: { provider: "mistral", windowId: "monthly", shared: true },
				amount: { usedFraction: 0.5, unit: "usd" },
				status: "ok",
			},
			{
				id: "mistral:api:monthly",
				label: "API",
				scope: { provider: "mistral", windowId: "monthly", shared: true },
				amount: { usedFraction: 1, unit: "usd" },
				status: "exhausted",
			},
		];
		const usageProvider: UsageProvider = {
			id: "mistral",
			fetchUsage: async () => ({ provider: "mistral", fetchedAt: Date.now(), limits }),
		};
		const storage = new AuthStorage(
			makeStore([
				{
					id: 1,
					provider: "mistral",
					credential: { type: "api_key", key: "mistral-key", source: "login" },
					disabledCause: null,
				},
			]),
			{
				usageProviderResolver: provider => (provider === "mistral" ? usageProvider : undefined),
				rankingStrategyResolver: provider => (provider === "mistral" ? mistralRankingStrategy : undefined),
			},
		);

		try {
			await storage.credentials.reload();
			const health = await storage.health.model("mistral", {
				modelId: "mistral-large-latest",
				reserveFraction: 0.1,
			});
			// The strategy scopes the reserve check to the Vibe budget, so a drained API
			// allowance cannot mark this key depleted.
			expect(health.state).toBe("healthy");
		} finally {
			storage.close();
		}
	});

	it("is registered as the default usage provider and ranking strategy for mistral", () => {
		expect(defaultUsageProvider("mistral")).toBe(mistralUsageProvider);
		expect(defaultRankingStrategy("mistral")).toBe(mistralRankingStrategy);
	});
});
