import { describe, expect, it } from "bun:test";

import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import type { UsageFetchContext, UsageReport } from "@oh-my-pi/pi-ai/usage";
import { mistralUsageProvider } from "@oh-my-pi/pi-ai/usage/mistral";

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

		// A zero API allowance is no budget at all, not an exhausted one.
		expect(capped?.limits.map(limit => limit.id)).toEqual(["mistral:vibe:monthly"]);
		expect(capped?.limits[0]?.status).toBe("exhausted");
		expect(billed?.limits[0]?.status).toBe("warning");
		expect(billed?.limits[0]?.notes).toEqual(["pay-as-you-go past the allowance"]);
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
});
