import { afterEach, describe, expect, test, vi } from "bun:test";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { getEnvApiKey } from "@oh-my-pi/pi-ai/stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { isCatalogDescriptor } from "@oh-my-pi/pi-catalog/provider-models";
import { PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import { cheaperInferenceModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl, ModelSpec } from "@oh-my-pi/pi-catalog/types";

/**
 * Rows follow the documented `GET /v1/models` shape: `type` separates chat
 * rows from image/video generation rows, limits sit in
 * `context_length`/`max_output_tokens`, modalities and reasoning behind
 * boolean `capabilities` flags, and `pricing` is USD per million tokens as
 * decimal strings.
 */
const ROWS: Record<string, unknown>[] = [
	{
		id: "gpt-5.4-mini",
		object: "model",
		type: "text",
		endpoint: "/v1/chat/completions",
		context_length: 400_000,
		max_output_tokens: 128_000,
		capabilities: { vision: true, reasoning: true, streaming: true },
		pricing: {
			currency: "USD",
			input_per_million: "0.200000",
			cache_read_input_per_million: "0.020000",
			cache_write_input_per_million: "0.000000",
			output_per_million: "1.600000",
		},
	},
	{
		id: "glm-5.3",
		object: "model",
		type: "text",
		endpoint: "/v1/chat/completions",
		context_length: 1_000_000,
		capabilities: { vision: false, reasoning: false, streaming: true },
	},
	{
		id: "image-model",
		object: "model",
		type: "image",
		endpoint: "/v1/images/generations",
		capabilities: { image_edit: true },
	},
	{
		id: "video-model",
		object: "model",
		type: "video",
		capabilities: { video: true },
	},
];

function modelsFetch(): { calls: string[]; authorizations: (string | null)[]; fetch: FetchImpl } {
	const calls: string[] = [];
	const authorizations: (string | null)[] = [];
	const fetch: FetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
		calls.push(String(input));
		authorizations.push(new Headers(init?.headers).get("authorization"));
		return new Response(JSON.stringify({ object: "list", data: ROWS }), {
			headers: { "content-type": "application/json" },
		});
	};
	return { calls, authorizations, fetch };
}

async function discover(fetch: FetchImpl) {
	const options = cheaperInferenceModelManagerOptions({ apiKey: "ci_live_test", fetch });
	const specs = (await options.fetchDynamicModels?.()) ?? [];
	return specs.map(spec => buildModel(spec as ModelSpec<"openai-completions">));
}

const originalKey = Bun.env.CHEAPER_INFERENCE_API_KEY;

afterEach(() => {
	if (originalKey === undefined) delete Bun.env.CHEAPER_INFERENCE_API_KEY;
	else Bun.env.CHEAPER_INFERENCE_API_KEY = originalKey;
	vi.restoreAllMocks();
});

describe("Cheaper Inference provider support", () => {
	test("maps the gateway row's limits, modalities and decimal-string tariff", async () => {
		const { calls, authorizations, fetch } = modelsFetch();
		const models = await discover(fetch);

		expect(calls).toEqual(["https://api.cheaperinference.com/v1/models"]);
		expect(authorizations).toEqual(["Bearer ci_live_test"]);
		expect(models.find(model => model.id === "gpt-5.4-mini")).toMatchObject({
			provider: "cheaperinference",
			api: "openai-completions",
			baseUrl: "https://api.cheaperinference.com/v1",
			contextWindow: 400_000,
			maxTokens: 128_000,
			input: ["text", "image"],
			// Decimal strings parse to per-million USD, and a published zero
			// cache-write rate stays zero.
			cost: { input: 0.2, output: 1.6, cacheRead: 0.02, cacheWrite: 0 },
		});
		expect(models.find(model => model.id === "glm-5.3")?.input).toEqual(["text"]);
	});

	test("keeps image and video generation rows out of the chat roster", async () => {
		const { fetch } = modelsFetch();
		const models = await discover(fetch);

		// A chat transport cannot serve generation SKUs; selecting one would
		// fail on the first request.
		expect(models.map(model => model.id)).toEqual(["glm-5.3", "gpt-5.4-mini"]);
	});

	test("gives reasoning rows an effort ladder and leaves the rest without one", async () => {
		const { fetch } = modelsFetch();
		const models = await discover(fetch);

		const reasoning = models.find(model => model.id === "gpt-5.4-mini");
		expect(reasoning?.reasoning).toBe(true);
		expect(reasoning?.thinking?.mode).toBe("effort");

		const plain = models.find(model => model.id === "glm-5.3");
		expect(plain?.reasoning).toBe(false);
		expect(plain?.thinking).toBeUndefined();
	});

	test("sends the output budget as max_tokens and the system prompt as system", async () => {
		const { fetch } = modelsFetch();
		const models = await discover(fetch);

		for (const model of models) {
			expect(model.compat.maxTokensField, model.id).toBe("max_tokens");
			expect(model.compat.supportsDeveloperRole, model.id).toBe(false);
		}
	});

	test("skips discovery without a key", () => {
		// `/v1/models` requires a key, so an unauthenticated probe would only
		// fail and leave an empty roster behind.
		expect(cheaperInferenceModelManagerOptions().fetchDynamicModels).toBeUndefined();
	});

	test("registers discovery and the env key without enrolling in catalog generation", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "cheaperinference");
		expect(descriptor?.dynamicModelsAuthoritative).toBe(true);
		// No `catalogDiscovery`: the roster needs a key, so it is never frozen
		// into models.json, matching the runtime-only set in
		// compat-conformance.test.ts.
		expect(isCatalogDescriptor(descriptor!)).toBe(false);

		Bun.env.CHEAPER_INFERENCE_API_KEY = "ci_live_env";
		expect(getEnvApiKey("cheaperinference")).toBe("ci_live_env");
	});

	test("validates a pasted key against the models endpoint and strips a Bearer prefix", async () => {
		expect(getOAuthProviders().find(item => item.id === "cheaperinference")?.name).toBe("Cheaper Inference");
		const login = getProviderDefinition("cheaperinference")?.login;
		expect(login).toBeDefined();

		const probed: string[] = [];
		const probeFetch: FetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
			probed.push(`${new Headers(init?.headers).get("authorization")} ${String(input)}`);
			return Response.json({ object: "list", data: [] });
		};
		const onAuth = vi.fn();
		await expect(
			login?.({ onAuth, onPrompt: async () => "  Bearer ci_live_test  ", fetch: probeFetch }),
		).resolves.toBe("ci_live_test");
		expect(onAuth).toHaveBeenCalledWith({
			url: "https://cheaperinference.com/signup",
			instructions: "Create or copy an API key from your Cheaper Inference account",
		});
		expect(probed).toEqual(["Bearer ci_live_test https://api.cheaperinference.com/v1/models"]);
	});

	test("rejects a key the models endpoint refuses", async () => {
		const login = getProviderDefinition("cheaperinference")?.login;
		const unauthorizedFetch: FetchImpl = async () => Response.json({ error: "invalid api key" }, { status: 401 });

		await expect(
			login?.({ onAuth: vi.fn(), onPrompt: async () => "ci_live_bogus", fetch: unauthorizedFetch }),
		).rejects.toThrow();
	});
});
