import { describe, expect, test } from "bun:test";
import { INFRON_BASE_URL, infronModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

function infronFixture(): Response {
	return Response.json({
		success: true,
		data: [
			{
				id: "z-ai/glm-5.2",
				object: "model",
				display_name: "Z.AI: GLM 5.2",
				category_type: "LLM",
				context_length: 1000000,
				max_output_tokens: 128000,
				input_modalities: ["text"],
				supports_function_calling: true,
				min_prompt_price: 0.55,
				min_completion_price: 1.9255,
				deprecated: false,
				is_display_only: false,
			},
			{
				id: "anthropic/claude-sonnet-5",
				object: "model",
				display_name: "Anthropic: Claude Sonnet 5",
				category_type: "LLM",
				context_length: 1000000,
				// Mirrors production: the reported output cap restates the context
				// ceiling, so it is not a real output limit.
				max_output_tokens: 1000000,
				input_modalities: ["text", "image", "file"],
				supports_function_calling: true,
				min_prompt_price: 2,
				min_completion_price: 10,
			},
			{
				id: "openai/tool-less-model",
				object: "model",
				display_name: "OpenAI: Tool-less Model",
				category_type: "LLM",
				context_length: 131072,
				max_output_tokens: 8192,
				input_modalities: ["text"],
				supports_function_calling: false,
				min_prompt_price: 0.1,
				min_completion_price: 0.2,
			},
			// The same roster interleaves non-chat surfaces; only
			// `category_type: "LLM"` rows are servable by the chat picker.
			{
				id: "openai/text-embedding-3-small",
				display_name: "OpenAI: Text Embedding 3 Small",
				category_type: "Embeddings",
			},
			{
				id: "google/nano-banana/text-to-image",
				display_name: "Google: Nano Banana",
				category_type: "Text to Image",
			},
			{
				id: "tavily/tavily-search",
				display_name: "Tavily: Search",
				category_type: "Search",
			},
			{
				id: "openai/retired-model",
				display_name: "OpenAI: Retired Model",
				category_type: "LLM",
				deprecated: true,
			},
		],
	});
}

describe("Infron built-in provider", () => {
	test("maps chat rows with native limits, $/M prices, and modalities", async () => {
		const requests: string[] = [];
		const fetchMock = async (input: string | URL | Request): Promise<Response> => {
			requests.push(input.toString());
			return infronFixture();
		};

		const options = infronModelManagerOptions({ fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();

		expect(requests).toEqual([`${INFRON_BASE_URL}/models`]);
		// The exact id list also proves embeddings, image, search, and
		// deprecated rows never reach the chat picker.
		expect(models?.map(item => item.id)).toEqual([
			"anthropic/claude-sonnet-5",
			"openai/tool-less-model",
			"z-ai/glm-5.2",
		]);

		const glm = models?.find(item => item.id === "z-ai/glm-5.2");
		expect(glm?.provider).toBe("infron");
		expect(glm?.baseUrl).toBe(INFRON_BASE_URL);
		expect(glm?.name).toBe("Z.AI: GLM 5.2");
		expect(glm?.cost).toEqual({ input: 0.55, output: 1.9255, cacheRead: 0, cacheWrite: 0 });
		expect(glm?.contextWindow).toBe(1000000);
		expect(glm?.maxTokens).toBe(128000);
		expect(glm?.input).toEqual(["text"]);
	});

	test("treats an output cap at the context ceiling as unknown", async () => {
		const fetchMock = async (): Promise<Response> => infronFixture();
		const options = infronModelManagerOptions({ fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();

		const sonnet = models?.find(item => item.id === "anthropic/claude-sonnet-5");
		expect(sonnet?.contextWindow).toBe(1000000);
		expect(sonnet?.maxTokens).toBeNull();
		// `file` is not a chat input modality the picker can serve.
		expect(sonnet?.input).toEqual(["text", "image"]);
	});

	test("drops tool support when the roster row says function calling is unsupported", async () => {
		const fetchMock = async (): Promise<Response> => infronFixture();
		const options = infronModelManagerOptions({ fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();

		const toolless = models?.find(item => item.id === "openai/tool-less-model");
		expect(toolless?.supportsTools).toBe(false);
		const glm = models?.find(item => item.id === "z-ai/glm-5.2");
		expect(glm?.supportsTools).toBeUndefined();
	});
});
