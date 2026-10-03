import { afterEach, describe, expect, test, vi } from "bun:test";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { getEnvApiKey } from "@oh-my-pi/pi-ai/stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { isCatalogDescriptor, resolveModelCacheProviderId } from "@oh-my-pi/pi-catalog/provider-models";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import { lithosAiModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl, ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { LITHOSAI_API_BASE_URL, normalizeLithosAiBaseUrl } from "@oh-my-pi/pi-catalog/wire/lithosai";

const originalKey = Bun.env.LITHOSAI_API_KEY;

afterEach(() => {
	if (originalKey === undefined) delete Bun.env.LITHOSAI_API_KEY;
	else Bun.env.LITHOSAI_API_KEY = originalKey;
	vi.restoreAllMocks();
});

/** The exact roster `GET /v1/models` served on 2026-10-03. */
const LITHOSAI_ROSTER = [
	"deepseek-ai/DeepSeek-V4.1-Flash",
	"deepseek-ai/DeepSeek-V4.1-Flash-fast",
	"deepseek-ai/DeepSeek-V4.1-Flash-ultra",
	"deepseek-ai/DeepSeek-V4.1-Flash-ultra-chat",
	"zai-org/GLM-5.3",
	"zai-org/GLM-5.3-Flash",
	"zai-org/GLM-5.3-Flash-ultra",
	"zai-org/GLM-5.3-Flash-ultra-chat",
	"zai-org/GLM-5.3-ultra-chat",
	"moonshotai/Kimi-K3",
	"moonshotai/Kimi-K3-fast",
	"moonshotai/Kimi-K3-ultra",
	"moonshotai/Kimi-K3-ultra-chat",
] as const;

function lithosModelsFetch(): { calls: string[]; authorizations: (string | null)[]; fetch: FetchImpl } {
	const calls: string[] = [];
	const authorizations: (string | null)[] = [];
	const fetch: FetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
		calls.push(String(input));
		authorizations.push(new Headers(init?.headers).get("authorization"));
		return new Response(
			JSON.stringify({
				object: "list",
				data: LITHOSAI_ROSTER.map(id => ({ id, object: "model", created: 1785110400, owned_by: "LithosAI" })),
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	};
	return { calls, authorizations, fetch };
}

/** A roster row as discovery yields it: `id` and nothing else. */
function lithosSpec(id: string): ModelSpec<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "lithosai",
		baseUrl: LITHOSAI_API_BASE_URL,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: null,
		maxTokens: null,
	};
}

describe("LithosAI provider support", () => {
	test("discovers the roster with the stored key", async () => {
		const { calls, authorizations, fetch } = lithosModelsFetch();
		const pending = lithosAiModelManagerOptions({ apiKey: "lith_sk_test", fetch }).fetchDynamicModels?.();
		const models = pending ? await pending : pending;

		expect(calls).toEqual([`${LITHOSAI_API_BASE_URL}/models`]);
		expect(authorizations).toEqual(["Bearer lith_sk_test"]);
		// Discovery sorts the roster; the wire order is not preserved.
		expect(models?.map(model => model.id).sort()).toEqual([...LITHOSAI_ROSTER].sort());
		expect(models?.[0]).toMatchObject({
			provider: "lithosai",
			api: "openai-completions",
			baseUrl: LITHOSAI_API_BASE_URL,
		});
		// The roster is credential-scoped and answers 401 without one, so an
		// unauthenticated manager must not probe.
		expect(lithosAiModelManagerOptions({}).fetchDynamicModels).toBeUndefined();
	});

	test("keeps roster rows on the deployment wire shape", () => {
		// The endpoint publishes no capability flags or effort vocabulary per
		// row — only ids — so every row keeps the discovery defaults for those
		// axes and inherits the provider-wide request shape instead of the
		// openai-completions default (`max_completion_tokens`). Cost and context
		// window are rule-owned and asserted separately.
		for (const id of LITHOSAI_ROSTER) {
			const model = buildModel(lithosSpec(id));
			expect(model.reasoning).toBe(false);
			expect(model.thinking).toBeUndefined();
			expect(model.maxTokens).toBeNull();
			expect(model.compat.maxTokensField).toBe("max_tokens");
			expect(model.compat.reasoningContentField).toBe("reasoning_content");
			expect(model.compat.supportsDeveloperRole).toBe(true);
			expect(model.compat.supportsStore).toBe(false);
		}
	});

	test("prices every roster row from the console tariff table", () => {
		// A discovered row arrives with zeroed cost (the endpoint publishes
		// none), so without the KDL rules every lithosai model bills at $0.
		// These are the console's live discounted rates per million tokens;
		// the `-chat` ids share their sibling's tariff.
		const EXPECTED: Record<(typeof LITHOSAI_ROSTER)[number], [number, number, number]> = {
			"deepseek-ai/DeepSeek-V4.1-Flash": [0.15, 0.003, 0.6],
			"deepseek-ai/DeepSeek-V4.1-Flash-fast": [0.25, 0.005, 1],
			"deepseek-ai/DeepSeek-V4.1-Flash-ultra": [0.35, 0.007, 1.4],
			"deepseek-ai/DeepSeek-V4.1-Flash-ultra-chat": [0.35, 0.007, 1.4],
			"zai-org/GLM-5.3": [1.05, 0.195, 3.3],
			"zai-org/GLM-5.3-Flash": [0.3, 0.06, 1],
			"zai-org/GLM-5.3-Flash-ultra": [0.3, 0.06, 1],
			"zai-org/GLM-5.3-Flash-ultra-chat": [0.3, 0.06, 1],
			"zai-org/GLM-5.3-ultra-chat": [2.1, 0.39, 6.6],
			"moonshotai/Kimi-K3": [2.4, 0.24, 12],
			"moonshotai/Kimi-K3-fast": [4, 0.4, 20],
			"moonshotai/Kimi-K3-ultra": [5.6, 0.56, 28],
			"moonshotai/Kimi-K3-ultra-chat": [5.6, 0.56, 28],
		};
		for (const id of LITHOSAI_ROSTER) {
			const [input, cacheRead, output] = EXPECTED[id];
			const model = buildModel(lithosSpec(id));
			expect(model.cost).toMatchObject({ input, output, cacheRead, cacheWrite: 0 });
			expect(model.contextWindow).toBe(1048576);
		}
	});

	test("registers the catalog entry, default model, and API key environment name", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "lithosai");
		expect(descriptor).toMatchObject({
			defaultModel: "moonshotai/Kimi-K3",
			dynamicModelsAuthoritative: true,
		});
		// No `discovery` node: the roster is account-scoped, so a catalog
		// regeneration must never freeze one organization's snapshot.
		expect(isCatalogDescriptor(descriptor!)).toBe(false);
		expect(DEFAULT_MODEL_PER_PROVIDER.lithosai).toBe("moonshotai/Kimi-K3");

		delete Bun.env.LITHOSAI_API_KEY;
		expect(getEnvApiKey("lithosai")).toBeUndefined();
		Bun.env.LITHOSAI_API_KEY = "lith_sk_test";
		expect(getEnvApiKey("lithosai")).toBe("lith_sk_test");
	});

	test("pastes a key through the login selector after models-endpoint validation", async () => {
		expect(getOAuthProviders().find(item => item.id === "lithosai")?.name).toBe("LithosAI");
		const login = getProviderDefinition("lithosai")?.login;
		expect(login).toBeDefined();

		const { calls, fetch } = lithosModelsFetch();
		const onAuth = vi.fn();
		await expect(
			login?.({
				onAuth,
				onPrompt: async () => "  Bearer lith_sk_test  ",
				fetch,
			}),
		).resolves.toBe("lith_sk_test");
		expect(onAuth).toHaveBeenCalledWith({
			url: "https://console.lithosai.cloud/keys",
			instructions: "Create an API key on the LithosAI console's API Keys page",
		});
		expect(calls).toEqual([`${LITHOSAI_API_BASE_URL}/models`]);
	});

	test("rejects a key the models endpoint refuses", async () => {
		const login = getProviderDefinition("lithosai")?.login;
		// Observed 2026-10-03 against the live endpoint without a credential.
		const unauthorizedFetch: FetchImpl = async () =>
			Response.json({ error: { message: "invalid API key", type: "invalid_request_error" } }, { status: 401 });

		await expect(
			login?.({ onAuth: vi.fn(), onPrompt: async () => "lith_sk_bogus", fetch: unauthorizedFetch }),
		).rejects.toThrow();
	});

	test("scopes the model cache to the credential and the endpoint", () => {
		// The roster is org-scoped, so a second key in another organization must
		// miss the cache, and a self-hosted engine must not read the canonical
		// host's namespace. `ModelRegistry` resolves this provider through the
		// credential-scoped hydration pass, which builds these manager options;
		// discovery hashes the `/v1`-suffixed endpoint the manager passes.
		const apiKey = "lith_sk_org_a";
		const canonical = normalizeLithosAiBaseUrl(undefined);
		expect(canonical).toBe(LITHOSAI_API_BASE_URL);
		const viaManager = lithosAiModelManagerOptions({
			apiKey,
			baseUrl: "  https://api.lithosai.cloud/v1/  ",
		}).cacheProviderId;

		expect(viaManager).toBe(resolveModelCacheProviderId("lithosai", { apiKey, baseUrl: canonical }));
		expect(resolveModelCacheProviderId("lithosai", { apiKey: "lith_sk_org_b", baseUrl: canonical })).not.toBe(
			viaManager,
		);
		const viaProxy = lithosAiModelManagerOptions({ apiKey, baseUrl: "https://engine.internal" }).cacheProviderId;
		expect(viaProxy).toBe(resolveModelCacheProviderId("lithosai", { apiKey, baseUrl: "https://engine.internal/v1" }));
		expect(viaProxy).not.toBe(viaManager);
	});
});
