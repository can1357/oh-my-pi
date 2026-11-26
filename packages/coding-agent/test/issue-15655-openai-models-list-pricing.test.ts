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

		test("invalidates warm context-v6 cache rows under online-if-uncached", async () => {
			const cacheDbPath = path.join(tempDir, "model-cache.db");
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
			// Seed all pre-change context-v6 namespaces (standard, bare, advertised-off)
			// with fresh timestamps to confirm none satisfies context-v7 reads.
			for (const suffix of [
				"openai-models-list-context-v6",
				"openai-models-list-advertised-off-context-v6",
				"openai-models-list-bare-context-v6",
				"openai-models-list-bare-advertised-off-context-v6",
			]) {
				writeModelCache(`custom-gateway:${suffix}`, Date.now(), [staleRow], true, "", cacheDbPath);
			}
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
						},
					},
				}),
			);

			const registry = new ModelRegistry(authStorage, modelsJsonPath, {
				cacheDbPath,
				fetch: mockFetch([
					{
						id: "vendor/model-b",
						display_name: "Model B Pro",
						pricing: { prompt: "0.000002", completion: "0.00001" },
					},
				]),
			});
			await registry.refresh("online-if-uncached");

			const refreshed = registry.find("custom-gateway", "vendor/model-b");
			expect(refreshed?.name).toBe("Model B Pro");
			expect(refreshed?.cost).toEqual({ input: 2, output: 10, cacheRead: 0, cacheWrite: 0 });
			expect(getModelPricingStatus(refreshed!)).toBe("fixed");
		});
	});
});
