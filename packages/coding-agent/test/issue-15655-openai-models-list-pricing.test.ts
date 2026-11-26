import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
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

	test("marks explicit all-zero pricing as free and keeps absent, malformed, or negative cards unknown", async () => {
		const models = await discoverOpenAIModelsList(providerConfig, {
			fetch: mockFetch([
				{
					id: "vendor/free-tier",
					pricing: { prompt: "0", completion: "0" },
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

	test("handles nested modalities.output task rows with prompt-only pricing", async () => {
		const models = await discoverOpenAIModelsList(providerConfig, {
			fetch: mockFetch([
				{
					id: "vendor/text-embed",
					display_name: "Vendor Embed",
					context_window: 8192,
					modalities: { input: ["text"], output: ["embeddings"] },
					pricing: { prompt: "0.00000002" },
				},
			]),
			getBearerApiKeyResolver: async () => undefined,
		});

		expect(models).toHaveLength(1);
		const model = models[0]!;
		expect(model.kind).toBe("embedding");
		expect(model.api).toBe("openai-embeddings");
		expect(model.cost).toEqual({ input: 0.02, output: 0, cacheRead: 0, cacheWrite: 0 });
		expect(getModelPricingStatus(model)).toBe("fixed");
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
			expect(modelB?.cost).toEqual({ input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 });
			expect(getModelPricingStatus(modelB!)).toBe("fixed");
		});
	});
});
