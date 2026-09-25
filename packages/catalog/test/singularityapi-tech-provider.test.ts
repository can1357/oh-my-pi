import { afterEach, describe, expect, test, vi } from "bun:test";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import { getEnvApiKey } from "@oh-my-pi/pi-ai/stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { isCatalogDescriptor, resolveModelCacheProviderId } from "@oh-my-pi/pi-catalog/provider-models";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import { singularityApiTechModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl, ModelSpec } from "@oh-my-pi/pi-catalog/types";
import {
	SINGULARITYAPI_DEV_API_BASE_URL,
	SINGULARITYAPI_TECH_API_BASE_URL,
	normalizeSingularityApiBaseUrl,
} from "@oh-my-pi/pi-catalog/wire/singularityapi";

const originalKey = Bun.env.SINGULARITYAPI_TECH_API_KEY;

afterEach(() => {
	if (originalKey === undefined) delete Bun.env.SINGULARITYAPI_TECH_API_KEY;
	else Bun.env.SINGULARITYAPI_TECH_API_KEY = originalKey;
	vi.restoreAllMocks();
});

function laneModelsFetch(): { calls: string[]; authorizations: (string | null)[]; fetch: FetchImpl } {
	const calls: string[] = [];
	const authorizations: (string | null)[] = [];
	const fetch: FetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
		calls.push(String(input));
		authorizations.push(new Headers(init?.headers).get("authorization"));
		return new Response(
			JSON.stringify({
				data: [
					{ id: "deepseek-ai/DeepSeek-V4.1-Flash", object: "model", owned_by: "openai" },
					{ id: "deepseek-ai/DeepSeek-V4-Flash-0731", object: "model", owned_by: "openai" },
				],
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	};
	return { calls, authorizations, fetch };
}

/** A bare lane row as discovery yields it: no metadata beyond the id. */
function laneSpec(id: string): ModelSpec<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "singularityapi-tech",
		baseUrl: "https://api.singularityapi.tech/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: null,
		maxTokens: null,
	};
}

describe("SingularityAPI reserved lanes support", () => {
	test("discovers the reserved-lane roster with the stored key", async () => {
		const { calls, authorizations, fetch } = laneModelsFetch();
		const pending = singularityApiTechModelManagerOptions({ apiKey: "sk-test", fetch }).fetchDynamicModels?.();
		const models = pending ? await pending : pending;

		expect(calls).toEqual(["https://api.singularityapi.tech/v1/models"]);
		expect(authorizations).toEqual(["Bearer sk-test"]);
		expect(models?.find(model => model.id === "deepseek-ai/DeepSeek-V4.1-Flash")).toMatchObject({
			provider: "singularityapi-tech",
			api: "openai-completions",
			baseUrl: "https://api.singularityapi.tech/v1",
		});
		// Lane discovery needs the key: an unauthenticated manager must not probe.
		expect(singularityApiTechModelManagerOptions({}).fetchDynamicModels).toBeUndefined();
	});

	test("identifies the lane DeepSeek ids with the lane ladder", () => {
		// Probed live 2026-09-22: this gateway accepts `none`, `minimal`, `low`,
		// `high`, `xhigh`, `max` and 400s `medium` (and integers), the mirror
		// image of `singularityapi-dev` — the reason the products are separate
		// providers instead of one ladder.
		for (const id of ["deepseek-ai/DeepSeek-V4-Flash-0731", "deepseek-ai/DeepSeek-V4.1-Flash"]) {
			const model = buildModel(laneSpec(id));
			expect(model.reasoning).toBe(true);
			expect(model.thinking).toMatchObject({ mode: "effort", efforts: ["low", "high", "xhigh", "max"] });
			expect(model.contextWindow).toBe(262144);
			expect(model.input).toEqual(["text", "image"]);
			expect(model.compat.maxTokensField).toBe("max_tokens");
			expect(model.compat.clampOutputToModelMax).toBe(true);
			// Live wire (2026-09-22): reasoning arrives as top-level
			// `reasoning_content`, not the guide's `message.reasoning`.
			expect(model.compat.reasoningContentField).toBe("reasoning_content");
			expect(model.compat.reasoningDisableMode).toBe("none-effort");
		}
	});

	test("leaves lane ids no rule reviews on the gateway-wide wire shape", () => {
		// The roster is per key, so lanes outside the reviewed globs are expected.
		// They must inherit the deployment's request shape instead of the
		// openai-completions default (`max_completion_tokens`), and must not be
		// handed an effort ladder or a request-size policy the guide never
		// published for them.
		const model = buildModel(laneSpec("deepseek-ai/DeepSeek-V3.2"));
		expect(model.compat.maxTokensField).toBe("max_tokens");
		expect(model.compat.reasoningContentField).toBe("reasoning_content");
		expect(model.compat.clampOutputToModelMax).toBe(false);
		expect(model.reasoning).toBe(false);
		expect(model.thinking).toBeUndefined();
	});

	test("registers discovery, defaults, and the API key environment name", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "singularityapi-tech");
		expect(descriptor).toMatchObject({
			defaultModel: "deepseek-ai/DeepSeek-V4.1-Flash",
			dynamicModelsAuthoritative: true,
		});
		// No `discovery` node: the lane snapshot must never be frozen into
		// models.json by a catalog regeneration.
		expect(isCatalogDescriptor(descriptor!)).toBe(false);
		expect(DEFAULT_MODEL_PER_PROVIDER["singularityapi-tech"]).toBe("deepseek-ai/DeepSeek-V4.1-Flash");

		delete Bun.env.SINGULARITYAPI_TECH_API_KEY;
		expect(getEnvApiKey("singularityapi-tech")).toBeUndefined();
		Bun.env.SINGULARITYAPI_TECH_API_KEY = "sk-test";
		expect(getEnvApiKey("singularityapi-tech")).toBe("sk-test");
	});

	test("pastes a key through the lanes login selector after models-endpoint validation", async () => {
		const provider = getOAuthProviders().find(item => item.id === "singularityapi-tech");
		expect(provider?.name).toBe("SingularityAPI Reserved Lanes");
		const login = getProviderDefinition("singularityapi-tech")?.login;
		expect(login).toBeDefined();

		const { calls, fetch } = laneModelsFetch();
		const onAuth = vi.fn();
		await expect(
			login?.({
				onAuth,
				onPrompt: async () => "  Bearer sk-test  ",
				fetch,
			}),
		).resolves.toBe("sk-test");
		expect(onAuth).toHaveBeenCalledWith({
			url: "https://app.singularityapi.tech/compute/billing",
			instructions: "Create a key from the SingularityAPI lanes dashboard, then paste it here",
		});
		expect(calls).toEqual(["https://api.singularityapi.tech/v1/models"]);
	});

	test("rejects a key the models endpoint refuses", async () => {
		const login = getProviderDefinition("singularityapi-tech")?.login;
		const unauthorizedFetch: FetchImpl = async () =>
			Response.json({ error: { message: "token_not_found_in_db", type: "token_not_found_in_db" } }, { status: 401 });

		await expect(
			login?.({ onAuth: vi.fn(), onPrompt: async () => "sk-bogus", fetch: unauthorizedFetch }),
		).rejects.toThrow();
	});

	test("scopes the model cache to the credential and the endpoint across both call paths", () => {
		// The lane roster is issued per key and a proxy publishes its own, so the
		// authoritative cache must be keyed on both. `ModelRegistry` resolves this
		// provider through the credential-scoped hydration pass, which builds these
		// manager options; discovery hashes the `/v1`-suffixed endpoint the manager
		// passes. They must agree, or discovery writes a namespace nobody reads.
		const apiKey = "sk-lane-a";
		const canonical = normalizeSingularityApiBaseUrl(undefined, SINGULARITYAPI_TECH_API_BASE_URL);
		const viaManager = singularityApiTechModelManagerOptions({
			apiKey,
			baseUrl: "  https://api.singularityapi.tech/v1/  ",
		}).cacheProviderId;

		expect(viaManager).toBe(resolveModelCacheProviderId("singularityapi-tech", { apiKey, baseUrl: canonical }));
		// Switching lanes must miss the prior roster and re-discover.
		expect(resolveModelCacheProviderId("singularityapi-tech", { apiKey: "sk-lane-b", baseUrl: canonical })).not.toBe(
			viaManager,
		);
		// A self-hosted proxy publishes its own lanes, so it must not read the
		// canonical host's cache.
		const viaProxy = singularityApiTechModelManagerOptions({
			apiKey,
			baseUrl: "https://proxy.example",
		}).cacheProviderId;
		expect(viaProxy).toBe(
			resolveModelCacheProviderId("singularityapi-tech", { apiKey, baseUrl: "https://proxy.example/v1" }),
		);
		expect(viaProxy).not.toBe(viaManager);
	});

	test("keeps the two products' model caches apart behind one proxy", () => {
		// Same key, same override endpoint: only the provider id separates them.
		// If the namespaces ever collided, one product would serve the other's
		// roster — a lanes key would surface pay-as-you-go ids it cannot call.
		const shared = { apiKey: "sk-lane-a", baseUrl: "https://proxy.example/v1" };
		expect(resolveModelCacheProviderId("singularityapi-tech", shared)).not.toBe(
			resolveModelCacheProviderId("singularityapi-dev", {
				...shared,
				baseUrl: normalizeSingularityApiBaseUrl(shared.baseUrl, SINGULARITYAPI_DEV_API_BASE_URL),
			}),
		);
	});
});
