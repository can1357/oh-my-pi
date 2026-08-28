import { describe, expect, test } from "bun:test";
import { chutesModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

describe("Chutes provider discovery", () => {
	const makeFetchMock = (models: unknown[]): FetchImpl => {
		return async () =>
			new Response(JSON.stringify({ data: models }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
	};

	test("maps pricing, context, reasoning, and modalities from Chutes /v1/models", async () => {
		const fetchMock = makeFetchMock([
			{
				id: "moonshotai/Kimi-K2.6-TEE",
				name: "Kimi K2.6 TEE",
				pricing: { prompt: 0.58, completion: 3.4, input_cache_read: 0.058 },
				context_length: 262144,
				max_output_length: 65535,
				supported_features: ["reasoning", "tools", "json_mode"],
				input_modalities: ["text", "image"],
			},
			{
				id: "Qwen/Qwen3-32B-TEE",
				pricing: { prompt: 0.104, completion: 0.416, input_cache_read: 0.0104 },
				context_length: 40960,
				max_output_length: 40960,
				supported_features: ["tools"],
				input_modalities: ["text"],
			},
		]);

		const options = chutesModelManagerOptions({ apiKey: "test-key", fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();

		const kimi = models?.find(m => m.id === "moonshotai/Kimi-K2.6-TEE");
		expect(kimi).toMatchObject({
			provider: "chutes",
			name: "Kimi K2.6 TEE",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0.58, output: 3.4, cacheRead: 0.058 },
			contextWindow: 262144,
			maxTokens: 65535,
		});

		const qwen = models?.find(m => m.id === "Qwen/Qwen3-32B-TEE");
		expect(qwen).toMatchObject({
			provider: "chutes",
			reasoning: false,
			input: ["text"],
			cost: { input: 0.104, output: 0.416, cacheRead: 0.0104 },
			contextWindow: 40960,
			maxTokens: 40960,
		});
	});

	test("falls back to defaults when Chutes fields are absent", async () => {
		const fetchMock = makeFetchMock([
			{
				id: "gemma-4-31B-turbo-TEE",
			},
		]);

		const options = chutesModelManagerOptions({ apiKey: "test-key", fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();

		expect(models?.find(m => m.id === "gemma-4-31B-turbo-TEE")).toMatchObject({
			provider: "chutes",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0 },
			contextWindow: null,
			maxTokens: null,
		});
	});
});
