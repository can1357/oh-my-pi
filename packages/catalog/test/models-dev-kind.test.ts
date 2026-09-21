import { describe, expect, it } from "bun:test";
import {
	MODELS_DEV_PROVIDER_DESCRIPTORS,
	mapModelsDevToModels,
	type ModelsDevProviderDescriptor,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

function descriptorFor(providerId: string): ModelsDevProviderDescriptor {
	const descriptor = MODELS_DEV_PROVIDER_DESCRIPTORS.find(candidate => candidate.providerId === providerId);
	if (!descriptor) throw new Error(`Missing models.dev descriptor for ${providerId}`);
	return descriptor;
}

const OPENROUTER_DESCRIPTOR: ModelsDevProviderDescriptor = {
	modelsDevKey: "openrouter",
	providerId: "openrouter",
	api: "openrouter",
	baseUrl: "https://openrouter.ai/api/v1",
};

describe("models.dev normalized kind mapping", () => {
	it("routes supported non-chat kinds while preserving ordinary chat mapping", () => {
		const models = mapModelsDevToModels(
			{
				openai: {
					models: {
						"gpt-image-1": {
							name: "GPT Image 1",
							kind: "image",
							tool_call: false,
							modalities: { input: ["text", "image"], output: ["image"] },
							cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 0.2 },
							limit: { context: 32_000, output: 4_096 },
						},
						"gpt-5": {
							name: "GPT-5",
							tool_call: true,
							reasoning: true,
							modalities: { input: ["text", "image"], output: ["text"] },
							cost: { input: 3, output: 15 },
							limit: { context: 400_000, output: 128_000 },
						},
					},
				},
				google: {
					models: {
						"gemini-2.5-flash-preview-tts": {
							name: "Gemini 2.5 Flash Preview TTS",
							kind: "tts",
							tool_call: false,
							modalities: { input: ["text"], output: ["audio"] },
						},
					},
				},
				openrouter: {
					models: {
						"openrouter/auto": {
							name: "OpenRouter Auto",
							kind: "chat",
							tool_call: true,
							modalities: { input: ["text", "image"], output: ["text", "image"] },
						},
					},
				},
			},
			[descriptorFor("openai"), descriptorFor("google"), OPENROUTER_DESCRIPTOR],
		);

		expect(models.find(model => model.provider === "openai" && model.id === "gpt-image-1")).toMatchObject({
			api: "openai-responses",
			kind: "image",
			reasoning: false,
			input: ["text", "image"],
			supportsTools: false,
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
			contextWindow: 32_000,
			maxTokens: 4_096,
		});
		expect(models.some(model => model.provider === "google" && model.id === "gemini-2.5-flash-preview-tts")).toBe(
			false,
		);
		expect(models.find(model => model.provider === "openrouter" && model.id === "openrouter/auto")).toMatchObject({
			api: "openrouter",
			reasoning: false,
			input: ["text", "image"],
		});
		expect(
			models.find(model => model.provider === "openrouter" && model.id === "openrouter/auto")?.kind,
		).toBeUndefined();
		expect(models.find(model => model.provider === "openai" && model.id === "gpt-5")).toMatchObject({
			api: "openai-responses",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400_000,
			maxTokens: 128_000,
		});
		expect(models.find(model => model.provider === "openai" && model.id === "gpt-5")?.kind).toBeUndefined();
	});

	it("lets reviewed catalog residue correct an ambiguous proxy kind", () => {
		const models = mapModelsDevToModels(
			{
				google: {
					models: {
						"gemini-3.1-flash-lite-image": {
							name: "Gemini 3.1 Flash Lite Image",
							kind: "chat",
							tool_call: false,
							modalities: { input: ["text", "image"], output: ["text", "image"] },
						},
					},
				},
			},
			[descriptorFor("google")],
		);

		expect(models).toHaveLength(1);
		expect(models[0]).toMatchObject({
			id: "gemini-3.1-flash-lite-image",
			api: "google-generative-ai",
			kind: "image",
			reasoning: false,
			supportsTools: false,
		});
	});
});
