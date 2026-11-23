import { afterEach, describe, expect, it } from "bun:test";
import { type AuthCredentialStore, AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import type { UsageFetchParams, UsageReport } from "@oh-my-pi/pi-ai/usage";
import { bifrostRankingStrategy, bifrostUsageProvider } from "@oh-my-pi/pi-ai/usage/bifrost";

type Routes = Record<string, Response | undefined>;

function routedFetch(routes: Routes, requests: { url: string; init?: RequestInit }[] = []) {
	return Object.assign(
		async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			requests.push({ url, init });
			return routes[url] ?? new Response(null, { status: 404 });
		},
		{ preconnect: fetch.preconnect },
	);
}

async function probe(routes: Routes, params: Partial<UsageFetchParams> = {}) {
	const requests: { url: string; init?: RequestInit }[] = [];
	const report = await bifrostUsageProvider.fetchUsage(
		{
			provider: "bifrost",
			baseUrl: "https://gw.example/v1",
			credential: { type: "api_key", apiKey: "sk-bf-test" },
			...params,
		},
		{ fetch: routedFetch(routes, requests) },
	);
	return { report, requests };
}

const QUOTA = "https://gw.example/api/governance/virtual-keys/quota";
const LAST_RESET = "2030-01-01T00:00:00Z";

function budget(id: string, current: number, max: number, extra: Record<string, unknown> = {}) {
	return { id, current_usage: current, max_limit: max, reset_duration: "1M", last_reset: LAST_RESET, ...extra };
}

function quota(body: Record<string, unknown>) {
	return Response.json({
		virtual_key_name: "OMP",
		is_active: true,
		budgets: [],
		rate_limit: null,
		rate_limits: [],
		provider_configs: [],
		model_configs: [],
		...body,
	});
}

function scopedIds(report: UsageReport | null, modelId?: string) {
	return report ? bifrostRankingStrategy.scopeLimits!(report, { modelId }).map(limit => limit.id) : [];
}

describe("bifrostUsageProvider", () => {
	it("reports key, route, and model limits from the gateway root", async () => {
		const { report, requests } = await probe({
			[QUOTA]: quota({
				budgets: [budget("key-monthly", 25, 20, { override_amount: 10 })],
				rate_limit: {
					token_max_limit: 1000,
					token_current_usage: 1000,
					token_reset_duration: "1h",
					token_last_reset: LAST_RESET,
					request_max_limit: null,
					request_current_usage: 4,
				},
				provider_configs: [
					{
						provider: "Chinese Router",
						virtual_key_id: "vk-1",
						budgets: [budget("route", 5, 5)],
						model_budgets: [{ model_name: "glm-5", budgets: [budget("route-model", 1, 10)] }],
					},
				],
				model_configs: [{ model_name: "gpt-5", budgets: [budget("model", 2, 4)] }],
			}),
		});

		expect(requests.map(request => request.url)).toEqual([QUOTA]);
		expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe("Bearer sk-bf-test");
		expect(requests[0]?.init?.redirect).toBe("error");
		const byId = new Map(report?.limits.map(limit => [limit.id, limit]));
		// An override adds to max_limit; the window resets one calendar month after last_reset.
		expect(byId.get("bifrost:key:budget:key-monthly")).toMatchObject({
			amount: { used: 25, limit: 30, unit: "usd" },
			status: "ok",
			window: { id: "1M", resetsAt: Date.UTC(2030, 1, 1) },
		});
		expect(byId.get("bifrost:key:rate:tokens")).toMatchObject({
			status: "exhausted",
			window: { id: "1h", durationMs: 3_600_000, resetsAt: Date.UTC(2030, 0, 1, 1) },
		});
		// A null maximum is unlimited.
		expect(byId.has("bifrost:key:rate:requests")).toBe(false);
		expect(byId.get("bifrost:provider:Chinese Router:budget:route")?.status).toBe("exhausted");
		expect(report?.metadata).toEqual({ endpoint: "https://gw.example", accountId: "vk-1", keyName: "OMP" });

		expect(scopedIds(report, "Chinese Router/glm-5").sort()).toEqual([
			"bifrost:key:budget:key-monthly",
			"bifrost:key:rate:tokens",
			"bifrost:model:Chinese Router/glm-5:budget:route-model",
			"bifrost:provider:Chinese Router:budget:route",
		]);
		expect(scopedIds(report, "openai/gpt-5").sort()).toEqual([
			"bifrost:key:budget:key-monthly",
			"bifrost:key:rate:tokens",
			"bifrost:model:gpt-5:budget:model",
		]);
		// Without a model only key-wide limits apply.
		expect(scopedIds(report).sort()).toEqual(["bifrost:key:budget:key-monthly", "bifrost:key:rate:tokens"]);
	});

	it("retries the origin when an integration route has no quota endpoint", async () => {
		const { report, requests } = await probe(
			{ [QUOTA]: quota({ is_active: false }) },
			{ baseUrl: "https://gw.example/typesafe" },
		);
		expect(requests.map(request => request.url)).toEqual([
			"https://gw.example/typesafe/api/governance/virtual-keys/quota",
			QUOTA,
		]);
		expect(report?.limits.map(limit => [limit.id, limit.status])).toEqual([["bifrost:key:active", "exhausted"]]);
	});

	it("reports nothing for a key without limits and rejects a refused key", async () => {
		expect((await probe({ [QUOTA]: quota({}) })).report).toBeNull();
		await expect(probe({ [QUOTA]: new Response(null, { status: 401 }) })).rejects.toBeInstanceOf(ProviderHttpError);
	});

	it("scopes rate-limit blocks to the model's route", () => {
		expect(bifrostRankingStrategy.blockScope?.({ modelId: "Chinese Router/glm-5" })).toBe("route:Chinese Router");
		expect(bifrostRankingStrategy.blockScope?.({ modelId: "glm-5" })).toBeUndefined();
	});
});

function memoryStore(): AuthCredentialStore {
	const cache = new Map<string, { value: string; expiresAtSec: number }>();
	return {
		close() {},
		listAuthCredentials: () => [],
		updateAuthCredential() {},
		async deleteAuthCredential() {
			return false;
		},
		tryDisableAuthCredentialIfMatches: () => false,
		replaceAuthCredentials: async () => [],
		upsertAuthCredential: async () => [],
		async deleteAuthCredentials() {},
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

describe("Bifrost model usage health for a config key", () => {
	const storages: AuthStorage[] = [];
	afterEach(() => {
		for (const storage of storages) storage.close();
		storages.length = 0;
	});

	it("evaluates the configured key as one account, scoped to the model's route", async () => {
		const storage = new AuthStorage(memoryStore(), {
			configValueResolver: async value => value,
			usageFetch: routedFetch({
				[QUOTA]: quota({
					provider_configs: [{ provider: "Chinese Router", budgets: [budget("route", 5, 5)] }],
					budgets: [budget("key", 1, 10)],
				}),
			}) as unknown as typeof fetch,
		});
		storages.push(storage);
		storage.keys.setConfig("bifrost", "sk-bf-test");
		const options = { baseUrl: "https://gw.example/v1", reserveFraction: 0.05 };

		const depleted = await storage.health.model("bifrost", { ...options, modelId: "Chinese Router/glm-5" });
		expect(depleted.state).toBe("depleted");
		expect(depleted.accounts).toEqual([
			{
				credentialId: -1,
				credentialType: "api_key",
				selected: true,
				state: "depleted",
				resetsAt: Date.UTC(2030, 1, 1),
			},
		]);
		const healthy = await storage.health.model("bifrost", { ...options, modelId: "openai/gpt-5" });
		expect(healthy.state).toBe("healthy");
	});
});
