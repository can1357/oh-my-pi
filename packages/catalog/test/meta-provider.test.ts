import { describe, expect, test } from "bun:test";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { CATALOG_PROVIDERS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import { META_MUSE_STATIC_MODELS, metaModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

describe("Meta Model API provider", () => {
	test("ships the documented Muse Spark catalog with Responses capabilities", () => {
		expect(META_MUSE_STATIC_MODELS).toEqual([
			{
				id: "muse-spark-1.3",
				name: "Muse Spark 1.3",
				api: "openai-responses",
				provider: "meta",
				baseUrl: "https://api.meta.ai/v1",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 },
				contextWindow: 1_048_576,
				maxTokens: 131_072,
				thinking: {
					mode: "effort",
					efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
				},
				compat: {
					supportsReasoningEffort: true,
					includeEncryptedReasoning: true,
				},
			},
			{
				id: "muse-spark-1.3-contributor",
				name: "Muse Spark 1.3 Contributor (Data Used for Training)",
				api: "openai-responses",
				provider: "meta",
				baseUrl: "https://api.meta.ai/v1",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0 },
				contextWindow: 1_048_576,
				maxTokens: 131_072,
				thinking: {
					mode: "effort",
					efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
				},
				compat: {
					supportsReasoningEffort: true,
					includeEncryptedReasoning: true,
				},
			},
			{
				id: "muse-spark-1.1",
				name: "Muse Spark 1.1",
				api: "openai-responses",
				provider: "meta",
				baseUrl: "https://api.meta.ai/v1",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 },
				contextWindow: 1_048_576,
				maxTokens: 131_072,
				thinking: {
					mode: "effort",
					efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
				},
				compat: {
					supportsReasoningEffort: true,
					includeEncryptedReasoning: true,
				},
			},
			{
				id: "muse-spark-1.2",
				name: "Muse Spark 1.2",
				api: "openai-responses",
				provider: "meta",
				baseUrl: "https://api.meta.ai/v1",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 },
				contextWindow: 1_048_576,
				maxTokens: 131_072,
				thinking: {
					mode: "effort",
					efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
				},
				compat: {
					supportsReasoningEffort: true,
					includeEncryptedReasoning: true,
				},
			},
			{
				id: "muse-spark-1.2-contributor",
				name: "Muse Spark 1.2 Contributor (Data Used for Training)",
				api: "openai-responses",
				provider: "meta",
				baseUrl: "https://api.meta.ai/v1",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0 },
				contextWindow: 1_048_576,
				maxTokens: 131_072,
				thinking: {
					mode: "effort",
					efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
				},
				compat: {
					supportsReasoningEffort: true,
					includeEncryptedReasoning: true,
				},
			},
		]);
		const options = metaModelManagerOptions();
		expect(options.providerId).toBe("meta");
		expect(options.staticModels).toEqual(META_MUSE_STATIC_MODELS);
	});

	test("refreshes the team-enabled Muse Spark roster with family-safe defaults", async () => {
		let requestedUrl = "";
		let authorization = "";
		const options = metaModelManagerOptions({
			apiKey: "LLM|catalog-key",
			fetch: (input, init) => {
				requestedUrl = String(input);
				authorization = new Headers(init?.headers).get("Authorization") ?? "";
				return Promise.resolve(
					Response.json({
						data: [
							{ id: "muse-spark-1.3" },
							{ id: "muse-spark-1.3-contributor" },
							{ id: "muse-spark-1.4-preview" },
							{ id: "muse-image-1.0" },
							{ id: "muse-voice-transcribe-1.0" },
						],
					}),
				);
			},
		});

		expect(options.dynamicModelsAuthoritative).toBe(true);
		const models = await options.fetchDynamicModels?.();
		expect(models?.map(model => model.id)).toEqual([
			"muse-spark-1.3",
			"muse-spark-1.3-contributor",
			"muse-spark-1.4-preview",
		]);
		const byId = new Map(models?.map(model => [model.id, model]));
		expect(byId.get("muse-spark-1.3")).toMatchObject({
			name: "Muse Spark 1.3",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 },
			contextWindow: 1_048_576,
			maxTokens: 131_072,
		});
		expect(byId.get("muse-spark-1.3-contributor")).toMatchObject({
			name: "Muse Spark 1.3 Contributor (Data Used for Training)",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0 },
			contextWindow: 1_048_576,
			maxTokens: 131_072,
		});
		expect(byId.get("muse-spark-1.4-preview")).toMatchObject({
			name: "Muse Spark 1.4-preview",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_048_576,
			maxTokens: 131_072,
		});
		expect(requestedUrl).toBe("https://api.meta.ai/v1/models");
		expect(authorization).toBe("Bearer LLM|catalog-key");
	});

	test("prefers Meta's documented key name while accepting the provider-specific alias", () => {
		const descriptor = CATALOG_PROVIDERS.find(provider => provider.id === "meta");
		expect(descriptor).toMatchObject({
			defaultModel: "muse-spark-1.3",
			dynamicModelsAuthoritative: true,
			envVars: ["MODEL_API_KEY", "META_API_KEY"],
			catalogDiscovery: { label: "Meta Model API" },
		});
	});
});
