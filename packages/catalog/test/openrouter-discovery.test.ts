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

describe("OpenRouter chat and image discovery", () => {
	it("keeps image-only rows and lets the image endpoint win id collisions", async () => {
		const requested: string[] = [];
		const options = openrouterModelManagerOptions({
			fetch: async input => {
				const url = String(input);
				requested.push(url);
				if (url.endsWith("/images/models")) return Response.json(IMAGE_PAYLOAD);
				if (url.endsWith("/models")) return Response.json(CHAT_PAYLOAD);
				return new Response(null, { status: 404 });
			},
		});

		const models = await options.fetchDynamicModels?.();
		expect(requested.sort()).toEqual([
			"https://openrouter.ai/api/v1/images/models",
			"https://openrouter.ai/api/v1/models",
		]);
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
				if (url.endsWith("/models")) return Response.json(CHAT_PAYLOAD);
				return new Response(null, { status: 404 });
			},
		});

		const models = await options.fetchDynamicModels?.();
		expect(models?.some(model => model.id === "openrouter/auto" && model.api === "openrouter")).toBe(true);
		expect(models?.some(model => model.api === "openrouter-images")).toBe(false);
	});
});
