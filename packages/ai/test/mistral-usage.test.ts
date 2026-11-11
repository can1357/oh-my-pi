import { describe, expect, it } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { mistralUsageProvider } from "../src/usage/mistral";

// Shape returned by `GET https://api.mistral.ai/v1/billing/budget` for a Vibe individual plan.
const BUDGET_PAYLOAD = {
	vibe_budget: {
		usage_percentage: 15.35,
		initial_budget: 255.0,
		currency: "EUR",
		reset_at: "2026-12-01T00:00:00Z",
		payg_enabled: false,
	},
	api_budget: {
		usage_percentage: 0.0,
		initial_budget: 25.5,
		currency: "EUR",
		reset_at: "2026-12-01T00:00:00Z",
		payg_enabled: false,
	},
	usage_percentage: 0.0,
	initial_budget: 25.5,
	currency: "EUR",
	reset_at: "2026-12-01T00:00:00Z",
};

function respond(body: unknown, status = 200, calls: string[] = []): FetchImpl {
	return (async (input: string | URL | Request) => {
		calls.push(String(input));
		return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
	}) as FetchImpl;
}

const params = { provider: "mistral", credential: { type: "api_key" as const, apiKey: "mk-test" } };

describe("mistral usage provider", () => {
	it("maps the Vibe Code and API budgets to monthly percent limits", async () => {
		const calls: string[] = [];
		const report = await mistralUsageProvider.fetchUsage(
			{ ...params, baseUrl: "https://api.mistral.ai/v1/" },
			{ fetch: respond(BUDGET_PAYLOAD, 200, calls) },
		);
		expect(calls).toEqual(["https://api.mistral.ai/v1/billing/budget"]);
		expect(report?.limits.map(limit => [limit.label, limit.amount.used, limit.window?.resetsAt])).toEqual([
			["Vibe Code Monthly", 15.35, Date.parse("2026-12-01T00:00:00Z")],
			["API Monthly", 0, Date.parse("2026-12-01T00:00:00Z")],
		]);
		expect(report?.limits[0]?.notes).toEqual(["Monthly budget: 255 EUR"]);
	});

	it("omits an absent budget and keeps pay-as-you-go overage non-exhausted", async () => {
		const report = await mistralUsageProvider.fetchUsage(params, {
			fetch: respond({ vibe_budget: { ...BUDGET_PAYLOAD.vibe_budget, usage_percentage: 120, payg_enabled: true } }),
		});
		expect(report?.limits.map(limit => [limit.label, limit.status])).toEqual([["Vibe Code Monthly", "warning"]]);
	});

	it("rejects an invalid key but treats a missing usage permission as unknown", async () => {
		await expect(mistralUsageProvider.fetchUsage(params, { fetch: respond({}, 401) })).rejects.toMatchObject({
			status: 401,
		});
		expect(await mistralUsageProvider.fetchUsage(params, { fetch: respond({}, 403) })).toBeNull();
	});
});
