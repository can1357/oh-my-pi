import { describe, expect, test } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { trustedRouterModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

const COMPLETIONS_URL = "https://api.trustedrouter.com/v1/chat/completions";

function requestUrl(input: string | URL | Request): string {
	if (typeof input === "string") {
		return input;
	}
	if (input instanceof URL) {
		return input.toString();
	}
	return input.url;
}

describe("TrustedRouter inference request routing", () => {
	const DISABLEABLE_DEFAULT_ON = {
		mandatory: false,
		default_enabled: true,
		supported_efforts: ["max", "high", "low", "none"],
		default_effort: "high",
	};

	/** Minimal stop-only SSE response that records the request body it was sent. */
	function captureBody(): { body: () => Record<string, unknown>; fetch: FetchImpl } {
		let captured: Record<string, unknown> = {};
		const fetch: FetchImpl = async (_input: string | URL | Request, init?: RequestInit) => {
			captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
			const chunk = {
				id: "chatcmpl-tr-02",
				object: "chat.completion.chunk",
				created: 0,
				choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
			};
			return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		};
		return { body: () => captured, fetch };
	}

	/** Build a live model the way the runtime does: discovery, then `buildModel`. */
	async function discoverModel(
		reasoning: unknown = DISABLEABLE_DEFAULT_ON,
		options: {
			id?: string;
			name?: string;
			supportedParameters?: string[];
			capabilities?: Record<string, unknown>;
		} = {},
	): Promise<Model<"openai-completions">> {
		const id = options.id ?? "deepseek/deepseek-v4-flash-0731";
		const name = options.name ?? "DeepSeek: DeepSeek V4 Flash";
		const supportedParameters = options.supportedParameters ?? [
			"tools",
			"tool_choice",
			"max_tokens",
			"reasoning",
			"reasoning_effort",
			"include_reasoning",
		];
		const discoveryFetch: FetchImpl = async () =>
			new Response(
				JSON.stringify({
					data: [
						{
							id,
							name,
							context_length: 1_048_576,
							architecture: {
								modality: "text->text",
								input_modalities: ["text"],
								output_modalities: ["text"],
							},
							pricing: { prompt: "0.0000002", completion: "0.0000004", input_cache_read: "0.00000005" },
							top_provider: { context_length: 1_048_576, max_completion_tokens: 131_072 },
							supported_parameters: supportedParameters,
							...(reasoning !== undefined ? { reasoning } : {}),
							trustedrouter: {
								provider: "deepseek",
								configuration_hidden: false,
								synthetic_monitor: false,
								internal_only: false,
								supports_chat: true,
								...(options.capabilities ? { capabilities: options.capabilities } : {}),
							},
						},
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		const models = await trustedRouterModelManagerOptions({
			fetch: discoveryFetch,
		}).fetchDynamicModels?.();
		const spec = models?.[0];
		if (!spec) {
			throw new Error("discovery returned no TrustedRouter models");
		}
		return buildModel(spec) as Model<"openai-completions">;
	}

	test("streams OpenAI chat completions against TrustedRouter preserving full vendor/model ids", async () => {
		const model = await discoverModel();
		expect(model.api).toBe("openai-completions");

		let requestedUrl = "";
		let authorization = "";
		let body: Record<string, unknown> = {};
		const fetchMock: FetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
			requestedUrl = requestUrl(input);
			authorization = new Headers(init?.headers).get("Authorization") ?? "";
			body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			const chunks = [
				{
					id: "chatcmpl-tr-01",
					object: "chat.completion.chunk",
					created: 0,
					choices: [{ index: 0, delta: { role: "assistant", content: "Hello" } }],
				},
				{
					id: "chatcmpl-tr-01",
					object: "chat.completion.chunk",
					created: 0,
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					usage: { prompt_tokens: 15, completion_tokens: 8, total_tokens: 23 },
				},
			];
			const payload = `${chunks.map(chunk => `data: ${JSON.stringify(chunk)}`).join("\n\n")}\n\ndata: [DONE]\n\n`;
			return new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } });
		};

		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] };
		const result = await streamOpenAICompletions(model, context, {
			apiKey: "sk-tr-test",
			fetch: fetchMock,
		}).result();

		expect(requestedUrl).toBe(COMPLETIONS_URL);
		expect(authorization).toBe("Bearer sk-tr-test");
		expect(body.model).toBe("deepseek/deepseek-v4-flash-0731");
		expect(result.content).toEqual([{ type: "text", text: "Hello" }]);
		expect(result.stopReason).toBe("stop");
		expect(result.usage?.input).toBe(15);
		expect(result.usage?.output).toBe(8);
	});

	test("sends requested effort as top-level reasoning_effort for default-on models", async () => {
		const model = await discoverModel();
		const { body, fetch } = captureBody();
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] };

		await streamOpenAICompletions(model, context, {
			apiKey: "sk-tr-test",
			reasoning: Effort.High,
			fetch,
		}).result();

		expect(body().reasoning_effort).toBe("high");
		expect(body().reasoning).toBeUndefined();
	});

	test("switches reasoning off with reasoning: { enabled: false } when reasoning is disableable", async () => {
		const model = await discoverModel();
		const { body, fetch } = captureBody();
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] };

		await streamOpenAICompletions(model, context, { apiKey: "sk-tr-test", disableReasoning: true, fetch }).result();

		expect(body().reasoning).toEqual({ enabled: false });
		expect(body().reasoning_effort).toBeUndefined();
	});

	test("switches reasoning off for a disableable model with no effort dial", async () => {
		const model = await discoverModel({
			mandatory: false,
			default_enabled: true,
			supported_efforts: [],
			default_effort: null,
		});
		const { body, fetch } = captureBody();
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] };

		await streamOpenAICompletions(model, context, { apiKey: "sk-tr-test", disableReasoning: true, fetch }).result();

		expect(body().reasoning).toEqual({ enabled: false });
		expect(body().reasoning_effort).toBeUndefined();
	});

	test("clamps instead of switching off when reasoning is mandatory", async () => {
		const model = await discoverModel(
			{
				mandatory: true,
				default_enabled: false,
				supported_efforts: ["high", "medium", "low"],
				default_effort: "medium",
			},
			{ id: "google/gemini-3.1-pro-preview", name: "Google: Gemini 3.1 Pro Preview" },
		);
		const { body, fetch } = captureBody();
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] };

		await streamSimple(model, context, { apiKey: "sk-tr-test", disableReasoning: true, fetch }).result();

		expect(body().reasoning).toBeUndefined();
		expect(body().reasoning_effort).toBe("low");
	});

	test("switches off a disableable model whose id reads as reasoning-locked", async () => {
		const model = await discoverModel(
			{
				mandatory: false,
				default_enabled: true,
				supported_efforts: ["low", "high", "none"],
				default_effort: "high",
			},
			{ id: "qwen/qwen3-235b-a22b-thinking-2507", name: "Qwen3 235B A22B Thinking 2507" },
		);
		const { body, fetch } = captureBody();
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] };

		await streamSimple(model, context, { apiKey: "sk-tr-test", disableReasoning: true, fetch }).result();

		expect(body().reasoning).toEqual({ enabled: false });
		expect(body().reasoning_effort).toBeUndefined();
	});

	test("never sends identity-derived reasoning_effort when no effort ladder is published", async () => {
		const model = await discoverModel({
			mandatory: false,
			default_enabled: true,
			supported_efforts: [],
			default_effort: null,
		});
		const { body, fetch } = captureBody();
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] };

		await streamOpenAICompletions(model, context, {
			apiKey: "sk-tr-test",
			reasoning: Effort.High,
			fetch,
		}).result();

		expect(model.thinking).toBeDefined();
		expect(body().reasoning_effort).toBeUndefined();
		expect(body().reasoning).toBeUndefined();
	});

	test("explicitly enables a default-off model without an effort dial", async () => {
		const model = await discoverModel(
			{ mandatory: false, default_enabled: false, supported_efforts: [], default_effort: null },
			{ id: "qwen/qwen3-14b", name: "Qwen: Qwen3 14B" },
		);
		const { body, fetch } = captureBody();
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] };

		await streamOpenAICompletions(model, context, {
			apiKey: "sk-tr-test",
			reasoning: Effort.High,
			fetch,
		}).result();

		expect(body().reasoning).toEqual({ enabled: true });
		expect(body().reasoning_effort).toBeUndefined();
		expect(body().enable_thinking).toBeUndefined();
	});

	test("enables a default-off model while preserving its published effort", async () => {
		const model = await discoverModel(
			{
				mandatory: false,
				default_enabled: false,
				supported_efforts: ["max", "high", "medium", "low", "none"],
				default_effort: "medium",
			},
			{ id: "anthropic/claude-sonnet-4.6", name: "Anthropic: Claude Sonnet 4.6" },
		);
		const { body, fetch } = captureBody();
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] };

		await streamOpenAICompletions(model, context, {
			apiKey: "sk-tr-test",
			reasoning: Effort.High,
			fetch,
		}).result();

		expect(body().reasoning).toEqual({ enabled: true });
		expect(body().reasoning_effort).toBe("high");
	});

	test("clamps a mandatory-reasoning Qwen model instead of sending native enable_thinking", async () => {
		const model = await discoverModel(
			{ mandatory: true, default_enabled: false, supported_efforts: ["high"], default_effort: "high" },
			{ id: "qwen/qwen3.6-35b-a3b", name: "Qwen3.6 35B A3B" },
		);
		const { body, fetch } = captureBody();
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] };

		await streamSimple(model, context, { apiKey: "sk-tr-test", disableReasoning: true, fetch }).result();

		expect(body().enable_thinking).toBeUndefined();
		expect(body().reasoning).toBeUndefined();
		expect(body().reasoning_effort).toBe("high");
	});

	test("omits both disable and effort fields for mandatory reasoning without an effort dial", async () => {
		const model = await discoverModel(
			{ mandatory: true, default_enabled: false, supported_efforts: [], default_effort: null },
			{ id: "deepseek/deepseek-r1-0528", name: "DeepSeek: R1 0528" },
		);
		const { body, fetch } = captureBody();
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] };

		await streamOpenAICompletions(model, context, {
			apiKey: "sk-tr-test",
			disableReasoning: true,
			fetch,
		}).result();

		expect(body().reasoning).toBeUndefined();
		expect(body().reasoning_effort).toBeUndefined();
	});

	test("uses reasoning_effort: none to disable effort-only rows that do not advertise the reasoning object", async () => {
		const model = await discoverModel(undefined, {
			id: "google/gemini-2.5-flash-lite",
			name: "Google: Gemini 2.5 Flash Lite",
			supportedParameters: ["tools", "max_tokens", "reasoning_effort", "seed"],
			capabilities: { reasoning_effort: ["none", "minimal", "low", "medium", "high"], tools: true },
		});
		const { body, fetch } = captureBody();
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] };

		await streamOpenAICompletions(model, context, {
			apiKey: "sk-tr-test",
			disableReasoning: true,
			fetch,
		}).result();

		expect(body().reasoning_effort).toBe("none");
		expect(body().reasoning).toBeUndefined();
	});
});
