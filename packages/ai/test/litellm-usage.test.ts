import { describe, expect, it } from "bun:test";

import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import type { UsageFetchContext, UsageFetchParams } from "@oh-my-pi/pi-ai/usage";
import { litellmUsageProvider } from "@oh-my-pi/pi-ai/usage/litellm";

const KEY_RESET = "2026-09-12T00:00:00.000Z";
const USER_RESET = "2026-10-01T00:00:00.000Z";

const KEY_INFO = {
	key: "sk-...abcd",
	info: {
		key_alias: "dev-laptop",
		spend: 2.5,
		max_budget: 10,
		budget_duration: "1d",
		budget_reset_at: KEY_RESET,
		budget_limits: null,
	},
};

const USER_INFO = {
	user_info: {
		user_id: "user-1",
		spend: 40,
		max_budget: 100,
		budget_duration: "30d",
		budget_reset_at: USER_RESET,
	},
	keys: [],
	teams: [],
};

function makeParams(baseUrl?: string, credential?: UsageFetchParams["credential"]): UsageFetchParams {
	return {
		provider: "litellm",
		credential: credential ?? { type: "api_key", apiKey: "sk-litellm-test" },
		baseUrl,
		signal: undefined,
	};
}

interface RouteResponse {
	status?: number;
	body: unknown;
}

function makeCtx(routes: Record<string, RouteResponse>, requested: string[] = []): UsageFetchContext {
	const fetch: FetchImpl = async input => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		requested.push(url);
		const path = new URL(url).pathname;
		const route = routes[path];
		if (!route) return new Response("not found", { status: 404 });
		return new Response(JSON.stringify(route.body), {
			status: route.status ?? 200,
			headers: { "content-type": "application/json" },
		});
	};
	return { fetch };
}

describe("litellm usage provider", () => {
	it("emits a USD limit per key and user budget window with canonical window ids", async () => {
		const report = await litellmUsageProvider.fetchUsage(
			makeParams("http://proxy.test:4000/v1"),
			makeCtx({ "/key/info": { body: KEY_INFO }, "/user/info": { body: USER_INFO } }),
		);

		expect(report).not.toBeNull();
		expect(report!.limits.map(l => l.id)).toEqual(["litellm:key:daily", "litellm:user:monthly"]);
		expect(report!.limits.map(l => l.label)).toEqual(["Key · daily", "User · monthly"]);
		expect(report!.limits.map(l => l.scope.windowId)).toEqual(["daily", "monthly"]);

		const key = report!.limits[0];
		expect(key.amount).toEqual({
			used: 2.5,
			limit: 10,
			remaining: 7.5,
			usedFraction: 0.25,
			remainingFraction: 0.75,
			unit: "usd",
		});
		expect(key.window?.resetsAt).toBe(Date.parse(KEY_RESET));
		expect(key.window?.durationMs).toBe(86_400_000);
		expect(key.status).toBe("ok");

		const user = report!.limits[1];
		expect(user.amount.used).toBe(40);
		expect(user.amount.limit).toBe(100);
		expect(user.amount.usedFraction).toBe(0.4);
		expect(user.window?.resetsAt).toBe(Date.parse(USER_RESET));
		expect(report!.metadata).toEqual({ keyAlias: "dev-laptop", userId: "user-1" });
	});

	it("skips extra budget_limits windows when the proxy does not report budget_limits_usage", async () => {
		const keyInfo = {
			...KEY_INFO,
			info: {
				...KEY_INFO.info,
				budget_limits: [
					{ budget_duration: "1d", max_budget: 10, reset_at: KEY_RESET },
					{ budget_duration: "7d", max_budget: 50, reset_at: null },
				],
			},
		};
		const report = await litellmUsageProvider.fetchUsage(
			makeParams(),
			makeCtx({ "/key/info": { body: keyInfo }, "/user/info": { body: { user_info: null } } }),
		);

		expect(report!.limits.map(l => l.id)).toEqual(["litellm:key:daily"]);
	});

	it("emits extra budget_limits windows from budget_limits_usage current_spend", async () => {
		const weeklyReset = "2026-09-15T00:00:00.000Z";
		const keyInfo = {
			...KEY_INFO,
			info: {
				...KEY_INFO.info,
				budget_limits: [
					{ budget_duration: "1d", max_budget: 10, reset_at: KEY_RESET },
					{ budget_duration: "7d", max_budget: 50, reset_at: weeklyReset },
				],
				budget_limits_usage: {
					"1d": { current_spend: 2.5 },
					"7d": { current_spend: 47 },
				},
			},
		};
		const report = await litellmUsageProvider.fetchUsage(
			makeParams(),
			makeCtx({ "/key/info": { body: keyInfo }, "/user/info": { body: { user_info: null } } }),
		);

		expect(report!.limits.map(l => l.id)).toEqual(["litellm:key:daily", "litellm:key:7d"]);
		const weekly = report!.limits[1];
		expect(weekly.scope.windowId).toBe("7d");
		expect(weekly.amount.used).toBe(47);
		expect(weekly.amount.limit).toBe(50);
		expect(weekly.amount.usedFraction).toBe(0.94);
		expect(weekly.status).toBe("warning");
		expect(weekly.window?.resetsAt).toBe(Date.parse(weeklyReset));
		expect(weekly.window?.durationMs).toBe(7 * 86_400_000);
	});

	it("keeps key limits when /user/info fails", async () => {
		const report = await litellmUsageProvider.fetchUsage(
			makeParams(),
			makeCtx({
				"/key/info": { body: KEY_INFO },
				"/user/info": { status: 500, body: { error: "boom" } },
			}),
		);

		expect(report!.limits.map(l => l.id)).toEqual(["litellm:key:daily"]);
	});

	it("keeps user limits when /key/info fails", async () => {
		const report = await litellmUsageProvider.fetchUsage(
			makeParams(),
			makeCtx({
				"/key/info": { status: 403, body: { error: "forbidden" } },
				"/user/info": { body: USER_INFO },
			}),
		);

		expect(report!.limits.map(l => l.id)).toEqual(["litellm:user:monthly"]);
	});

	it("returns null when both management routes fail", async () => {
		const report = await litellmUsageProvider.fetchUsage(
			makeParams(),
			makeCtx({
				"/key/info": { status: 401, body: {} },
				"/user/info": { status: 401, body: {} },
			}),
		);

		expect(report).toBeNull();
	});

	it("strips a trailing /v1 from the provider base URL before appending management routes", async () => {
		const requested: string[] = [];
		await litellmUsageProvider.fetchUsage(
			makeParams("https://host.test/gateway/v1/"),
			makeCtx({ "/gateway/key/info": { body: KEY_INFO }, "/gateway/user/info": { body: USER_INFO } }, requested),
		);

		expect(requested.sort()).toEqual(["https://host.test/gateway/key/info", "https://host.test/gateway/user/info"]);
	});

	it("emits no limit for a window without max_budget and reports an unbudgeted key", async () => {
		const report = await litellmUsageProvider.fetchUsage(
			makeParams(),
			makeCtx({
				"/key/info": { body: { key: "sk", info: { spend: 3, max_budget: null, budget_duration: null } } },
				"/user/info": { body: { user_info: { user_id: "u", spend: 3, max_budget: null } } },
			}),
		);

		expect(report).not.toBeNull();
		expect(report!.limits).toEqual([]);
		expect(report!.notes?.[0]).toContain("No LiteLLM budget");
	});

	it("renders a max_budget of 0 as an exhausted hard block without dividing by zero", async () => {
		const report = await litellmUsageProvider.fetchUsage(
			makeParams(),
			makeCtx({
				"/key/info": { body: { key: "sk", info: { spend: 0, max_budget: 0, budget_duration: null } } },
				"/user/info": { body: { user_info: null } },
			}),
		);

		const [limit] = report!.limits;
		expect(limit.id).toBe("litellm:key:lifetime");
		expect(limit.scope.windowId).toBeUndefined();
		expect(limit.window).toBeUndefined();
		expect(limit.amount.usedFraction).toBe(1);
		expect(limit.status).toBe("exhausted");
	});

	it("passes unrecognised budget durations through as the window id", async () => {
		const report = await litellmUsageProvider.fetchUsage(
			makeParams(),
			makeCtx({
				"/key/info": { body: { key: "sk", info: { spend: 1, max_budget: 5, budget_duration: "12h" } } },
				"/user/info": { body: { user_info: null } },
			}),
		);

		const [limit] = report!.limits;
		expect(limit.id).toBe("litellm:key:12h");
		expect(limit.scope.windowId).toBe("12h");
		expect(limit.window?.durationMs).toBe(12 * 3_600_000);
	});

	it("returns null without a credential and does not hit the proxy", async () => {
		const requested: string[] = [];
		const report = await litellmUsageProvider.fetchUsage(
			makeParams(undefined, { type: "api_key" }),
			makeCtx({ "/key/info": { body: KEY_INFO } }, requested),
		);

		expect(report).toBeNull();
		expect(requested).toEqual([]);
		expect(litellmUsageProvider.supports!(makeParams(undefined, { type: "oauth", accessToken: "tok" }))).toBe(false);
	});
});
