import { afterEach, describe, expect, test, vi } from "bun:test";
import { fetchLiteLLMRichModels, litellmModelManagerOptions } from "@pk-nerdsaver-ai/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@pk-nerdsaver-ai/pi-catalog/types";

const ORIGINAL_LITELLM_BASE_URL = Bun.env.LITELLM_BASE_URL;
const MODELS_DEV_URL = "https://models.dev/api.json";

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
			`litellm:rich-v1:${Bun.hash("http://litellm.example:4100/v1").toString(36)}`,
		);
		expect(fetchMock).toHaveBeenCalledTimes(6);
		expect(models).toHaveLength(1);
		expect(models?.[0]).toMatchObject({
			id: "openai/gpt-5",
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
			`litellm:rich-v1:${Bun.hash("http://litellm-config.example:4200/v1/").toString(36)}`,
		);
		expect(fetchMock).toHaveBeenCalledTimes(6);
		expect(models).toHaveLength(1);
		expect(models?.[0]?.baseUrl).toBe("http://litellm-config.example:4200/v1");
	});

	test("keeps LiteLLM transport when models.dev has a colliding provider model id", async () => {
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

	test("uses LiteLLM tool support metadata when rich endpoints succeed", async () => {
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = inputUrl(input);
			if (url === MODELS_DEV_URL) {
				return Response.json({});
			}
			if (url === "http://primary:4000/model_group/info") {
				return Response.json({
					data: [
						{ model_group: "no-tools", supports_function_calling: false },
						{ model_group: "params-tools", supported_openai_params: ["tools"] },
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

	test("falls back from v2 model info to LiteLLM model info", async () => {
		const calls: string[] = [];
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = inputUrl(input);
			calls.push(url);
			if (url === "http://primary:4000/model_group/info" || url === "http://primary:4000/v2/model/info") {
				return new Response("{}", { status: 404 });
			}
			if (url === "http://primary:4000/model/info") {
				return Response.json({ data: [{ model_name: "legacy-gpt", model_info: { max_input_tokens: 96_000 } }] });
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
				return Response.json({ data: [{ id: "deepseek-v4-flash" }] });
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
	});
});
