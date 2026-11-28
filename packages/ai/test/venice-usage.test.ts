import { describe, expect, it } from "bun:test";

import { type } from "@oh-my-pi/omptype";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { type UsageFetchParams, usageReportSchema } from "@oh-my-pi/pi-ai/usage";
import { veniceUsageProvider } from "@oh-my-pi/pi-ai/usage/venice";

const RATE_LIMITS_FIXTURE = {
	data: {
		accessPermitted: true,
		apiTier: { id: "ultra", isCharged: true },
		balances: { USD: 0, DIEM: 0.03181079, BUNDLED_CREDITS: 12.5 },
		keyExpiration: null,
		nextEpochBegins: "2026-11-24T00:00:00.000Z",
		rateLimits: [{ apiModelId: "qwen3-4b", rateLimits: [{ amount: 100, type: "RPM" }] }],
	},
};

function makeParams(provider: "venice" | "openai" = "venice", type: "api_key" | "oauth" = "api_key"): UsageFetchParams {
	return { provider, credential: { type, apiKey: type === "api_key" ? "vapi_test" : undefined } };
}

describe("venice usage provider", () => {
	it("reads balances from the regular key endpoint without requesting billing data", async () => {
		const requests: Array<[string, string, string | null]> = [];
		const fetch: FetchImpl = async (url, init) => {
			requests.push([String(url), init?.method ?? "GET", new Headers(init?.headers).get("Authorization")]);
			return Response.json(RATE_LIMITS_FIXTURE);
		};
		const report = await veniceUsageProvider.fetchUsage(makeParams(), { fetch });
		expect(requests).toEqual([["https://api.venice.ai/api/v1/api_keys/rate_limits", "GET", "Bearer vapi_test"]]);
		expect(report?.limits).toMatchObject([
			{ id: "venice:usd", label: "USD balance", amount: { remaining: 0, unit: "usd" }, status: "ok" },
			{
				label: "DIEM balance",
				amount: { remaining: 0.03181079, unit: "credits" },
				status: "ok",
				window: { resetsAt: Date.parse("2026-11-24T00:00:00.000Z") },
			},
			{ label: "Bundled credits", amount: { remaining: 12.5, unit: "usd" }, status: "ok" },
		]);
		expect(report?.limits[1].amount.usedFraction).toBeUndefined();
	});

	it("keeps reported balances visible when Venice denies inference, without adding a zero bundled balance", async () => {
		const fetch: FetchImpl = async () =>
			Response.json({
				data: {
					...RATE_LIMITS_FIXTURE.data,
					accessPermitted: false,
					balances: { USD: 10, DIEM: 1, BUNDLED_CREDITS: 0 },
					nextEpochBegins: "unknown",
				},
			});
		const report = await veniceUsageProvider.fetchUsage(makeParams(), { fetch });
		const validated = usageReportSchema(report);
		expect(validated instanceof type.errors ? validated.summary : "valid").toBe("valid");
		expect(report?.limits).toMatchObject([
			{ label: "USD balance", amount: { remaining: 10 }, status: "exhausted" },
			{ label: "DIEM balance", amount: { remaining: 1 }, status: "exhausted" },
		]);
	});

	it.each([401, 403])(
		"throws a typed auth error for HTTP %i so the usage cache can discard stale balances",
		async status => {
			const fetch: FetchImpl = async () => new Response(null, { status });
			expect(await veniceUsageProvider.fetchUsage(makeParams(), { fetch }).catch(error => error)).toMatchObject({
				name: "ProviderHttpError",
				status,
			});
		},
	);

	it("returns no fresh usage report on a temporary server error", async () => {
		const fetch: FetchImpl = async () => new Response("boom", { status: 500 });
		const report = await veniceUsageProvider.fetchUsage(makeParams(), { fetch });
		expect(report).toBeNull();
	});

	it("non-venice provider → null", async () => {
		const report = await veniceUsageProvider.fetchUsage(makeParams("openai"), {
			fetch: async () => Response.json(RATE_LIMITS_FIXTURE),
		});
		expect(report).toBeNull();
	});

	it("oauth credential → null", async () => {
		const report = await veniceUsageProvider.fetchUsage(makeParams("venice", "oauth"), {
			fetch: async () => Response.json(RATE_LIMITS_FIXTURE),
		});
		expect(report).toBeNull();
	});

	it("thrown fetch → null", async () => {
		const fetch: FetchImpl = async () => {
			throw new Error("Network error");
		};
		const report = await veniceUsageProvider.fetchUsage(makeParams(), { fetch });
		expect(report).toBeNull();
	});
});
