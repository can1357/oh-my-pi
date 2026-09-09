import { describe, expect, test } from "bun:test";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import { novitaModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

describe("Novita built-in provider", () => {
	test("registers catalog descriptor with NOVITA_API_KEY env discovery", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "novita");
		expect(descriptor).toBeDefined();
		expect(descriptor?.defaultModel).toBe("moonshotai/kimi-k2.7-code");
		expect(descriptor?.catalogDiscovery?.envVars).toContain("NOVITA_API_KEY");
		expect(descriptor?.catalogDiscovery?.allowUnauthenticated).toBe(true);
		expect(descriptor?.dynamicModelsAuthoritative).toBe(true);
		expect(DEFAULT_MODEL_PER_PROVIDER.novita).toBe("moonshotai/kimi-k2.7-code");
	});

	test("maps Novita model catalog metadata from the public OpenAI-compatible endpoint", async () => {
		const requests: string[] = [];
		const fetchMock = async (input: string | URL | Request): Promise<Response> => {
			requests.push(input.toString());
			return Response.json({
				data: [
					{
						id: "moonshotai/kimi-k2.7-code",
						display_name: "Kimi K2.7 Code",
						status: 1,
						context_size: 262144,
						max_output_tokens: 131072,
						input_token_price_per_m: 9500,
						output_token_price_per_m: 40000,
						pricing: {
							input_cache_read: {
								price_per_m: 1900,
							},
						},
						features: ["serverless", "function-calling", "structured-outputs", "reasoning"],
						endpoints: ["chat/completions", "anthropic"],
						input_modalities: ["text", "image", "video"],
					},
					{
						id: "qwen/qwen3-8b-fp8",
						status: 4,
						context_size: 128000,
						max_output_tokens: 20000,
						endpoints: ["chat/completions"],
						input_modalities: ["text"],
					},
					{
						id: "ai_infer_test_1",
						status: 1,
						context_size: 200000,
						max_output_tokens: 200000,
						features: ["function-calling"],
						endpoints: ["chat/completions"],
						input_modalities: ["text"],
					},
					{
						id: "minimax/m2-her",
						status: 1,
						context_size: 32000,
						features: ["serverless"],
						endpoints: ["chat/completions"],
						input_modalities: ["text"],
					},
					{
						id: "test/zero-output",
						status: 1,
						context_size: 32000,
						max_output_tokens: 0,
						features: ["serverless"],
						endpoints: ["chat/completions"],
						input_modalities: ["text"],
					},
				],
			});
		};

		const options = novitaModelManagerOptions({ fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();
		const model = models?.find(item => item.id === "moonshotai/kimi-k2.7-code");

		expect(requests).toEqual(["https://api.novita.ai/openai/v1/models"]);
		expect(options.dynamicModelsAuthoritative).toBe(true);
		expect(models?.map(item => item.id)).toEqual(["moonshotai/kimi-k2.7-code"]);
		expect(model?.provider).toBe("novita");
		expect(model?.baseUrl).toBe("https://api.novita.ai/openai/v1");
		expect(model?.name).toBe("Kimi K2.7 Code");
		expect(model?.reasoning).toBe(true);
		expect(model?.supportsTools).toBe(true);
		expect(model?.input).toEqual(["text", "image"]);
		expect(model?.cost).toEqual({ input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0 });
		expect(model?.contextWindow).toBe(262144);
		expect(model?.maxTokens).toBe(131072);
	});
});
