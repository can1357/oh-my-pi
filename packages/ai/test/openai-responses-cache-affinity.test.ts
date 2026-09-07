import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	type AzureOpenAIResponsesOptions,
	streamAzureOpenAIResponses,
} from "@oh-my-pi/pi-ai/providers/azure-openai-responses";
import {
	buildParams,
	type OpenAIResponsesOptions,
	streamOpenAIResponses,
} from "@oh-my-pi/pi-ai/providers/openai-responses";
import { stream as streamModel, streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, FetchImpl, Model, ProviderSessionState, SimpleStreamOptions } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { resolveModelPolicy } from "@oh-my-pi/pi-catalog/compat/resolve";
import { classifyModel } from "@oh-my-pi/pi-catalog/compat/taxonomy";

import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { withEnv } from "./helpers";

interface ResponsesCompatTestSpec {
	id?: string;
	name: string;
	provider: string;
	baseUrl: string;
	reasoning?: boolean;
}

function buildOpenAIResponsesCompat(spec: ResponsesCompatTestSpec) {
	return resolveModelPolicy({
		id: spec.id ?? "test-model",
		api: "openai-responses",
		provider: spec.provider,
		baseUrl: spec.baseUrl,
		name: spec.name,
		reasoning: spec.reasoning ?? false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	}).compat;
}

const model = getBundledModel("openai", "gpt-5-mini") as Model<"openai-responses">;
const openRouterResponsesModel: Model<"openai-responses"> = {
	...model,
	id: "openai/gpt-5.5",
	identity: classifyModel("openrouter", "openai/gpt-5.5"),
	name: "OpenRouter GPT 5.5",
	provider: "openrouter",
	baseUrl: "https://openrouter.ai/api/v1",
	compat: buildOpenAIResponsesCompat({
		id: "openai/gpt-5.5",
		name: "OpenRouter GPT 5.5",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
	}),
};
const openRouterAnthropicResponsesModel: Model<"openai-responses"> = {
	...model,
	id: "anthropic/claude-sonnet-4.5",
	identity: classifyModel("openrouter", "anthropic/claude-sonnet-4.5"),
	name: "OpenRouter Claude Sonnet 4.5",
	provider: "openrouter",
	baseUrl: "https://openrouter.ai/api/v1",
	compat: buildOpenAIResponsesCompat({
		id: "anthropic/claude-sonnet-4.5",
		name: "OpenRouter Claude Sonnet 4.5",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
	}),
};
const xaiOAuthResponsesModel: Model<"openai-responses"> = {
	...model,
	id: "grok-build",
	identity: classifyModel("xai-oauth", "grok-build"),
	name: "Grok Build",
	provider: "xai-oauth",
	baseUrl: "https://api.x.ai/v1",
	compat: buildOpenAIResponsesCompat({
		id: "grok-build",
		name: "Grok Build",
		provider: "xai-oauth",
		baseUrl: "https://api.x.ai/v1",
		reasoning: true,
	}),
};
const xaiApiKeyResponsesModel: Model<"openai-responses"> = {
	...model,
	id: "grok-code-fast-1",
	identity: classifyModel("xai", "grok-code-fast-1"),
	name: "Grok Code Fast 1",
	provider: "xai",
	baseUrl: "https://api.x.ai/v1",
	compat: buildOpenAIResponsesCompat({
		id: "grok-code-fast-1",
		name: "Grok Code Fast 1",
		provider: "xai",
		baseUrl: "https://api.x.ai/v1",
		reasoning: true,
	}),
};

const openAI56ResponsesModel: Model<"openai-responses"> = {
	...model,
	id: "gpt-5.6",
	identity: classifyModel("openai", "gpt-5.6"),
	name: "GPT-5.6",
	compat: buildOpenAIResponsesCompat({
		id: "gpt-5.6",
		name: "GPT-5.6",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
	}),
};

const azureOpenAI56ResponsesModel: Model<"azure-openai-responses"> = buildModel({
	id: "gpt-5.6",
	name: "GPT-5.6",
	api: "azure-openai-responses",
	provider: "azure",
	baseUrl: "https://example.openai.azure.com/openai/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400_000,
	maxTokens: 128_000,
});

function createSseResponse(events: unknown[]): Response {
	const payload = `${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
	return new Response(payload, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function getHeader(headers: RequestInit["headers"], name: string): string | null {
	return new Headers(headers).get(name);
}

async function captureOpenAIResponseHeaders(
	options: OpenAIResponsesOptions,
	requestModel: Model<"openai-responses"> = model,
): Promise<{
	sessionId: string | null;
	clientRequestId: string | null;
	headers: Headers;
	body: Record<string, unknown> | null;
}> {
	const captured = {
		sessionId: null as string | null,
		clientRequestId: null as string | null,
		headers: new Headers(),
		body: null as Record<string, unknown> | null,
	};
	const fetchMock: FetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
		captured.sessionId = getHeader(init?.headers, "session_id");
		captured.clientRequestId = getHeader(init?.headers, "x-client-request-id");
		captured.headers = new Headers(init?.headers);
		captured.body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
		return createSseResponse([
			{
				type: "response.output_item.added",
				item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
			},
			{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
			{ type: "response.output_text.delta", delta: "Hello" },
			{
				type: "response.output_item.done",
				item: {
					type: "message",
					id: "msg_1",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Hello" }],
				},
			},
			{
				type: "response.completed",
				response: {
					status: "completed",
					usage: {
						input_tokens: 5,
						output_tokens: 3,
						total_tokens: 8,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			},
		]);
	});

	const context: Context = {
		systemPrompt: ["stable system", "stable durable context"],
		messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
	};
	const stream = streamOpenAIResponses(requestModel, context, { apiKey: "test-key", ...options, fetch: fetchMock });

	for await (const event of stream) {
		if (event.type === "done" || event.type === "error") break;
	}

	return captured;
}

async function captureDispatchedOpenAIResponseHeaders(
	options: OpenAIResponsesOptions,
	requestModel: Model<"openai-responses">,
): Promise<{
	sessionId: string | null;
	clientRequestId: string | null;
	headers: Headers;
	body: Record<string, unknown> | null;
}> {
	const captured = {
		sessionId: null as string | null,
		clientRequestId: null as string | null,
		headers: new Headers(),
		body: null as Record<string, unknown> | null,
	};
	const fetchMock: FetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
		captured.sessionId = getHeader(init?.headers, "session_id");
		captured.clientRequestId = getHeader(init?.headers, "x-client-request-id");
		captured.headers = new Headers(init?.headers);
		captured.body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
		return createSseResponse([
			{
				type: "response.output_item.added",
				item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
			},
			{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
			{ type: "response.output_text.delta", delta: "Hello" },
			{
				type: "response.output_item.done",
				item: {
					type: "message",
					id: "msg_1",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Hello" }],
				},
			},
			{
				type: "response.completed",
				response: {
					status: "completed",
					usage: {
						input_tokens: 5,
						output_tokens: 3,
						total_tokens: 8,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			},
		]);
	});

	const context: Context = {
		systemPrompt: ["stable system", "stable durable context"],
		messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
	};
	const stream = streamModel(requestModel, context, { apiKey: "test-key", ...options, fetch: fetchMock });

	for await (const event of stream) {
		if (event.type === "done" || event.type === "error") break;
	}

	return captured;
}

async function captureSimpleOpenAIResponseBody(
	options: SimpleStreamOptions,
	requestModel: Model<"openai-responses"> = model,
	requestContext: Context = {
		systemPrompt: ["stable system", "stable durable context"],
		messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
	},
): Promise<Record<string, unknown> | null> {
	let body: Record<string, unknown> | null = null;
	const fetchMock: FetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
		body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
		return createSseResponse([
			{
				type: "response.output_item.added",
				item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
			},
			{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
			{ type: "response.output_text.delta", delta: "Hello" },
			{
				type: "response.output_item.done",
				item: {
					type: "message",
					id: "msg_1",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Hello" }],
				},
			},
			{
				type: "response.completed",
				response: {
					status: "completed",
					usage: {
						input_tokens: 5,
						output_tokens: 3,
						total_tokens: 8,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			},
		]);
	});

	const stream = streamSimple(requestModel, requestContext, { apiKey: "test-key", ...options, fetch: fetchMock });
	for await (const event of stream) {
		if (event.type === "done" || event.type === "error") break;
	}

	return body;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("OpenAI Responses explicit prompt cache policy", () => {
	const historicalContext: Context = {
		messages: [
			{ role: "user", content: [{ type: "text", text: "stable history" }], timestamp: 0 },
			{ role: "user", content: [{ type: "text", text: "current prompt" }], timestamp: 1 },
		],
	};

	it("leaves the existing request shape unchanged when the policy is unset", () => {
		const params = buildParams(
			openAI56ResponsesModel,
			historicalContext,
			{ sessionId: "cache-key" },
			undefined,
		).params;

		expect(params.prompt_cache_key).toBe("cache-key");
		expect(params).not.toHaveProperty("prompt_cache_options");
		const [firstMessage] = params.input ?? [];
		if (!firstMessage || !("content" in firstMessage) || !Array.isArray(firstMessage.content)) {
			throw new Error("Expected Responses input message content");
		}
		expect(firstMessage.content[0]).not.toHaveProperty("prompt_cache_breakpoint");
	});

	it("marks one existing stable history block and leaves the current prompt unmodified", () => {
		const params = buildParams(
			openAI56ResponsesModel,
			historicalContext,
			{ sessionId: "cache-key", promptCache: { mode: "explicit" } },
			undefined,
		).params;

		expect(params.prompt_cache_options).toEqual({ mode: "explicit", ttl: "30m" });
		const [historical, current] = params.input ?? [];
		if (
			!historical ||
			!current ||
			!("content" in historical) ||
			!Array.isArray(historical.content) ||
			!("content" in current) ||
			!Array.isArray(current.content)
		) {
			throw new Error("Expected Responses input message content");
		}
		expect(historical.content[0]).toMatchObject({ prompt_cache_breakpoint: { mode: "explicit" } });
		expect(current.content[0]).not.toHaveProperty("prompt_cache_breakpoint");
		expect(historicalContext.messages[0].content).toEqual([{ type: "text", text: "stable history" }]);
	});

	it("leaves boundary selection automatic in implicit mode", () => {
		const params = buildParams(
			openAI56ResponsesModel,
			historicalContext,
			{ sessionId: "cache-key", promptCache: { mode: "implicit" } },
			undefined,
		).params;

		expect(params.prompt_cache_options).toEqual({ mode: "implicit", ttl: "30m" });
		expect(JSON.stringify(params.input)).not.toContain("prompt_cache_breakpoint");
	});

	it("marks the latest eligible stable history block", () => {
		const params = buildParams(
			openAI56ResponsesModel,
			{
				messages: [
					{ role: "user", content: [{ type: "text", text: "oldest stable history" }], timestamp: 0 },
					{ role: "user", content: [{ type: "text", text: "newer stable history" }], timestamp: 1 },
					{ role: "user", content: [{ type: "text", text: "current prompt" }], timestamp: 2 },
				],
			},
			{ sessionId: "cache-key", promptCache: { mode: "explicit" } },
			undefined,
		).params;

		expect(params.input).toEqual([
			{ role: "user", content: [{ type: "input_text", text: "oldest stable history" }] },
			{
				role: "user",
				content: [
					{
						type: "input_text",
						text: "newer stable history",
						prompt_cache_breakpoint: { mode: "explicit" },
					},
				],
			},
			{ role: "user", content: [{ type: "input_text", text: "current prompt" }] },
		]);
	});

	it("marks an existing first-turn developer string without adding a message or changing its text", () => {
		const firstTurnWithSystem: Context = {
			systemPrompt: ["stable developer instruction"],
			messages: [{ role: "user", content: [{ type: "text", text: "only prompt" }], timestamp: 0 }],
		};
		const params = buildParams(
			openAI56ResponsesModel,
			firstTurnWithSystem,
			{ promptCache: { mode: "explicit" } },
			undefined,
		).params;

		expect(params.input).toEqual([
			{
				role: "developer",
				content: [
					{
						type: "input_text",
						text: "stable developer instruction",
						prompt_cache_breakpoint: { mode: "explicit" },
					},
				],
			},
			{ role: "user", content: [{ type: "input_text", text: "only prompt" }] },
		]);
	});

	it("routes explicit policy through streamSimple", async () => {
		const body = await captureSimpleOpenAIResponseBody(
			{ sessionId: "cache-key", promptCache: { mode: "explicit" } },
			openAI56ResponsesModel,
			historicalContext,
		);

		expect(body?.prompt_cache_key).toBe("cache-key");
		expect(body?.prompt_cache_options).toEqual({ mode: "explicit", ttl: "30m" });
		const input = body?.input;
		if (!Array.isArray(input)) throw new Error("Expected Responses input");
		expect(input[0]).toMatchObject({
			content: [{ type: "input_text", text: "stable history", prompt_cache_breakpoint: { mode: "explicit" } }],
		});
	});

	it("does not manufacture a breakpoint on a first-turn prompt or when the caller opts out", () => {
		const firstTurn: Context = {
			messages: [{ role: "user", content: [{ type: "text", text: "only prompt" }], timestamp: 0 }],
		};
		const firstTurnParams = buildParams(
			openAI56ResponsesModel,
			firstTurn,
			{ promptCache: { mode: "explicit" } },
			undefined,
		).params;
		const noBreakpointParams = buildParams(
			openAI56ResponsesModel,
			historicalContext,
			{ promptCache: { mode: "explicit", breakpoint: "none" } },
			undefined,
		).params;

		for (const params of [firstTurnParams, noBreakpointParams]) {
			for (const item of params.input ?? []) {
				if (!("content" in item) || !Array.isArray(item.content)) continue;
				for (const block of item.content) {
					expect(block).not.toHaveProperty("prompt_cache_breakpoint");
				}
			}
		}
	});

	it("rejects explicit policy through streamSimple before sending unsupported Responses requests", () => {
		const unsupportedModel: Model<"openai-responses"> = {
			...openAI56ResponsesModel,
			id: "gpt-5.5",
			identity: classifyModel("openai", "gpt-5.5"),
			compat: buildOpenAIResponsesCompat({
				id: "gpt-5.5",
				name: "GPT-5.5",
				provider: "openai",
				baseUrl: "https://api.openai.com/v1",
			}),
		};
		const fetchMock: FetchImpl = vi.fn(async () => {
			throw new Error("Unsupported Responses requests must not reach fetch");
		});
		const context: Context = {
			messages: [{ role: "user", content: [{ type: "text", text: "prompt" }], timestamp: 0 }],
		};
		const options: SimpleStreamOptions = {
			apiKey: "test-key",
			promptCache: { mode: "explicit" },
			fetch: fetchMock,
		};

		expect(() => streamSimple(unsupportedModel, context, options)).toThrow(
			"OpenAI explicit prompt caching is unsupported",
		);
		expect(() => streamSimple(azureOpenAI56ResponsesModel, context, options)).toThrow(
			"OpenAI explicit prompt caching is unsupported",
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("rejects explicit policy through typed and direct Azure Responses dispatch", () => {
		const fetchMock: FetchImpl = vi.fn(async () => {
			throw new Error("Unsupported Azure Responses requests must not reach fetch");
		});
		const context: Context = {
			messages: [{ role: "user", content: [{ type: "text", text: "prompt" }], timestamp: 0 }],
		};
		const options: AzureOpenAIResponsesOptions = {
			apiKey: "test-key",
			promptCache: { mode: "explicit" },
			fetch: fetchMock,
		};

		expect(() => streamModel(azureOpenAI56ResponsesModel, context, options)).toThrow(
			"OpenAI explicit prompt caching is unsupported",
		);
		expect(() => streamAzureOpenAIResponses(azureOpenAI56ResponsesModel, context, options)).toThrow(
			"OpenAI explicit prompt caching is unsupported",
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("defers explicit policy validation to the gateway-resolved model for pi-native transport", async () => {
		const sidecarModel: Model<"openai-responses"> = {
			...openAI56ResponsesModel,
			id: "gateway-model",
			identity: classifyModel("openai", "gateway-model"),
			baseUrl: "http://gateway.internal",
			transport: "pi-native",
			compat: buildOpenAIResponsesCompat({
				id: "gpt-5.5",
				name: "Gateway model",
				provider: "openai",
				baseUrl: "https://api.openai.com/v1",
			}),
		};
		const fetchMock: FetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as { options?: SimpleStreamOptions };
			expect(body.options?.promptCache).toEqual({ mode: "explicit" });
			return new Response(
				`data: ${JSON.stringify({
					type: "done",
					reason: "stop",
					message: {
						role: "assistant",
						content: [],
						api: "openai-responses",
						provider: "openai",
						model: "gpt-5.6",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: 0,
					},
				})}\n\ndata: [DONE]\n\n`,
				{ headers: { "content-type": "text/event-stream" } },
			);
		}) as FetchImpl;
		const result = await streamSimple(
			sidecarModel,
			{ messages: [{ role: "user", content: "prompt", timestamp: 0 }] },
			{ apiKey: "gateway-token", promptCache: { mode: "explicit" }, fetch: fetchMock },
		).result();

		expect(result.stopReason).toBe("stop");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("treats cacheRetention none as a disabled no-op before public policy validation", async () => {
		const unsupportedModel: Model<"openai-responses"> = {
			...openAI56ResponsesModel,
			id: "gpt-5.5",
			identity: classifyModel("openai", "gpt-5.5"),
			compat: buildOpenAIResponsesCompat({
				id: "gpt-5.5",
				name: "GPT-5.5",
				provider: "openai",
				baseUrl: "https://api.openai.com/v1",
			}),
		};

		const body = await captureSimpleOpenAIResponseBody(
			{ cacheRetention: "none", promptCache: { mode: "explicit" } },
			unsupportedModel,
		);

		if (body === null) throw new Error("Expected disabled prompt-cache request to reach the provider");
		expect(body).not.toHaveProperty("prompt_cache_options");
		const input = body.input;
		if (!Array.isArray(input)) throw new Error("Expected Responses input");
		const contentBlocks = input.flatMap(item => {
			if (typeof item !== "object" || item === null || !("content" in item) || !Array.isArray(item.content)) {
				return [];
			}
			return item.content;
		});
		expect(contentBlocks.length).toBeGreaterThan(0);
		for (const block of contentBlocks) {
			expect(block).not.toHaveProperty("prompt_cache_breakpoint");
		}
	});

	it("honors cache retention environment overrides before public explicit policy validation", async () => {
		const unsupportedModel: Model<"openai-responses"> = {
			...openAI56ResponsesModel,
			id: "gpt-5.5",
			identity: classifyModel("openai", "gpt-5.5"),
			compat: buildOpenAIResponsesCompat({
				id: "gpt-5.5",
				name: "GPT-5.5",
				provider: "openai",
				baseUrl: "https://api.openai.com/v1",
			}),
		};

		await withEnv({ PI_CACHE_RETENTION: "none" }, async () => {
			const body = await captureSimpleOpenAIResponseBody({ promptCache: { mode: "explicit" } }, unsupportedModel);

			if (body === null) throw new Error("Expected disabled prompt-cache request to reach the provider");
			expect(body).not.toHaveProperty("prompt_cache_options");
		});

		for (const retention of ["short", "long"] as const) {
			await withEnv({ PI_CACHE_RETENTION: retention }, () => {
				expect(() =>
					streamSimple(
						unsupportedModel,
						{ messages: [{ role: "user", content: [{ type: "text", text: "prompt" }], timestamp: 0 }] },
						{ apiKey: "test-key", promptCache: { mode: "explicit" } },
					),
				).toThrow("OpenAI explicit prompt caching is unsupported");
			});
		}
	});
});

describe("openai-responses cache affinity", () => {
	it("sets session routing headers for official OpenAI Responses requests with a sessionId", async () => {
		const captured = await captureOpenAIResponseHeaders({ sessionId: "session-123" });

		expect(captured.sessionId).toBe("session-123");
		expect(captured.clientRequestId).toBe("session-123");
		expect(captured.body?.prompt_cache_key).toBe("session-123");
	});

	it("forwards textVerbosity through streamSimple to official OpenAI Responses text config", async () => {
		const body = await captureSimpleOpenAIResponseBody({ textVerbosity: "low" });

		expect(body?.text).toEqual({ verbosity: "low" });
	});
	it("keeps prompt cache key separate from OpenAI routing headers when both are provided", async () => {
		const captured = await captureOpenAIResponseHeaders({
			sessionId: "side-channel-456",
			promptCacheKey: "session-123",
		});

		expect(captured.sessionId).toBe("side-channel-456");
		expect(captured.clientRequestId).toBe("side-channel-456");
		expect(captured.body?.prompt_cache_key).toBe("session-123");
	});

	it("xAI OAuth adapter request shaping does not mutate reused options", async () => {
		const options: OpenAIResponsesOptions = {
			sessionId: "session-123",
			headers: { existing: "header" },
			extraBody: { existing: true },
		};

		const first = await captureDispatchedOpenAIResponseHeaders(options, xaiOAuthResponsesModel);
		const second = await captureDispatchedOpenAIResponseHeaders(options, xaiOAuthResponsesModel);

		expect(options).toEqual({
			sessionId: "session-123",
			headers: { existing: "header" },
			extraBody: { existing: true },
		});
		for (const captured of [first, second]) {
			expect(getHeader(captured.headers, "x-grok-conv-id")).toBe("session-123");
			expect(captured.body?.prompt_cache_key).toBe("session-123");
			expect(captured.body?.existing).toBe(true);
			expect(captured.body?.reasoning).toBeUndefined();
		}
	});

	it("sets x-grok-conv-id cache affinity for paid xai Responses requests", async () => {
		const captured = await captureDispatchedOpenAIResponseHeaders(
			{ sessionId: "session-fallback" },
			xaiApiKeyResponsesModel,
		);

		expect(getHeader(captured.headers, "x-grok-conv-id")).toBe("session-fallback");
		expect(captured.body?.prompt_cache_key).toBe("session-fallback");
	});

	it("sets OpenRouter Responses session_id from sessionId in the body", async () => {
		const captured = await captureOpenAIResponseHeaders(
			{ sessionId: "workflow-123", promptCacheKey: "cache-key-123" },
			openRouterResponsesModel,
		);

		expect(captured.sessionId).toBeNull();
		expect(captured.clientRequestId).toBeNull();
		expect(captured.body?.session_id).toBe("workflow-123");
		expect(captured.body?.prompt_cache_key).toBe("cache-key-123");
	});
	it("sets Anthropic cache control for OpenRouter Anthropic Responses requests", async () => {
		const captured = await captureOpenAIResponseHeaders(
			{ sessionId: "workflow-123" },
			openRouterAnthropicResponsesModel,
		);

		expect(captured.body?.cache_control).toEqual({ type: "ephemeral" });
	});

	it("upgrades to 1h ttl when cacheRetention is long for OpenRouter Anthropic Responses requests", async () => {
		const captured = await captureOpenAIResponseHeaders(
			{ sessionId: "workflow-123", cacheRetention: "long" },
			openRouterAnthropicResponsesModel,
		);

		expect(captured.body?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
	});

	it("lets explicit headers override OpenRouter Responses defaults", async () => {
		const captured = await captureOpenAIResponseHeaders(
			{
				headers: {
					"HTTP-Referer": "https://example.test/",
					"X-OpenRouter-Title": "Custom App",
					"X-OpenRouter-Cache": "false",
				},
			},
			openRouterResponsesModel,
		);

		expect(getHeader(captured.headers, "HTTP-Referer")).toBe("https://example.test/");
		expect(getHeader(captured.headers, "X-OpenRouter-Title")).toBe("Custom App");
		expect(getHeader(captured.headers, "X-OpenRouter-Cache")).toBe("false");
	});

	it("applies OpenRouter Responses model variants and provider routing to the body", async () => {
		const routedModel: Model<"openai-responses"> = {
			...openRouterResponsesModel,
			compat: {
				...openRouterResponsesModel.compat,
				openRouterRouting: { only: ["anthropic"], order: ["anthropic"] },
			},
		};
		const captured = await captureOpenAIResponseHeaders({ openrouterVariant: "nitro" }, routedModel);

		expect(captured.body?.model).toBe("openai/gpt-5.5:nitro");
		expect(captured.body?.provider).toEqual({ only: ["anthropic"], order: ["anthropic"] });
	});

	it("keeps OpenRouter session_id on values longer than OpenAI prompt cache keys", async () => {
		const longSessionId = "s".repeat(100);
		const captured = await captureOpenAIResponseHeaders({ sessionId: longSessionId }, openRouterResponsesModel);

		expect(captured.body?.session_id).toBe(longSessionId);
		expect(captured.body?.prompt_cache_key).not.toBe(longSessionId);
	});

	it("hashes OpenRouter session_id only past the 256 character limit", async () => {
		const tooLongSessionId = "s".repeat(300);
		const captured = await captureOpenAIResponseHeaders({ sessionId: tooLongSessionId }, openRouterResponsesModel);
		const sessionId = captured.body?.session_id;

		expect(typeof sessionId).toBe("string");
		expect((sessionId as string).length).toBeLessThanOrEqual(256);
		expect(sessionId).not.toBe(tooLongSessionId);
	});

	it("lets explicit extraBody override OpenRouter Responses session_id", async () => {
		const captured = await captureOpenAIResponseHeaders(
			{
				sessionId: "workflow-123",
				extraBody: { session_id: "body-wins" },
			},
			openRouterResponsesModel,
		);

		expect(captured.body?.session_id).toBe("body-wins");
	});

	it("merges adapter extra body fields into the Responses request payload", async () => {
		const captured = await captureOpenAIResponseHeaders({
			sessionId: "session-123",
			extraBody: {
				prompt_cache_key: "adapter-cache-key",
				x_provider_hint: "xai",
			},
		});

		expect(captured.body?.prompt_cache_key).toBe("adapter-cache-key");
		expect(captured.body?.x_provider_hint).toBe("xai");
	});

	it("sends an async onPayload replacement body", async () => {
		const captured = await captureOpenAIResponseHeaders({
			onPayload: async payload => ({
				...(payload as Record<string, unknown>),
				input: [{ role: "user", content: [{ type: "input_text", text: "replacement" }] }],
				prompt_cache_key: "replacement-cache-key",
			}),
		});

		expect(captured.body?.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "replacement" }] }]);
		expect(captured.body?.prompt_cache_key).toBe("replacement-cache-key");
	});

	it("reapplies onPayload replacements on stateful stale-chain retry", async () => {
		const providerSessionState = new Map<string, ProviderSessionState>();
		const requestBodies: Array<Record<string, unknown>> = [];
		let payloadCall = 0;

		const fetchMock: FetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
			requestBodies.push(body);
			if (requestBodies.length === 2) {
				return new Response(
					JSON.stringify({
						error: {
							message: "previous_response_id not found",
							code: "previous_response_not_found",
							type: "invalid_request_error",
						},
					}),
					{ status: 400, headers: { "content-type": "application/json" } },
				);
			}

			const responseId = requestBodies.length === 1 ? "resp_first" : "resp_retry";
			return createSseResponse([
				{ type: "response.created", response: { id: responseId, status: "in_progress" } },
				{
					type: "response.output_item.added",
					item: {
						type: "message",
						id: `msg_${requestBodies.length}`,
						role: "assistant",
						status: "in_progress",
						content: [],
					},
				},
				{
					type: "response.output_item.done",
					item: {
						type: "message",
						id: `msg_${requestBodies.length}`,
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: "Hello" }],
					},
				},
				{
					type: "response.completed",
					response: {
						id: responseId,
						status: "completed",
						usage: {
							input_tokens: 5,
							output_tokens: 3,
							total_tokens: 8,
							input_tokens_details: { cached_tokens: 0 },
						},
					},
				},
			]);
		});

		const runContext = (context: Context) =>
			streamOpenAIResponses(model, context, {
				apiKey: "test-key",
				fetch: fetchMock,
				onPayload: async payload => ({
					...(payload as Record<string, unknown>),
					input: [{ role: "user", content: [{ type: "input_text", text: `replacement-${++payloadCall}` }] }],
				}),
				providerSessionState,
				sessionId: "stateful-retry-session",
				statefulResponses: true,
			}).result();

		const firstUserMessage = { role: "user" as const, content: "first", timestamp: Date.now() };
		const firstResponse = await runContext({ systemPrompt: ["stable system"], messages: [firstUserMessage] });
		await runContext({
			systemPrompt: ["stable system"],
			messages: [firstUserMessage, firstResponse, { role: "user", content: "second", timestamp: Date.now() }],
		});

		expect(requestBodies).toHaveLength(3);
		expect(requestBodies[1]?.previous_response_id).toBe("resp_first");
		expect(requestBodies[1]?.input).toEqual([
			{ role: "user", content: [{ type: "input_text", text: "replacement-2" }] },
		]);
		expect(requestBodies[2]?.previous_response_id).toBeUndefined();
		expect(requestBodies[2]?.input).toEqual([
			{ role: "user", content: [{ type: "input_text", text: "replacement-3" }] },
		]);
	});

	it("omits OpenRouter Responses session_id when cache retention is disabled", async () => {
		const captured = await captureOpenAIResponseHeaders(
			{ cacheRetention: "none", sessionId: "workflow-123" },
			openRouterAnthropicResponsesModel,
		);

		expect(captured.body?.session_id).toBeUndefined();
		expect(captured.body?.prompt_cache_key).toBeUndefined();
		expect(captured.body?.cache_control).toBeUndefined();
	});
});
