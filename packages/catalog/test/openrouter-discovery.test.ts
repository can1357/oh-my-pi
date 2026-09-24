import { describe, expect, it } from "bun:test";
import { openrouterModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

const CHAT_PAYLOAD = {
	data: [
		{
			id: "openrouter/auto",
			name: "OpenRouter Auto",
			supported_parameters: ["tools"],
			architecture: { input_modalities: ["text"], modality: "text+image" },
		},
		{
			id: "google/gemini-3-pro-image",
			name: "Gemini 3 Pro Image (chat listing)",
			supported_parameters: ["tools"],
			architecture: { input_modalities: ["text", "image"] },
		},
		{
			id: "fallback/modality-model",
			name: "Fallback Modality Model",
			supported_parameters: ["tools"],
			architecture: { modality: "text+image" },
		},
		{
			id: "embeddings/not-chat",
			name: "Not Chat",
			supported_parameters: [],
			architecture: { input_modalities: ["text"] },
		},
	],
};

const IMAGE_PAYLOAD = {
	data: [
		{
			id: "google/gemini-3-pro-image",
			name: "Gemini 3 Pro Image",
			architecture: { output_modalities: ["image"] },
			supported_parameters: ["aspect_ratio"],
			supports_streaming: false,
		},
		{
			id: "bytedance-seed/seedream-5-0-pro",
			name: "Seedream 5.0 Pro",
			architecture: { output_modalities: ["image"] },
			supported_parameters: ["aspect_ratio"],
			supports_streaming: false,
		},
	],
};

const DECISIONS_PAYLOAD = {
	data: [
		{
			id: "~typesafe/jev-latest",
			name: "TypeSafe: Jev Latest",
			architecture: { modality: "text->decisions", input_modalities: ["text"], output_modalities: ["decisions"] },
			context_length: 32000,
			pricing: { prompt: "0.000000042", completion: "0" },
			supported_parameters: [],
			top_provider: { context_length: 32000, max_completion_tokens: 28800 },
		},
	],
};

const RERANK_PAYLOAD = {
	data: [
		{
			id: "cohere/rerank-v3.5",
			name: "Cohere: Rerank v3.5",
			architecture: { modality: "text->rerank", input_modalities: ["text"], output_modalities: ["rerank"] },
			context_length: 4096,
			pricing: { prompt: "0", completion: "0" },
			supported_parameters: [],
			top_provider: { context_length: 4096, max_completion_tokens: 3686 },
		},
	],
};

const VIDEO_PAYLOAD = {
	data: [
		{
			id: "google/veo-3.1",
			name: "Google: Veo 3.1",
			supported_durations: [4, 6, 8],
			supported_resolutions: ["720p", "1080p", "4K"],
			supported_aspect_ratios: ["16:9", "9:16"],
			pricing_skus: { duration_seconds_with_audio: "0.40" },
		},
	],
};

const EMBEDDING_PAYLOAD = {
	data: [
		{
			id: "qwen/qwen3-embedding-8b",
			name: "Qwen: Qwen3 Embedding 8B",
			architecture: {
				modality: "text->embeddings",
				input_modalities: ["text"],
				output_modalities: ["embeddings"],
			},
			context_length: 32768,
			pricing: { prompt: "0.00000001", completion: "0" },
			supported_parameters: [],
			top_provider: { context_length: 32000, max_completion_tokens: null },
		},
	],
};

describe("OpenRouter chat, image, decisions, rerank, video, and embedding discovery", () => {
	it("keeps image-only rows and lets the image endpoint win id collisions", async () => {
		const requested: string[] = [];
		const options = openrouterModelManagerOptions({
			fetch: async input => {
				const url = String(input);
				requested.push(url);
				if (url.endsWith("/videos/models")) return Response.json(VIDEO_PAYLOAD);
				if (url.endsWith("/embeddings/models")) return Response.json(EMBEDDING_PAYLOAD);
				if (url.endsWith("/images/models")) return Response.json(IMAGE_PAYLOAD);
				if (url.endsWith("/models?output_modalities=decisions")) return Response.json(DECISIONS_PAYLOAD);
				if (url.endsWith("/models?output_modalities=rerank")) return Response.json(RERANK_PAYLOAD);
				if (url.endsWith("/models")) return Response.json(CHAT_PAYLOAD);
				return new Response(null, { status: 404 });
			},
		});

		const models = await options.fetchDynamicModels?.();
		expect(requested.sort()).toEqual([
			"https://openrouter.ai/api/v1/embeddings/models",
			"https://openrouter.ai/api/v1/images/models",
			"https://openrouter.ai/api/v1/models",
			"https://openrouter.ai/api/v1/models?output_modalities=decisions",
			"https://openrouter.ai/api/v1/models?output_modalities=rerank",
			"https://openrouter.ai/api/v1/videos/models",
		]);
		// Decision rows answer only through `/api/alpha/decisions`; they are judge-kind, tool-less, input-priced.
		expect(models?.find(model => model.id === "~typesafe/jev-latest")).toEqual(
			expect.objectContaining({
				api: "openrouter-decisions",
				kind: "judge",
				baseUrl: "https://openrouter.ai/api/alpha",
				supportsTools: false,
				input: ["text"],
				cost: expect.objectContaining({ input: expect.closeTo(0.042, 6), output: 0 }),
				contextWindow: 32000,
				maxTokens: 28800,
			}),
		);
		expect(models?.find(model => model.id === "cohere/rerank-v3.5")).toMatchObject({
			api: "openrouter-rerank",
			kind: "rerank",
			baseUrl: "https://openrouter.ai/api/v1",
			reasoning: false,
			input: ["text"],
			supportsTools: false,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 3686,
		});
		expect(models?.find(model => model.id === "google/veo-3.1")).toMatchObject({
			api: "openrouter-video",
			kind: "video",
			baseUrl: "https://openrouter.ai/api/v1",
			reasoning: false,
			input: ["text", "image"],
			supportsTools: false,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: null,
			maxTokens: null,
		});
		expect(models?.find(model => model.id === "qwen/qwen3-embedding-8b")).toMatchObject({
			api: "openai-embeddings",
			kind: "embedding",
			baseUrl: "https://openrouter.ai/api/v1",
			reasoning: false,
			input: ["text"],
			supportsTools: false,
			cost: { input: 0.01, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32768,
			maxTokens: null,
		});
		expect(models?.find(model => model.id === "openrouter/auto")).toMatchObject({
			api: "openrouter",
			input: ["text"],
		});
		expect(models?.find(model => model.id === "fallback/modality-model")).toMatchObject({
			api: "openrouter",
			input: ["text", "image"],
		});
		expect(models?.some(model => model.id === "embeddings/not-chat")).toBe(false);
		expect(models?.filter(model => model.id === "google/gemini-3-pro-image")).toEqual([
			expect.objectContaining({
				name: "Gemini 3 Pro Image",
				api: "openrouter-images",
				kind: "image",
				baseUrl: "https://openrouter.ai/api/v1",
				reasoning: false,
				input: ["text", "image"],
				supportsTools: false,
			}),
		]);
		expect(models?.find(model => model.id === "bytedance-seed/seedream-5-0-pro")).toMatchObject({
			api: "openrouter-images",
			kind: "image",
		});
	});

	it("preserves chat discovery when the image endpoint fails", async () => {
		const options = openrouterModelManagerOptions({
			fetch: async input => {
				const url = String(input);
				if (url.endsWith("/images/models")) throw new Error("image endpoint unavailable");
				if (url === "https://openrouter.ai/api/v1/models") return Response.json(CHAT_PAYLOAD);
				return new Response(null, { status: 404 });
			},
		});

		const models = await options.fetchDynamicModels?.();
		expect(models?.some(model => model.id === "openrouter/auto" && model.api === "openrouter")).toBe(true);
		expect(models?.some(model => model.api === "openrouter-images")).toBe(false);
	});
});
