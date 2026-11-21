import { describe, expect, it } from "bun:test";
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import type { UsageFetchParams, UsageReport } from "@oh-my-pi/pi-ai/usage";
import { litellmUsageProvider } from "@oh-my-pi/pi-ai/usage/litellm";
import { withEnv } from "./helpers";

type Routes = Record<string, Response | undefined>;

async function probe(apiKey: string, routes: Routes, params: Partial<UsageFetchParams> = {}) {
	const requests: { url: string; init?: RequestInit }[] = [];
	const fetchImpl = Object.assign(
		async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			requests.push({ url, init });
			return routes[url] ?? new Response(null, { status: 404 });
		},
		{ preconnect: fetch.preconnect },
	);
	const report = await litellmUsageProvider.fetchUsage(
		{
			provider: "team-gateway",
			baseUrl: "https://gw.example/team/v1/",
			credential: { type: "api_key", apiKey },
			...params,
		},
		{ fetch: fetchImpl },
	);
	return { report, requests };
}

const KEY_INFO = "https://gw.example/team/key/info";
const USER_INFO = "https://gw.example/team/v2/user/info";

function rows(report: UsageReport | null) {
	return report?.limits.map(limit => ({
		id: limit.id,
		window: limit.window,
		amount: limit.amount,
		status: limit.status,
	}));
}

describe("litellmUsageProvider", () => {
	it("reports the calling key's and user's budgets from the management base", async () => {
		const { report, requests } = await probe("sk-test", {
			[KEY_INFO]: Response.json({
				info: {
					user_id: "u1",
					spend: 10,
					max_budget: 40,
					budget_duration: "30d",
					budget_reset_at: "2030-01-31T00:00:00",
				},
			}),
			[USER_INFO]: Response.json({ user_id: "u1", user_email: "ada@example.com", spend: 150, max_budget: 100 }),
		});

		expect(requests.map(request => request.url).sort()).toEqual([KEY_INFO, USER_INFO]);
		for (const { init } of requests) {
			expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sk-test");
			expect(init?.redirect).toBe("error");
		}
		expect(rows(report)).toEqual([
			{
				id: "team-gateway:key:budget",
				// Naive gateway timestamps are UTC.
				window: { id: "30d", label: "30d", resetsAt: Date.UTC(2030, 0, 31) },
				amount: { used: 10, limit: 40, remaining: 30, usedFraction: 0.25, remainingFraction: 0.75, unit: "usd" },
				status: "ok",
			},
			{
				id: "team-gateway:user:budget",
				window: undefined,
				amount: { used: 150, limit: 100, remaining: 0, usedFraction: 1, remainingFraction: 0, unit: "usd" },
				status: "exhausted",
			},
		]);
		expect(report?.metadata).toEqual({
			endpoint: "https://gw.example/team",
			accountId: "u1",
			email: "ada@example.com",
		});
	});

	it("reads only the user record for a non-`sk-` token and reports an uncapped budget as spend", async () => {
		const { report, requests } = await probe("jwt-token", {
			[USER_INFO]: Response.json({ user_id: "u1", spend: 7, max_budget: null }),
		});
		expect(requests.map(request => request.url)).toEqual([USER_INFO]);
		expect(rows(report)).toEqual([
			{ id: "team-gateway:user:budget", window: undefined, amount: { used: 7, unit: "usd" }, status: "unknown" },
		]);
	});

	it("treats a zero cap as exhausted and keeps a budget whose duration is not a LiteLLM token, without its label", async () => {
		const { report } = await probe("jwt-token", {
			[USER_INFO]: Response.json({ user_id: "u1", spend: 0, max_budget: 0, budget_duration: "\u001b[31m7d" }),
		});
		expect(rows(report)).toEqual([
			{
				id: "team-gateway:user:budget",
				window: undefined,
				amount: { used: 0, limit: 0, remaining: 0, usedFraction: 1, remainingFraction: 0, unit: "usd" },
				status: "exhausted",
			},
		]);
		expect(report?.limits[0]?.scope.windowId).toBeUndefined();
	});

	it("drops a scope refused with 401, and rejects when every scope is refused", async () => {
		const denied = () => new Response(null, { status: 401 });
		const partial = await probe("sk-test", {
			[KEY_INFO]: Response.json({ info: { spend: 1, max_budget: 10 } }),
			[USER_INFO]: denied(),
		});
		expect(partial.report?.limits.map(limit => limit.id)).toEqual(["team-gateway:key:budget"]);

		for (const [apiKey, routes] of [
			["sk-revoked", { [KEY_INFO]: denied(), [USER_INFO]: denied() }],
			["jwt-revoked", { [USER_INFO]: denied() }],
		] as const) {
			const error = await probe(apiKey, routes).then(
				() => undefined,
				(caught: unknown) => caught,
			);
			expect(error, apiKey).toBeInstanceOf(ProviderHttpError);
			expect(error, apiKey).toMatchObject({ status: 401 });
		}
	});

	it("falls back to LITELLM_BASE_URL only for the built-in provider", async () => {
		await withEnv({ LITELLM_BASE_URL: "http://127.0.0.1:4010/custom/v1" }, async () => {
			const routes = { "http://127.0.0.1:4010/custom/v2/user/info": Response.json({ spend: 1 }) };
			const alias = await probe("jwt-token", routes, { baseUrl: undefined });
			expect(alias.requests).toEqual([]);
			const builtIn = await probe("jwt-token", routes, { provider: "litellm", baseUrl: undefined });
			expect(builtIn.report?.limits.map(limit => limit.id)).toEqual(["litellm:user:budget"]);
		});
	});
});
