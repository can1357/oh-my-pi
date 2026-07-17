import { afterEach, describe, expect, it, vi } from "bun:test";
import { streamOpenAIResponses } from "@pk-nerdsaver-ai/pi-ai/providers/openai-responses";
import type { Context, FetchImpl, Model, ModelSpec, ProviderSessionState } from "@pk-nerdsaver-ai/pi-ai/types";
import { buildModel } from "@pk-nerdsaver-ai/pi-catalog/build";
import { getBundledModel } from "@pk-nerdsaver-ai/pi-catalog/models";

const model = getBundledModel("openai", "gpt-5-mini") as Model<"openai-responses">;

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

	it("keeps chaining when the GPT-5 no-reasoning scaffolding trails every request", async () => {
		const sentRequests: Array<Record<string, unknown>> = [];
		const fetchMock = createCapturingFetch(sentRequests);
		const providerSessionState = new Map<string, ProviderSessionState>();
		// No reasoning option: applyResponsesReasoningParams appends the trailing
		// "# Juice: 0 !important" developer item to every request's input.
		const options = {
			apiKey: "test-key",
			sessionId: "stateful-juice-session",
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
		const firstInput = sentRequests[0]?.input as unknown[];
		expect(JSON.stringify(firstInput.at(-1))).toContain("# Juice: 0");

		const secondResponse = await streamOpenAIResponses(
			model,
			{
				systemPrompt,
				messages: [firstUser, firstResponse, { role: "user", content: "Second question", timestamp: 1001 }],
			},
			options,
		).result();
		expect(secondResponse.stopReason).toBe("stop");

		// The trailing scaffolding is excluded from the prefix check and re-sent
		// with the delta: [new user item, juice item].
		expect(sentRequests).toHaveLength(2);
		expect(sentRequests[1]?.previous_response_id).toBe("resp_1");
		const deltaInput = sentRequests[1]?.input as Array<{ role?: string }>;
		expect(deltaInput).toHaveLength(2);
		expect(deltaInput[0]?.role).toBe("user");
		expect(JSON.stringify(deltaInput[1])).toContain("# Juice: 0");
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
		expect(sentRequests[1]?.store).toBe(false);
		expect(sentRequests[1]?.previous_response_id).toBeUndefined();
		expect((sentRequests[1]!.input as unknown[]).length).toBeGreaterThan(1);
	});
});
