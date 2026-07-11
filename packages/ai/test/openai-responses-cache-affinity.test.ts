import { afterEach, describe, expect, it, vi } from "bun:test";
import { type OpenAIResponsesOptions, streamOpenAIResponses } from "@pk-nerdsaver-ai/pi-ai/providers/openai-responses";
import { stream as streamModel, streamSimple } from "@pk-nerdsaver-ai/pi-ai/stream";
import type { Context, FetchImpl, Model, ProviderSessionState, SimpleStreamOptions } from "@pk-nerdsaver-ai/pi-ai/types";
import { buildOpenAIResponsesCompat } from "@pk-nerdsaver-ai/pi-catalog/compat/openai";
import { getBundledModel } from "@pk-nerdsaver-ai/pi-catalog/models";

const model = getBundledModel("openai", "gpt-5-mini") as Model<"openai-responses">;
const openRouterResponsesModel: Model<"openai-responses"> = {
	...model,
	id: "openai/gpt-5.5",
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

	const context: Context = {
		systemPrompt: ["stable system", "stable durable context"],
		messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
	};
	const stream = streamSimple(requestModel, context, { apiKey: "test-key", ...options, fetch: fetchMock });

	for await (const event of stream) {
		if (event.type === "done" || event.type === "error") break;
	}

	return body;
}

afterEach(() => {
	vi.restoreAllMocks();
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

	it("lets explicit headers override the default OpenAI session routing headers", async () => {
		const captured = await captureOpenAIResponseHeaders({
			sessionId: "session-123",
			headers: {
				session_id: "override-session",
				"x-client-request-id": "override-request",
			},
		});

		expect(captured.sessionId).toBe("override-session");
		expect(captured.clientRequestId).toBe("override-request");
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

	it("omits OpenAI session routing headers when cache retention is disabled", async () => {
		const captured = await captureOpenAIResponseHeaders({ cacheRetention: "none", sessionId: "session-123" });

		expect(captured.sessionId).toBeNull();
		expect(captured.clientRequestId).toBeNull();
		expect(captured.body?.prompt_cache_key).toBeUndefined();
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
