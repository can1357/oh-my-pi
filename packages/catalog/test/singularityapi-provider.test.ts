import { afterEach, describe, expect, test, vi } from "bun:test";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import { getEnvApiKey } from "@oh-my-pi/pi-ai/stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { isCatalogDescriptor, resolveModelCacheProviderId } from "@oh-my-pi/pi-catalog/provider-models";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import { singularityApiModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl, ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { normalizeSingularityApiBaseUrl } from "@oh-my-pi/pi-catalog/wire/singularityapi";

const originalKey = Bun.env.SINGULARITYAPI_API_KEY;

afterEach(() => {
	if (originalKey === undefined) delete Bun.env.SINGULARITYAPI_API_KEY;
	else Bun.env.SINGULARITYAPI_API_KEY = originalKey;
	vi.restoreAllMocks();
});

function singularityApiModelsFetch(): { calls: string[]; authorizations: (string | null)[]; fetch: FetchImpl } {
	const calls: string[] = [];
	const authorizations: (string | null)[] = [];
	const fetch: FetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
		calls.push(String(input));
		authorizations.push(new Headers(init?.headers).get("authorization"));
		return new Response(
			JSON.stringify({
				data: [{ id: "deepseek-v4-flash", object: "model", owned_by: "singularityapi" }],
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
		provider: "singularityapi",
		baseUrl: "https://api.singularityapi.tech/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: null,
		maxTokens: null,
	};
}

describe("SingularityAPI provider support", () => {
	test("discovers the reserved-lane roster with the stored key", async () => {
		const { calls, authorizations, fetch } = singularityApiModelsFetch();
		const pending = singularityApiModelManagerOptions({ apiKey: "sk-test", fetch }).fetchDynamicModels?.();
		const models = pending ? await pending : pending;

		expect(calls).toEqual(["https://api.singularityapi.tech/v1/models"]);
		expect(authorizations).toEqual(["Bearer sk-test"]);
		expect(models?.find(model => model.id === "deepseek-v4-flash")).toMatchObject({
			provider: "singularityapi",
			api: "openai-completions",
			baseUrl: "https://api.singularityapi.tech/v1",
		});
		// Lane discovery needs the key: an unauthenticated manager must not probe.
		expect(singularityApiModelManagerOptions({}).fetchDynamicModels).toBeUndefined();
	});

	test("identifies the prefixed DeepSeek V4 Flash lane ids as the reviewed Flash family", () => {
		for (const id of ["deepseek-ai/DeepSeek-V4-Flash-0731", "deepseek-ai/DeepSeek-V4.1-Flash"]) {
			const model = buildModel(laneSpec(id));
			expect(model.reasoning).toBe(true);
			expect(model.thinking).toMatchObject({ mode: "effort", efforts: ["low", "high", "xhigh", "max"] });
			expect(model.contextWindow).toBe(262144);
			expect(model.input).toEqual(["text", "image"]);
			expect(model.compat.maxTokensField).toBe("max_tokens");
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
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "singularityapi");
		expect(descriptor).toMatchObject({
			defaultModel: "deepseek-ai/DeepSeek-V4.1-Flash",
			dynamicModelsAuthoritative: true,
		});
		// No `discovery` node: the lane snapshot must never be frozen into
		// models.json by a catalog regeneration.
		expect(isCatalogDescriptor(descriptor!)).toBe(false);
		expect(DEFAULT_MODEL_PER_PROVIDER.singularityapi).toBe("deepseek-ai/DeepSeek-V4.1-Flash");

		delete Bun.env.SINGULARITYAPI_API_KEY;
		expect(getEnvApiKey("singularityapi")).toBeUndefined();
		Bun.env.SINGULARITYAPI_API_KEY = "sk-test";
		expect(getEnvApiKey("singularityapi")).toBe("sk-test");
	});

	test("pastes a key through the login selector after models-endpoint validation", async () => {
		const provider = getOAuthProviders().find(item => item.id === "singularityapi");
		expect(provider?.name).toBe("SingularityAPI");
		const login = getProviderDefinition("singularityapi")?.login;
		expect(login).toBeDefined();

		const { calls, fetch } = singularityApiModelsFetch();
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
			instructions: "Create an API key from the SingularityAPI dashboard, then paste it here",
		});
		expect(calls).toEqual(["https://api.singularityapi.tech/v1/models"]);
	});

	test("rejects a key the models endpoint refuses", async () => {
		const login = getProviderDefinition("singularityapi")?.login;
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
		const canonical = normalizeSingularityApiBaseUrl();
		const viaManager = singularityApiModelManagerOptions({
			apiKey,
			baseUrl: "  https://api.singularityapi.tech/v1/  ",
		}).cacheProviderId;

		expect(viaManager).toBe(resolveModelCacheProviderId("singularityapi", { apiKey, baseUrl: canonical }));
		// A blank override means "not configured", so it shares the canonical host's
		// namespace instead of hashing a bare `/v1`.
		expect(singularityApiModelManagerOptions({ apiKey, baseUrl: "   " }).cacheProviderId).toBe(
			singularityApiModelManagerOptions({ apiKey }).cacheProviderId,
		);
		// Switching lanes must miss the prior roster and re-discover.
		expect(resolveModelCacheProviderId("singularityapi", { apiKey: "sk-lane-b", baseUrl: canonical })).not.toBe(
			viaManager,
		);
		// A self-hosted proxy publishes its own lanes, so it must not read the
		// canonical host's cache.
		const viaProxy = singularityApiModelManagerOptions({ apiKey, baseUrl: "https://proxy.example" }).cacheProviderId;
		expect(viaProxy).toBe(
			resolveModelCacheProviderId("singularityapi", { apiKey, baseUrl: "https://proxy.example/v1" }),
		);
		expect(viaProxy).not.toBe(viaManager);
	});
});
