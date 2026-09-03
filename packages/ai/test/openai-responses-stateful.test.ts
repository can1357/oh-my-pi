import { afterEach, describe, expect, it, vi } from "bun:test";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { Context, FetchImpl, Model, ModelSpec, ProviderSessionState } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { resolveModelPolicy } from "@oh-my-pi/pi-catalog/compat/resolve";
import { classifyModel } from "@oh-my-pi/pi-catalog/compat/taxonomy";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const model = getBundledModel("openai", "gpt-5-mini") as Model<"openai-responses">;

const explicitPromptCacheModel: Model<"openai-responses"> = {
	...model,
	id: "gpt-5.6",
	identity: classifyModel("openai", "gpt-5.6"),
	name: "GPT-5.6",
	compat: resolveModelPolicy({
		id: "gpt-5.6",
		api: "openai-responses",
		name: "GPT-5.6",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	}).compat,
};

afterEach(() => {
	vi.restoreAllMocks();
});

function createStatefulSse(text: string, responseId: string): Response {
	const events = [
		{ type: "response.created", response: { id: responseId } },
		{
			type: "response.output_item.added",
			item: { type: "message", id: `msg_${responseId}`, role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
		{ type: "response.output_text.delta", delta: text },
		{
			type: "response.output_item.done",
			item: {
				type: "message",
				id: `msg_${responseId}`,
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text }],
			},
		},
		{
			type: "response.completed",
			response: {
				id: responseId,
				status: "completed",
				usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } },
			},
		},
	];
	return new Response(`${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function createCapturingFetch(sentRequests: Array<Record<string, unknown>>): FetchImpl {
	return vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
		sentRequests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
		return createStatefulSse(`Answer ${sentRequests.length}`, `resp_${sentRequests.length}`);
	}) as FetchImpl;
}

describe("openai-responses stateful chaining", () => {
	const systemPrompt = ["You are a helpful assistant."];

	it("chains turns with previous_response_id, delta input, and store: true", async () => {
		const sentRequests: Array<Record<string, unknown>> = [];
		const fetchMock = createCapturingFetch(sentRequests);
		const providerSessionState = new Map<string, ProviderSessionState>();
		const options = {
			apiKey: "test-key",
			sessionId: "stateful-session",
			providerSessionState,
			statefulResponses: true,
			reasoning: "low" as const,
			fetch: fetchMock,
		};

		const firstUser = { role: "user" as const, content: "First question", timestamp: 1000 };
		const firstResponse = await streamOpenAIResponses(
			model,
			{ systemPrompt, messages: [firstUser] },
			options,
		).result();
		expect(firstResponse.stopReason).toBe("stop");
		const secondResponse = await streamOpenAIResponses(
			model,
			{
				systemPrompt,
				messages: [firstUser, firstResponse, { role: "user", content: "Second question", timestamp: 1001 }],
			},
			options,
		).result();
		expect(secondResponse.stopReason).toBe("stop");

		expect(sentRequests).toHaveLength(2);
		expect(sentRequests[0]?.previous_response_id).toBeUndefined();
		expect(sentRequests[0]?.store).toBe(true);
		expect(sentRequests[1]?.previous_response_id).toBe("resp_1");
		expect(sentRequests[1]?.store).toBe(true);
		const deltaInput = sentRequests[1]?.input as Array<{ role?: string }>;
		expect(Array.isArray(deltaInput)).toBe(true);
		expect(deltaInput).toHaveLength(1);
		expect(deltaInput[0]?.role).toBe("user");
		expect(JSON.stringify(deltaInput)).toContain("Second question");
		expect(JSON.stringify(deltaInput)).not.toContain("Answer 1");
	});

	it("keeps the automatic explicit cache breakpoint stable across chained turns", async () => {
		const sentRequests: Array<Record<string, unknown>> = [];
		const fetchMock = createCapturingFetch(sentRequests);
		const providerSessionState = new Map<string, ProviderSessionState>();
		const options = {
			apiKey: "test-key",
			sessionId: "stateful-cache-session",
			providerSessionState,
			statefulResponses: true,
			promptCache: { mode: "explicit" as const },
			fetch: fetchMock,
		};
		const firstUser = { role: "user" as const, content: "First question", timestamp: 1000 };
		const firstResponse = await streamOpenAIResponses(
			explicitPromptCacheModel,
			{ systemPrompt, messages: [firstUser] },
			options,
		).result();
		const secondResponse = await streamOpenAIResponses(
			explicitPromptCacheModel,
			{
				systemPrompt,
				messages: [firstUser, firstResponse, { role: "user", content: "Second question", timestamp: 1001 }],
			},
			options,
		).result();

		expect(secondResponse.stopReason).toBe("stop");
		expect(sentRequests).toHaveLength(2);
		expect(sentRequests[1]?.previous_response_id).toBe("resp_1");
		expect(sentRequests[1]?.input).toEqual([
			{ role: "user", content: [{ type: "input_text", text: "Second question" }] },
		]);
	});

	it("chains no-system explicit-cache turns without retroactively marking user history", async () => {
		const sentRequests: Array<Record<string, unknown>> = [];
		const fetchMock = createCapturingFetch(sentRequests);
		const providerSessionState = new Map<string, ProviderSessionState>();
		const options = {
			apiKey: "test-key",
			sessionId: "stateful-no-system-cache-session",
			providerSessionState,
			statefulResponses: true,
			promptCache: { mode: "explicit" as const },
			fetch: fetchMock,
		};
		const firstUser = { role: "user" as const, content: "First question", timestamp: 1000 };
		const firstResponse = await streamOpenAIResponses(
			explicitPromptCacheModel,
			{ messages: [firstUser] },
			options,
		).result();
		const secondResponse = await streamOpenAIResponses(
			explicitPromptCacheModel,
			{
				messages: [firstUser, firstResponse, { role: "user", content: "Second question", timestamp: 1001 }],
			},
			options,
		).result();

		expect(secondResponse.stopReason).toBe("stop");
		expect(sentRequests).toHaveLength(2);
		expect(JSON.stringify(sentRequests[0]?.input)).not.toContain("prompt_cache_breakpoint");
		expect(sentRequests[1]?.previous_response_id).toBe("resp_1");
		expect(sentRequests[1]?.input).toEqual([
			{ role: "user", content: [{ type: "input_text", text: "Second question" }] },
		]);
	});

	it("re-enables an explicit cache breakpoint after a markerless chained turn", async () => {
		const sentRequests: Array<Record<string, unknown>> = [];
		const fetchMock = createCapturingFetch(sentRequests);
		const providerSessionState = new Map<string, ProviderSessionState>();
		const baseOptions = {
			apiKey: "test-key",
			sessionId: "stateful-reenabled-cache-breakpoint-session",
			providerSessionState,
			statefulResponses: true,
			fetch: fetchMock,
		};
		const firstUser = { role: "user" as const, content: "First question", timestamp: 1000 };
		const firstResponse = await streamOpenAIResponses(
			explicitPromptCacheModel,
			{ messages: [firstUser] },
			{ ...baseOptions, promptCache: { mode: "explicit", breakpoint: "none" } },
		).result();
		const secondUser = { role: "user" as const, content: "Second question", timestamp: 1001 };
		const secondResponse = await streamOpenAIResponses(
			explicitPromptCacheModel,
			{ messages: [firstUser, firstResponse, secondUser] },
			{ ...baseOptions, promptCache: { mode: "explicit" } },
		).result();
		const thirdUser = { role: "user" as const, content: "Third question", timestamp: 1002 };
		await streamOpenAIResponses(
			explicitPromptCacheModel,
			{ messages: [firstUser, firstResponse, secondUser, secondResponse, thirdUser] },
			{ ...baseOptions, promptCache: { mode: "explicit" } },
		).result();

		expect(sentRequests).toHaveLength(3);
		expect(JSON.stringify(sentRequests[0]?.input)).not.toContain("prompt_cache_breakpoint");
		expect(sentRequests[1]?.previous_response_id).toBeUndefined();
		expect(JSON.stringify(sentRequests[1]?.input)).toContain("prompt_cache_breakpoint");
		expect(sentRequests[2]?.previous_response_id).toBe("resp_2");
		expect(sentRequests[2]?.input).toEqual([
			{ role: "user", content: [{ type: "input_text", text: "Third question" }] },
		]);
	});

	it("preserves an established no-system cache breakpoint across chained turns", async () => {
		const sentRequests: Array<Record<string, unknown>> = [];
		const fetchMock = createCapturingFetch(sentRequests);
		const providerSessionState = new Map<string, ProviderSessionState>();
		const options = {
			apiKey: "test-key",
			sessionId: "stateful-no-system-marker-session",
			providerSessionState,
			statefulResponses: true,
			promptCache: { mode: "explicit" as const },
			fetch: fetchMock,
		};
		const oldestUser = { role: "user" as const, content: "Oldest stable question", timestamp: 1000 };
		const firstUser = { role: "user" as const, content: "First question", timestamp: 1001 };
		const firstResponse = await streamOpenAIResponses(
			explicitPromptCacheModel,
			{ messages: [oldestUser, firstUser] },
			options,
		).result();
		const secondUser = { role: "user" as const, content: "Second question", timestamp: 1002 };
		const secondResponse = await streamOpenAIResponses(
			explicitPromptCacheModel,
			{
				messages: [oldestUser, firstUser, firstResponse, secondUser],
			},
			options,
		).result();
		const thirdUser = { role: "user" as const, content: "Third question", timestamp: 1003 };
		const thirdResponse = await streamOpenAIResponses(
			explicitPromptCacheModel,
			{
				messages: [oldestUser, firstUser, firstResponse, secondUser, secondResponse, thirdUser],
			},
			options,
		).result();

		expect(secondResponse.stopReason).toBe("stop");
		expect(thirdResponse.stopReason).toBe("stop");
		expect(sentRequests).toHaveLength(3);
		expect(sentRequests[0]?.input).toEqual([
			{
				role: "user",
				content: [
					{
						type: "input_text",
						text: "Oldest stable question",
						prompt_cache_breakpoint: { mode: "explicit" },
					},
				],
			},
			{ role: "user", content: [{ type: "input_text", text: "First question" }] },
		]);
		expect(sentRequests[1]?.previous_response_id).toBe("resp_1");
		expect(sentRequests[1]?.input).toEqual([
			{ role: "user", content: [{ type: "input_text", text: "Second question" }] },
		]);
		expect(sentRequests[2]?.previous_response_id).toBe("resp_2");
		expect(sentRequests[2]?.input).toEqual([
			{ role: "user", content: [{ type: "input_text", text: "Third question" }] },
		]);
	});

	it("recomputes a cache breakpoint when an edited prefix resets the chain", async () => {
		const sentRequests: Array<Record<string, unknown>> = [];
		const fetchMock = createCapturingFetch(sentRequests);
		const providerSessionState = new Map<string, ProviderSessionState>();
		const options = {
			apiKey: "test-key",
			sessionId: "stateful-edited-cache-prefix-session",
			providerSessionState,
			statefulResponses: true,
			promptCache: { mode: "explicit" as const },
			fetch: fetchMock,
		};
		const firstUser = { role: "user" as const, content: "First question", timestamp: 1000 };
		const firstResponse = await streamOpenAIResponses(
			explicitPromptCacheModel,
			{ systemPrompt: ["Original system prompt"], messages: [firstUser] },
			options,
		).result();
		const secondUser = { role: "user" as const, content: "Second question", timestamp: 1001 };
		const secondResponse = await streamOpenAIResponses(
			explicitPromptCacheModel,
			{
				systemPrompt: ["Edited system prompt"],
				messages: [firstUser, firstResponse, secondUser],
			},
			options,
		).result();
		const thirdUser = { role: "user" as const, content: "Third question", timestamp: 1002 };
		await streamOpenAIResponses(
			explicitPromptCacheModel,
			{
				systemPrompt: ["Edited system prompt"],
				messages: [firstUser, firstResponse, secondUser, secondResponse, thirdUser],
			},
			options,
		).result();

		expect(sentRequests).toHaveLength(3);
		expect(sentRequests[1]?.previous_response_id).toBeUndefined();
		expect(JSON.stringify(sentRequests[1]?.input)).toContain("Edited system prompt");
		expect(JSON.stringify(sentRequests[1]?.input)).toContain("prompt_cache_breakpoint");
		expect(sentRequests[2]?.previous_response_id).toBe("resp_2");
		expect(sentRequests[2]?.input).toEqual([
			{ role: "user", content: [{ type: "input_text", text: "Third question" }] },
		]);
	});

	it("recomputes the cache breakpoint when the marked message content changes", async () => {
		const sentRequests: Array<Record<string, unknown>> = [];
		const fetchMock = createCapturingFetch(sentRequests);
		const providerSessionState = new Map<string, ProviderSessionState>();
		const options = {
			apiKey: "test-key",
			sessionId: "stateful-edited-marked-message-session",
			providerSessionState,
			statefulResponses: true,
			promptCache: { mode: "explicit" as const },
			fetch: fetchMock,
		};
		const oldestUser = { role: "user" as const, content: "Oldest stable question", timestamp: 1000 };
		const firstUser = { role: "user" as const, content: "First question", timestamp: 1001 };
		const firstResponse = await streamOpenAIResponses(
			explicitPromptCacheModel,
			{ messages: [oldestUser, firstUser] },
			options,
		).result();

		await streamOpenAIResponses(
			explicitPromptCacheModel,
			{
				messages: [
					{ ...oldestUser, content: "Edited oldest question" },
					firstUser,
					firstResponse,
					{ role: "user", content: "Second question", timestamp: 1002 },
				],
			},
			options,
		).result();

		expect(sentRequests).toHaveLength(2);
		expect(sentRequests[1]?.previous_response_id).toBeUndefined();
		const replayInput = sentRequests[1]?.input;
		if (!Array.isArray(replayInput)) throw new Error("Expected a full Responses replay");
		expect(replayInput[0]).toEqual({
			role: "user",
			content: [{ type: "input_text", text: "Edited oldest question" }],
		});
		expect(replayInput[1]).toEqual({
			role: "user",
			content: [
				{
					type: "input_text",
					text: "First question",
					prompt_cache_breakpoint: { mode: "explicit" },
				},
			],
		});
	});

	it("chains turns without appending an extra no-reasoning developer item", async () => {
		const sentRequests: Array<Record<string, unknown>> = [];
		const fetchMock = createCapturingFetch(sentRequests);
		const providerSessionState = new Map<string, ProviderSessionState>();
		const options = {
			apiKey: "test-key",
			sessionId: "stateful-no-reasoning-session",
			providerSessionState,
			statefulResponses: true,
			fetch: fetchMock,
		};

		const firstUser = { role: "user" as const, content: "First question", timestamp: 1000 };
		const firstResponse = await streamOpenAIResponses(
			model,
			{ systemPrompt, messages: [firstUser] },
			options,
		).result();
		expect(firstResponse.stopReason).toBe("stop");
		const firstInput = sentRequests[0]?.input as Array<{ role?: string }>;
		expect(firstInput).toHaveLength(2);
		expect(firstInput[0]?.role).toBe("developer");
		expect(firstInput[1]?.role).toBe("user");

		const secondResponse = await streamOpenAIResponses(
			model,
			{
				systemPrompt,
				messages: [firstUser, firstResponse, { role: "user", content: "Second question", timestamp: 1001 }],
			},
			options,
		).result();
		expect(secondResponse.stopReason).toBe("stop");

		expect(sentRequests).toHaveLength(2);
		expect(sentRequests[1]?.previous_response_id).toBe("resp_1");
		const deltaInput = sentRequests[1]?.input as Array<{ role?: string }>;
		expect(deltaInput).toHaveLength(1);
		expect(deltaInput[0]?.role).toBe("user");
		expect(JSON.stringify(deltaInput)).toContain("Second question");
	});

	it("replays the full transcript when history mutates", async () => {
		const sentRequests: Array<Record<string, unknown>> = [];
		const fetchMock = createCapturingFetch(sentRequests);
		const providerSessionState = new Map<string, ProviderSessionState>();
		const options = {
			apiKey: "test-key",
			sessionId: "stateful-mutation-session",
			providerSessionState,
			statefulResponses: true,
			reasoning: "low" as const,
			fetch: fetchMock,
		};

		const firstUser = { role: "user" as const, content: "First question", timestamp: 1000 };
		const firstResponse = await streamOpenAIResponses(
			model,
			{ systemPrompt, messages: [firstUser] },
			options,
		).result();
		const mutatedResponse = await streamOpenAIResponses(
			model,
			{
				systemPrompt,
				messages: [
					{ role: "user", content: "First question EDITED", timestamp: 1000 },
					firstResponse,
					{ role: "user", content: "Second question", timestamp: 1001 },
				],
			},
			options,
		).result();

		expect(mutatedResponse.stopReason).toBe("stop");
		expect(sentRequests).toHaveLength(2);
		expect(sentRequests[1]?.previous_response_id).toBeUndefined();
		expect(JSON.stringify(sentRequests[1]?.input)).toContain("First question EDITED");
	});

	it("retries a rejected previous_response_id with the full transcript", async () => {
		const sentRequests: Array<Record<string, unknown>> = [];
		const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
			sentRequests.push(request);
			if (typeof request.previous_response_id === "string") {
				return new Response(
					JSON.stringify({
						error: {
							message: `Previous response with id '${request.previous_response_id}' not found.`,
							type: "invalid_request_error",
							param: "previous_response_id",
							code: "previous_response_not_found",
						},
					}),
					{ status: 404, headers: { "content-type": "application/json" } },
				);
			}
			return createStatefulSse(`Answer ${sentRequests.length}`, `resp_${sentRequests.length}`);
		}) as FetchImpl;
		const providerSessionState = new Map<string, ProviderSessionState>();
		const options = {
			apiKey: "test-key",
			sessionId: "stateful-stale-session",
			providerSessionState,
			statefulResponses: true,
			reasoning: "low" as const,
			fetch: fetchMock,
		};

		const firstUser = { role: "user" as const, content: "First question", timestamp: 1000 };
		const firstResponse = await streamOpenAIResponses(
			model,
			{ systemPrompt, messages: [firstUser] },
			options,
		).result();
		const secondResponse = await streamOpenAIResponses(
			model,
			{
				systemPrompt,
				messages: [firstUser, firstResponse, { role: "user", content: "Second question", timestamp: 1001 }],
			},
			options,
		).result();

		expect(secondResponse.stopReason).toBe("stop");
		expect(JSON.stringify(secondResponse.content)).toContain("Answer 3");
		expect(sentRequests).toHaveLength(3);
		expect(sentRequests[1]?.previous_response_id).toBe("resp_1");
		expect(sentRequests[2]?.previous_response_id).toBeUndefined();
		expect(JSON.stringify(sentRequests[2]?.input)).toContain("First question");
		expect(JSON.stringify(sentRequests[2]?.input)).toContain("Second question");
	});
	it("retries a blocked invalid_prompt previous_response_id with the full transcript", async () => {
		const sentRequests: Array<Record<string, unknown>> = [];
		const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
			sentRequests.push(request);
			if (typeof request.previous_response_id === "string") {
				return new Response(
					JSON.stringify({
						error: {
							message: "Request blocked.",
							type: "invalid_request_error",
							code: "invalid_prompt",
						},
					}),
					{ status: 400, headers: { "content-type": "application/json" } },
				);
			}
			return createStatefulSse(`Answer ${sentRequests.length}`, `resp_${sentRequests.length}`);
		}) as FetchImpl;
		const providerSessionState = new Map<string, ProviderSessionState>();
		const options = {
			apiKey: "test-key",
			sessionId: "stateful-blocked-session",
			providerSessionState,
			statefulResponses: true,
			reasoning: "low" as const,
			fetch: fetchMock,
		};

		const firstUser = { role: "user" as const, content: "First question", timestamp: 1000 };
		const firstResponse = await streamOpenAIResponses(
			model,
			{ systemPrompt, messages: [firstUser] },
			options,
		).result();
		const secondResponse = await streamOpenAIResponses(
			model,
			{
				systemPrompt,
				messages: [firstUser, firstResponse, { role: "user", content: "Second question", timestamp: 1001 }],
			},
			options,
		).result();

		expect(secondResponse.stopReason).toBe("stop");
		expect(JSON.stringify(secondResponse.content)).toContain("Answer 3");
		expect(sentRequests).toHaveLength(3);
		expect(sentRequests[1]?.previous_response_id).toBe("resp_1");
		expect(sentRequests[2]?.previous_response_id).toBeUndefined();
		expect(JSON.stringify(sentRequests[2]?.input)).toContain("First question");
		expect(JSON.stringify(sentRequests[2]?.input)).toContain("Second question");
	});

	it("disables chaining for the session after repeated stale failures and stops forcing store", async () => {
		const sentRequests: Array<Record<string, unknown>> = [];
		const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
			sentRequests.push(request);
			if (typeof request.previous_response_id === "string") {
				return new Response(
					JSON.stringify({
						error: {
							message: "Previous response not found.",
							type: "invalid_request_error",
							param: "previous_response_id",
							code: "previous_response_not_found",
						},
					}),
					{ status: 404, headers: { "content-type": "application/json" } },
				);
			}
			return createStatefulSse(`Answer ${sentRequests.length}`, `resp_${sentRequests.length}`);
		}) as FetchImpl;
		const providerSessionState = new Map<string, ProviderSessionState>();
		const options = {
			apiKey: "test-key",
			sessionId: "stateful-circuit-session",
			providerSessionState,
			statefulResponses: true,
			reasoning: "low" as const,
			fetch: fetchMock,
		};

		const messages: Context["messages"] = [{ role: "user", content: "Question 1", timestamp: 1000 }];
		for (let turn = 1; turn <= 5; turn++) {
			const result = await streamOpenAIResponses(model, { systemPrompt, messages }, options).result();
			expect(result.stopReason).toBe("stop");
			messages.push(result, { role: "user", content: `Question ${turn + 1}`, timestamp: 1000 + turn });
		}

		// Turns 2-4 each attempt one delta (rejected) + one full retry; after the
		// third consecutive stale failure chaining is disabled, so turn 5 issues a
		// single full-context request without forcing store.
		expect(sentRequests).toHaveLength(8);
		expect(sentRequests.filter(request => typeof request.previous_response_id === "string")).toHaveLength(3);
		expect(sentRequests[7]?.previous_response_id).toBeUndefined();
		expect(sentRequests[7]?.store).toBe(false);
	});

	it("disables chaining categorically when the org has Zero Data Retention enabled", async () => {
		const sentRequests: Array<Record<string, unknown>> = [];
		const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
			sentRequests.push(request);
			if (typeof request.previous_response_id === "string") {
				return new Response(
					JSON.stringify({
						error: {
							message: "Previous response cannot be used for this organization due to Zero Data Retention.",
							type: "invalid_request_error",
							param: "previous_response_id",
							code: "zero_data_retention",
						},
					}),
					{ status: 400, headers: { "content-type": "application/json" } },
				);
			}
			return createStatefulSse(`Answer ${sentRequests.length}`, `resp_${sentRequests.length}`);
		}) as FetchImpl;
		const providerSessionState = new Map<string, ProviderSessionState>();
		const options = {
			apiKey: "test-key",
			sessionId: "stateful-zdr-session",
			providerSessionState,
			statefulResponses: true,
			reasoning: "low" as const,
			fetch: fetchMock,
		};

		const messages: Context["messages"] = [];
		for (let turn = 1; turn <= 3; turn++) {
			messages.push({ role: "user", content: `Question ${turn}`, timestamp: 1000 + turn });
			const result = await streamOpenAIResponses(model, { systemPrompt, messages }, options).result();
			expect(result.stopReason).toBe("stop");
			messages.push(result);
		}

		// Turn 1: no previous_response_id (cold chain). Turn 2: tries chaining,
		// gets a ZDR 400, retries once with full transcript and store: false.
		// Turn 3: chain is permanently disabled — no second 400.
		expect(sentRequests).toHaveLength(4);
		expect(sentRequests[0]?.previous_response_id).toBeUndefined();
		expect(sentRequests[1]?.previous_response_id).toBe("resp_1");
		expect(sentRequests[2]?.previous_response_id).toBeUndefined();
		expect(sentRequests[2]?.store).toBe(false);
		expect(sentRequests[3]?.previous_response_id).toBeUndefined();
		expect(sentRequests[3]?.store).toBe(false);
	});

	it("chains by default against the official OpenAI API", async () => {
		const sentRequests: Array<Record<string, unknown>> = [];
		const fetchMock = createCapturingFetch(sentRequests);
		const providerSessionState = new Map<string, ProviderSessionState>();
		// No statefulResponses option: the official-API default applies.
		const options = {
			apiKey: "test-key",
			sessionId: "stateful-default-session",
			providerSessionState,
			reasoning: "low" as const,
			fetch: fetchMock,
		};

		const firstUser = { role: "user" as const, content: "First question", timestamp: 1000 };
		const firstResponse = await streamOpenAIResponses(
			model,
			{ systemPrompt, messages: [firstUser] },
			options,
		).result();
		await streamOpenAIResponses(
			model,
			{
				systemPrompt,
				messages: [firstUser, firstResponse, { role: "user", content: "Second question", timestamp: 1001 }],
			},
			options,
		).result();

		expect(sentRequests).toHaveLength(2);
		expect(sentRequests[0]?.store).toBe(true);
		expect(sentRequests[1]?.store).toBe(true);
		expect(sentRequests[1]?.previous_response_id).toBe("resp_1");
		expect(sentRequests[1]?.input as unknown[]).toHaveLength(1);
	});

	it("stays stateless by default off the official OpenAI API", async () => {
		const proxyModel = buildModel({
			...model,
			baseUrl: "https://proxy.example.com/v1",
			compat: model.compatConfig,
		} as ModelSpec<"openai-responses">) as Model<"openai-responses">;
		const sentRequests: Array<Record<string, unknown>> = [];
		const fetchMock = createCapturingFetch(sentRequests);
		const providerSessionState = new Map<string, ProviderSessionState>();
		const options = {
			apiKey: "test-key",
			sessionId: "stateless-proxy-session",
			providerSessionState,
			reasoning: "low" as const,
			fetch: fetchMock,
		};

		const firstUser = { role: "user" as const, content: "First question", timestamp: 1000 };
		const firstResponse = await streamOpenAIResponses(
			proxyModel,
			{ systemPrompt, messages: [firstUser] },
			options,
		).result();
		await streamOpenAIResponses(
			proxyModel,
			{
				systemPrompt,
				messages: [firstUser, firstResponse, { role: "user", content: "Second question", timestamp: 1001 }],
			},
			options,
		).result();

		expect(sentRequests).toHaveLength(2);
		expect(sentRequests[0]?.store).toBe(false);
		expect(sentRequests[1]).toBeDefined();
		expect(sentRequests[1]!.store).toBe(false);
		expect(sentRequests[1]!.previous_response_id).toBeUndefined();
		expect((sentRequests[1]!.input as unknown[]).length).toBeGreaterThan(1);
	});
});
