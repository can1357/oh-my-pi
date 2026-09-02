import { describe, expect, test } from "bun:test";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { CATALOG_PROVIDERS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import { metaModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("Meta Model API provider", () => {
	test("builds every team-enabled Meta model through Muse Spark family policy", async () => {
		using tempDir = TempDir.createSync("@omp-meta-models-");
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
							{ id: "muse-spark-1.4-preview", context_length: 2_000_000, max_completion_tokens: 200_000 },
							{ id: "muse-image-1.0" },
							{ id: "muse-voice-transcribe-1.0" },
						],
					}),
				);
			},
		});

		const result = await resolveProviderModels({ ...options, cacheDbPath: tempDir.join("models.db") }, "online");
		const models = result.models;
		expect(models.map(model => model.id).sort()).toEqual([
			"muse-image-1.0",
			"muse-spark-1.3",
			"muse-spark-1.3-contributor",
			"muse-spark-1.4-preview",
			"muse-voice-transcribe-1.0",
		]);
		const byId = new Map(models.map(model => [model.id, model]));
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
			contextWindow: 2_000_000,
			maxTokens: 200_000,
		});
		expect(byId.get("muse-spark-1.4-preview")?.thinking?.efforts).toEqual([
			Effort.Minimal,
			Effort.Low,
			Effort.Medium,
			Effort.High,
			Effort.XHigh,
		]);
		expect(byId.get("muse-image-1.0")).toMatchObject({
			reasoning: false,
			input: ["text"],
			contextWindow: null,
			maxTokens: null,
		});
		expect(requestedUrl).toBe("https://api.meta.ai/v1/models");
		expect(authorization).toBe("Bearer LLM|catalog-key");
	});

	test("rejects a partial multi-account roster as non-authoritative", async () => {
		using tempDir = TempDir.createSync("@omp-meta-partial-models-");
		const options = metaModelManagerOptions({
			apiKeys: ["LLM|catalog-a", "LLM|catalog-b"],
			fetch: (_input, init) => {
				const authorization = new Headers(init?.headers).get("Authorization");
				if (authorization === "Bearer LLM|catalog-a") {
					return Promise.resolve(Response.json({ data: [{ id: "muse-image-1.0" }] }));
				}
				return Promise.resolve(new Response("unavailable", { status: 503 }));
			},
		});

		const result = await resolveProviderModels({ ...options, cacheDbPath: tempDir.join("models.db") }, "online");
		expect(result.models.map(model => model.id).sort()).toEqual([
			"muse-spark-1.1",
			"muse-spark-1.2",
			"muse-spark-1.2-contributor",
			"muse-spark-1.3",
			"muse-spark-1.3-contributor",
		]);
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
