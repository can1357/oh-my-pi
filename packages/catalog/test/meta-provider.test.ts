import { describe, expect, test } from "bun:test";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { CATALOG_PROVIDERS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import { META_MUSE_STATIC_MODELS, metaModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

describe("Meta Model API provider", () => {
	test("ships Muse Spark 1.1 with its documented Responses capabilities", () => {
		expect(META_MUSE_STATIC_MODELS).toEqual([
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

	test("prefers Meta's documented key name while accepting the provider-specific alias", () => {
		const descriptor = CATALOG_PROVIDERS.find(provider => provider.id === "meta");
		expect(descriptor).toMatchObject({
			defaultModel: "muse-spark-1.1",
			envVars: ["MODEL_API_KEY", "META_API_KEY"],
			catalogDiscovery: { label: "Meta Model API" },
		});
	});
});
