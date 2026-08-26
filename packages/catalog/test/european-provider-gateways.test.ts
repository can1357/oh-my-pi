import { afterEach, describe, expect, test, vi } from "bun:test";
import { getEnvApiKey } from "@oh-my-pi/pi-ai/stream";
import { createModelManager } from "@oh-my-pi/pi-catalog/model-manager";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import {
	akiIoModelManagerOptions,
	cortecsModelManagerOptions,
	EUROPEAN_GATEWAY_STATIC_MODELS,
	eurouterModelManagerOptions,
	getEuropeanGatewayStaticFallbackModels,
	meliousModelManagerOptions,
	nebiusModelManagerOptions,
	opperModelManagerOptions,
	ovhcloudModelManagerOptions,
	scalewayModelManagerOptions,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";
import nebiusModelsInfoFixture from "./fixtures/nebius-models-info-2026-08-13.json";

const providerCases = [
	{
		id: "aki-io",
		defaultModel: "kimi-k2.7-code-1100b",
		envVar: "AKI_API_KEY",
		baseUrl: "https://aki.io/openai/v1",
		modelsPath: "/models",
		manager: akiIoModelManagerOptions,
	},
	{
		id: "melious",
		defaultModel: "gpt-oss-120b",
		envVar: "MELIOUS_API_KEY",
		baseUrl: "https://api.melious.ai/v1",
		modelsPath: "/models",
		manager: meliousModelManagerOptions,
	},
	{
		id: "nebius",
		defaultModel: "Qwen/Qwen3-235B-A22B-Instruct-2507",
		envVar: "NEBIUS_API_KEY",
		baseUrl: "https://api.tokenfactory.nebius.com/v1",
		modelsPath: "/models?verbose=true",
		manager: nebiusModelManagerOptions,
	},
	{
		id: "cortecs",
		defaultModel: "gpt-oss-120b",
		envVar: "CORTECS_API_KEY",
		baseUrl: "https://api.cortecs.ai/v1",
		modelsPath: "/models",
		allowUnauthenticated: true,
		manager: cortecsModelManagerOptions,
	},
	{
		id: "eurouter",
		defaultModel: "mistral-large-3",
		envVar: "EUROUTER_API_KEY",
		baseUrl: "https://api.eurouter.ai/api/v1",
		modelsPath: "/models",
		allowUnauthenticated: true,
		manager: eurouterModelManagerOptions,
	},
	{
		id: "ovhcloud",
		defaultModel: "gpt-oss-120b",
		envVar: "OVH_AI_ENDPOINTS_ACCESS_TOKEN",
		baseUrl: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1",
		modelsPath: "/models",
		allowUnauthenticated: true,
		manager: ovhcloudModelManagerOptions,
	},
	{
		id: "opper",
		defaultModel: "mistral/devstral-2512",
		envVar: "OPPER_API_KEY",
		baseUrl: "https://api.opper.ai/v3/compat",
		modelsPath: "/models",
		manager: opperModelManagerOptions,
	},
	{
		id: "scaleway",
		defaultModel: "glm-5.2",
		envVar: "SCW_SECRET_KEY",
		baseUrl: "https://api.scaleway.ai/v1",
		modelsPath: "/models",
		manager: scalewayModelManagerOptions,
	},
] as const;

const originalEnv = new Map<string, string | undefined>(
	providerCases.map(provider => [provider.envVar, Bun.env[provider.envVar]]),
);

afterEach(() => {
	for (const [key, value] of originalEnv) {
		if (value === undefined) {
			delete Bun.env[key];
		} else {
			Bun.env[key] = value;
		}
	}
	vi.restoreAllMocks();
});

describe("European gateway provider catalog support", () => {
	for (const provider of providerCases) {
		test(`registers ${provider.id} descriptor, default model, and env var`, () => {
			Bun.env[provider.envVar] = `${provider.id}-test-key`;

			const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === provider.id);
			expect(descriptor).toBeDefined();
			expect(descriptor?.defaultModel).toBe(provider.defaultModel);
			expect(descriptor?.dynamicModelsAuthoritative).toBe(true);
			if ("allowUnauthenticated" in provider) {
				expect(descriptor?.allowUnauthenticated).toBe(true);
			}
			expect(descriptor?.catalogDiscovery?.envVars).toContain(provider.envVar);
			expect((DEFAULT_MODEL_PER_PROVIDER as Record<string, string>)[provider.id]).toBe(provider.defaultModel);
			expect(getEnvApiKey(provider.id)).toBe(`${provider.id}-test-key`);
		});

		test(`${provider.id} discovers models from its documented OpenAI-compatible endpoint`, async () => {
			const fetchMock: FetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
				expect(url).toBe(`${provider.baseUrl}${provider.modelsPath}`);
				expect(init?.method).toBe("GET");
				expect(init?.headers).toEqual({
					Accept: "application/json",
					Authorization: `Bearer ${provider.id}-test-key`,
				});
				return new Response(
					JSON.stringify({
						data: [
							{
								id: provider.defaultModel,
								name: provider.defaultModel,
								context_length: 131000,
								max_completion_tokens: 8192,
								supported_parameters: ["tools"],
							},
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			});

			const options = provider.manager({ apiKey: `${provider.id}-test-key`, fetch: fetchMock });
			expect(options.providerId).toBe(provider.id);
			expect(options.fetchDynamicModels).toBeDefined();

			const models = await options.fetchDynamicModels?.();
			expect(models?.[0]).toMatchObject({
				id: provider.defaultModel,
				api: "openai-completions",
				provider: provider.id,
				baseUrl: provider.baseUrl,
			});
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});
	}

	test("serves curated fallback models through offline model managers", async () => {
		for (const provider of providerCases) {
			const manager = createModelManager({
				...provider.manager(),
				cacheDbPath: ":memory:",
			});
			const result = await manager.refresh("offline");

			expect(result.models).toContainEqual(
				expect.objectContaining({
					id: provider.defaultModel,
					provider: provider.id,
					baseUrl: provider.baseUrl,
				}),
			);
		}
	});

	test("discovers the saved current Nebius catalog model through the model manager", async () => {
		const snapshotModel = nebiusModelsInfoFixture.models[0];
		const flavor = snapshotModel?.flavors[0];
		if (!snapshotModel || !flavor) throw new Error("Expected a Nebius catalog model fixture");

		const fetchMock: FetchImpl = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					data: [
						{
							id: flavor.model_id,
							name: snapshotModel.name,
							context_length: flavor.max_model_len,
							supported_parameters: snapshotModel.use_cases,
							pricing: {
								prompt: flavor.input_price_per_million_tokens / 1_000_000,
								completion: flavor.output_price_per_million_tokens / 1_000_000,
							},
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});
		const manager = createModelManager({
			...nebiusModelManagerOptions({ apiKey: "nebius-test-key", fetch: fetchMock }),
			cacheDbPath: `/private/tmp/omp-nebius-snapshot-${Date.now()}-${Math.random()}.sqlite`,
		});

		const result = await manager.refresh("online");

		expect(result.stale).toBe(false);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result.models).toContainEqual(
			expect.objectContaining({
				id: flavor.model_id,
				provider: "nebius",
				baseUrl: "https://api.tokenfactory.nebius.com/v1",
				contextWindow: flavor.max_model_len,
				supportsTools: true,
				cost: expect.objectContaining({
					input: flavor.input_price_per_million_tokens,
					output: flavor.output_price_per_million_tokens,
				}),
			}),
		);
	});

	test("preserves EURouter fallback vision metadata for the default model", () => {
		expect(EUROPEAN_GATEWAY_STATIC_MODELS).toContainEqual(
			expect.objectContaining({
				id: "mistral-large-3",
				provider: "eurouter",
				input: ["text", "image"],
			}),
		);
	});

	test("advertises the EURouter fallback context limit", () => {
		expect(EUROPEAN_GATEWAY_STATIC_MODELS).toContainEqual(
			expect.objectContaining({
				id: "mistral-large-3",
				provider: "eurouter",
				contextWindow: 262_144,
			}),
		);
	});

	test("applies configured base URLs to European gateway fallback seeds", () => {
		const baseUrl = "https://gateway.internal.example/v1";
		const options = eurouterModelManagerOptions({ baseUrl });

		expect(options.staticModels?.length).toBeGreaterThan(0);
		expect(options.staticModels?.every(model => model.baseUrl === baseUrl)).toBe(true);
	});

	test("namespaces European gateway model caches by configured base URL", () => {
		const defaultOptions = eurouterModelManagerOptions();
		const customOptions = eurouterModelManagerOptions({ baseUrl: "https://gateway.internal.example/v1" });
		const otherCustomOptions = eurouterModelManagerOptions({ baseUrl: "https://gateway.internal.example/v2" });

		expect(defaultOptions.cacheProviderId).toBeDefined();
		expect(customOptions.cacheProviderId).toBeDefined();
		expect(customOptions.cacheProviderId).not.toBe(customOptions.providerId);
		expect(customOptions.cacheProviderId).not.toBe(defaultOptions.cacheProviderId);
		expect(customOptions.cacheProviderId).not.toBe(otherCustomOptions.cacheProviderId);
	});

	test("omits gateway fallback seeds after authoritative discovery", () => {
		const seeds = getEuropeanGatewayStaticFallbackModels(new Set(["cortecs", "eurouter"]));
		const seededProviders = new Set(seeds.map(model => model.provider));

		expect(seededProviders.has("melious")).toBe(true);
		expect(seededProviders.has("nebius")).toBe(true);
		expect(seededProviders.has("cortecs")).toBe(false);
		expect(seededProviders.has("eurouter")).toBe(false);
	});

	test("bundles European gateway defaults for fresh installs", () => {
		for (const provider of providerCases) {
			const bundledModels = getBundledModels(provider.id);

			expect(bundledModels).toContainEqual(
				expect.objectContaining({
					id: provider.defaultModel,
					provider: provider.id,
					baseUrl: provider.baseUrl,
				}),
			);
		}
	});

	test("filters non-chat model ids from European gateway discovery", async () => {
		const fetchMock: FetchImpl = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					data: [
						{ id: "mistral-large-3", name: "Mistral Large 3" },
						{ id: "codestral-embed", name: "Codestral Embed" },
						{ id: "text-embedding-3-small", name: "Text Embedding 3 Small" },
						{ id: "bge-m3", name: "BGE M3" },
						{ id: "jina-reranker-v2", name: "Jina Reranker v2" },
						{ id: "flux-1.1-pro", name: "FLUX 1.1 Pro" },
						{ id: "whisper-large-v3", name: "Whisper Large v3" },
						{ id: "omni-moderation-latest", name: "Omni Moderation Latest" },
						{ id: "llama-moderation-guard", name: "Llama Moderation Guard" },
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});

		const models = await eurouterModelManagerOptions({ fetch: fetchMock }).fetchDynamicModels?.();

		expect(models?.map(model => model.id)).toEqual(["mistral-large-3"]);
	});

	test("filters guard-only model ids from European gateway discovery", async () => {
		const fetchMock: FetchImpl = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					data: [
						{ id: "gpt-oss-120b", name: "GPT OSS 120B" },
						{ id: "gpt-oss-safeguard-120b", name: "GPT OSS Safeguard 120B" },
						{ id: "llama-guard-3-8b", name: "Llama Guard 3 8B" },
						{ id: "qwen3guard-gen-8b", name: "Qwen3Guard-Gen-8B" },
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});

		const models = await cortecsModelManagerOptions({ fetch: fetchMock }).fetchDynamicModels?.();

		expect(models?.map(model => model.id)).toEqual(["gpt-oss-120b"]);
	});

	test("ignores generic gateway reasoning request parameters for non-reasoning models", async () => {
		const fetchMock: FetchImpl = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					data: [
						{
							id: "llama-3.1-8b-instruct",
							name: "Llama 3.1 8B Instruct",
							tags: ["Instruct", "Tools", "Reasoning"],
							supported_features: ["json_mode", "reasoning", "tools"],
							supported_parameters: ["tools", "reasoning"],
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});

		const models = await cortecsModelManagerOptions({ fetch: fetchMock }).fetchDynamicModels?.();

		expect(models?.[0]).toMatchObject({
			id: "llama-3.1-8b-instruct",
			provider: "cortecs",
			reasoning: false,
		});
	});

	test("preserves known reasoning capability for European gateway refreshes", async () => {
		const fetchMock: FetchImpl = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					data: [
						{
							id: "claude-sonnet-5",
							name: "Claude Sonnet 5",
							supported_parameters: ["tools"],
						},
						{
							id: "gemini-2.5-flash",
							name: "Gemini 2.5 Flash",
							supported_parameters: ["tools"],
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});

		const models = await eurouterModelManagerOptions({ fetch: fetchMock }).fetchDynamicModels?.();

		expect(models).toContainEqual(
			expect.objectContaining({
				id: "claude-sonnet-5",
				provider: "eurouter",
				reasoning: true,
			}),
		);
		expect(models).toContainEqual(
			expect.objectContaining({
				id: "gemini-2.5-flash",
				provider: "eurouter",
				reasoning: true,
			}),
		);
	});

	test("preserves known limits for sparse European gateway refreshes", async () => {
		const fetchMock: FetchImpl = vi.fn(async () => {
			return Response.json({
				data: [{ id: "claude-sonnet-5", name: "Claude Sonnet 5" }],
			});
		});

		const models = await eurouterModelManagerOptions({ fetch: fetchMock }).fetchDynamicModels?.();

		expect(models?.[0]).toMatchObject({
			id: "claude-sonnet-5",
			provider: "eurouter",
			contextWindow: 1_000_000,
			maxTokens: 128_000,
		});
	});

	test("preserves known reasoning capability for reordered Claude gateway ids", async () => {
		const fetchMock: FetchImpl = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					data: [
						{
							id: "claude-opus4-6",
							name: "Claude Opus 4.6",
							supported_parameters: ["tools"],
						},
						{
							id: "claude-opus4-7",
							name: "Claude Opus 4.7",
							supported_parameters: ["tools"],
						},
						{
							id: "claude-4-6-sonnet",
							name: "Claude 4.6 Sonnet",
							supported_parameters: ["tools"],
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});

		const models = await cortecsModelManagerOptions({ fetch: fetchMock }).fetchDynamicModels?.();

		expect(models).toContainEqual(
			expect.objectContaining({
				id: "claude-opus4-6",
				provider: "cortecs",
				reasoning: true,
			}),
		);
		expect(models).toContainEqual(
			expect.objectContaining({
				id: "claude-opus4-7",
				provider: "cortecs",
				reasoning: true,
			}),
		);
		expect(models).toContainEqual(
			expect.objectContaining({
				id: "claude-4-6-sonnet",
				provider: "cortecs",
				reasoning: true,
			}),
		);
	});

	test("marks European gateway models without tool capabilities as non-native tool models", async () => {
		const fetchMock: FetchImpl = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					data: [
						{
							id: "code-llama-13b-instruct",
							name: "Code Llama 13B Instruct",
							supported_features: ["json_mode", "streaming"],
						},
						{
							id: "mistral-large-3",
							name: "Mistral Large 3",
							supported_parameters: ["tools"],
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});

		const models = await eurouterModelManagerOptions({ fetch: fetchMock }).fetchDynamicModels?.();

		expect(models).toContainEqual(
			expect.objectContaining({
				id: "code-llama-13b-instruct",
				provider: "eurouter",
				supportsTools: false,
			}),
		);
		expect(models).toContainEqual(
			expect.objectContaining({
				id: "mistral-large-3",
				provider: "eurouter",
				supportsTools: true,
			}),
		);
	});

	test("normalizes gateway tool capability tokens before matching", async () => {
		const fetchMock: FetchImpl = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					data: [
						{
							id: "mistral-large-3",
							name: "Mistral Large 3",
							tags: [" Tools "],
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});

		const models = await eurouterModelManagerOptions({ fetch: fetchMock }).fetchDynamicModels?.();

		expect(models?.[0]).toMatchObject({
			id: "mistral-large-3",
			provider: "eurouter",
			supportsTools: true,
		});
	});

	test("preserves native tool support when gateway capability metadata is absent", async () => {
		const fetchMock: FetchImpl = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					data: [{ id: "mistral-large-3", name: "Mistral Large 3" }],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});

		const models = await eurouterModelManagerOptions({ fetch: fetchMock }).fetchDynamicModels?.();
		const model = models?.find(candidate => candidate.id === "mistral-large-3");

		expect(model).toBeDefined();
		expect(model?.provider).toBe("eurouter");
		expect(model?.supportsTools).toBeUndefined();
	});

	test("parses European gateway architecture modality strings for image input", async () => {
		const fetchMock: FetchImpl = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					data: [
						{
							id: "qwen2.5-vl-72b-instruct",
							name: "Qwen 2.5 VL 72B Instruct",
							architecture: {
								modality: "text+image->text",
							},
							supported_parameters: ["tools"],
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});

		const models = await nebiusModelManagerOptions({
			apiKey: "nebius-test-key",
			fetch: fetchMock,
		}).fetchDynamicModels?.();

		expect(models?.[0]).toMatchObject({
			id: "qwen2.5-vl-72b-instruct",
			provider: "nebius",
			input: ["text", "image"],
		});
	});

	test("normalizes gateway input modality tokens before matching", async () => {
		const fetchMock: FetchImpl = vi.fn(async () => {
			return Response.json({
				data: [
					{
						id: "custom-vision-model",
						name: "Custom Vision Model",
						input_modalities: [" Image "],
					},
					{
						id: "tagged-vision-model",
						name: "Tagged Vision Model",
						tags: [" Vision "],
					},
				],
			});
		});

		const models = await eurouterModelManagerOptions({ fetch: fetchMock }).fetchDynamicModels?.();

		expect(models?.map(model => ({ id: model.id, input: model.input }))).toEqual([
			{ id: "custom-vision-model", input: ["text", "image"] },
			{ id: "tagged-vision-model", input: ["text", "image"] },
		]);
	});

	test("normalizes gateway output modality tokens before filtering", async () => {
		const fetchMock: FetchImpl = vi.fn(async () => {
			return Response.json({
				data: [
					{
						id: "custom-chat-model",
						name: "Custom Chat Model",
						output_modalities: [" Text "],
					},
				],
			});
		});

		const models = await eurouterModelManagerOptions({ fetch: fetchMock }).fetchDynamicModels?.();

		expect(models?.map(model => model.id)).toEqual(["custom-chat-model"]);
	});

	test("filters modality-only image generation rows from European gateway discovery", async () => {
		const fetchMock: FetchImpl = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					data: [
						{
							id: "stability-ai/sdxl",
							name: "SDXL",
							architecture: {
								modality: "text->image",
							},
						},
						{
							id: "qwen2.5-vl-72b-instruct",
							name: "Qwen 2.5 VL 72B Instruct",
							architecture: {
								modality: "text+image->text",
							},
							supported_parameters: ["tools"],
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});

		const models = await nebiusModelManagerOptions({
			apiKey: "nebius-test-key",
			fetch: fetchMock,
		}).fetchDynamicModels?.();

		expect(models?.map(model => model.id)).toEqual(["qwen2.5-vl-72b-instruct"]);
	});

	test("preserves known image input for European gateway rows with sparse text metadata", async () => {
		const fetchMock: FetchImpl = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					data: [
						{
							id: "llama-4-maverick",
							name: "Llama 4 Maverick",
							supported_parameters: ["tools"],
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});

		const models = await cortecsModelManagerOptions({ fetch: fetchMock }).fetchDynamicModels?.();

		expect(models?.[0]).toMatchObject({
			id: "llama-4-maverick",
			provider: "cortecs",
			input: ["text", "image"],
		});
	});

	test("marks MiniCPM-V gateway rows as image-capable when discovery metadata is sparse", async () => {
		const fetchMock: FetchImpl = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					data: [
						{
							id: "minicpm-v-4.5",
							name: "MiniCPM-V 4.5",
							supported_parameters: ["tools"],
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});

		const models = await cortecsModelManagerOptions({ fetch: fetchMock }).fetchDynamicModels?.();

		expect(models?.[0]).toMatchObject({
			id: "minicpm-v-4.5",
			provider: "cortecs",
			input: ["text", "image"],
		});
	});

	test("honors explicit text-only input metadata for otherwise vision-capable models", async () => {
		const fetchMock: FetchImpl = vi.fn(async () => {
			return Response.json({
				data: [
					{
						id: "llama-4-maverick",
						name: "Llama 4 Maverick",
						input_modalities: ["text"],
					},
					{
						id: "minicpm-v-4.5",
						name: "MiniCPM-V 4.5",
						architecture: { modality: "text->text" },
					},
				],
			});
		});

		const models = await cortecsModelManagerOptions({ fetch: fetchMock }).fetchDynamicModels?.();

		expect(models?.map(model => ({ id: model.id, input: model.input }))).toEqual([
			{ id: "llama-4-maverick", input: ["text"] },
			{ id: "minicpm-v-4.5", input: ["text"] },
		]);
	});

	test("does not inherit unrelated provider transport metadata for common gateway model ids", async () => {
		const fetchMock: FetchImpl = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					data: [{ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", supported_parameters: ["tools"] }],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});

		const models = await eurouterModelManagerOptions({ fetch: fetchMock }).fetchDynamicModels?.();
		const model = models?.[0] as Record<string, unknown> | undefined;

		expect(model).toMatchObject({
			id: "deepseek-v4-flash",
			provider: "eurouter",
			baseUrl: "https://api.eurouter.ai/api/v1",
		});
		expect(model?.compat).toBeUndefined();
		expect(model?.headers).toBeUndefined();
		expect(model?.premiumMultiplier).toBeUndefined();
	});

	test("does not merge stale bundled transport metadata into EURouter discovery refreshes", async () => {
		const fetchMock: FetchImpl = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					data: [
						{
							id: "claude-haiku-4.5",
							name: "Claude Haiku 4.5",
							context_length: 200000,
							max_completion_tokens: 8192,
							architecture: {
								input_modalities: ["text", "image"],
								output_modalities: ["text"],
							},
							pricing: {
								prompt: "0.000001",
								completion: "0.000005",
							},
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});
		const manager = createModelManager({
			...eurouterModelManagerOptions({ fetch: fetchMock }),
			cacheDbPath: `/private/tmp/omp-european-provider-gateways-${Date.now()}-${Math.random()}.sqlite`,
		});

		const result = await manager.refresh("online");
		const model = result.models.find(item => item.id === "claude-haiku-4.5") as Record<string, unknown> | undefined;

		expect(result.stale).toBe(false);
		expect(model).toMatchObject({
			id: "claude-haiku-4.5",
			provider: "eurouter",
			baseUrl: "https://api.eurouter.ai/api/v1",
		});
		expect(model?.headers).toBeUndefined();
		expect(model?.premiumMultiplier).toBeUndefined();
	});
});
