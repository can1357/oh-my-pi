import { describe, expect, test } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { arkaneCloudModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

const COMPLETIONS_URL = "https://console.arkanecloud.com/api/v2/chat/completions";

function requestUrl(input: string | URL | Request): string {
	if (typeof input === "string") {
		return input;
	}
	if (input instanceof URL) {
		return input.toString();
	}
	return input.url;
}

describe("ArkaneCloud inference request routing", () => {
	const DISABLEABLE_REASONING = { can_disable: true, enabled_by_default: true, supported_efforts: ["high", "xhigh"] };

	/** Minimal stop-only SSE response that records the request body it was sent. */
	function captureBody(): { body: () => Record<string, unknown>; fetch: FetchImpl } {
		let captured: Record<string, unknown> = {};
		const fetch: FetchImpl = async (_input: string | URL | Request, init?: RequestInit) => {
			captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
			const chunk = {
				id: "chatcmpl-02",
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
		reasoning: unknown = DISABLEABLE_REASONING,
		identity: { id: string; name: string } = {
			id: "deepseek-ai/DeepSeek-V4-Flash",
			name: "DeepSeek-V4-Flash",
		},
	): Promise<Model<"openai-completions">> {
		const discoveryFetch: FetchImpl = async () =>
			new Response(
				JSON.stringify({
					object: "list",
					data: [
						{
							id: identity.id,
							object: "model",
							owned_by: "arkanecloud",
							name: identity.name,
							type: "text",
							pricing: { input: 0.2, output: 0.4, cache_read: 0.05, unit: "per million tokens" },
							endpoint: "/api/v2/chat/completions",
							context_length: 1_048_576,
							max_input_tokens: 655_360,
							max_output_tokens: 393_216,
							input_modalities: ["text"],
							reasoning,
							capabilities: { tool_calling: true, image_input: false },
						},
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		const models = await arkaneCloudModelManagerOptions({
			apiKey: "ak_test",
			fetch: discoveryFetch,
		}).fetchDynamicModels?.();
		const spec = models?.[0];
		if (!spec) {
			throw new Error("discovery returned no ArkaneCloud models");
		}
		return buildModel(spec) as Model<"openai-completions">;
	}

	test("streams OpenAI chat completions against the ArkaneCloud base with a bearer token", async () => {
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
					id: "chatcmpl-01",
					object: "chat.completion.chunk",
					created: 0,
					choices: [{ index: 0, delta: { role: "assistant", content: "Hello" } }],
				},
				{
					id: "chatcmpl-01",
					object: "chat.completion.chunk",
					created: 0,
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					usage: { prompt_tokens: 12, completion_tokens: 9, total_tokens: 21 },
				},
			];
			const payload = `${chunks.map(chunk => `data: ${JSON.stringify(chunk)}`).join("\n\n")}\n\ndata: [DONE]\n\n`;
			return new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } });
		};

		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] };
		const result = await streamOpenAICompletions(model, context, {
			apiKey: "ak_test",
			fetch: fetchMock,
		}).result();

		expect(requestedUrl).toBe(COMPLETIONS_URL);
		expect(authorization).toBe("Bearer ak_test");
		expect(body.model).toBe("deepseek-ai/DeepSeek-V4-Flash");
		expect(result.content).toEqual([{ type: "text", text: "Hello" }]);
		expect(result.stopReason).toBe("stop");
		// The endpoint reports OpenAI-shaped usage, so token accounting works.
		expect(result.usage?.input).toBe(12);
		expect(result.usage?.output).toBe(9);
	});

	test("sends a requested effort as reasoning_effort, never as a reasoning object", async () => {
		// The most common shape in production: reasons by default, publishes a
		// ladder, and could be switched off. Intensity rides the documented
		// `reasoning_effort` field.
		const model = await discoverModel();
		const { body, fetch } = captureBody();
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] };

		await streamOpenAICompletions(model, context, {
			apiKey: "ak_test",
			reasoning: Effort.High,
			fetch,
		}).result();

		expect(body().reasoning_effort).toBe("high");
		expect(body().reasoning).toBeUndefined();
	});

	test("switches reasoning off with the documented reasoning.enabled flag", async () => {
		const model = await discoverModel();
		const { body, fetch } = captureBody();
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] };

		await streamOpenAICompletions(model, context, { apiKey: "ak_test", disableReasoning: true, fetch }).result();

		// `can_disable: true`, so thinking-off sends the switch ArkaneCloud
		// documents instead of the `openai` dialect's default of clamping to the
		// lowest effort — which leaves the model reasoning, and billing for it.
		expect(body().reasoning).toEqual({ enabled: false });
		expect(body().reasoning_effort).toBeUndefined();
	});

	test("switches reasoning off for a disableable model with no effort dial", async () => {
		const model = await discoverModel({ can_disable: true, enabled_by_default: true, supported_efforts: [] });
		const { body, fetch } = captureBody();
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] };

		await streamOpenAICompletions(model, context, { apiKey: "ak_test", disableReasoning: true, fetch }).result();

		// There is no ladder to clamp to here, so the request would otherwise carry
		// nothing at all and the model would go on reasoning.
		expect(body().reasoning).toEqual({ enabled: false });
		expect(body().reasoning_effort).toBeUndefined();
	});

	test("clamps instead of switching off when reasoning is mandatory", async () => {
		// `can_disable: false` must never produce the switch — there is nothing to
		// switch off. An id outside every known family keeps the published ladder,
		// so the clamp target is ArkaneCloud's own lowest advertised effort.
		const model = await discoverModel(
			{ can_disable: false, enabled_by_default: true, supported_efforts: ["high"] },
			{ id: "arkane/mandatory-reasoner", name: "Mandatory Reasoner" },
		);
		const { body, fetch } = captureBody();
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] };

		await streamOpenAICompletions(model, context, { apiKey: "ak_test", disableReasoning: true, fetch }).result();

		expect(body().reasoning).toBeUndefined();
		expect(body().reasoning_effort).toBe("high");
	});

	test("omits identity-derived efforts for a model without an effort dial", async () => {
		const model = await discoverModel({ can_disable: true, enabled_by_default: true, supported_efforts: [] });
		const { body, fetch } = captureBody();
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] };

		await streamOpenAICompletions(model, context, {
			apiKey: "ak_test",
			reasoning: Effort.High,
			fetch,
		}).result();

		// buildModel still derives a UI thinking surface, but ArkaneCloud publishes
		// no accepted reasoning_effort values for this model. It already reasons by
		// default, so there is nothing to send.
		expect(model.thinking).toBeDefined();
		expect(body().reasoning_effort).toBeUndefined();
		expect(body().reasoning).toBeUndefined();
	});

	test("explicitly enables a default-off model without an effort dial", async () => {
		const model = await discoverModel({ can_disable: true, enabled_by_default: false, supported_efforts: [] });
		const { body, fetch } = captureBody();
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] };

		await streamOpenAICompletions(model, context, {
			apiKey: "ak_test",
			reasoning: Effort.High,
			fetch,
		}).result();

		expect(body().reasoning).toEqual({ enabled: true });
		expect(body().reasoning_effort).toBeUndefined();
	});

	test("enables a default-off model while preserving its published effort", async () => {
		const model = await discoverModel(
			{ can_disable: true, enabled_by_default: false, supported_efforts: ["high"] },
			{ id: "Qwen/Qwen3.6-35B-A3B", name: "Qwen3.6 35B A3B" },
		);
		const { body, fetch } = captureBody();
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] };

		await streamOpenAICompletions(model, context, {
			apiKey: "ak_test",
			reasoning: Effort.High,
			fetch,
		}).result();

		expect(body().reasoning).toEqual({ enabled: true });
		expect(body().reasoning_effort).toBe("high");
		expect(body().enable_thinking).toBeUndefined();
	});

	test("omits both disable and effort fields for mandatory reasoning without an effort dial", async () => {
		const model = await discoverModel({ can_disable: false, enabled_by_default: true, supported_efforts: [] });
		const { body, fetch } = captureBody();
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] };

		await streamOpenAICompletions(model, context, {
			apiKey: "ak_test",
			disableReasoning: true,
			fetch,
		}).result();

		expect(body().reasoning).toBeUndefined();
		expect(body().reasoning_effort).toBeUndefined();
	});
});
