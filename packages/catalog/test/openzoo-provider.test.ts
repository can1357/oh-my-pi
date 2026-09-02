import { afterEach, describe, expect, test } from "bun:test";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { getEnvApiKey } from "@oh-my-pi/pi-ai/stream";
import { getBundledModelReferenceIndex } from "@oh-my-pi/pi-catalog/identity/bundled";
import { resolveModelReference } from "@oh-my-pi/pi-catalog/identity/reference";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { resolveModelCacheProviderId } from "@oh-my-pi/pi-catalog/provider-models/cache-provider-id";
import type { ProviderCatalogEntry } from "@oh-my-pi/pi-catalog/provider-models/descriptor-types";
import {
	CATALOG_PROVIDERS,
	DEFAULT_MODEL_PER_PROVIDER,
	PROVIDER_DESCRIPTORS,
} from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import { MODELS_DEV_PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import {
	OPENZOO_DEFAULT_BASE_URL,
	openzooModelManagerOptions,
	resolveOpenzooBaseUrl,
} from "@oh-my-pi/pi-catalog/provider-models/openzoo";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

const ENV_KEYS = ["OPENZOO_BASE_URL", "OPENZOO_API_KEY"] as const;
const ORIGINAL_ENV = new Map(ENV_KEYS.map(key => [key, Bun.env[key]]));

afterEach(() => {
	for (const key of ENV_KEYS) {
		const value = ORIGINAL_ENV.get(key);
		if (value === undefined) {
			delete Bun.env[key];
		} else {
			Bun.env[key] = value;
		}
	}
});

/**
 * Shape of `GET /v1/models` as the proxy serves it: OpenRouter-style ids with
 * per-token USD `pricing`, the bind ceiling as `context_length` (128M — not
 * the attention window), the real window as `max_model_len`, plus the router
 * aliases and the harness-compat twins the local proxy adds for editors that
 * hard-code bland ids.
 */
const OPENZOO_MODELS_PAYLOAD = {
	object: "list",
	data: [
		{
			id: "anthropic/claude-sonnet-4",
			object: "model",
			owned_by: "openrouter",
			pricing: { prompt: 3e-6, completion: 1.5e-5, unit: "USD", markup: 1 },
			context_length: 128_000_000,
			context_window: 128_000_000,
			max_model_len: 1_000_000,
			max_output_tokens: 64_000,
			top_provider: { context_length: 128_000_000, max_completion_tokens: 64_000, is_moderated: false },
			display_name: "claude-sonnet-4 (anthropic)",
		},
		{
			id: "example-lab/not-in-any-catalog",
			object: "model",
			owned_by: "openrouter",
			pricing: { prompt: "8.34e-7", completion: "2.501e-6", unit: "USD", markup: 1 },
			context_length: 128_000_000,
			max_model_len: 1_048_576,
			top_provider: { context_length: 128_000_000, max_completion_tokens: 64_000, is_moderated: false },
			display_name: "not-in-any-catalog (example-lab)",
		},
		{
			id: "openzoo/auto",
			object: "model",
			owned_by: "openzoo",
			pricing: { prompt: 1e-7, completion: 2e-7, unit: "USD", markup: 1 },
			context_length: 128_000_000,
			max_model_len: 32_768,
			max_output_tokens: null,
			top_provider: { context_length: 128_000_000, max_completion_tokens: null, is_moderated: false },
			display_name: "auto (openzoo)",
		},
		{ id: "openzoo-auto", object: "model", owned_by: "openzoo", pricing: { prompt: 1e-7, completion: 2e-7 } },
		{ id: "auto", object: "model", owned_by: "openzoo", pricing: { prompt: 1e-7, completion: 2e-7 } },
		{ id: "gpt-5.6-auto", object: "model", owned_by: "openzoo", pricing: { prompt: 1e-7, completion: 2e-7 } },
		{
			id: "gpt-4o",
			object: "model",
			owned_by: "openzoo-alias",
			served_by: "openai/gpt-4o-2024-11-20",
			pricing: { prompt: 2.5e-6, completion: 1e-5, unit: "USD", markup: 1 },
			context_length: 128_000_000,
			display_name: "gpt-4o",
		},
	],
};

function stubFetch(seen: { urls: string[]; authorization: (string | null)[] }): FetchImpl {
	return async (input, init) => {
		seen.urls.push(String(input));
		seen.authorization.push(new Headers(init?.headers).get("Authorization"));
		return new Response(JSON.stringify(OPENZOO_MODELS_PAYLOAD), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};
}

describe("openzoo built-in provider", () => {
	test("registers a keyless, dynamic-authoritative runtime descriptor defaulting to the router", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "openzoo");
		expect(descriptor).toBeDefined();
		expect(descriptor?.defaultModel).toBe("auto");
		expect(descriptor?.allowUnauthenticated).toBe(true);
		expect(descriptor?.dynamicModelsAuthoritative).toBe(true);
		expect(DEFAULT_MODEL_PER_PROVIDER.openzoo).toBe("auto");
		expect(descriptor?.createModelManagerOptions({}).providerId).toBe("openzoo");
	});

	test("ships no bundled catalog — the proxy's live /v1/models is the model list", () => {
		const entry: ProviderCatalogEntry | undefined = CATALOG_PROVIDERS.find(item => item.id === "openzoo");
		expect(entry).toBeDefined();
		expect(entry?.catalogDiscovery).toBeUndefined();
		expect(MODELS_DEV_PROVIDER_DESCRIPTORS.some(d => d.providerId === "openzoo")).toBe(false);
		expect(getBundledModels("openzoo" as Parameters<typeof getBundledModels>[0])).toEqual([]);
	});

	test("counts as authenticated without any env var; OPENZOO_API_KEY still wins", () => {
		delete Bun.env.OPENZOO_API_KEY;
		expect(getEnvApiKey("openzoo")).toBe("openzoo-local");
		Bun.env.OPENZOO_API_KEY = "oz_tunnel-bearer";
		expect(getEnvApiKey("openzoo")).toBe("oz_tunnel-bearer");
	});

	test("registers an optional login flow", () => {
		const provider = getOAuthProviders().find(item => item.id === "openzoo");
		expect(provider?.name).toBe("openzoo (local x402 pay-per-call proxy)");
		expect(provider?.available).toBe(true);
	});

	test("resolves the base URL from config, then OPENZOO_BASE_URL, then the proxy default", () => {
		delete Bun.env.OPENZOO_BASE_URL;
		expect(resolveOpenzooBaseUrl()).toBe(OPENZOO_DEFAULT_BASE_URL);
		expect(OPENZOO_DEFAULT_BASE_URL).toBe("http://localhost:8402/v1");
		Bun.env.OPENZOO_BASE_URL = "http://localhost:9402/v1";
		expect(resolveOpenzooBaseUrl()).toBe("http://localhost:9402/v1");
		expect(resolveOpenzooBaseUrl("https://tunnel.example/v1/")).toBe("https://tunnel.example/v1");
	});

	test("namespaces the model cache per endpoint", () => {
		delete Bun.env.OPENZOO_BASE_URL;
		const local = resolveModelCacheProviderId("openzoo");
		const moved = resolveModelCacheProviderId("openzoo", { baseUrl: "http://localhost:9402/v1" });
		expect(local).toStartWith("openzoo:models-v1:");
		expect(moved).toStartWith("openzoo:models-v1:");
		expect(moved).not.toBe(local);
		expect(openzooModelManagerOptions().cacheProviderId).toBe(local);
		expect(openzooModelManagerOptions({ baseUrl: "http://localhost:9402/v1" }).cacheProviderId).toBe(moved);
	});

	test("discovers the live catalog keylessly, pricing from the proxy and limits from the real window", async () => {
		delete Bun.env.OPENZOO_BASE_URL;
		const seen = { urls: [] as string[], authorization: [] as (string | null)[] };
		const options = openzooModelManagerOptions({ fetch: stubFetch(seen) });
		expect(options.dynamicModelsAuthoritative).toBe(true);

		const models = await options.fetchDynamicModels?.();
		expect(models).not.toBeNull();
		expect(seen.urls).toEqual(["http://localhost:8402/v1/models"]);
		expect(seen.authorization).toEqual([null]);

		// Router aliases collapse to `auto`; harness-compat twins are dropped.
		expect((models ?? []).map(model => model.id)).toEqual([
			"anthropic/claude-sonnet-4",
			"auto",
			"example-lab/not-in-any-catalog",
		]);

		const sonnet = models?.find(model => model.id === "anthropic/claude-sonnet-4");
		expect(sonnet?.provider).toBe("openzoo");
		expect(sonnet?.api).toBe("openai-completions");
		expect(sonnet?.baseUrl).toBe("http://localhost:8402/v1");
		// USD per token → USD per million tokens.
		expect(sonnet?.cost).toEqual({ input: 3, output: 15, cacheRead: 0, cacheWrite: 0 });
		// `max_model_len` is the attention window; `context_length` is the 128M bind ceiling.
		expect(sonnet?.contextWindow).toBe(1_000_000);
		expect(sonnet?.maxTokens).toBe(64_000);
		// Capabilities the row does not describe hydrate from the bundled upstream reference.
		const canonical = resolveModelReference("anthropic/claude-sonnet-4", getBundledModelReferenceIndex());
		expect(canonical).toBeDefined();
		expect(sonnet?.name).toBe(canonical?.name ?? "");
		expect(sonnet?.reasoning).toBe(canonical?.reasoning ?? false);
		expect(sonnet?.input).toEqual(canonical?.input ?? ["text"]);

		// Unknown ids keep the proxy's numbers (string prices parse too) and conservative capabilities.
		expect(resolveModelReference("example-lab/not-in-any-catalog", getBundledModelReferenceIndex())).toBeUndefined();
		const unknown = models?.find(model => model.id === "example-lab/not-in-any-catalog");
		expect(unknown?.cost.input).toBeCloseTo(0.834, 6);
		expect(unknown?.cost.output).toBeCloseTo(2.501, 6);
		expect(unknown?.contextWindow).toBe(1_048_576);
		expect(unknown?.maxTokens).toBe(64_000);
		expect(unknown?.name).toBe("not-in-any-catalog (example-lab)");
		expect(unknown?.reasoning).toBe(false);
		expect(unknown?.input).toEqual(["text"]);

		const auto = models?.find(model => model.id === "auto");
		expect(auto?.name).toBe("Auto");
		expect(auto?.cost.input).toBeCloseTo(0.1, 9);
		expect(auto?.cost.output).toBeCloseTo(0.2, 9);
		expect(auto?.cost.cacheRead).toBe(0);
		expect(auto?.cost.cacheWrite).toBe(0);
		expect(auto?.contextWindow).toBe(32_768);
		expect(auto?.maxTokens).toBeNull();
	});

	test("sends the bearer and honours OPENZOO_BASE_URL when configured", async () => {
		Bun.env.OPENZOO_BASE_URL = "https://tunnel.example/v1";
		const seen = { urls: [] as string[], authorization: [] as (string | null)[] };
		const options = openzooModelManagerOptions({ apiKey: "oz_tunnel-bearer", fetch: stubFetch(seen) });
		const models = await options.fetchDynamicModels?.();
		expect(seen.urls).toEqual(["https://tunnel.example/v1/models"]);
		expect(seen.authorization).toEqual(["Bearer oz_tunnel-bearer"]);
		expect(models?.every(model => model.baseUrl === "https://tunnel.example/v1")).toBe(true);
	});

	test("an unreachable proxy yields no models rather than an error", async () => {
		const failingFetch: FetchImpl = async () => {
			throw new Error("connect ECONNREFUSED 127.0.0.1:8402");
		};
		const options = openzooModelManagerOptions({ fetch: failingFetch });
		expect(await options.fetchDynamicModels?.()).toBeNull();
	});
});
