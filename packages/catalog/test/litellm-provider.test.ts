import { afterEach, describe, expect, test, vi } from "bun:test";
import { fetchLiteLLMRichModels, litellmModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";
import * as logger from "@oh-my-pi/pi-utils/logger";

const ORIGINAL_LITELLM_BASE_URL = Bun.env.LITELLM_BASE_URL;
const MODELS_DEV_URL = "https://catalog.stencil.so/models.json.zstd";
function makeLiteLLMSentinelPlaceholder(modelGroup: string) {
	return {
		model_group: modelGroup,
		model_name: null,
		providers: [],
		max_input_tokens: null,
		max_output_tokens: null,
		supports_vision: null,
		supports_reasoning: null,
		supports_function_calling: null,
		supported_openai_params: [],
		litellm_params: {
			model: null,
			model_name: null,
		},
		model_info: {
			max_input_tokens: null,
			max_output_tokens: null,
			supports_vision: null,
			supports_reasoning: null,
			supports_function_calling: null,
			supported_openai_params: [],
		},
	} as const;
}

const ALL_TEAM_MODELS_PLACEHOLDER = makeLiteLLMSentinelPlaceholder("all-team-models");

function restoreLiteLLMBaseUrl(): void {
	if (ORIGINAL_LITELLM_BASE_URL === undefined) {
		delete Bun.env.LITELLM_BASE_URL;
		return;
	}
	Bun.env.LITELLM_BASE_URL = ORIGINAL_LITELLM_BASE_URL;
}

function inputUrl(input: string | URL | Request): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	return input.url;
}

function makeFetchMock(expectedModelUrl: string): FetchImpl {
	const managementBaseUrl = expectedModelUrl.replace(/\/v1\/models$/, "");
	return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = inputUrl(input);
		if (url === MODELS_DEV_URL) {
			return new Response("{}", { status: 500 });
		}

		expect(init?.method).toBe("GET");
		expect(init?.headers).toMatchObject({
			Accept: "application/json",
			Authorization: "Bearer sk-litellm-test",
		});
		if (url === `${managementBaseUrl}/model_group/info`) {
			return new Response("{}", { status: 404 });
		}
		if (url === `${managementBaseUrl}/v2/model/info`) {
			return new Response("{}", { status: 500 });
		}
		if (url === `${managementBaseUrl}/model/info` || url === `${managementBaseUrl}/v1/model/info`) {
			return new Response("{}", { status: 404 });
		}
		expect(url).toBe(expectedModelUrl);
		return new Response(JSON.stringify({ data: [{ id: "openai/gpt-5" }] }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}) as FetchImpl;
}

function makeCollisionFetchMock(): FetchImpl {
	return vi.fn(async (input: string | URL | Request) => {
		const url = inputUrl(input);
		if (url === MODELS_DEV_URL) {
			return Response.json({
				"ollama-cloud": {
					models: {
						"deepseek-v4-flash": {
							name: "DeepSeek V4 Flash",
							tool_call: true,
							limit: { context: 64_000, output: 8_000 },
							cost: { input: 1, output: 2 },
						},
					},
				},
			});
		}
		if (url === "http://primary:4000/model_group/info") {
			return new Response("{}", { status: 404 });
		}
		if (url === "http://primary:4000/v2/model/info") {
			return new Response("{}", { status: 500 });
		}
		if (url === "http://primary:4000/model/info" || url === "http://primary:4000/v1/model/info") {
			return new Response("{}", { status: 404 });
		}

		expect(url).toBe("http://primary:4000/v1/models");
		return Response.json({ data: [{ id: "deepseek-v4-flash" }] });
	}) as FetchImpl;
}

afterEach(() => {
	restoreLiteLLMBaseUrl();
	vi.restoreAllMocks();
});

describe("LiteLLM provider discovery", () => {
	test("uses LITELLM_BASE_URL when no explicit baseUrl is configured", async () => {
		Bun.env.LITELLM_BASE_URL = "http://litellm.example:4100/v1";
		const fetchMock = makeFetchMock("http://litellm.example:4100/v1/models");

		const options = litellmModelManagerOptions({
			apiKey: "sk-litellm-test",
			fetch: fetchMock,
		});
		const models = await options.fetchDynamicModels?.();

		expect(options.cacheProviderId).toBe(
			`litellm:rich-v7:${Bun.hash("http://litellm.example:4100/v1").toString(36)}`,
		);
		expect(fetchMock).toHaveBeenCalledTimes(6);
		expect(models).toHaveLength(1);
		expect(models?.[0]).toMatchObject({
			id: "openai/gpt-5",
			api: "openai-responses",
			provider: "litellm",
			baseUrl: "http://litellm.example:4100/v1",
		});
	});

	test("keeps explicit baseUrl higher precedence than LITELLM_BASE_URL", async () => {
		Bun.env.LITELLM_BASE_URL = "http://litellm-env.example:4100/v1";
		const fetchMock = makeFetchMock("http://litellm-config.example:4200/v1/models");

		const options = litellmModelManagerOptions({
			apiKey: "sk-litellm-test",
			baseUrl: "http://litellm-config.example:4200/v1/",
			fetch: fetchMock,
		});
		const models = await options.fetchDynamicModels?.();

		expect(options.cacheProviderId).toBe(
			`litellm:rich-v7:${Bun.hash("http://litellm-config.example:4200/v1/").toString(36)}`,
		);
		expect(fetchMock).toHaveBeenCalledTimes(6);
		expect(models).toHaveLength(1);
		expect(models?.[0]?.baseUrl).toBe("http://litellm-config.example:4200/v1");
	});

	test("keeps LiteLLM transport when stencil.so has a colliding provider model id", async () => {
		const fetchMock = makeCollisionFetchMock();

		const options = litellmModelManagerOptions({
			apiKey: "sk-litellm-test",
			baseUrl: "http://primary:4000/v1",
			fetch: fetchMock,
		});
		const models = await options.fetchDynamicModels?.();

		expect(models).toHaveLength(1);
		expect(models?.[0]).toMatchObject({
			id: "deepseek-v4-flash",
			name: "DeepSeek V4 Flash",
			api: "openai-completions",
			provider: "litellm",
			baseUrl: "http://primary:4000/v1",
			contextWindow: 64_000,
			maxTokens: 8_000,
			cost: {
				input: 1,
				output: 2,
			},
		});
	});

	test("routes only OpenAI-backed rich models through Responses", async () => {
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = inputUrl(input);
			if (url === MODELS_DEV_URL) {
				return Response.json({});
			}
			if (url === "http://primary:4000/model_group/info") {
				return Response.json({
					data: [
						{
							model_group: "team-reasoner",
							providers: ["openai"],
							supports_vision: false,
						},
						{
							model_group: "configured-reasoner",
							litellm_params: { custom_llm_provider: "openai", model: "internal-model-name" },
							supports_vision: false,
						},
						{
							model_group: "backend-reasoner",
							litellm_params: { model: "openai/gpt-5.6-sol" },
							supports_vision: false,
						},
						{
							model_group: "base-reasoner",
							model_info: { base_model: "openai/gpt-5.4" },
							supports_vision: false,
						},
						{
							model_group: "mixed-gpt",
							providers: ["openai", "azure"],
							supports_vision: false,
						},
						{
							model_group: "claude-proxy",
							providers: ["anthropic"],
							supports_vision: false,
						},
					],
				});
			}
			throw new Error(`Unexpected URL: ${url}`);
		}) as FetchImpl;
		const options = litellmModelManagerOptions({
			apiKey: "sk-rich",
			baseUrl: "http://primary:4000/v1",
			fetch: fetchMock,
		});

		const models = await options.fetchDynamicModels?.();

		expect(models?.find(model => model.id === "team-reasoner")?.api).toBe("openai-responses");
		expect(models?.find(model => model.id === "configured-reasoner")?.api).toBe("openai-responses");
		expect(models?.find(model => model.id === "backend-reasoner")?.api).toBe("openai-responses");
		expect(models?.find(model => model.id === "base-reasoner")?.api).toBe("openai-responses");
		expect(models?.find(model => model.id === "mixed-gpt")?.api).toBe("openai-completions");
		expect(models?.find(model => model.id === "claude-proxy")?.api).toBe("openai-completions");
	});

	test("uses rich LiteLLM metadata before /v1/models", async () => {
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = inputUrl(input);
			if (url === MODELS_DEV_URL) {
				return Response.json({});
			}
			expect(init?.headers).toMatchObject({
				Accept: "application/json",
				Authorization: "Bearer sk-rich",
			});
			if (url === "http://primary:4000/model_group/info") {
				return Response.json({
					data: [
						{
							model_group: "gpt-big",
							model_name: "Gateway GPT Big",
							max_input_tokens: 262_144,
							max_output_tokens: 16_384,
							supports_vision: true,
							supports_reasoning: true,
							supports_function_calling: true,
							supported_openai_params: ["reasoning_effort"],
						},
					],
				});
			}
			if (url === "http://primary:4000/v1/models") {
				throw new Error("/v1/models should not be called when rich metadata succeeds");
			}
			throw new Error(`Unexpected URL: ${url}`);
		}) as FetchImpl;
		const options = litellmModelManagerOptions({
			apiKey: "sk-rich",
			baseUrl: "http://primary:4000/v1",
			fetch: fetchMock,
		});
		const models = await options.fetchDynamicModels?.();

		expect(models).toHaveLength(1);
		expect(models?.[0]).toMatchObject({
			id: "gpt-big",
			name: "Gateway GPT Big",
			provider: "litellm",
			baseUrl: "http://primary:4000/v1",
			contextWindow: 262_144,
			maxTokens: 16_384,
			input: ["text", "image"],
			reasoning: true,
			compat: {
				supportsStore: false,
				supportsDeveloperRole: false,
				supportsReasoningEffort: true,
			},
			supportsTools: true,
		});
	});

	test("warns once when forbidden rich metadata forces /v1/models fallback", async () => {
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = inputUrl(input);
			if (url === MODELS_DEV_URL) {
				return Response.json({});
			}
			if (url === "http://forbidden:4000/v1/models") {
				return Response.json({ data: [{ id: "hosted_vllm/private-model" }] });
			}
			return new Response("Forbidden", { status: 403 });
		}) as FetchImpl;
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const options = litellmModelManagerOptions({
			apiKey: "sk-restricted",
			baseUrl: "http://forbidden:4000/v1",
			fetch: fetchMock,
		});

		const models = await options.fetchDynamicModels?.();
		await options.fetchDynamicModels?.();

		expect(models?.[0]).toMatchObject({
			id: "hosted_vllm/private-model",
			contextWindow: null,
			maxTokens: null,
		});
		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(warnSpy).toHaveBeenCalledWith(
			"LiteLLM rich model metadata unavailable; falling back to /v1/models",
			expect.objectContaining({
				endpoint: "http://forbidden:4000/model_group/info",
				status: 403,
				reason: "http-status",
			}),
		);
	});

	test("treats missing rich metadata endpoints as absent without warning", async () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

		const models = await fetchLiteLLMRichModels({
			api: "openai-completions",
			provider: "litellm",
			apiKey: "sk-restricted",
			baseUrl: "http://missing:4000/v1",
			fetch: async () => new Response("Not Found", { status: 404 }),
		});

		expect(models).toBeNull();
		expect(warnSpy).not.toHaveBeenCalled();
	});

	test("stays silent on retryable 401 rich failures so the caller's auth retry owns them", async () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

		const models = await fetchLiteLLMRichModels({
			api: "openai-completions",
			provider: "litellm",
			apiKey: "sk-stale",
			baseUrl: "http://unauthorized:4000/v1",
			fetch: async () => new Response("Unauthorized", { status: 401 }),
		});

		expect(models).toBeNull();
		expect(warnSpy).not.toHaveBeenCalled();
	});

	test("maps LiteLLM per-token cost onto cost.input/output for models missing from stencil.so", async () => {
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = inputUrl(input);
			if (url === MODELS_DEV_URL) {
				return Response.json({});
			}
			if (url === "http://primary:4000/model_group/info") {
				return Response.json({
					data: [
						{
							model_group: "openrouter/acme/big",
							model_name: "Acme Big",
							max_input_tokens: 262_144,
							max_output_tokens: 16_384,
							input_cost_per_token: 0.000_005,
							output_cost_per_token: 0.000_03,
							cache_read_input_token_cost: 0.000_000_5,
							supports_vision: true,
						},
					],
				});
			}
			if (url === "http://primary:4000/v1/models") {
				throw new Error("/v1/models should not be called when rich metadata succeeds");
			}
			throw new Error(`Unexpected URL: ${url}`);
		}) as FetchImpl;
		const options = litellmModelManagerOptions({
			apiKey: "sk-rich",
			baseUrl: "http://primary:4000/v1",
			fetch: fetchMock,
		});

		const models = await options.fetchDynamicModels?.();

		expect(models).toHaveLength(1);
		expect(models?.[0]).toMatchObject({
			id: "openrouter/acme/big",
			contextWindow: 262_144,
			cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
		});
	});

	test("enriches LiteLLM rich models missing from stencil.so with bundled reasoning metadata", async () => {
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = inputUrl(input);
			if (url === MODELS_DEV_URL) {
				return Response.json({});
			}
			if (url === "http://primary:4000/model_group/info") {
				return Response.json({
					data: [
						{
							model_group: "glm-5.2",
							model_name: "GLM-5.2",
						},
					],
				});
			}
			if (url === "http://primary:4000/v1/models") {
				throw new Error("/v1/models should not be called when model_group info has a real model");
			}
			throw new Error(`Unexpected URL: ${url}`);
		}) as FetchImpl;
		const options = litellmModelManagerOptions({
			apiKey: "sk-rich",
			baseUrl: "http://primary:4000/v1",
			fetch: fetchMock,
		});

		const models = await options.fetchDynamicModels?.();

		expect(models).toHaveLength(1);
		expect(models?.[0]).toMatchObject({
			id: "glm-5.2",
			name: "GLM-5.2",
			api: "openai-completions",
			provider: "litellm",
			baseUrl: "http://primary:4000/v1",
			reasoning: true,
			thinking: {
				mode: "effort",
				efforts: ["minimal", "low", "medium", "high", "max"],
				effortMap: {
					minimal: "none",
				},
			},
		});
	});

	test("uses LiteLLM tool support metadata when rich endpoints succeed", async () => {
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = inputUrl(input);
			if (url === MODELS_DEV_URL) {
				return Response.json({});
			}
			if (url === "http://primary:4000/model_group/info") {
				return Response.json({
					data: [
						{
							model_group: "no-tools",
							providers: ["openai"],
							supports_vision: false,
							supports_function_calling: false,
						},
						{ model_group: "params-tools", supports_vision: false, supported_openai_params: ["tools"] },
					],
				});
			}
			throw new Error(`Unexpected URL: ${url}`);
		}) as FetchImpl;
		const options = litellmModelManagerOptions({
			baseUrl: "http://primary:4000/v1",
			fetch: fetchMock,
		});

		const models = await options.fetchDynamicModels?.();

		expect(models?.find(model => model.id === "no-tools")?.supportsTools).toBe(false);
		expect(models?.find(model => model.id === "params-tools")?.supportsTools).toBe(true);
	});

	test.each([["all-team-models"], ["all-proxy-models"], ["no-default-models"]])(
		"falls back from %s placeholder to v2 model info",
		async sentinelModelId => {
			const calls: string[] = [];
			const fetchMock = vi.fn(async (input: string | URL | Request) => {
				const url = inputUrl(input);
				calls.push(url);
				if (url === MODELS_DEV_URL) {
					return Response.json({});
				}
				if (url === "http://primary:4000/model_group/info") {
					return Response.json({ data: [makeLiteLLMSentinelPlaceholder(sentinelModelId)] });
				}
				if (url === "http://primary:4000/v2/model/info") {
					return Response.json({
						data: [
							{
								model_name: "example-real-model",
								model_info: {
									max_input_tokens: 200_000,
									max_output_tokens: 12_000,
									supports_vision: false,
									supports_reasoning: true,
								},
							},
						],
					});
				}
				if (url === "http://primary:4000/v1/models") {
					throw new Error("/v1/models should not be called when v2 metadata succeeds");
				}
				throw new Error(`Unexpected URL: ${url}`);
			}) as FetchImpl;
			const options = litellmModelManagerOptions({
				apiKey: "sk-rich",
				baseUrl: "http://primary:4000/v1",
				fetch: fetchMock,
			});

			const models = await options.fetchDynamicModels?.();

			expect(calls).toContain("http://primary:4000/model_group/info");
			expect(calls).toContain("http://primary:4000/v2/model/info");
			expect(calls).not.toContain("http://primary:4000/v1/models");
			expect(models?.map(model => model.id)).toEqual(["example-real-model"]);
			expect(models?.[0]).toMatchObject({
				id: "example-real-model",
				contextWindow: 200_000,
				maxTokens: 12_000,
				input: ["text"],
				reasoning: true,
			});
		},
	);

	test("filters all-team-models placeholder from mixed model_group info", async () => {
		const calls: string[] = [];
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = inputUrl(input);
			calls.push(url);
			if (url === MODELS_DEV_URL) {
				return Response.json({});
			}
			if (url === "http://primary:4000/model_group/info") {
				return Response.json({
					data: [
						ALL_TEAM_MODELS_PLACEHOLDER,
						{
							model_group: "example-real-model",
							model_name: "Example Real Model",
							providers: ["anthropic"],
							max_input_tokens: 96_000,
							max_output_tokens: 8_000,
							supports_function_calling: true,
							supports_vision: false,
						},
					],
				});
			}
			if (url === "http://primary:4000/v2/model/info") {
				throw new Error("/v2/model/info should not be called when model_group info has a real model");
			}
			if (url === "http://primary:4000/v1/models") {
				throw new Error("/v1/models should not be called when model_group info has a real model");
			}
			throw new Error(`Unexpected URL: ${url}`);
		}) as FetchImpl;
		const options = litellmModelManagerOptions({
			apiKey: "sk-rich",
			baseUrl: "http://primary:4000/v1",
			fetch: fetchMock,
		});

		const models = await options.fetchDynamicModels?.();

		expect(calls).toContain("http://primary:4000/model_group/info");
		expect(calls).not.toContain("http://primary:4000/v2/model/info");
		expect(calls).not.toContain("http://primary:4000/v1/models");
		expect(models?.map(model => model.id)).toEqual(["example-real-model"]);
		expect(models?.[0]).toMatchObject({
			id: "example-real-model",
			name: "Example Real Model",
			contextWindow: 96_000,
			maxTokens: 8_000,
			supportsTools: true,
		});
	});

	test("falls back from missing model_group info to v2 model info", async () => {
		const calls: string[] = [];
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = inputUrl(input);
			calls.push(url);
			if (url === MODELS_DEV_URL) {
				return Response.json({});
			}
			if (url === "http://primary:4000/model_group/info") {
				return new Response("{}", { status: 404 });
			}
			if (url === "http://primary:4000/v2/model/info") {
				return Response.json({
					data: [
						{
							model_name: "team-gpt",
							model_info: {
								max_input_tokens: 200_000,
								max_output_tokens: 12_000,
								supports_vision: false,
								supports_reasoning: true,
							},
						},
					],
				});
			}
			if (url === "http://primary:4000/v1/models") {
				throw new Error("/v1/models should not be called when v2 metadata succeeds");
			}
			throw new Error(`Unexpected URL: ${url}`);
		}) as FetchImpl;
		const options = litellmModelManagerOptions({
			apiKey: "sk-rich",
			baseUrl: "http://primary:4000/v1",
			fetch: fetchMock,
		});
		const models = await options.fetchDynamicModels?.();

		expect(calls).toContain("http://primary:4000/model_group/info");
		expect(calls).toContain("http://primary:4000/v2/model/info");
		expect(calls).not.toContain("http://primary:4000/v1/models");
		expect(models?.[0]).toMatchObject({
			id: "team-gpt",
			contextWindow: 200_000,
			maxTokens: 12_000,
			input: ["text"],
			reasoning: true,
		});
	});

	test("continues rich discovery for cache pricing omitted by model group info", async () => {
		const calls: string[] = [];
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = inputUrl(input);
			calls.push(url);
			if (url === MODELS_DEV_URL) {
				return Response.json({});
			}
			if (url === "http://primary:4000/model_group/info") {
				return Response.json({
					data: [
						{
							model_group: "team-gpt",
							input_cost_per_token: 0.000_005_5,
							output_cost_per_token: 0.000_033,
							supports_vision: false,
						},
					],
				});
			}
			if (url === "http://primary:4000/v2/model/info") {
				return Response.json({
					data: [
						{
							model_name: "team-gpt",
							model_info: {
								cache_read_input_token_cost: 0.000_000_55,
								cache_creation_input_token_cost: 0.000_006_875,
							},
						},
					],
				});
			}
			if (url === "http://primary:4000/model/info" || url === "http://primary:4000/v1/model/info") {
				return new Response("{}", { status: 404 });
			}
			throw new Error(`Unexpected URL: ${url}`);
		}) as FetchImpl;
		const options = litellmModelManagerOptions({
			apiKey: "sk-rich",
			baseUrl: "http://primary:4000/v1",
			fetch: fetchMock,
		});

		const models = await options.fetchDynamicModels?.();

		expect(calls).toContain("http://primary:4000/v2/model/info");
		expect(models?.[0]?.cost).toEqual({ input: 5.5, output: 33, cacheRead: 0.55, cacheWrite: 6.875 });
	});

	test("ignores zero placeholder prices from later rich metadata", async () => {
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = inputUrl(input);
			if (url === MODELS_DEV_URL) {
				return Response.json({});
			}
			if (url === "http://primary:4000/model_group/info") {
				return Response.json({
					data: [
						{
							model_group: "placeholder-cache",
							input_cost_per_token: 0.000_005,
							output_cost_per_token: 0.000_03,
							cache_read_input_token_cost: 0.000_000_5,
							supports_vision: false,
						},
					],
				});
			}
			if (url === "http://primary:4000/v2/model/info") {
				return Response.json({
					data: [
						{
							model_name: "placeholder-cache",
							model_info: {
								input_cost_per_token: 0,
								output_cost_per_token: 0,
								cache_read_input_token_cost: 0,
								cache_creation_input_token_cost: 0,
							},
						},
					],
				});
			}
			throw new Error(`Unexpected URL: ${url}`);
		}) as FetchImpl;

		const models = await litellmModelManagerOptions({
			apiKey: "sk-rich",
			baseUrl: "http://primary:4000/v1",
			fetch: fetchMock,
		}).fetchDynamicModels?.();

		expect(models?.[0]?.cost).toEqual({ input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 });
	});

	test("preserves cache prices reported before base prices", async () => {
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = inputUrl(input);
			if (url === MODELS_DEV_URL) {
				return Response.json({});
			}
			if (url === "http://primary:4000/model_group/info") {
				return Response.json({
					data: [
						{
							model_group: "cache-first",
							cache_read_input_token_cost: 0.000_000_5,
							cache_creation_input_token_cost: 0.000_006_25,
							supports_vision: false,
						},
					],
				});
			}
			if (url === "http://primary:4000/v2/model/info") {
				return Response.json({
					data: [
						{
							model_name: "cache-first",
							model_info: {
								input_cost_per_token: 0.000_005,
								output_cost_per_token: 0.000_03,
								supports_vision: false,
							},
						},
					],
				});
			}
			if (url === "http://primary:4000/model/info" || url === "http://primary:4000/v1/model/info") {
				return new Response("{}", { status: 404 });
			}
			throw new Error(`Unexpected URL: ${url}`);
		}) as FetchImpl;

		const models = await litellmModelManagerOptions({
			apiKey: "sk-rich",
			baseUrl: "http://primary:4000/v1",
			fetch: fetchMock,
		}).fetchDynamicModels?.();

		expect(models?.[0]?.cost).toEqual({ input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 });
	});

	test("merges API routing evidence across rich metadata endpoints", async () => {
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = inputUrl(input);
			if (url === MODELS_DEV_URL) {
				return Response.json({});
			}
			if (url === "http://primary:4000/model_group/info") {
				return Response.json({
					data: [{ model_group: "aliased-openai" }, { model_group: "mixed-backend", providers: ["openai"] }],
				});
			}
			if (url === "http://primary:4000/v2/model/info") {
				return Response.json({
					data: [
						{
							model_name: "aliased-openai",
							litellm_params: { custom_llm_provider: "openai", model: "internal-model-name" },
							model_info: { supports_vision: false },
						},
						{
							model_name: "mixed-backend",
							providers: ["openai", "azure"],
							model_info: { supports_vision: false },
						},
					],
				});
			}
			throw new Error(`Unexpected URL: ${url}`);
		}) as FetchImpl;
		const options = litellmModelManagerOptions({
			apiKey: "sk-rich",
			baseUrl: "http://primary:4000/v1",
			fetch: fetchMock,
		});

		const models = await options.fetchDynamicModels?.();

		expect(models?.find(model => model.id === "aliased-openai")?.api).toBe("openai-responses");
		expect(models?.find(model => model.id === "mixed-backend")?.api).toBe("openai-completions");
	});

	test("continues rich discovery when API routing is unknown despite complete vision metadata", async () => {
		const calls: string[] = [];
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = inputUrl(input);
			calls.push(url);
			if (url === MODELS_DEV_URL) {
				return Response.json({});
			}
			if (url === "http://primary:4000/model_group/info") {
				return Response.json({
					data: [{ model_group: "opaque-alias", supports_vision: false }],
				});
			}
			if (url === "http://primary:4000/v2/model/info") {
				return Response.json({
					data: [
						{
							model_name: "opaque-alias",
							litellm_params: { custom_llm_provider: "openai", model: "internal-model-name" },
							model_info: { supports_vision: false },
						},
					],
				});
			}
			throw new Error(`Unexpected URL: ${url}`);
		}) as FetchImpl;
		const models = await litellmModelManagerOptions({
			apiKey: "sk-rich",
			baseUrl: "http://primary:4000/v1",
			fetch: fetchMock,
		}).fetchDynamicModels?.();

		expect(calls).toContain("http://primary:4000/v2/model/info");
		expect(models?.find(model => model.id === "opaque-alias")?.api).toBe("openai-responses");
	});

	test("merges mixed-provider routing evidence within one rich endpoint", async () => {
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = inputUrl(input);
			if (url === MODELS_DEV_URL) {
				return Response.json({});
			}
			if (url === "http://primary:4000/model_group/info") {
				return Response.json({
					data: [
						{ model_group: "openai-last", providers: ["anthropic"], supports_vision: false },
						{ model_group: "openai-last", providers: ["openai"], supports_vision: false },
						{ model_group: "openai-first", providers: ["openai"], supports_vision: false },
						{ model_group: "openai-first", providers: ["anthropic"], supports_vision: false },
					],
				});
			}
			throw new Error(`Unexpected URL: ${url}`);
		}) as FetchImpl;
		const models = await litellmModelManagerOptions({
			apiKey: "sk-rich",
			baseUrl: "http://primary:4000/v1",
			fetch: fetchMock,
		}).fetchDynamicModels?.();

		expect(models?.find(model => model.id === "openai-last")?.api).toBe("openai-completions");
		expect(models?.find(model => model.id === "openai-first")?.api).toBe("openai-completions");
	});

	test("continues to LiteLLM model info when model_group omits vision metadata", async () => {
		const calls: string[] = [];
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = inputUrl(input);
			calls.push(url);
			if (url === MODELS_DEV_URL) {
				return Response.json({});
			}
			if (url === "http://primary:4000/model_group/info") {
				return Response.json({
					data: [
						{
							model_group: "vision-proxy-model",
							model_name: "Vision Proxy Model",
							max_input_tokens: 64_000,
							max_output_tokens: 8_000,
						},
					],
				});
			}
			if (url === "http://primary:4000/v2/model/info") {
				return Response.json({
					data: [{ model_name: "unrelated-v2-model", model_info: { supports_vision: false } }],
				});
			}
			if (url === "http://primary:4000/model/info") {
				return Response.json({
					data: [
						{ model_name: "text-only-model", model_info: { supports_vision: false } },
						{
							model_name: "vision-proxy-model",
							model_info: {
								supports_vision: true,
							},
						},
					],
				});
			}
			if (url === "http://primary:4000/v1/models") {
				throw new Error("/v1/models should not be called when LiteLLM model info succeeds");
			}
			throw new Error(`Unexpected URL: ${url}`);
		}) as FetchImpl;
		const options = litellmModelManagerOptions({
			apiKey: "sk-rich",
			baseUrl: "http://primary:4000/v1",
			fetch: fetchMock,
		});

		const models = await options.fetchDynamicModels?.();

		expect(calls).toContain("http://primary:4000/model_group/info");
		expect(calls).toContain("http://primary:4000/v2/model/info");
		expect(calls).toContain("http://primary:4000/model/info");
		expect(calls).not.toContain("http://primary:4000/v1/models");
		expect(models).toHaveLength(1);
		expect(models?.find(model => model.id === "vision-proxy-model")).toMatchObject({
			id: "vision-proxy-model",
			name: "Vision Proxy Model",
			input: ["text", "image"],
			contextWindow: 64_000,
			maxTokens: 8_000,
		});
	});

	test("falls back from v2 model info to LiteLLM model info", async () => {
		const calls: string[] = [];
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = inputUrl(input);
			calls.push(url);
			if (url === "http://primary:4000/model_group/info" || url === "http://primary:4000/v2/model/info") {
				return new Response("{}", { status: 404 });
			}
			if (url === "http://primary:4000/model/info") {
				return Response.json({
					data: [{ model_name: "legacy-gpt", model_info: { max_input_tokens: 96_000, supports_vision: false } }],
				});
			}
			throw new Error(`Unexpected URL: ${url}`);
		}) as FetchImpl;

		const models = await fetchLiteLLMRichModels({
			api: "openai-completions",
			provider: "litellm",
			baseUrl: "http://primary:4000/v1",
			fetch: fetchMock,
		});

		expect(calls).toEqual([
			"http://primary:4000/model_group/info",
			"http://primary:4000/v2/model/info",
			"http://primary:4000/model/info",
		]);
		expect(models?.[0]).toMatchObject({ id: "legacy-gpt", contextWindow: 96_000 });
	});

	test("drops reseller usage suffix from LiteLLM rich model names", async () => {
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = inputUrl(input);
			if (url === MODELS_DEV_URL) {
				return Response.json({});
			}
			if (url === "http://primary:4000/model_group/info") {
				return Response.json({
					data: [
						{
							model_group: "minimax-m3",
							model_name: "MiniMax M3 (3x usage)",
						},
					],
				});
			}
			throw new Error(`Unexpected URL: ${url}`);
		}) as FetchImpl;
		const options = litellmModelManagerOptions({
			baseUrl: "http://primary:4000/v1",
			fetch: fetchMock,
		});

		const models = await options.fetchDynamicModels?.();

		expect(models?.[0]).toMatchObject({
			id: "minimax-m3",
			name: "MiniMax M3",
			provider: "litellm",
			baseUrl: "http://primary:4000/v1",
		});
	});

	test("falls back to OpenAI models list when rich endpoints are unavailable", async () => {
		const authByUrl = new Map<string, string | undefined>();
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = inputUrl(input);
			const headers = init?.headers as Record<string, string> | undefined;
			if (url !== MODELS_DEV_URL) {
				authByUrl.set(url, headers?.Authorization);
			}
			if (url === MODELS_DEV_URL) {
				return Response.json({
					"ollama-cloud": {
						models: {
							"deepseek-v4-flash": {
								name: "DeepSeek V4 Flash",
								tool_call: true,
								limit: { context: 64_000, output: 8_000 },
							},
							"minimax-m3": {
								name: "MiniMax M3 (3x usage)",
								tool_call: true,
								limit: { context: 262_144, output: 8_192 },
							},
						},
					},
				});
			}
			if (url === "http://primary:4000/model_group/info") {
				return new Response("{}", { status: 404 });
			}
			if (url === "http://primary:4000/v2/model/info") {
				return new Response("{}", { status: 500 });
			}
			if (url === "http://primary:4000/model/info" || url === "http://primary:4000/v1/model/info") {
				return new Response("{}", { status: 404 });
			}
			if (url === "http://primary:4000/v1/models") {
				return Response.json({ data: [{ id: "deepseek-v4-flash" }, { id: "minimax-m3" }] });
			}
			throw new Error(`Unexpected URL: ${url}`);
		}) as FetchImpl;
		const options = litellmModelManagerOptions({
			apiKey: "sk-fallback",
			baseUrl: "http://primary:4000/v1",
			fetch: fetchMock,
		});
		const models = await options.fetchDynamicModels?.();

		expect(authByUrl.get("http://primary:4000/model_group/info")).toBe("Bearer sk-fallback");
		expect(authByUrl.get("http://primary:4000/v2/model/info")).toBe("Bearer sk-fallback");
		expect(authByUrl.get("http://primary:4000/v1/models")).toBe("Bearer sk-fallback");
		expect(models?.[0]).toMatchObject({
			id: "deepseek-v4-flash",
			name: "DeepSeek V4 Flash",
			contextWindow: 64_000,
			maxTokens: 8_000,
		});
		expect(models?.find(model => model.id === "minimax-m3")).toMatchObject({
			id: "minimax-m3",
			name: "MiniMax M3",
			contextWindow: 262_144,
			maxTokens: 8_192,
		});
	});

	test("enriches LiteLLM /v1/models fallback entries missing from stencil.so with bundled reasoning metadata", async () => {
		const calls: string[] = [];
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = inputUrl(input);
			calls.push(url);
			if (url === MODELS_DEV_URL) {
				return Response.json({});
			}
			if (
				url === "http://primary:4000/model_group/info" ||
				url === "http://primary:4000/v2/model/info" ||
				url === "http://primary:4000/model/info" ||
				url === "http://primary:4000/v1/model/info"
			) {
				return new Response("{}", { status: 404 });
			}
			if (url === "http://primary:4000/v1/models") {
				return Response.json({ data: [{ id: "glm-5.2" }] });
			}
			throw new Error(`Unexpected URL: ${url}`);
		}) as FetchImpl;
		const options = litellmModelManagerOptions({
			apiKey: "sk-fallback",
			baseUrl: "http://primary:4000/v1",
			fetch: fetchMock,
		});

		const models = await options.fetchDynamicModels?.();

		expect(calls).toContain("http://primary:4000/v1/models");
		expect(models).toHaveLength(1);
		expect(models?.[0]).toMatchObject({
			id: "glm-5.2",
			name: "GLM-5.2",
			api: "openai-completions",
			provider: "litellm",
			baseUrl: "http://primary:4000/v1",
			reasoning: true,
			thinking: {
				mode: "effort",
				efforts: ["minimal", "low", "medium", "high", "max"],
				effortMap: {
					minimal: "none",
				},
			},
		});
	});
});
