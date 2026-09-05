import { afterEach, describe, expect, test, vi } from "bun:test";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { getEnvApiKey } from "@oh-my-pi/pi-ai/stream";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import { nebiusModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

const ORIGINAL_ENV = {
	NEBIUS_API_KEY: Bun.env.NEBIUS_API_KEY,
	NEBIUS_BASE_URL: Bun.env.NEBIUS_BASE_URL,
} as const;

function restoreEnvVar(name: keyof typeof ORIGINAL_ENV): void {
	const value = ORIGINAL_ENV[name];
	if (value === undefined) {
		delete Bun.env[name];
		return;
	}
	Bun.env[name] = value;
}
afterEach(() => {
	restoreEnvVar("NEBIUS_API_KEY");
	restoreEnvVar("NEBIUS_BASE_URL");
	vi.restoreAllMocks();
});

/** One entry in Token Factory's verbose `/v1/models` (RichModel) response shape. */
function nebiusModelsResponse(entries: Record<string, unknown>[]): Response {
	return new Response(JSON.stringify({ object: "list", data: entries }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

describe("Nebius Token Factory provider support", () => {
	test("resolves the NEBIUS_API_KEY environment fallback", () => {
		Bun.env.NEBIUS_API_KEY = "nebius-test-key";
		expect(getEnvApiKey("nebius")).toBe("nebius-test-key");
	});

	test("registers descriptor, default model, bundled seed, and login provider", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "nebius");
		expect(descriptor).toBeDefined();
		expect(descriptor?.defaultModel).toBe("moonshotai/Kimi-K2.7-Code");
		expect(descriptor?.dynamicModelsAuthoritative).toBe(true);
		expect(DEFAULT_MODEL_PER_PROVIDER.nebius).toBe("moonshotai/Kimi-K2.7-Code");

		const bundled = getBundledModels("nebius");
		const defaultModel = bundled.find(model => model.id === "moonshotai/Kimi-K2.7-Code");
		expect(defaultModel).toBeDefined();
		for (const model of bundled) {
			expect(model.api).toBe("openai-completions");
			expect(model.baseUrl).toBe("https://api.tokenfactory.nebius.com/v1");
		}

		const provider = getOAuthProviders().find(item => item.id === "nebius");
		expect(provider?.name).toBe("Nebius");
	});

	test("maps Token Factory RichModel metadata: reasoning flag, modality, and per-token pricing", async () => {
		delete Bun.env.NEBIUS_BASE_URL;
		const fetchMock: FetchImpl = vi.fn(async () =>
			nebiusModelsResponse([
				{
					id: "moonshotai/Kimi-K2.7-Code",
					name: "Kimi-K2.7-Code",
					description: "Kimi K2.7 coding agent model.",
					context_length: 262144,
					architecture: { modality: "text->text", tokenizer: "Other" },
					quantization: "fp8",
					pricing: { prompt: "0.00000050", completion: "0.00000150", image: "0", request: "0" },
					supported_features: ["reasoning", "tools", "json_mode", "structured_outputs"],
					supported_sampling_parameters: ["temperature", "top_p", "top_k"],
				},
				{
					id: "openbmb/MiniCPM-V-4_5",
					name: "MiniCPM-V-4_5",
					context_length: 32768,
					architecture: { modality: "text+image->text", tokenizer: "Other" },
					pricing: { prompt: "0.00000010", completion: "0.00000030", image: "0", request: "0" },
					supported_features: ["tools"],
				},
				{
					id: "Qwen/Qwen3-Embedding-8B",
					name: "Qwen3-Embedding-8B",
					context_length: 32768,
					architecture: { modality: "text->embedding", tokenizer: "Other" },
					pricing: { prompt: "0.00000002", completion: "0", image: "0", request: "0" },
					supported_features: [],
				},
			]),
		) as unknown as FetchImpl;

		const options = nebiusModelManagerOptions({ apiKey: "nebius-key", fetch: fetchMock });
		expect(options.dynamicModelsAuthoritative).toBe(true);
		const models = await options.fetchDynamicModels?.();

		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.tokenfactory.nebius.com/v1/models",
			expect.objectContaining({
				method: "GET",
				headers: expect.objectContaining({ Authorization: "Bearer nebius-key" }),
			}),
		);

		const kimi = models?.find(model => model.id === "moonshotai/Kimi-K2.7-Code");
		expect(kimi?.reasoning).toBe(true);
		expect(kimi?.input).toEqual(["text"]);
		expect(kimi?.contextWindow).toBe(262144);
		expect(kimi?.cost).toEqual({ input: 0.5, output: 1.5, cacheRead: 0, cacheWrite: 0 });

		const vision = models?.find(model => model.id === "openbmb/MiniCPM-V-4_5");
		expect(vision?.reasoning).toBe(false);
		expect(vision?.input).toEqual(["text", "image"]);

		const embedding = models?.find(model => model.id === "Qwen/Qwen3-Embedding-8B");
		expect(embedding?.supportsTools).toBe(false);
	});

	test("prefers explicit base URL over NEBIUS_BASE_URL and appends /v1", async () => {
		Bun.env.NEBIUS_BASE_URL = "https://env.tokenfactory.test";
		const fetchMock: FetchImpl = vi.fn(async () =>
			nebiusModelsResponse([{ id: "moonshotai/Kimi-K2.7-Code" }]),
		) as unknown as FetchImpl;

		const options = nebiusModelManagerOptions({
			apiKey: "nebius-key",
			baseUrl: "https://config.tokenfactory.test/",
			fetch: fetchMock,
		});
		await options.fetchDynamicModels?.();

		expect(fetchMock).toHaveBeenCalledWith(
			"https://config.tokenfactory.test/v1/models",
			expect.objectContaining({ method: "GET" }),
		);
	});
});
