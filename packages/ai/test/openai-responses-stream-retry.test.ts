import { describe, expect, it, vi } from "bun:test";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type {
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	FetchImpl,
	Model,
	ProviderSessionState,
} from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const model = getBundledModel("openai", "gpt-5-mini") as Model<"openai-responses">;
const firstUser = { role: "user" as const, content: "Read the file", timestamp: 1_000 };
const context: Context = { messages: [firstUser] };

function createSseResponse(events: unknown[]): Response {
	return new Response(`${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function createTruncatedPendingToolResponse(): Response {
	const prefix = [
		{ type: "response.created", response: { id: "resp_partial", status: "in_progress" } },
		{
			type: "response.output_item.added",
			output_index: 0,
			item: {
				type: "function_call",
				id: "fc_partial",
				call_id: "call_partial",
				name: "read",
				arguments: "",
				status: "in_progress",
			},
		},
	];
	const truncatedEvent = 'data: {"type":"response.function_call_arguments.delta","item_id":"fc_partial","delta":';
	return new Response(`${prefix.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n${truncatedEvent}`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function createTruncatedReasoningPartDoneResponse(): Response {
	const prefix = [
		{ type: "response.created", response: { id: "resp_reasoning", status: "in_progress" } },
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { type: "reasoning", id: "reasoning_partial", summary: [], status: "in_progress" },
		},
		{
			type: "response.reasoning_summary_part.added",
			item_id: "reasoning_partial",
			output_index: 0,
			summary_index: 0,
			part: { type: "summary_text", text: "" },
		},
		{
			type: "response.reasoning_summary_part.done",
			item_id: "reasoning_partial",
			output_index: 0,
			summary_index: 0,
			part: { type: "summary_text", text: "" },
		},
	];
	const truncatedEvent = 'data: {"type":"response.output_text.delta","item_id":"missing","delta":';
	return new Response(`${prefix.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n${truncatedEvent}`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function createCompletedToolResponse(responseId = "resp_retry"): Response {
	const argumentsJson = JSON.stringify({ path: "README.md" });
	return createSseResponse([
		{ type: "response.created", response: { id: responseId, status: "in_progress" } },
		{
			type: "response.output_item.added",
			output_index: 0,
			item: {
				type: "function_call",
				id: "fc_recovered",
				call_id: "call_recovered",
				name: "read",
				arguments: "",
				status: "in_progress",
			},
		},
		{
			type: "response.function_call_arguments.delta",
			output_index: 0,
			item_id: "fc_recovered",
			delta: argumentsJson,
		},
		{
			type: "response.function_call_arguments.done",
			output_index: 0,
			item_id: "fc_recovered",
			arguments: argumentsJson,
		},
		{
			type: "response.output_item.done",
			output_index: 0,
			item: {
				type: "function_call",
				id: "fc_recovered",
				call_id: "call_recovered",
				name: "read",
				arguments: argumentsJson,
				status: "completed",
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
	]);
}

function createCompletedTextResponse(text: string, responseId: string): Response {
	return createSseResponse([
		{ type: "response.created", response: { id: responseId, status: "in_progress" } },
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { type: "message", id: `msg_${responseId}`, role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.output_text.delta", output_index: 0, item_id: `msg_${responseId}`, delta: text },
		{
			type: "response.output_item.done",
			output_index: 0,
			item: {
				type: "message",
				id: `msg_${responseId}`,
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text }],
			},
		},
		{ type: "response.completed", response: { id: responseId, status: "completed" } },
	]);
}

function createGatedTextAndToolResponse(): {
	response: Response;
	terminalRequested: Promise<void>;
	releaseTerminal: () => void;
} {
	const nonTerminalEvents = [
		{ type: "response.created", response: { id: "resp_live", status: "in_progress" } },
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { type: "message", id: "msg_live", role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.output_text.delta", output_index: 0, item_id: "msg_live", delta: "draft" },
		{
			type: "response.output_item.done",
			output_index: 0,
			item: {
				type: "message",
				id: "msg_live",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "draft" }],
			},
		},
		{
			type: "response.output_item.added",
			output_index: 1,
			item: {
				type: "function_call",
				id: "fc_live",
				call_id: "call_live",
				name: "read",
				arguments: "",
				status: "in_progress",
			},
		},
		{
			type: "response.function_call_arguments.delta",
			output_index: 1,
			item_id: "fc_live",
			delta: '{"path":"README',
		},
	];
	const terminalEvents = [
		{
			type: "response.function_call_arguments.done",
			output_index: 1,
			item_id: "fc_live",
			arguments: '{"path":"README.md"}',
		},
		{
			type: "response.output_item.done",
			output_index: 1,
			item: {
				type: "function_call",
				id: "fc_live",
				call_id: "call_live",
				name: "read",
				arguments: '{"path":"README.md"}',
				status: "completed",
			},
		},
		{ type: "response.completed", response: { id: "resp_live", status: "completed" } },
	];
	const terminalGate = Promise.withResolvers<void>();
	const terminalRequest = Promise.withResolvers<void>();
	let sentNonTerminal = false;
	const body = new ReadableStream<Uint8Array>(
		{
			async pull(controller) {
				if (!sentNonTerminal) {
					sentNonTerminal = true;
					controller.enqueue(
						new TextEncoder().encode(
							`${nonTerminalEvents.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`,
						),
					);
					return;
				}
				terminalRequest.resolve();
				await terminalGate.promise;
				controller.enqueue(
					new TextEncoder().encode(
						`${terminalEvents.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`,
					),
				);
				controller.close();
			},
		},
		{ highWaterMark: 0 },
	);
	return {
		response: new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
		terminalRequested: terminalRequest.promise,
		releaseTerminal: terminalGate.resolve,
	};
}

function parseBody(init: RequestInit | undefined): Record<string, unknown> {
	return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

async function collectEvents(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

describe("OpenAI Responses transient stream retry", () => {
	it("retries a truncated pending tool call with a fresh request and clean state", async () => {
		const sentRequests: Array<Record<string, unknown>> = [];
		let attempt = 0;
		let payloadCalls = 0;
		const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			sentRequests.push(parseBody(init));
			attempt++;
			if (attempt === 1) return createTruncatedPendingToolResponse();
			if (attempt === 2) return createCompletedToolResponse();
			return createCompletedTextResponse("Follow-up", "resp_followup");
		}) as FetchImpl;
		const providerSessionState = new Map<string, ProviderSessionState>();
		const options = {
			apiKey: "test-key",
			fetch: fetchMock,
			providerRetryWait: async () => {},
			providerSessionState,
			sessionId: "stream-retry-session",
			statefulResponses: true,
			onPayload: (payload: unknown) => {
				payloadCalls++;
				return { ...(payload as Record<string, unknown>), metadata: { retry_test: "preserved" } };
			},
		};

		const responseStream = streamOpenAIResponses(model, context, options);
		const events = await collectEvents(responseStream);
		const result = await responseStream.result();

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(payloadCalls).toBe(1);
		expect(sentRequests[0]?.metadata).toEqual({ retry_test: "preserved" });
		expect(sentRequests[1]).toEqual(sentRequests[0]);
		expect(result.stopReason).toBe("toolUse");
		expect(JSON.parse(JSON.stringify(result.content))).toEqual([
			{ type: "toolCall", id: "call_recovered|fc_recovered", name: "read", arguments: { path: "README.md" } },
		]);
		expect(events.map(event => event.type)).toEqual([
			"start",
			"toolcall_start",
			"toolcall_delta",
			"toolcall_end",
			"done",
		]);
		expect(JSON.stringify(result.providerPayload)).not.toContain("partial");

		const followup = await streamOpenAIResponses(
			model,
			{
				messages: [firstUser, result, { role: "user", content: "What did it contain?", timestamp: 1_001 }],
			},
			options,
		).result();
		expect(followup.stopReason).toBe("stop");
		expect(sentRequests[2]?.previous_response_id).toBe("resp_retry");
	});

	it("falls back to full transcript when a fresh stream retry finds a stale chain baseline", async () => {
		const sentRequests: Array<Record<string, unknown>> = [];
		const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			const request = parseBody(init);
			sentRequests.push(request);
			switch (sentRequests.length) {
				case 1:
					return createCompletedTextResponse("Baseline", "resp_baseline");
				case 2:
					return createTruncatedPendingToolResponse();
				case 3:
					return new Response(
						JSON.stringify({
							error: {
								message: "Previous response with id 'resp_baseline' not found.",
								type: "invalid_request_error",
								param: "previous_response_id",
								code: "previous_response_not_found",
							},
						}),
						{ status: 404, headers: { "content-type": "application/json" } },
					);
				case 4:
					return createCompletedTextResponse("Recovered", "resp_recovered");
				default:
					return createCompletedTextResponse("Follow-up", "resp_followup");
			}
		}) as FetchImpl;
		const providerSessionState = new Map<string, ProviderSessionState>();
		const options = {
			apiKey: "test-key",
			fetch: fetchMock,
			providerRetryWait: async () => {},
			providerSessionState,
			sessionId: "stream-retry-stale-chain-session",
			statefulResponses: true,
		};

		const baseline = await streamOpenAIResponses(model, context, options).result();
		const secondUser = { role: "user" as const, content: "Continue after baseline", timestamp: 1_001 };
		const responseStream = streamOpenAIResponses(model, { messages: [firstUser, baseline, secondUser] }, options);
		const events = await collectEvents(responseStream);
		const recovered = await responseStream.result();

		expect(fetchMock).toHaveBeenCalledTimes(4);
		expect(sentRequests[0]?.previous_response_id).toBeUndefined();
		expect(sentRequests[1]?.previous_response_id).toBe("resp_baseline");
		expect(sentRequests[2]).toEqual(sentRequests[1]);
		expect(JSON.stringify(sentRequests[1]?.input)).toContain("Continue after baseline");
		expect(JSON.stringify(sentRequests[1]?.input)).not.toContain("Read the file");
		expect(sentRequests[3]?.previous_response_id).toBeUndefined();
		expect(sentRequests[3]?.store).toBe(true);
		expect(JSON.stringify(sentRequests[3]?.input)).toContain("Read the file");
		expect(JSON.stringify(sentRequests[3]?.input)).toContain("Baseline");
		expect(JSON.stringify(sentRequests[3]?.input)).toContain("Continue after baseline");
		expect(recovered.responseId).toBe("resp_recovered");
		expect(events.map(event => event.type)).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);

		const followup = await streamOpenAIResponses(
			model,
			{
				messages: [
					firstUser,
					baseline,
					secondUser,
					recovered,
					{ role: "user", content: "One more question", timestamp: 1_002 },
				],
			},
			options,
		).result();
		expect(followup.stopReason).toBe("stop");
		expect(fetchMock).toHaveBeenCalledTimes(5);
		expect(sentRequests[4]?.previous_response_id).toBe("resp_recovered");
	});

	it("forwards text and tool deltas live with their delta-time partial state", async () => {
		const gated = createGatedTextAndToolResponse();
		const fetchMock = vi.fn(async () => gated.response) as FetchImpl;
		const responseStream = streamOpenAIResponses(model, context, {
			apiKey: "test-key",
			fetch: fetchMock,
			providerRetryWait: async () => {},
		});
		const nonTerminalEvents = (async () => {
			const observed: Array<{ type: AssistantMessageEvent["type"]; content: unknown }> = [];
			for await (const event of responseStream) {
				observed.push({
					type: event.type,
					content:
						event.type !== "start" && "partial" in event ? structuredClone(event.partial.content) : undefined,
				});
				if (event.type === "toolcall_delta") return observed;
			}
			throw new Error("stream ended before the tool delta");
		})();

		await gated.terminalRequested;
		const observedBeforeTerminal = await nonTerminalEvents;
		const deltaText = { type: "text", text: "draft", textSignature: JSON.stringify({ v: 1, id: "msg_live" }) };
		expect(observedBeforeTerminal).toEqual([
			{ type: "start", content: undefined },
			{ type: "text_start", content: [deltaText] },
			{ type: "text_delta", content: [deltaText] },
			{ type: "text_end", content: [deltaText] },
			{
				type: "toolcall_start",
				content: [deltaText, { type: "toolCall", id: "call_live|fc_live", name: "read", arguments: {} }],
			},
			{
				type: "toolcall_delta",
				content: [
					deltaText,
					{ type: "toolCall", id: "call_live|fc_live", name: "read", arguments: { path: "README" } },
				],
			},
		]);

		gated.releaseTerminal();
		const result = await responseStream.result();
		expect(result.stopReason).toBe("toolUse");
		expect(JSON.parse(JSON.stringify(result.content[1]))).toEqual({
			type: "toolCall",
			id: "call_live|fc_live",
			name: "read",
			arguments: { path: "README.md" },
		});
	});

	it("does not retry after a tool argument delta was emitted", async () => {
		const partialWithDelta = createSseResponse([
			{ type: "response.created", response: { id: "resp_partial", status: "in_progress" } },
			{
				type: "response.output_item.added",
				output_index: 0,
				item: {
					type: "function_call",
					id: "fc_partial",
					call_id: "call_partial",
					name: "read",
					arguments: "",
					status: "in_progress",
				},
			},
			{
				type: "response.function_call_arguments.delta",
				output_index: 0,
				item_id: "fc_partial",
				delta: '{"path":"README.md"}',
			},
		]);
		const fetchMock = vi.fn(async () => partialWithDelta) as FetchImpl;

		const result = await streamOpenAIResponses(model, context, {
			apiKey: "test-key",
			fetch: fetchMock,
			providerRetryWait: async () => {},
		}).result();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result.stopReason).toBe("error");
	});

	it("does not retry after a reasoning summary part completion emitted thinking", async () => {
		const fetchMock = vi.fn(async () => createTruncatedReasoningPartDoneResponse()) as FetchImpl;
		const responseStream = streamOpenAIResponses(model, context, {
			apiKey: "test-key",
			fetch: fetchMock,
			providerRetryWait: async () => {},
		});

		const events = await collectEvents(responseStream);
		const result = await responseStream.result();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(events.map(event => event.type)).toEqual(["start", "thinking_start", "thinking_delta", "error"]);
		expect(result.stopReason).toBe("error");
	});

	it("bounds repeated pre-output stream corruption to one retry", async () => {
		const fetchMock = vi.fn(async () => createTruncatedPendingToolResponse()) as FetchImpl;

		const result = await streamOpenAIResponses(model, context, {
			apiKey: "test-key",
			fetch: fetchMock,
			providerRetryWait: async () => {},
		}).result();

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(result.stopReason).toBe("error");
	});

	it("honors caller abort during the retry wait", async () => {
		const controller = new AbortController();
		const fetchMock = vi.fn(async () => createTruncatedPendingToolResponse()) as FetchImpl;

		const responseStream = streamOpenAIResponses(model, context, {
			apiKey: "test-key",
			fetch: fetchMock,
			signal: controller.signal,
			providerRetryWait: async () => controller.abort(),
		});
		const events = await collectEvents(responseStream);
		const result = await responseStream.result();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result.stopReason).toBe("aborted");
		expect(events.map(event => event.type)).toEqual(["start", "error"]);
		expect(result.content).toEqual([]);
		expect(result.responseId).toBeUndefined();
		expect(result.providerPayload).toBeUndefined();
		expect(result.usage).toEqual({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
		expect(result.ttft).toBeUndefined();
	});

	for (const error of [
		{ code: "invalid_request_error", message: "Tool schema is invalid" },
		{ code: "insufficient_quota", message: "Persistent quota exhausted" },
	]) {
		it(`does not retry terminal ${error.code} failures`, async () => {
			const fetchMock = vi.fn(async () =>
				createSseResponse([
					{
						type: "response.failed",
						response: { id: "resp_failed", status: "failed", error },
					},
				]),
			) as FetchImpl;

			const result = await streamOpenAIResponses(model, context, {
				apiKey: "test-key",
				fetch: fetchMock,
				providerRetryWait: async () => {},
			}).result();

			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(result.stopReason).toBe("error");
		});
	}
});
