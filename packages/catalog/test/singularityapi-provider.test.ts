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

/**
 * Fixture mirrors the documented `GET /v1/models` shape: a `data` array
 * whose rows carry per-endpoint `capabilities` (limits + 12-decimal
 * per-million pricing strings), not bare `{id}` rows.
 */
function singularityApiModelsFetch(): { calls: string[]; authorizations: (string | null)[]; fetch: FetchImpl } {
	const calls: string[] = [];
	const authorizations: (string | null)[] = [];
	const fetch: FetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
		calls.push(String(input));
		authorizations.push(new Headers(init?.headers).get("authorization"));
		return new Response(
			JSON.stringify({
				object: "list",
				data: [
					{
						id: "deepseek-v4-flash",
						object: "model",
						created: 1690000000,
						owned_by: "singularityapi",
						capabilities: [
							{
								endpoint: "/v1/chat/completions",
								context_window_tokens: 1000000,
								maximum_output_tokens: 384000,
								default_output_tokens: 8192,
								pricing: {
									input_per_million_usd: "0.081000000000",
									output_per_million_usd: "0.162000000000",
								},
							},
						],
					},
					{
						id: "gpt-image-2",
						object: "model",
						created: 1690000000,
						owned_by: "singularityapi",
						capabilities: [
							{
								endpoint: "/v1/images/generations",
								pricing: {},
							},
						],
					},
				],
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	};
	return { calls, authorizations, fetch };
}

/** A bare row as discovery yields it before capability mapping. */
function bareSpec(id: string): ModelSpec<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "singularityapi",
		baseUrl: "https://api.singularityapi.dev/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: null,
		maxTokens: null,
	};
}

describe("SingularityAPI provider support", () => {
	test("discovers the catalog with live limits and tariffs", async () => {
		const { calls, authorizations, fetch } = singularityApiModelsFetch();
		const pending = singularityApiModelManagerOptions({ apiKey: "sapi-test", fetch }).fetchDynamicModels?.();
		const models = pending ? await pending : pending;

		expect(calls).toEqual(["https://api.singularityapi.dev/v1/models"]);
		expect(authorizations).toEqual(["Bearer sapi-test"]);
		expect(models?.find(model => model.id === "deepseek-v4-flash")).toMatchObject({
			provider: "singularityapi",
			api: "openai-completions",
			baseUrl: "https://api.singularityapi.dev/v1",
			contextWindow: 1000000,
			maxTokens: 384000,
			cost: { input: 0.081, output: 0.162, cacheRead: 0, cacheWrite: 0 },
		});
		// Discovery needs the key: an unauthenticated manager must not probe.
		expect(singularityApiModelManagerOptions({}).fetchDynamicModels).toBeUndefined();
	});

	test("identifies DeepSeek V4 Flash rows as the reviewed Flash family", () => {
		for (const id of ["deepseek-v4-flash", "deepseek-v4-flash-0731"]) {
			const model = buildModel(bareSpec(id));
			expect(model.reasoning).toBe(true);
			expect(model.thinking).toMatchObject({ mode: "effort", efforts: ["low", "high", "max"] });
			expect(model.compat.maxTokensField).toBe("max_tokens");
			expect(model.compat.reasoningContentField).toBe("reasoning_content");
			expect(model.compat.reasoningDisableMode).toBe("none-effort");
			expect(model.compat.supportsToolChoice).toBe(false);
		}
	});

	test("identifies DeepSeek V4 Pro rows with the Pro ladder", () => {
		const model = buildModel(bareSpec("deepseek-v4-pro"));
		expect(model.reasoning).toBe(true);
		expect(model.thinking).toMatchObject({ mode: "effort", efforts: ["low", "high", "max"] });
		expect(model.compat.reasoningContentField).toBe("reasoning_content");
	});

	test("routes image rows to the image transport", () => {
		for (const id of ["flux-1-schnell", "flux-pro-1.1", "gpt-image-2", "gpt-image-1.5"]) {
			expect(buildModel(bareSpec(id)).kind).toBe("image");
		}
	});

	test("leaves rows no rule reviews on the gateway-wide wire shape", () => {
		const model = buildModel(bareSpec("kimi-k2.7-code"));
		expect(model.compat.maxTokensField).toBe("max_tokens");
		expect(model.reasoning).toBe(false);
		expect(model.thinking).toBeUndefined();
	});

	test("registers discovery, defaults, and the API key environment name", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "singularityapi");
		expect(descriptor).toMatchObject({
			defaultModel: "deepseek-v4-flash",
			dynamicModelsAuthoritative: true,
		});
		expect(isCatalogDescriptor(descriptor!)).toBe(false);
		expect(DEFAULT_MODEL_PER_PROVIDER.singularityapi).toBe("deepseek-v4-flash");

		delete Bun.env.SINGULARITYAPI_API_KEY;
		expect(getEnvApiKey("singularityapi")).toBeUndefined();
		Bun.env.SINGULARITYAPI_API_KEY = "sapi-test";
		expect(getEnvApiKey("singularityapi")).toBe("sapi-test");
	});

	test("pastes a key through the login selector after models-endpoint validation", async () => {
		const provider = getOAuthProviders().find(item => item.id === "singularityapi");
		expect(provider?.name).toBe("SingularityAPI");
		const login = getProviderDefinition("singularityapi")?.login;
		expect(login).toBeDefined();

		const { calls, fetch } = singularityApiModelsFetch();
		const onAuth = vi.fn();
		const previousFetch = globalThis.fetch;
		globalThis.fetch = fetch as typeof globalThis.fetch;
		try {
			await expect(
				login?.({
					onAuth,
					onPrompt: async () => "  Bearer sapi-test  ",
				}),
			).resolves.toBe("sapi-test");
		} finally {
			globalThis.fetch = previousFetch;
		}
		expect(onAuth).toHaveBeenCalledWith({
			url: "https://app.singularityapi.dev",
			instructions: "Create an API key from the SingularityAPI dashboard, then paste it here",
		});
		expect(calls).toEqual(["https://api.singularityapi.dev/v1/models"]);
	});

	test("rejects a key the models endpoint refuses", async () => {
		const login = getProviderDefinition("singularityapi")?.login;
		const unauthorizedFetch: FetchImpl = async () =>
			Response.json({ error: { message: "Invalid API key.", type: "invalid_request_error" } }, { status: 401 });
		const previousFetch = globalThis.fetch;
		globalThis.fetch = unauthorizedFetch as typeof globalThis.fetch;
		try {
			await expect(
				login?.({ onPrompt: async () => "sapi-bogus" }) ?? Promise.reject(new Error("missing login")),
			).rejects.toThrow();
		} finally {
			globalThis.fetch = previousFetch;
		}
	});

	test("scopes the model cache to the credential and the endpoint across both call paths", () => {
		const keyed = { apiKey: "sapi-a", baseUrl: "https://api.singularityapi.dev/v1" };
		expect(singularityApiModelManagerOptions(keyed).cacheProviderId).toBe(
			resolveModelCacheProviderId("singularityapi", keyed),
		);
		expect(resolveModelCacheProviderId("singularityapi", keyed)).not.toBe(
			resolveModelCacheProviderId("singularityapi", { apiKey: "sapi-b", baseUrl: keyed.baseUrl }),
		);
		expect(normalizeSingularityApiBaseUrl("https://api.singularityapi.dev")).toBe(keyed.baseUrl);
	});
});
