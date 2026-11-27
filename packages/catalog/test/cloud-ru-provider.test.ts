import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { cloudRuModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

/** Rows mirror `GET https://foundation-models.api.cloud.ru/v1/models` (2026-11-27). */
const GIGACHAT_ROW = {
	id: "ai-sage/GigaChat3-10B-A1.8B",
	object: "model",
	owned_by: "ai-sage",
	context_length: 262144,
	max_model_len: 262144,
	function_calling: true,
	metadata: {
		name: "GigaChat3-10B-A1.8B",
		type: "llm",
		provider: "cloud.ru",
		input_modalities: ["text"],
		output_modalities: ["text"],
		prompt_tokens_cost: 12.2,
		generated_tokens_cost: 12.2,
		endpoints: [{ method: "POST", path: "/v1/chat/completions" }],
	},
};

const DEEPSEEK_ROW = {
	id: "deepseek-ai/DeepSeek-V4-Pro",
	object: "model",
	owned_by: "deepseek-ai",
	context_length: 1048576,
	max_model_len: 1048576,
	function_calling: true,
	reasoning: true,
	metadata: {
		name: "DeepSeek-V4-Pro",
		type: "llm",
		provider: "cloud.ru",
		input_modalities: ["text"],
		output_modalities: ["text"],
		prompt_tokens_cost: 183,
		generated_tokens_cost: 732,
		endpoints: [{ method: "POST", path: "/v1/chat/completions" }],
	},
};

const VISION_REASONING_ROW = {
	id: "Qwen/Qwen3.5-397B-A17B",
	object: "model",
	owned_by: "Qwen",
	context_length: 262144,
	max_model_len: 262144,
	function_calling: true,
	reasoning: true,
	metadata: {
		name: "Qwen3.5-397B-A17B",
		type: "llm",
		provider: "cloud.ru",
		input_modalities: ["text", "image"],
		output_modalities: ["text"],
		prompt_tokens_cost: 915,
		generated_tokens_cost: 1085.8,
		endpoints: [{ method: "POST", path: "/v1/chat/completions" }],
	},
};

const NO_TOOLS_ROW = {
	id: "google/gemini-3.1-flash-lite-image",
	object: "model",
	owned_by: "Google",
	context_length: 65536,
	function_calling: false,
	metadata: {
		name: "Gemini 3.1 Flash Lite Image",
		type: "llm",
		provider: "external",
		input_modalities: ["image", "text"],
		output_modalities: ["image", "text"],
		prompt_tokens_cost: 44.51,
		generated_tokens_cost: 267,
		endpoints: [{ method: "POST", path: "/v1/chat/completions" }],
	},
};

const NON_CHAT_ROWS = [
	{
		id: "ai-sage/Giga-Embeddings-instruct-3B",
		object: "model",
		context_length: 8192,
		metadata: {
			name: "Giga-Embeddings-instruct-3B",
			type: "embedder",
			input_modalities: ["text"],
			output_modalities: ["embedding"],
			endpoints: [{ method: "POST", path: "/v1/embeddings" }],
		},
	},
	{
		id: "BAAI/bge-reranker-v2-m3",
		object: "model",
		context_length: 8192,
		metadata: {
			name: "bge-reranker-v2-m3",
			type: "rerank",
			input_modalities: ["text"],
			output_modalities: ["text"],
			endpoints: [{ method: "POST", path: "/v1/rerank" }],
		},
	},
	{
		id: "hivetrace/HiveTraceGuard-Pro",
		object: "model",
		context_length: 40960,
		metadata: {
			name: "HiveTraceGuard-Pro",
			type: "guard",
			input_modalities: ["text"],
			output_modalities: ["text"],
			endpoints: [{ method: "POST", path: "/v1/chat/completions" }],
		},
	},
	{
		id: "deepseek-ai/DeepSeek-OCR-2",
		object: "model",
		context_length: 8192,
		metadata: {
			name: "DeepSeek-OCR-2",
			type: "image+text-to-text",
			input_modalities: ["image", "text"],
			output_modalities: ["text"],
			endpoints: [{ method: "POST", path: "/v1/chat/completions" }],
		},
	},
	{
		id: "openai/whisper-large-v3",
		object: "model",
		context_length: 448,
		metadata: {
			name: "whisper-large-v3",
			type: "audio-to-text",
			input_modalities: ["audio"],
			output_modalities: ["text"],
			endpoints: [{ method: "POST", path: "/v1/audio/transcriptions" }],
		},
	},
	{
		id: "GigaChat/SaluteSpeech",
		object: "model",
		metadata: {
			name: "SaluteSpeech",
			type: "tts",
			endpoints: [{ method: "GET", path: "/v1/realtime" }],
		},
	},
	{
		id: "custom/completions-only",
		object: "model",
		context_length: 32768,
		metadata: {
			name: "Completions Only",
			type: "llm",
			input_modalities: ["text"],
			output_modalities: ["text"],
			endpoints: [{ method: "POST", path: "/v1/completions" }],
		},
	},
];

async function discover(data: Record<string, unknown>[], config?: { apiKey?: string; baseUrl?: string }) {
	const requests: { url: string; authorization: string | null }[] = [];
	const fetch: FetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		if (url.includes("catalog.stencil.so")) {
			return new Response(null, { status: 404 });
		}
		requests.push({ url, authorization: new Headers(init?.headers).get("authorization") });
		return Response.json({ object: "list", data });
	};
	const specs = await cloudRuModelManagerOptions({ ...config, fetch }).fetchDynamicModels?.();
	return { requests, specs: specs ?? [], models: (specs ?? []).map(spec => buildModel(spec)) };
}

describe("Cloud.ru discovery", () => {
	test("maps LLM capabilities, drops non-chat entries, and keeps RUB rates out of USD cost", async () => {
		const { requests, models } = await discover(
			[GIGACHAT_ROW, DEEPSEEK_ROW, VISION_REASONING_ROW, NO_TOOLS_ROW, ...NON_CHAT_ROWS],
			{ apiKey: "key-id.key-secret" },
		);

		expect(requests).toEqual([
			{
				url: "https://foundation-models.api.cloud.ru/v1/models",
				authorization: "Bearer key-id.key-secret",
			},
		]);
		expect(models.map(model => model.id).sort()).toEqual(
			[GIGACHAT_ROW.id, DEEPSEEK_ROW.id, VISION_REASONING_ROW.id, NO_TOOLS_ROW.id].sort(),
		);

		const gigachat = models.find(model => model.id === GIGACHAT_ROW.id);
		expect(gigachat).toMatchObject({
			name: "GigaChat3-10B-A1.8B",
			reasoning: false,
			input: ["text"],
			contextWindow: 262144,
			maxTokens: null,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			pricingStatus: "unknown",
		});
		expect(gigachat?.compat).toMatchObject({ supportsStore: false });

		expect(models.find(model => model.id === DEEPSEEK_ROW.id)).toMatchObject({
			name: "DeepSeek-V4-Pro",
			reasoning: true,
			input: ["text"],
			contextWindow: 1048576,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			pricingStatus: "unknown",
			thinking: { efforts: [Effort.Low, Effort.High, Effort.Max] },
		});

		expect(models.find(model => model.id === VISION_REASONING_ROW.id)).toMatchObject({
			name: "Qwen3.5-397B-A17B",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 262144,
		});

		expect(models.find(model => model.id === NO_TOOLS_ROW.id)).toMatchObject({
			name: "Gemini 3.1 Flash Lite Image",
			input: ["text", "image"],
			supportsTools: false,
			contextWindow: 65536,
		});
	});

	test("honors a configured baseUrl override with trailing slash", async () => {
		const { requests, models } = await discover([GIGACHAT_ROW], {
			baseUrl: "https://proxy.example.com/v1/",
		});

		expect(requests).toEqual([{ url: "https://proxy.example.com/v1/models", authorization: null }]);
		expect(models[0]?.baseUrl).toBe("https://proxy.example.com/v1");
	});
});
