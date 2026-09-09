import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { readModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { basetenModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl, ModelSpec } from "@oh-my-pi/pi-catalog/types";

describe("Baseten provider discovery", () => {
	test("discovers Baseten models with custom metadata", async () => {
		const calls: Array<{ url: string; authorization: string | null }> = [];
		const fetchMock: FetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			calls.push({
				url: String(input),
				authorization: headers.get("authorization"),
			});
			return new Response(
				JSON.stringify({
					data: [
						{
							id: "moonshotai/Kimi-K2.7-Code",
							object: "model",
							name: "Kimi K2.7 Code",
							context_length: 262000,
							max_completion_tokens: 262000,
							supported_features: ["tools", "json_mode", "structured_outputs", "reasoning"],
							input_modalities: ["text", "image"],
							pricing: {
								prompt: "0.00000095",
								completion: "0.000004",
								input_cache_read: "0.00000016",
							},
						},
						{
							id: "moonshotai/Kimi-K3",
							object: "model",
							name: "Kimi K3",
							context_length: 1048576,
							max_completion_tokens: 262144,
							supported_features: ["tools", "json_mode", "structured_outputs", "reasoning_effort"],
							input_modalities: ["text", "image"],
							pricing: {
								prompt: "0.000003",
								completion: "0.000015",
								input_cache_read: "0.0000003",
							},
						},
						{
							id: "deepseek-ai/DeepSeek-V4-Pro",
							object: "model",
							name: "DeepSeek V4 Pro",
							context_length: 262144,
							max_completion_tokens: 262144,
							supported_features: ["tools", "json_mode", "structured_outputs", "reasoning"],
							input_modalities: ["text"],
							pricing: {
								prompt: "0.00000174",
								completion: "0.00000348",
								input_cache_read: "0.000000145",
							},
						},
						{
							id: "zai-org/GLM-4.7",
							object: "model",
							name: "GLM 4.7",
							supported_features: ["tools", "reasoning"],
							input_modalities: ["text"],
						},
						{
							id: "zai-org/GLM-5.2-Fast",
							object: "model",
							name: "GLM 5.2 Fast",
							context_length: 524288,
							max_completion_tokens: 262144,
							supported_features: ["tools", "json_mode", "structured_outputs", "reasoning"],
							input_modalities: ["text"],
							pricing: {
								prompt: "0.0000021",
								completion: "0.0000066",
								input_cache_read: "0.00000021",
							},
						},
						{
							id: "zai-org/GLM-5.3",
							object: "model",
							name: "GLM 5.3",
							supported_features: ["tools", "reasoning"],
							input_modalities: ["text"],
						},
						{
							id: "zai-org/GLM-5.3-Flash",
							object: "model",
							name: "GLM 5.3 Flash",
							context_length: 1048576,
							max_completion_tokens: 131072,
							supported_features: ["tools", "json_mode", "structured_outputs", "reasoning"],
							input_modalities: ["text", "image"],
							pricing: {
								prompt: "0.00000015",
								completion: "0.0000005",
								input_cache_read: "0.00000003",
							},
						},
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		};

		const options = basetenModelManagerOptions({ apiKey: "baseten-test-key", fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();

		expect(calls).toEqual([
			{
				url: "https://inference.baseten.co/v1/models",
				authorization: "Bearer baseten-test-key",
			},
		]);

		const kimi = models?.find(model => model.id === "moonshotai/Kimi-K2.7-Code");
		expect(kimi).toBeDefined();
		expect(kimi).toMatchObject({
			provider: "baseten",
			api: "openai-completions",
			name: "Kimi K2.7 Code",
			reasoning: false,
			input: ["text", "image"],
			contextWindow: 262000,
			maxTokens: 262000,
			cost: {
				input: 0.95,
				output: 4,
				cacheRead: 0.16,
				cacheWrite: 0,
			},
		});

		const kimiK3 = models?.find(model => model.id === "moonshotai/Kimi-K3");
		if (!kimiK3) throw new Error("Baseten Kimi K3 was not discovered");
		expect(kimiK3.reasoning).toBe(true);
		expect(buildModel(kimiK3).thinking).toMatchObject({
			mode: "effort",
			efforts: ["low", "high", "max"],
			defaultLevel: "max",
		});

		const deepseek = models?.find(model => model.id === "deepseek-ai/DeepSeek-V4-Pro");
		expect(deepseek).toBeDefined();
		expect(deepseek).toMatchObject({
			provider: "baseten",
			api: "openai-completions",
			name: "DeepSeek V4 Pro",
			reasoning: true,
			input: ["text"],
			contextWindow: 262144,
			maxTokens: 262144,
			cost: {
				input: 1.74,
				output: 3.48,
				cacheRead: 0.145,
				cacheWrite: 0,
			},
		});

		const glmFast = models?.find(model => model.id === "zai-org/GLM-5.2-Fast");
		const glm47 = models?.find(model => model.id === "zai-org/GLM-4.7");
		expect(glm47?.reasoning).toBe(false);

		const glm53 = models?.find(model => model.id === "zai-org/GLM-5.3");
		if (!glm53) throw new Error("Baseten GLM-5.3 was not discovered");
		expect(glm53.reasoning).toBe(true);
		expect(buildModel(glm53).thinking).toMatchObject({
			mode: "effort",
			efforts: ["low", "high", "max"],
			defaultLevel: "max",
		});

		expect(glmFast).toBeDefined();
		if (!glmFast) throw new Error("Baseten GLM-5.2 Fast was not discovered");
		expect(buildModel(glmFast).thinking).toMatchObject({
			mode: "effort",
			efforts: ["high", "max"],
		});

		const glmFlash = models?.find(model => model.id === "zai-org/GLM-5.3-Flash");
		if (!glmFlash) throw new Error("Baseten GLM-5.3-Flash was not discovered");
		expect(glmFlash).toMatchObject({
			provider: "baseten",
			api: "openai-completions",
			name: "GLM 5.3 Flash",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 1048576,
			maxTokens: 131072,
			cost: {
				input: 0.15,
				output: 0.5,
				cacheRead: 0.03,
				cacheWrite: 0,
			},
		});
		expect(buildModel(glmFlash).thinking).toMatchObject({
			mode: "effort",
			efforts: ["low", "high", "max"],
			defaultLevel: "max",
		});
	});

	test("invalidates cached GLM-5.3 reasoning metadata on upgrade", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-baseten-glm53-cache-"));
		const cacheDbPath = path.join(tempDir, "models.db");
		const discoveredModels: ModelSpec<"openai-completions">[] = [
			{
				id: "zai-org/GLM-5.3",
				name: "GLM 5.3",
				api: "openai-completions",
				provider: "baseten",
				baseUrl: "https://inference.baseten.co/v1",
				reasoning: true,
				input: ["text"],
				cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
				contextWindow: 1_048_576,
				maxTokens: 131_072,
			},
			{
				id: "zai-org/GLM-5.3-Flash",
				name: "GLM 5.3 Flash",
				api: "openai-completions",
				provider: "baseten",
				baseUrl: "https://inference.baseten.co/v1",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 },
				contextWindow: 1_048_576,
				maxTokens: 131_072,
			},
		];

		try {
			// Pass 1: write a fresh authoritative cache under the pre-fix identity
			// whose GLM-5.3 rows carry the stale computed value.
			await resolveProviderModels(
				{
					...basetenModelManagerOptions({ apiKey: "k" }),
					cacheDbPath,
					dropCachedModelIdsOnStaticMismatch: undefined,
					fetchDynamicModels: async () => discoveredModels.map(model => ({ ...model, reasoning: false })),
				},
				"online",
			);
			const priorCache = readModelCache("baseten", Number.POSITIVE_INFINITY, Date.now, cacheDbPath);
			if (!priorCache) throw new Error("Baseten cache was not written");

			// Pass 2: the migration policy must force discovery and replace both
			// corrected rows rather than serving either stale cache entry.
			let fetches = 0;
			const upgraded = await resolveProviderModels(
				{
					...basetenModelManagerOptions({ apiKey: "k" }),
					cacheDbPath,
					fetchDynamicModels: async () => {
						fetches++;
						return discoveredModels;
					},
				},
				"online-if-uncached",
			);
			expect(fetches).toBe(1);
			for (const id of ["zai-org/GLM-5.3", "zai-org/GLM-5.3-Flash"]) {
				const model = upgraded.models.find(candidate => candidate.id === id);
				expect(model?.reasoning).toBe(true);
				expect(model?.thinking).toEqual({
					mode: "effort",
					efforts: [Effort.Low, Effort.High, Effort.Max],
					defaultLevel: Effort.Max,
					requiresEffort: true,
				});
			}
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
