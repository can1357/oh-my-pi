import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context, FetchImpl, Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const testContext: Context = {
	messages: [{ role: "user", content: "hello", timestamp: 0 }],
};

function createSseResponse(events: unknown[]): Response {
	const payload = `${events.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`).join("\n\n")}\n\n`;
	return new Response(payload, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function createReasoningEffortModel(): Model<"openai-completions"> {
	return buildModel({
		id: "minimal-reasoner",
		name: "Minimal Reasoner",
		api: "openai-completions",
		provider: "custom",
		baseUrl: "https://proxy.example.com/v1",
		reasoning: true,
		thinking: {
			mode: "effort",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
		},
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	});
}

function createFireworksReasoningEffortModel(): Model<"openai-completions"> {
	const base = createReasoningEffortModel();
	return buildModel({
		...base,
		id: "glm-5.1",
		name: "GLM 5.1",
		provider: "fireworks",
		baseUrl: "https://api.fireworks.ai/inference/v1",
		compat: base.compatConfig,
	} as ModelSpec<"openai-completions">);
}

async function captureDisableReasoningPayload(model: Model<"openai-completions">): Promise<Record<string, unknown>> {
	let payload: Record<string, unknown> | undefined;
	const fetchMock: FetchImpl = Object.assign(
		async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			payload = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
			return createSseResponse([
				{
					id: "chatcmpl-disable-reasoning",
					object: "chat.completion.chunk",
					created: 0,
					model: model.id,
					choices: [{ index: 0, delta: { content: "ok" } }],
				},
				{
					id: "chatcmpl-disable-reasoning",
					object: "chat.completion.chunk",
					created: 0,
					model: model.id,
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				},
				"[DONE]",
			]);
		},
		{ preconnect: fetch.preconnect },
	);

	const result = await streamOpenAICompletions(model, testContext, {
		apiKey: "test-key",
		fetch: fetchMock,
		disableReasoning: true,
	}).result();

	expect(result.stopReason).toBe("stop");
	if (!payload) throw new Error("Expected OpenAI completions request payload");
	return payload;
}

describe("OpenAI completions disableReasoning and thinking dialects", () => {
	it("sends the lowest supported reasoning effort for generic effort-mode models", async () => {
		const payload = await captureDisableReasoningPayload(createReasoningEffortModel());

		expect(payload.reasoning_effort).toBe("minimal");
		expect(payload.reasoning).toBeUndefined();
	});

	it("maps Fireworks' lowest effort to the provider-supported none literal", async () => {
		const payload = await captureDisableReasoningPayload(createFireworksReasoningEffortModel());

		expect(payload.reasoning_effort).toBe("none");
		expect(payload.reasoning).toBeUndefined();
	});

	// Additional requested tests for applyChatCompletionsReasoningParams dialect / behavior verification
	it("sets OpenRouter thinking disabled when disableReasoning: true", async () => {
		const model = buildModel({
			id: "openrouter-reasoner",
			name: "OpenRouter Reasoner",
			api: "openai-completions",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			reasoning: true,
			compat: {
				thinkingFormat: "openrouter",
				supportsReasoningParams: true,
			},
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 16_384,
		});

		const payload = await captureDisableReasoningPayload(model);
		expect(payload.reasoning).toEqual({ enabled: false });
	});

	it("sets Qwen enable_thinking: true with reasoning enabled, and false with forced tool choice", async () => {
		const model = buildModel({
			id: "qwen-reasoner",
			name: "Qwen Reasoner",
			api: "openai-completions",
			provider: "custom",
			baseUrl: "https://proxy.example.com/v1",
			reasoning: true,
			compat: {
				thinkingFormat: "qwen",
				supportsReasoningParams: true,
				supportsToolChoice: true,
				supportsForcedToolChoice: true,
				disableReasoningOnForcedToolChoice: true,
			},
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 16_384,
		});

		// 1. Enabled check using stream call
		const { promise, resolve } = Promise.withResolvers<unknown>();
		streamOpenAICompletions(model, testContext, {
			apiKey: "test-key",
			fetch: createMockFetchForQwen(resolve),
			reasoning: "medium",
		});
		const payloadEnabled = (await promise) as Record<string, unknown>;
		expect(payloadEnabled.enable_thinking).toBe(true);

		// 2. Disabled on forced tool choice check
		const { promise: p2, resolve: r2 } = Promise.withResolvers<unknown>();
		streamOpenAICompletions(
			model,
			{
				messages: testContext.messages,
				tools: [
					{
						name: "read",
						description: "Read a file",
						parameters: { type: "object", properties: {} },
					},
				],
			},
			{
				apiKey: "test-key",
				fetch: createMockFetchForQwen(r2),
				reasoning: "medium",
				toolChoice: { type: "tool", name: "read" },
			},
		);
		const payloadDisabled = (await p2) as Record<string, unknown>;
		expect(payloadDisabled.enable_thinking).toBe(false);
	});

	it("sets Qwen chat-template thinking format properly", async () => {
		const model = buildModel({
			id: "qwen-ct-reasoner",
			name: "Qwen Chat Template Reasoner",
			api: "openai-completions",
			provider: "custom",
			baseUrl: "https://proxy.example.com/v1",
			reasoning: true,
			compat: {
				thinkingFormat: "qwen-chat-template",
				supportsReasoningParams: true,
			},
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 16_384,
		});

		const { promise, resolve } = Promise.withResolvers<unknown>();
		streamOpenAICompletions(model, testContext, {
			apiKey: "test-key",
			fetch: createMockFetchForQwen(resolve),
			reasoning: "medium",
		});
		const payload = (await promise) as Record<string, unknown>;
		expect(payload.chat_template_kwargs).toEqual({ enable_thinking: true });
	});
	it("does not emit enable_thinking or chat_template_kwargs for the bundled Fireworks Qwen model without reasoning", async () => {
		// Reproduces the raw 400 from `fireworks/qwen3.7-plus`: before the fix the
		// `qwen/*` id pattern forced `thinkingFormat: "qwen"`, so an effort-less
		// turn wrote top-level `enable_thinking: false`, which Fireworks' strict
		// schema rejects. Build from the real bundled entry so the dialect
		// classification — not a hardcoded compat override — is what's exercised.
		const model = getBundledModel<"openai-completions">("fireworks", "qwen3.7-plus");

		const { promise, resolve } = Promise.withResolvers<unknown>();
		streamOpenAICompletions(model, testContext, {
			apiKey: "test-key",
			fetch: createMockFetchForQwen(resolve),
			// no reasoning requested
		});
		const payload = (await promise) as Record<string, unknown>;
		expect(payload.enable_thinking).toBeUndefined();
		expect(payload.chat_template_kwargs).toBeUndefined();
	});

	it("sets Z.AI thinking format and toggles type logically based on forced tool choice", async () => {
		const model = buildModel({
			id: "zai-reasoner",
			name: "Z.AI Reasoner",
			api: "openai-completions",
			provider: "custom",
			baseUrl: "https://proxy.example.com/v1",
			reasoning: true,
			compat: {
				thinkingFormat: "zai",
				supportsReasoningParams: true,
				supportsToolChoice: true,
				supportsForcedToolChoice: true,
				disableReasoningOnForcedToolChoice: true,
			},
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 16_384,
		});

		const { promise, resolve } = Promise.withResolvers<unknown>();
		streamOpenAICompletions(model, testContext, {
			apiKey: "test-key",
			fetch: createMockFetchForQwen(resolve),
			reasoning: "medium",
		});
		const payloadEnabled = (await promise) as Record<string, unknown>;
		expect(payloadEnabled.thinking).toEqual({ type: "enabled" });

		const { promise: p2, resolve: r2 } = Promise.withResolvers<unknown>();
		streamOpenAICompletions(
			model,
			{
				messages: testContext.messages,
				tools: [
					{
						name: "read",
						description: "Read a file",
						parameters: { type: "object", properties: {} },
					},
				],
			},
			{
				apiKey: "test-key",
				fetch: createMockFetchForQwen(r2),
				reasoning: "medium",
				toolChoice: { type: "tool", name: "read" },
			},
		);
		const payloadDisabled = (await p2) as Record<string, unknown>;
		expect(payloadDisabled.thinking).toEqual({ type: "disabled" });
	});
});

function createMockFetchForQwen(resolve: (value: unknown) => void): FetchImpl {
	const fetchMock: FetchImpl = Object.assign(
		async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const payload = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
			resolve(payload);
			return createSseResponse([
				{
					id: "chatcmpl",
					object: "chat.completion.chunk",
					created: 0,
					model: "model",
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				},
				"[DONE]",
			]);
		},
		{ preconnect: fetch.preconnect },
	);
	return fetchMock;
}
