import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { getModelPricingStatus } from "@oh-my-pi/pi-catalog/models";
import {
	type DiscoveryProviderConfig,
	discoverOpenAIModelsList,
} from "@oh-my-pi/pi-coding-agent/config/model-discovery";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

describe("openai-models-list pricing and gateway metadata discovery (#15655)", () => {
	const providerConfig: DiscoveryProviderConfig = {
		provider: "custom-gateway",
		api: "openai-completions",
		baseUrl: "https://gateway.example.test/v1",
		discovery: { type: "openai-models-list" },
	};

	function mockFetch(rows: Record<string, unknown>[]): FetchImpl {
		return async () =>
			new Response(JSON.stringify({ object: "list", data: rows }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
	}

	test("extracts OpenRouter-style per-token pricing, display_name, context_window, modalities, and reasoning_levels", async () => {
		const models = await discoverOpenAIModelsList(providerConfig, {
			fetch: mockFetch([
				{
					id: "vendor/custom-reasoner",
					display_name: "Custom Reasoner Pro",
					context_window: 500_000,
					max_output_tokens: 65_536,
					modalities: { input: ["text", "image"], output: ["text"] },
					reasoning: true,
					reasoning_levels: ["low", "high", "max"],
					pricing: {
						prompt: "0.00000015",
						completion: "0.0000006",
						input_cache_read: "0.000000003",
						input_cache_write: "0.0000001875",
					},
				},
			]),
			getBearerApiKeyResolver: async () => undefined,
		});

		expect(models).toHaveLength(1);
		const model = models[0]!;
		expect(model.name).toBe("Custom Reasoner Pro");
		expect(model.contextWindow).toBe(500_000);
		expect(model.maxTokens).toBe(65_536);
		expect(model.input).toEqual(["text", "image"]);
		expect(model.reasoning).toBe(true);
		expect(model.thinking?.efforts).toEqual([Effort.Low, Effort.High, Effort.Max]);
		expect(model.cost).toEqual({
			input: 0.15,
			output: 0.6,
			cacheRead: 0.003,
			cacheWrite: 0.1875,
		});
		expect(getModelPricingStatus(model)).toBe("fixed");
	});

	test("honors pricing unit, plural cache-write key, and tiny positive rates without rounding to zero", async () => {
		const models = await discoverOpenAIModelsList(providerConfig, {
			fetch: mockFetch([
				{
					id: "vendor/nanogpt-per-million",
					pricing: {
						prompt: 2,
						completion: 10,
						cacheReadInputPer1kTokens: 0.0001,
						cacheWriteInputPer1kTokens: 0.0001875,
						currency: "USD",
						unit: "per_million_tokens",
					},
				},
				{
					id: "vendor/unsupported-unit",
					pricing: {
						prompt: 2,
						completion: 10,
						unit: "per_1k_tokens",
					},
				},
				{
					id: "vendor/plural-cache-keys",
					pricing: {
						prompt: "0",
						completion: "0",
						input_cache_reads: "0.0000001",
						input_cache_writes: "0.00000025",
					},
				},
				{
					id: "vendor/tiny-positive-rate",
					pricing: {
						prompt: "1e-13",
						completion: "0",
					},
				},
				{
					id: "vendor/explicit-per-token",
					pricing: {
						prompt: 0.000002,
						completion: 0.00001,
						unit: "per_token",
					},
				},
				{
					id: "vendor/chutes-unitless-numeric",
					pricing: {
						prompt: 0.44,
						completion: 1.32,
						input_cache_read: 0.044,
					},
				},
				{
					id: "vendor/unitless-numeric-free",
					pricing: {
						prompt: 0,
						completion: 0,
					},
				},
			]),
			getBearerApiKeyResolver: async () => undefined,
		});

		const byId = new Map(models.map(m => [m.id, m]));
		const perMillion = byId.get("vendor/nanogpt-per-million")!;
		expect(perMillion.cost.input).toBe(2);
		expect(perMillion.cost.output).toBe(10);
		expect(perMillion.cost.cacheRead).toBeCloseTo(0.1, 10);
		expect(perMillion.cost.cacheWrite).toBeCloseTo(0.1875, 10);
		expect(getModelPricingStatus(perMillion)).toBe("fixed");

		const unsupported = byId.get("vendor/unsupported-unit")!;
		expect(unsupported.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		expect(getModelPricingStatus(unsupported)).toBe("unknown");

		const plural = byId.get("vendor/plural-cache-keys")!;
		expect(plural.cost.cacheRead).toBeCloseTo(0.1, 10);
		expect(plural.cost.cacheWrite).toBeCloseTo(0.25, 10);
		expect(getModelPricingStatus(plural)).toBe("fixed");

		const tiny = byId.get("vendor/tiny-positive-rate")!;
		expect(tiny.cost.input).toBeCloseTo(1e-7, 15);
		expect(getModelPricingStatus(tiny)).toBe("fixed");

		const explicitPerToken = byId.get("vendor/explicit-per-token")!;
		expect(explicitPerToken.cost).toEqual({ input: 2, output: 10, cacheRead: 0, cacheWrite: 0 });
		expect(getModelPricingStatus(explicitPerToken)).toBe("fixed");

		const chutesAmbiguous = byId.get("vendor/chutes-unitless-numeric")!;
		expect(chutesAmbiguous.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		expect(getModelPricingStatus(chutesAmbiguous)).toBe("unknown");

		const numericFree = byId.get("vendor/unitless-numeric-free")!;
		expect(numericFree.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		expect(getModelPricingStatus(numericFree)).toBe("free");
	});

	test("marks explicit all-zero pricing as free and keeps non-token charges, malformed, or negative cards unknown", async () => {
		const models = await discoverOpenAIModelsList(providerConfig, {
			fetch: mockFetch([
				{
					id: "vendor/free-tier",
					pricing: { prompt: "0", completion: "0", request: "0", image: "0" },
				},
				{
					id: "vendor/request-priced",
					pricing: { prompt: "0", completion: "0", request: "0.01" },
				},
				{
					id: "vendor/image-priced",
					pricing: { prompt: "0", completion: "0", image: "0.04" },
				},
				{
					id: "vendor/dynamic-sentinel",
					pricing: { prompt: "-1", completion: "-1" },
				},
				{
					id: "vendor/missing-completion",
					pricing: { prompt: "0.000002" },
				},
				{
					id: "vendor/bad-cache-rate",
					pricing: { prompt: "0.000002", completion: "0.00001", input_cache_read: "invalid" },
				},
				{
					id: "vendor/unpriced",
				},
			]),
			getBearerApiKeyResolver: async () => undefined,
		});

		const byId = new Map(models.map(m => [m.id, m]));
		expect(byId.get("vendor/free-tier")?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		expect(getModelPricingStatus(byId.get("vendor/free-tier")!)).toBe("free");

		for (const id of [
			"vendor/request-priced",
			"vendor/image-priced",
			"vendor/dynamic-sentinel",
			"vendor/missing-completion",
			"vendor/bad-cache-rate",
			"vendor/unpriced",
		]) {
			const m = byId.get(id)!;
			expect(m.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
			expect(getModelPricingStatus(m)).toBe("unknown");
		}
	});

	test("canonicalizes embedding output aliases and does not let an echoed display_name mask a bundled reference", async () => {
		const models = await discoverOpenAIModelsList(providerConfig, {
			fetch: mockFetch([
				{
					id: "vendor/text-embed",
					display_name: "Vendor Embed",
					context_window: 8192,
					output_modalities: ["embedding"],
					modalities: { input: ["text"], output: ["embeddings"] },
					pricing: { prompt: "0.00000002" },
				},
				{
					id: "gpt-5",
					display_name: "gpt-5",
					pricing: { prompt: "0.00000125", completion: "0.00001" },
				},
			]),
			getBearerApiKeyResolver: async () => undefined,
		});

		const byId = new Map(models.map(m => [m.id, m]));
		const embed = byId.get("vendor/text-embed")!;
		expect(embed.kind).toBe("embedding");
		expect(embed.api).toBe("openai-embeddings");
		expect(embed.cost).toEqual({ input: 0.02, output: 0, cacheRead: 0, cacheWrite: 0 });
		expect(getModelPricingStatus(embed)).toBe("fixed");

		const gpt5 = byId.get("gpt-5")!;
		expect(gpt5.name).toBe("GPT-5");
		expect(gpt5.cost).toEqual({ input: 1.25, output: 10, cacheRead: 0, cacheWrite: 0 });
	});

	describe("ModelRegistry precedence", () => {
		let tempDir: string;
		let modelsJsonPath: string;
		let authStorage: AuthStorage;

		beforeEach(async () => {
			resetSettingsForTest();
			tempDir = path.join(os.tmpdir(), `pi-test-issue-15655-${Snowflake.next()}`);
			fs.mkdirSync(tempDir, { recursive: true });
			modelsJsonPath = path.join(tempDir, "models.json");
			authStorage = await AuthStorage.create(":memory:");
		});

		afterEach(() => {
			resetSettingsForTest();
			authStorage.close();
			if (tempDir && fs.existsSync(tempDir)) {
				removeSyncWithRetries(tempDir);
			}
		});

		test("modelOverrides.cost still takes priority over discovered pricing", async () => {
			fs.writeFileSync(
				modelsJsonPath,
				JSON.stringify({
					providers: {
						"custom-gateway": {
							baseUrl: "https://gateway.example.test/v1",
							apiKey: "test-key",
							api: "openai-completions",
							authHeader: true,
							discovery: { type: "openai-models-list" },
							modelOverrides: {
								"vendor/model-a": {
									cost: { input: 9.5, output: 19.5, cacheRead: 1, cacheWrite: 2 },
								},
							},
						},
					},
				}),
			);

			const registry = new ModelRegistry(authStorage, modelsJsonPath, {
				fetch: mockFetch([
					{
						id: "vendor/model-a",
						pricing: { prompt: "0.000002", completion: "0.00001", input_cache_read: "0.0000001" },
					},
					{
						id: "vendor/model-b",
						pricing: { prompt: "0.000002", completion: "0.00001", input_cache_read: "0.0000001" },
					},
				]),
			});
			await registry.refresh("online");

			const modelA = registry.find("custom-gateway", "vendor/model-a");
			const modelB = registry.find("custom-gateway", "vendor/model-b");
			expect(modelA?.cost).toEqual({ input: 9.5, output: 19.5, cacheRead: 1, cacheWrite: 2 });
			expect(modelB?.cost.input).toBe(2);
			expect(modelB?.cost.output).toBe(10);
			expect(modelB?.cost.cacheRead).toBeCloseTo(0.1, 10);
			expect(modelB?.cost.cacheWrite).toBe(0);
			expect(getModelPricingStatus(modelB!)).toBe("fixed");
		});

		test("keeps nested modalities.output image models on the configured Responses transport", async () => {
			const models = await discoverOpenAIModelsList(
				{
					...providerConfig,
					api: "openai-responses",
				},
				{
					fetch: mockFetch([
						{
							id: "gpt-image-1.5",
							modalities: { input: ["text", "image"], output: ["image"] },
							pricing: { prompt: "0.000005", completion: "0.00001" },
						},
					]),
					getBearerApiKeyResolver: async () => undefined,
				},
			);
			expect(models).toHaveLength(1);
			expect(models[0]?.api).toBe("openai-responses");
			expect(models[0]?.kind).toBe("image");
			expect(models[0]?.cost).toEqual({ input: 5, output: 10, cacheRead: 0, cacheWrite: 0 });
		});

		test("falls through to top-level display_name when nested metadata.display_name merely echoes id", async () => {
			const models = await discoverOpenAIModelsList(providerConfig, {
				fetch: mockFetch([
					{
						id: "vendor/model-echo",
						display_name: "Vendor Model Echo Pro",
						metadata: { display_name: "vendor/model-echo" },
						pricing: { prompt: "0.000001", completion: "0.000002" },
					},
				]),
				getBearerApiKeyResolver: async () => undefined,
			});
			expect(models).toHaveLength(1);
			expect(models[0].name).toBe("Vendor Model Echo Pro");
		});

		test.each([
			{
				label: "default (injectV1=true, advertisedReasoning=true)",
				discovery: { type: "openai-models-list" as const },
				retiredCacheProviderId: "custom-gateway:openai-models-list-context-v6",
			},
			{
				label: "advertisedReasoning=false",
				discovery: { type: "openai-models-list" as const, advertisedReasoning: false },
				retiredCacheProviderId: "custom-gateway:openai-models-list-advertised-off-context-v6",
			},
			{
				label: "injectV1=false",
				discovery: { type: "openai-models-list" as const, injectV1: false },
				retiredCacheProviderId: "custom-gateway:openai-models-list-bare-context-v6",
			},
			{
				label: "injectV1=false, advertisedReasoning=false",
				discovery: { type: "openai-models-list" as const, injectV1: false, advertisedReasoning: false },
				retiredCacheProviderId: "custom-gateway:openai-models-list-bare-advertised-off-context-v6",
			},
			{
				label: "lm-studio (bare pre-versioned cache)",
				discovery: { type: "lm-studio" as const },
				retiredCacheProviderId: "custom-gateway",
			},
			{
				label: "litellm (/v1/models fallback, litellm-rich-v7 cache)",
				discovery: { type: "litellm" as const },
				retiredCacheProviderId: "custom-gateway:litellm-rich-v7",
			},
		])(
			"invalidates retired cache namespace for $label under online-if-uncached",
			async ({ discovery, retiredCacheProviderId }) => {
				const variantDir = fs.mkdtempSync(path.join(tempDir, "cache-variant-"));
				const variantModelsJson = path.join(variantDir, "models.json");
				const cacheDbPath = path.join(variantDir, "model-cache.db");
				const staleRow = buildModel({
					id: "vendor/model-b",
					name: "vendor/model-b",
					api: "openai-completions",
					provider: "custom-gateway",
					baseUrl: "https://gateway.example.test/v1",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128_000,
					maxTokens: 16_384,
				});
				fs.writeFileSync(
					variantModelsJson,
					JSON.stringify({
						providers: {
							"custom-gateway": {
								baseUrl: "https://gateway.example.test/v1",
								apiKey: "test-key",
								api: "openai-completions",
								authHeader: true,
								discovery,
							},
						},
					}),
				);
				// Backdate models.json mtime by 2s and seed the retired cache at `now`
				// so `updatedAt` is strictly newer than models.json mtime while staying
				// <= Date.now() (required by `readModelCache`'s freshness check).
				const now = Date.now();
				const past = new Date(now - 2_000);
				fs.utimesSync(variantModelsJson, past, past);
				writeModelCache(retiredCacheProviderId, now, [staleRow], true, "", cacheDbPath);

				const fetchFn = (async (input: string | URL | Request) => {
					const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
					if (!url.endsWith("/models") || url.includes("/api/v0/models")) {
						return new Response("not found", { status: 404 });
					}
					return new Response(
						JSON.stringify({
							object: "list",
							data: [
								{
									id: "vendor/model-b",
									display_name: "Model B Pro",
									pricing: { prompt: "0.000002", completion: "0.00001" },
								},
							],
						}),
						{ status: 200, headers: { "content-type": "application/json" } },
					);
				}) as typeof fetch;

				const registry = new ModelRegistry(authStorage, variantModelsJson, {
					cacheDbPath,
					fetch: fetchFn,
				});
				await registry.refresh("online-if-uncached");

				const refreshed = registry.find("custom-gateway", "vendor/model-b");
				expect(refreshed?.name).toBe("Model B Pro");
				expect(refreshed?.cost).toEqual({ input: 2, output: 10, cacheRead: 0, cacheWrite: 0 });
				expect(getModelPricingStatus(refreshed!)).toBe("fixed");
			},
		);
	});
});
