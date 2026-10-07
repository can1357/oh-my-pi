import { describe, expect, it } from "bun:test";

import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import type { UsageFetchContext, UsageFetchParams } from "@oh-my-pi/pi-ai/usage";
import { ProviderHttpError } from "../src/error";
import { aiandUsageProvider } from "../src/usage/aiand";

const BALANCE_URL = "https://api.aiand.com/billing/balance";
const SUMMARY_URL = "https://api.aiand.com/analytics/summary?range=24h";

const SUMMARY_FIXTURE = {
	range: "24h",
	from: "2026-10-06T00:00:00Z",
	to: "2026-10-07T00:00:00Z",
	requests: 120,
	input_tokens: 340_000,
	output_tokens: 89_000,
	cost_usd: 12.5,
	errors: 2,
	p50_latency_ms: 700,
	p95_latency_ms: 2100,
};

function makeParams(overrides: Partial<UsageFetchParams> = {}): UsageFetchParams {
	return {
		provider: "aiand",
		credential: { type: "api_key", apiKey: "sk-test" },
		baseUrl: "https://api.aiand.com/v1",
		...overrides,
	};
}

interface Route {
	status?: number;
	body: unknown;
}

function makeFetch(routes: Record<string, Route>): {
	fetch: FetchImpl;
	calls: Array<{ url: string; headers: Record<string, string> }>;
} {
	const calls: Array<{ url: string; headers: Record<string, string> }> = [];
	const fn = async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		calls.push({ url, headers: (init?.headers as Record<string, string>) ?? {} });
		const route = routes[url];
		if (!route) throw new Error(`unexpected url: ${url}`);
		return new Response(JSON.stringify(route.body), {
			status: route.status ?? 200,
			headers: { "content-type": "application/json" },
		});
	};
	return { fetch: fn as unknown as typeof fetch, calls };
}

function makeCtx(fetch: FetchImpl): UsageFetchContext {
	return { fetch };
}

describe("ai& usage provider", () => {
	it("balance + 24h summary → one balance limit carrying the aggregate in metadata", async () => {
		const { fetch, calls } = makeFetch({
			[BALANCE_URL]: { body: { balance: "42.75000000", currency: "usd" } },
			[SUMMARY_URL]: { body: SUMMARY_FIXTURE },
		});

		const report = await aiandUsageProvider.fetchUsage!(makeParams(), makeCtx(fetch));

		expect(report).not.toBeNull();
		expect(report!.limits).toHaveLength(1);
		const limit = report!.limits[0];
		expect(limit.id).toBe("aiand-balance");
		expect(limit.label).toBe("Credit balance");
		// Org-wide prepaid pool: shared so consumers collapse duplicate keys
		// and exhaustion covers every ai& model on the account.
		expect(limit.scope).toEqual({ provider: "aiand", windowId: "balance", shared: true });
		expect(limit.amount.remaining).toBeCloseTo(42.75);
		expect(limit.amount.unit).toBe("usd");
		// No top limit exists, so no used fraction is derivable.
		expect(limit.amount.usedFraction).toBeUndefined();
		expect(limit.status).toBe("ok");
		expect(report!.notes).toBeUndefined();
		expect(report!.metadata).toEqual({
			balance: 42.75,
			currency: "usd",
			summary24h: { requests: 120, inputTokens: 340_000, outputTokens: 89_000, costUsd: 12.5, errors: 2 },
		});

		// Inference base URL `/v1` is stripped so management paths hit the root.
		expect(calls.map(call => call.url).sort()).toEqual([BALANCE_URL, SUMMARY_URL].sort());
		for (const call of calls) {
			expect(call.headers.authorization).toBe("Bearer sk-test");
			expect(call.headers.accept).toBe("application/json");
			expect(call.headers["User-Agent"]).toBeTruthy();
		}
	});

	it("nested live summary shape (current/previous/timeseries) is decoded from the current bucket", async () => {
		const { fetch } = makeFetch({
			[BALANCE_URL]: { body: { balance: "45.44405403", currency: "usd" } },
			[SUMMARY_URL]: {
				body: {
					current: { requests: 848, input_tokens: 85_539_619, output_tokens: 475_518 },
					previous: { requests: 89, input_tokens: 15_021_248, output_tokens: 42_064 },
					timeseries: [{ timestamp: "2026-10-06T04:00:00", tokens: 0 }],
				},
			},
		});

		const report = await aiandUsageProvider.fetchUsage!(makeParams(), makeCtx(fetch));

		expect(report!.metadata).toEqual({
			balance: 45.44405403,
			currency: "usd",
			// Only the documented fields the live endpoint reports inside
			// `current`; absent cost/error counters are dropped, not zeroed.
			summary24h: { requests: 848, inputTokens: 85_539_619, outputTokens: 475_518 },
		});
	});

	it("zero balance → exhausted", async () => {
		const { fetch } = makeFetch({
			[BALANCE_URL]: { body: { balance: "0.00000000", currency: "usd" } },
			[SUMMARY_URL]: { body: SUMMARY_FIXTURE },
		});

		const report = await aiandUsageProvider.fetchUsage!(makeParams(), makeCtx(fetch));

		expect(report!.limits[0].status).toBe("exhausted");
	});

	it("overdrawn (negative) balance → exhausted", async () => {
		const { fetch } = makeFetch({
			[BALANCE_URL]: { body: { balance: "-3.25", currency: "usd" } },
			[SUMMARY_URL]: { body: SUMMARY_FIXTURE },
		});

		const report = await aiandUsageProvider.fetchUsage!(makeParams(), makeCtx(fetch));

		expect(report!.limits[0].amount.remaining).toBeCloseTo(-3.25);
		expect(report!.limits[0].status).toBe("exhausted");
	});

	it("JPY org → credits unit and a JPY note on the report", async () => {
		const { fetch } = makeFetch({
			[BALANCE_URL]: { body: { balance: "5000", currency: "jpy" } },
			[SUMMARY_URL]: { body: SUMMARY_FIXTURE },
		});

		const report = await aiandUsageProvider.fetchUsage!(makeParams(), makeCtx(fetch));

		expect(report!.limits[0].amount.unit).toBe("credits");
		expect(report!.metadata?.currency).toBe("jpy");
		expect(report!.notes).toEqual(["Organization bills in JPY; balance shown in credits"]);
	});

	it("401 on balance → throws ProviderHttpError (key flagged bad)", async () => {
		const { fetch } = makeFetch({
			[BALANCE_URL]: { status: 401, body: { error: "invalid api key" } },
			[SUMMARY_URL]: { body: SUMMARY_FIXTURE },
		});

		const error = await aiandUsageProvider.fetchUsage!(makeParams(), makeCtx(fetch)).catch(error => error);

		expect(error).toBeInstanceOf(ProviderHttpError);
		expect((error as ProviderHttpError).status).toBe(401);
	});

	it("403 on balance → throws ProviderHttpError", async () => {
		const { fetch } = makeFetch({
			[BALANCE_URL]: { status: 403, body: { error: "forbidden" } },
			[SUMMARY_URL]: { body: SUMMARY_FIXTURE },
		});

		const error = await aiandUsageProvider.fetchUsage!(makeParams(), makeCtx(fetch)).catch(error => error);

		expect(error).toBeInstanceOf(ProviderHttpError);
		expect((error as ProviderHttpError).status).toBe(403);
	});

	it("503 on balance → null (serve last-good)", async () => {
		const { fetch } = makeFetch({
			[BALANCE_URL]: { status: 503, body: { error: "unavailable" } },
			[SUMMARY_URL]: { body: SUMMARY_FIXTURE },
		});

		expect(await aiandUsageProvider.fetchUsage!(makeParams(), makeCtx(fetch))).toBeNull();
	});

	it("network error on balance → null", async () => {
		const fetch: FetchImpl = async input => {
			if (String(input).includes("/billing/balance")) throw new Error("Network error");
			return new Response(JSON.stringify(SUMMARY_FIXTURE), { status: 200 });
		};

		expect(await aiandUsageProvider.fetchUsage!(makeParams(), makeCtx(fetch))).toBeNull();
	});

	it("balance OK + summary 503 → balance-only report, no throw", async () => {
		const { fetch } = makeFetch({
			[BALANCE_URL]: { body: { balance: "10", currency: "usd" } },
			[SUMMARY_URL]: { status: 503, body: { error: "unavailable" } },
		});

		const report = await aiandUsageProvider.fetchUsage!(makeParams(), makeCtx(fetch));

		expect(report).not.toBeNull();
		expect(report!.limits).toHaveLength(1);
		expect(report!.limits[0].amount.remaining).toBeCloseTo(10);
		expect(report!.metadata).toEqual({ balance: 10, currency: "usd" });
	});

	it("malformed balance payload → null", async () => {
		const { fetch } = makeFetch({
			[BALANCE_URL]: { body: { currency: "usd" } },
			[SUMMARY_URL]: { body: SUMMARY_FIXTURE },
		});

		expect(await aiandUsageProvider.fetchUsage!(makeParams(), makeCtx(fetch))).toBeNull();
	});

	it("wrong provider → null without fetching", async () => {
		const { fetch, calls } = makeFetch({
			[BALANCE_URL]: { body: { balance: "1", currency: "usd" } },
			[SUMMARY_URL]: { body: SUMMARY_FIXTURE },
		});

		const report = await aiandUsageProvider.fetchUsage!(makeParams({ provider: "openai" }), makeCtx(fetch));

		expect(report).toBeNull();
		expect(calls).toHaveLength(0);
	});

	it("non-api_key credential → null without fetching", async () => {
		const { fetch, calls } = makeFetch({
			[BALANCE_URL]: { body: { balance: "1", currency: "usd" } },
			[SUMMARY_URL]: { body: SUMMARY_FIXTURE },
		});

		const report = await aiandUsageProvider.fetchUsage!(
			makeParams({ credential: { type: "oauth", accessToken: "token" } }),
			makeCtx(fetch),
		);

		expect(report).toBeNull();
		expect(calls).toHaveLength(0);
	});

	it("missing apiKey → null without fetching", async () => {
		const { fetch, calls } = makeFetch({
			[BALANCE_URL]: { body: { balance: "1", currency: "usd" } },
			[SUMMARY_URL]: { body: SUMMARY_FIXTURE },
		});

		const report = await aiandUsageProvider.fetchUsage!(
			makeParams({ credential: { type: "api_key" } }),
			makeCtx(fetch),
		);

		expect(report).toBeNull();
		expect(calls).toHaveLength(0);
	});

	it("default endpoint used when no baseUrl is supplied", async () => {
		const { fetch, calls } = makeFetch({
			[BALANCE_URL]: { body: { balance: "1", currency: "usd" } },
			[SUMMARY_URL]: { body: SUMMARY_FIXTURE },
		});

		await aiandUsageProvider.fetchUsage!(makeParams({ baseUrl: undefined }), makeCtx(fetch));

		expect(calls.map(call => call.url).sort()).toEqual([BALANCE_URL, SUMMARY_URL].sort());
	});

	it("supports() requires the aiand provider and an api-key credential", () => {
		expect(aiandUsageProvider.supports!(makeParams())).toBe(true);
		expect(aiandUsageProvider.supports!(makeParams({ provider: "openai" }))).toBe(false);
		expect(aiandUsageProvider.supports!(makeParams({ credential: { type: "oauth" } }))).toBe(false);
	});
});
