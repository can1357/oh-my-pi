import { describe, expect, test } from "bun:test";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import { requestyModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

describe("Requesty built-in provider", () => {
	test("registers catalog descriptor with REQUESTY_API_KEY env discovery", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "requesty");
		expect(descriptor).toBeDefined();
		expect(descriptor?.defaultModel).toBe("openai/gpt-5.5");
		expect(descriptor?.catalogDiscovery?.envVars).toContain("REQUESTY_API_KEY");
		expect(descriptor?.catalogDiscovery?.allowUnauthenticated).toBe(true);
		expect(descriptor?.dynamicModelsAuthoritative).toBe(true);
		expect(DEFAULT_MODEL_PER_PROVIDER.requesty).toBe("openai/gpt-5.5");
	});

	test("maps Requesty model catalog metadata from the public endpoint", async () => {
		const requests: string[] = [];
		const fetchMock = async (input: string | URL | Request): Promise<Response> => {
			requests.push(input.toString());
			return Response.json({
				data: [
					{
						id: "anthropic/claude-3-7-sonnet",
						name: "Claude 3.7 Sonnet",
						supports_reasoning: true,
						supports_vision: true,
						input_price: 0.000003,
						output_price: 0.000015,
						cached_price: 0.0000003,
						caching_price: 0.00000375,
						context_window: 200000,
						max_output_tokens: 64000,
					},
					{
						id: "openai/gpt-4o-mini",
						name: "GPT-4o mini",
						supports_reasoning: false,
						supports_vision: true,
						input_price: 0.00000015,
						output_price: 0.0000006,
						cached_price: 0.000000075,
						caching_price: 0,
						context_window: 128000,
						max_output_tokens: 16384,
					},
					{
						id: "bedrock/claude-sonnet-4-6@us-east-1",
						name: "Claude Sonnet 4.6 Bedrock",
						supports_reasoning: true,
						supports_vision: true,
						context_window: 200000,
						max_output_tokens: 64000,
					},
				],
			});
		};

		const options = requestyModelManagerOptions({ fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();
		const claude = models?.find(item => item.id === "anthropic/claude-3-7-sonnet");
		const gpt = models?.find(item => item.id === "openai/gpt-4o-mini");

		expect(requests).toEqual(["https://router.requesty.ai/v1/models"]);
		expect(options.dynamicModelsAuthoritative).toBe(true);
		expect(models?.map(item => item.id)).toEqual([
			"anthropic/claude-3-7-sonnet",
			"bedrock/claude-sonnet-4-6@us-east-1",
			"openai/gpt-4o-mini",
		]);

		expect(claude?.provider).toBe("requesty");
		expect(claude?.baseUrl).toBe("https://router.requesty.ai/v1");
		expect(claude?.api).toBe("anthropic-messages");
		expect(claude?.name).toBe("Claude 3.7 Sonnet");
		expect(claude?.reasoning).toBe(true);
		expect(claude?.input).toEqual(["text", "image"]);
		expect(claude?.cost).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
		expect(claude?.contextWindow).toBe(200000);
		expect(claude?.maxTokens).toBe(64000);

		expect(gpt?.reasoning).toBe(false);
		expect(gpt?.api).toBe("openai-completions");
		expect(gpt?.cost).toEqual({ input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0 });
		const bedrockClaude = models?.find(item => item.id === "bedrock/claude-sonnet-4-6@us-east-1");
		expect(bedrockClaude?.api).toBe("anthropic-messages");
	});
});
