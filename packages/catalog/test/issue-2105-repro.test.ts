import { describe, expect, test } from "bun:test";
import { getEnvApiKey } from "@oh-my-pi/pi-ai/stream";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import {
	aimlApiModelManagerOptions,
	isLikelyAimlApiChatModelId,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

describe("AIML API built-in provider (issue #2105)", () => {
	test("registers built-in runtime descriptor with AIMLAPI_API_KEY discovery", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "aimlapi");

		expect(descriptor).toBeDefined();
		expect(descriptor?.defaultModel).toBe("gpt-5.5-2026-04-23");
		expect(descriptor?.catalogDiscovery?.label).toBe("AIML API");
		expect(descriptor?.catalogDiscovery?.envVars).toContain("AIMLAPI_API_KEY");
		expect(DEFAULT_MODEL_PER_PROVIDER.aimlapi).toBe("gpt-5.5-2026-04-23");
	});

	test("uses the OpenAI-compatible completions transport and AIML API base URL", async () => {
		const calls: Array<{ url: string; authorization: string | null }> = [];
		const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			calls.push({ url: input.toString(), authorization: headers.get("authorization") });
			return new Response(
				JSON.stringify({
					data: [
						{ id: "alibaba/qwen-image", name: "Qwen Image" },
						{ id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
						{ id: "google/veo-3.1-first-last-image-to-video", name: "Veo Video" },
						{ id: "gpt-4o", name: "GPT-4o" },
						{ id: "gpt-4o-mini-tts", name: "GPT-4o Mini TTS" },
						{ id: "text-embedding-3-large", name: "Text Embedding 3 Large" },
					],
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			);
		}) as typeof fetch;
		const options = aimlApiModelManagerOptions({ apiKey: "aiml-test-key", fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();

		expect(options.providerId).toBe("aimlapi");
		expect(calls).toEqual([
			{
				url: "https://api.aimlapi.com/v1/models",
				authorization: "Bearer aiml-test-key",
			},
		]);
		expect(models?.find(model => model.id === "gpt-4o")).toMatchObject({
			id: "gpt-4o",
			name: "GPT-4o",
			api: "openai-completions",
			provider: "aimlapi",
			baseUrl: "https://api.aimlapi.com/v1",
		});
		expect(models?.map(model => model.id)).toEqual(["claude-sonnet-4-5", "gpt-4o"]);
	});

	test("filters AIML API discovery to chat-compatible model IDs", () => {
		for (const modelId of [
			"alibaba/qwen-image",
			"gpt-4o-mini-tts",
			"google/veo-3.1-first-last-image-to-video",
			"text-embedding-3-large",
			"bytedance/seedance-1-0-lite-i2v",
			"dall-e-3",
			"flux-2",
			"google/veo-3.1-i2v",
			"imagen-3.0-generate-002",
			"sora-2-i2v",
			"whisper-large",
		]) {
			expect(isLikelyAimlApiChatModelId(modelId)).toBe(false);
		}

		for (const modelId of ["gpt-4o", "claude-sonnet-4-5", "deepseek-v3.2"]) {
			expect(isLikelyAimlApiChatModelId(modelId)).toBe(true);
		}
	});

	test("resolves AIMLAPI_API_KEY via env", () => {
		const previous = Bun.env.AIMLAPI_API_KEY;
		Bun.env.AIMLAPI_API_KEY = "aiml-test-key";
		try {
			expect(getEnvApiKey("aimlapi")).toBe("aiml-test-key");
		} finally {
			if (previous === undefined) {
				delete Bun.env.AIMLAPI_API_KEY;
			} else {
				Bun.env.AIMLAPI_API_KEY = previous;
			}
		}
	});
});
