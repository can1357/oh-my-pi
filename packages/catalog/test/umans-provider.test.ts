import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import {
	MODELS_DEV_PROVIDER_DESCRIPTORS,
	mapModelsDevToModels,
	umansModelManagerOptions,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl, ModelSpec } from "@oh-my-pi/pi-catalog/types";
import modelsJson from "../src/models.json";

const bundledModels = modelsJson;

describe("umans provider catalog", () => {
	it("discovers Anthropic-route models from the public models info endpoint", async () => {
		const requestedUrls: string[] = [];
		const fetchImpl: FetchImpl = async input => {
			requestedUrls.push(String(input));
			return new Response(
				JSON.stringify({
					"umans-coder": {
						display_name: "Umans Coder",
						capabilities: {
							context_window: 262_144,
							max_completion_tokens: 262_144,
							recommended_max_tokens: 32_768,
							supports_vision: true,
							supports_tools: true,
							reasoning: { supported: true, can_disable: true, default_level: "medium" },
						},
					},
					"umans-kimi-k2.7": {
						display_name: "Umans Kimi K2.7 Code",
						capabilities: {
							context_window: 262_144,
							max_completion_tokens: 262_144,
							recommended_max_tokens: 32_768,
							supports_vision: true,
							supports_tools: true,
							reasoning: { supported: true, can_disable: false, default_level: "medium" },
						},
					},
					"umans-glm-5.2": {
						display_name: "Umans GLM 5.2",
						capabilities: {
							context_window: 405_504,
							max_completion_tokens: 131_072,
							recommended_max_tokens: 131_071,
							supports_vision: "via-handoff",
							supports_tools: true,
							reasoning: {
								supported: true,
								can_disable: true,
								levels: ["none", "high", "max"],
								default_level: "high",
							},
						},
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		const options = umansModelManagerOptions({ fetch: fetchImpl });
		const fetchDynamicModels = options.fetchDynamicModels;
		if (!fetchDynamicModels) throw new Error("Umans dynamic discovery is not configured");

		const models = await fetchDynamicModels();

		expect(requestedUrls).toEqual(["https://api.code.umans.ai/v1/models/info"]);
		expect(models).not.toBeNull();
		const model = models?.find(item => item.id === "umans-coder");
		expect(model).toMatchObject({
			id: "umans-coder",
			name: "Umans Coder",
			api: "anthropic-messages",
			provider: "umans",
			baseUrl: "https://api.code.umans.ai",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0 },
			contextWindow: 262_144,
			maxTokens: 32_768,
			thinking: { defaultLevel: "medium" },
			compat: { escapeBuiltinToolNames: true },
		});
		const mandatoryReasoningModel = models?.find(item => item.id === "umans-kimi-k2.7");
		expect(mandatoryReasoningModel).toMatchObject({
			id: "umans-kimi-k2.7",
			reasoning: true,
			maxTokens: 32_768,
			thinking: { defaultLevel: "medium", requiresEffort: true },
			compat: { escapeBuiltinToolNames: true },
		});
		const glm52 = models?.find(item => item.id === "umans-glm-5.2");
		expect(glm52).toMatchObject({
			id: "umans-glm-5.2",
			reasoning: true,
			thinking: {
				mode: "anthropic-budget-effort",
				defaultLevel: "high",
				efforts: ["high", "max"],
			},
		});
		if (!glm52) throw new Error("Umans GLM 5.2 was not discovered");
		expect(glm52.thinking?.effortMap).toBeUndefined();
		expect(glm52.thinking?.defaultLevel).toBe(Effort.High);
	});

	it("surfaces Umans discovery fetch failures", async () => {
		const fetchDynamicModels = umansModelManagerOptions({
			fetch: async () => {
				throw new Error("boom");
			},
		}).fetchDynamicModels;
		if (!fetchDynamicModels) throw new Error("Umans dynamic discovery is not configured");

		await expect(fetchDynamicModels()).rejects.toThrow("Failed to fetch Umans models info");
	});

	it('maps supports_vision sentinel values like "via-handoff" to text-only input', async () => {
		const fetchImpl: FetchImpl = async () =>
			new Response(
				JSON.stringify({
					"umans-glm-5.2": {
						display_name: "Umans GLM 5.2",
						capabilities: {
							context_window: 405_504,
							max_completion_tokens: 131_071,
							recommended_max_tokens: 131_071,
							supports_vision: "via-handoff",
							supports_tools: true,
							reasoning: { supported: true, can_disable: true, default_level: "medium" },
						},
					},
					"umans-coder": {
						display_name: "Umans Coder",
						capabilities: {
							context_window: 262_144,
							max_completion_tokens: 262_144,
							recommended_max_tokens: 32_768,
							supports_vision: true,
							supports_tools: true,
							reasoning: { supported: true, can_disable: true, default_level: "medium" },
						},
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);

		const fetchDynamicModels = umansModelManagerOptions({ fetch: fetchImpl }).fetchDynamicModels;
		if (!fetchDynamicModels) throw new Error("Umans dynamic discovery is not configured");

		const models = await fetchDynamicModels();
		const glm = models?.find(item => item.id === "umans-glm-5.2");
		const coder = models?.find(item => item.id === "umans-coder");

		expect(glm?.input).toEqual(["text"]);
		expect(coder?.input).toEqual(["text", "image"]);
	});

	it("bundles Umans GLM via-handoff models as text-only", () => {
		const model = bundledModels.umans?.["umans-glm-5.2"];
		expect(model, "umans-glm-5.2 should be bundled").toBeDefined();
		expect(model.input, "umans-glm-5.2 input should be text-only").toEqual(["text"]);
	});

	it("drops stale cached GLM rows that predate the via-handoff static correction", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-umans-stale-cache-"));
		const dbPath = path.join(tempDir, "models.db");
		const staleGlm: ModelSpec<"anthropic-messages"> = {
			id: "umans-glm-5.2",
			name: "Umans GLM 5.2",
			api: "anthropic-messages",
			provider: "umans",
			baseUrl: "https://api.code.umans.ai",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 405_504,
			maxTokens: 131_071,
		};
		const correctedGlm: ModelSpec<"anthropic-messages"> = { ...staleGlm, input: ["text"] };

		try {
			await resolveProviderModels(
				{
					...umansModelManagerOptions({
						fetch: async () =>
							new Response(
								JSON.stringify({
									"umans-glm-5.2": {
										display_name: "Umans GLM 5.2",
										capabilities: {
											context_window: 405_504,
											recommended_max_tokens: 131_071,
											supports_vision: true,
											supports_tools: true,
											reasoning: { supported: true },
										},
									},
								}),
								{ status: 200, headers: { "Content-Type": "application/json" } },
							),
					}),
					staticModels: [staleGlm],
					cacheDbPath: dbPath,
				},
				"online",
			);

			const offline = await resolveProviderModels(
				{
					...umansModelManagerOptions({ fetch: async () => new Response(null, { status: 503 }) }),
					staticModels: [correctedGlm],
					cacheDbPath: dbPath,
				},
				"offline",
			);

			const model = offline.models.find(item => item.id === "umans-glm-5.2");
			expect(model?.input).toEqual(["text"]);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("maps the stencil.so Umans PAYG pricing to the Anthropic endpoint", () => {
		const models = mapModelsDevToModels(
			{
				"umans-ai": {
					models: {
						"umans-coder": {
							name: "Umans Coder",
							tool_call: true,
							reasoning: true,
							modalities: { input: ["text", "image"] },
							limit: { context: 262_144, output: 262_144 },
							cost: { input: 0.95, output: 4, cache_read: 0.19 },
						},
					},
				},
				"umans-ai-coding-plan": {
					models: {
						"umans-coder": {
							name: "Umans Coder",
							tool_call: true,
							reasoning: true,
							modalities: { input: ["text", "image"] },
							limit: { context: 262_144, output: 262_144 },
							cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
						},
					},
				},
			},
			MODELS_DEV_PROVIDER_DESCRIPTORS,
		).filter(model => model.provider === "umans");

		expect(models).toHaveLength(1);
		expect(models[0]).toMatchObject({
			id: "umans-coder",
			api: "anthropic-messages",
			provider: "umans",
			baseUrl: "https://api.code.umans.ai",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0 },
			contextWindow: 262_144,
			maxTokens: 262_144,
		});
	});

	it("bundles the default Umans coding model", () => {
		const model = bundledModels.umans?.["umans-coder"];

		expect(model).toBeDefined();
		expect(model).toMatchObject({
			api: "anthropic-messages",
			provider: "umans",
			baseUrl: "https://api.code.umans.ai",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 262_144,
			maxTokens: 32_768,
			compat: { escapeBuiltinToolNames: true },
		});
	});

	it("bundles published Umans PAYG pricing", () => {
		const models = bundledModels.umans;

		expect(models?.["umans-coder"].cost).toEqual({ input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0 });
		expect(models?.["umans-kimi-k2.7"].cost).toEqual({
			input: 0.95,
			output: 4,
			cacheRead: 0.19,
			cacheWrite: 0,
		});
		expect(models?.["umans-glm-5.2"].cost).toEqual({ input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 });
		expect(models?.["umans-flash"].cost).toEqual({ input: 0.15, output: 1, cacheRead: 0.05, cacheWrite: 0 });
		expect(models?.["umans-qwen3.6-35b-a3b"].cost).toEqual({
			input: 0.15,
			output: 1,
			cacheRead: 0.05,
			cacheWrite: 0,
		});
	});

	it("bundles Umans mandatory reasoning metadata", () => {
		const model = bundledModels.umans?.["umans-kimi-k2.7"];

		expect(model).toBeDefined();
		expect(model.maxTokens).toBe(32_768);
		expect(model.compat?.escapeBuiltinToolNames).toBe(true);
		expect(model.thinking).toMatchObject({
			requiresEffort: true,
		});
	});

	it("bundles Umans GLM 5.2 with the wire-exact high/max ladder", () => {
		const model = bundledModels.umans?.["umans-glm-5.2"];

		expect(model).toBeDefined();
		expect(model.thinking).toMatchObject({
			mode: "anthropic-budget-effort",
			efforts: ["high", "max"],
		});
		expect("effortMap" in model.thinking).toBe(false);
	});
});
