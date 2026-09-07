import { describe, expect, test } from "bun:test";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { CATALOG_PROVIDERS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import {
	META_MUSE_STATIC_MODELS,
	MUSE_CODE_STATIC_MODELS,
	metaModelManagerOptions,
	museCodeModelManagerOptions,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl, ThinkingConfig } from "@oh-my-pi/pi-catalog/types";

const MUSE_SPARK_THINKING: ThinkingConfig = {
	mode: "effort",
	efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
};
// Meta documents the `max` tier for Muse Spark 1.3 (standard) only.
const MUSE_SPARK_MAX_THINKING: ThinkingConfig = {
	mode: "effort",
	efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
};

function modelListResponse(ids: readonly string[]): Response {
	return Response.json({ object: "list", data: ids.map(id => ({ id, object: "model" })) });
}

describe("Meta Model API provider", () => {
	test("seeds every Muse Spark revision with Responses reasoning and tier pricing", () => {
		const byId = new Map(META_MUSE_STATIC_MODELS.map(model => [model.id, model]));
		expect([...byId.keys()]).toEqual([
			"muse-spark-1.1",
			"muse-spark-1.2",
			"muse-spark-1.2-contributor",
			"muse-spark-1.3",
			"muse-spark-1.3-contributor",
		]);
		expect(byId.get("muse-spark-1.3")).toEqual({
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
			thinking: MUSE_SPARK_MAX_THINKING,
			compat: { supportsReasoningEffort: true, includeEncryptedReasoning: true },
		});
		expect(byId.get("muse-spark-1.3-contributor")).toMatchObject({
			name: "Muse Spark 1.3 (C)",
			cost: { input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0 },
			thinking: MUSE_SPARK_THINKING,
		});
		const options = metaModelManagerOptions();
		expect(options.providerId).toBe("meta");
		expect(options.staticModels).toEqual(META_MUSE_STATIC_MODELS);
	});

	test("live discovery keeps seeded capabilities for ids Meta lists without metadata", async () => {
		// api.meta.ai/v1/models returns bare `{id}` rows: no name, limits,
		// reasoning, or pricing. Without the seed as reference, a newly shipped
		// revision surfaced as a text-only model with an unknown context window
		// and "Current model does not support thinking".
		const options = metaModelManagerOptions({
			apiKey: "meta-key",
			fetch: async () => modelListResponse(["muse-spark-1.3", "muse-spark-1.3-contributor", "muse-image-1.0"]),
		});
		const models = await options.fetchDynamicModels?.();
		const byId = new Map((models ?? []).map(model => [model.id, model]));
		expect(byId.get("muse-spark-1.3")).toMatchObject({
			name: "Muse Spark 1.3",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 1_048_576,
			maxTokens: 131_072,
			thinking: MUSE_SPARK_MAX_THINKING,
		});
		expect(byId.get("muse-spark-1.3-contributor")).toMatchObject({
			name: "Muse Spark 1.3 (C)",
			cost: { input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0 },
		});
		// Image/voice SKUs on the same roster are not chat models.
		expect(byId.has("muse-image-1.0")).toBe(false);
	});

	test("unseeded Muse Spark revisions inherit lineage capabilities and tier naming", async () => {
		// Meta ships revisions gateway-first; until the seed lists one it must
		// still resolve with the lineage's window, thinking ladder, and pricing
		// rather than the bare discovery defaults.
		const options = metaModelManagerOptions({
			apiKey: "meta-key",
			fetch: async () => modelListResponse(["muse-spark-1.4", "muse-spark-1.4-contributor", "muse-spark-2.0.1"]),
		});
		const models = await options.fetchDynamicModels?.();
		const byId = new Map((models ?? []).map(model => [model.id, model]));
		expect(byId.get("muse-spark-1.4")).toMatchObject({
			name: "Muse Spark 1.4",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 1_048_576,
			maxTokens: 131_072,
			cost: { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 },
			thinking: MUSE_SPARK_THINKING,
		});
		expect(byId.get("muse-spark-1.4-contributor")).toMatchObject({
			name: "Muse Spark 1.4 (C)",
			cost: { input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0 },
			thinking: MUSE_SPARK_THINKING,
		});
		expect(byId.get("muse-spark-2.0.1")).toMatchObject({ name: "Muse Spark 2.0.1", reasoning: true });
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

describe("Muse Code subscription provider", () => {
	test("exposes a distinct provider with subscription-scoped Muse models", async () => {
		const descriptor = CATALOG_PROVIDERS.find(provider => provider.id === "muse-code");
		expect(descriptor).toMatchObject({
			defaultModel: "muse-spark-1.3",
			dynamicModelsAuthoritative: true,
		});
		expect(descriptor).not.toHaveProperty("envVars");

		let requestHeaders = new Headers();
		const fetchModels: FetchImpl = async (_input, init) => {
			requestHeaders = new Headers(init?.headers);
			return modelListResponse(["muse-spark-1.3", "muse-image-1.0", "muse-voice-1.0"]);
		};
		const options = museCodeModelManagerOptions({
			apiKey: "LLM|subscription-key",
			fetch: fetchModels,
		});
		expect(options.providerId).toBe("muse-code");
		expect(options.dynamicModelsAuthoritative).toBe(true);
		expect(options.staticModels).toEqual(MUSE_CODE_STATIC_MODELS);
		expect(MUSE_CODE_STATIC_MODELS.every(model => model.provider === "muse-code")).toBe(true);
		const discovered = await options.fetchDynamicModels?.();
		expect(requestHeaders.get("Authorization")).toBe("Bearer LLM|subscription-key");
		expect(requestHeaders.get("x-api-version")).toBe("1.0.0");
		expect(discovered).toEqual([
			expect.objectContaining({
				id: "muse-spark-1.3",
				provider: "muse-code",
				reasoning: true,
				cost: { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 },
				maxTokens: 131_072,
			}),
		]);
	});

	test("leaves the existing Meta Model API descriptor API-key-only", () => {
		const descriptor = CATALOG_PROVIDERS.find(provider => provider.id === "meta");
		expect(descriptor).toMatchObject({
			defaultModel: "muse-spark-1.1",
			envVars: ["MODEL_API_KEY", "META_API_KEY"],
			catalogDiscovery: { label: "Meta Model API" },
		});
	});

	test("selects the compact edit prompt only for the subscription tier", () => {
		const subscriber = buildModel(MUSE_CODE_STATIC_MODELS.find(model => model.id === "muse-spark-1.3-contributor")!);
		expect(subscriber.editPromptVariant).toBe("compact");
		// Verified 2026-09-05: api.meta.ai/v1 400s `custom` tools
		// ("`custom` tools are not supported on this endpoint"), so the
		// subscription tier must keep apply-patch a function tool.
		expect(subscriber.applyPatchToolType).toBeUndefined();

		// Same model ids on the direct Meta API key path keep the stock
		// full-prompt JSON-function presentation.
		const apiKey = buildModel(META_MUSE_STATIC_MODELS.find(model => model.id === "muse-spark-1.3-contributor")!);
		expect(apiKey.editPromptVariant).toBeUndefined();
		expect(apiKey.applyPatchToolType).toBeUndefined();
	});

	test("bundled startup rows materialize the subscription policy without re-resolution", () => {
		// The registry serves committed rows verbatim on the cacheless,
		// pre-discovery path (model-registry #loadBuiltInModels), so the
		// policy must live in models.json itself — not only in live rules.
		const bundled = getBundledModel("muse-code", "muse-spark-1.3-contributor");
		expect(bundled?.editPromptVariant).toBe("compact");
		expect(bundled?.applyPatchToolType).toBeUndefined();
		for (const id of ["muse-spark-1.1", "muse-spark-1.2", "muse-spark-1.2-contributor", "muse-spark-1.3"]) {
			const row = getBundledModel("muse-code", id);
			expect(row?.editPromptVariant).toBe("compact");
			expect(row?.applyPatchToolType).toBeUndefined();
		}
		// Direct Meta API key rows carry neither field.
		expect(getBundledModel("meta", "muse-spark-1.3-contributor")?.editPromptVariant).toBeUndefined();
		expect(getBundledModel("meta", "muse-spark-1.3-contributor")?.applyPatchToolType).toBeUndefined();
	});

	test("exposes the max tier on bundled 1.3 standard rows only", () => {
		for (const provider of ["muse-code", "meta"] as const) {
			expect(getBundledModel(provider, "muse-spark-1.3")?.thinking?.efforts).toEqual([
				Effort.Minimal,
				Effort.Low,
				Effort.Medium,
				Effort.High,
				Effort.XHigh,
				Effort.Max,
			]);
			for (const id of [
				"muse-spark-1.1",
				"muse-spark-1.2",
				"muse-spark-1.2-contributor",
				"muse-spark-1.3-contributor",
			]) {
				expect(getBundledModel(provider, id)?.thinking?.efforts).toEqual([
					Effort.Minimal,
					Effort.Low,
					Effort.Medium,
					Effort.High,
					Effort.XHigh,
				]);
			}
		}
	});
});
