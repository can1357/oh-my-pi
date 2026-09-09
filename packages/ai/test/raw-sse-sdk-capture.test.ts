import { afterEach, describe, expect, it, vi } from "bun:test";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { AnthropicMessagesClientLike } from "@oh-my-pi/pi-ai/providers/anthropic-client";
import type { RawMessageStreamEvent } from "@oh-my-pi/pi-ai/providers/anthropic-wire";
import { streamAzureOpenAIResponses } from "@oh-my-pi/pi-ai/providers/azure-openai-responses";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { Context, FetchImpl, Model, RawSseEvent } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const context: Context = {
	messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
};

const openAIResponsesModel = getBundledModel("openai", "gpt-5-mini") as Model<"openai-responses">;
const openAICompletionsModel = {
	...(getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">),
	api: "openai-completions",
} satisfies Model<"openai-completions">;
const azureOpenAIResponsesModel: Model<"azure-openai-responses"> = buildModel({
	id: "gpt-5-mini",
	name: "GPT-5 Mini",
	api: "azure-openai-responses",
	provider: "azure",
	baseUrl: "https://example.openai.azure.com/openai/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400_000,
	maxTokens: 128_000,
});
const anthropicModel: Model<"anthropic-messages"> = buildModel({
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
});

const openAIResponsesEvents = [
	{ type: "response.created", response: { id: "resp_raw_sse", status: "in_progress" } },
	{
		type: "response.output_item.added",
		item: { type: "message", id: "msg_raw_sse", role: "assistant", status: "in_progress", content: [] },
	},
	{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
	{ type: "response.output_text.delta", delta: "Hello" },
	{
		type: "response.output_item.done",
		item: {
			type: "message",
			id: "msg_raw_sse",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text: "Hello" }],
		},
	},
	{
		type: "response.completed",
		response: {
			id: "resp_raw_sse",
			status: "completed",
			usage: {
				input_tokens: 5,
				output_tokens: 1,
				total_tokens: 6,
				input_tokens_details: { cached_tokens: 0 },
			},
		},
	},
];

const anthropicEvents: RawMessageStreamEvent[] = [
	{
		type: "message_start",
		message: {
			id: "msg_raw_sse",
			usage: {
				input_tokens: 5,
				output_tokens: 0,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
		},
	},
	{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
	{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
	{ type: "content_block_stop", index: 0 },
	{
		type: "message_delta",
		delta: { stop_reason: "end_turn" },
		usage: {
			input_tokens: 5,
			output_tokens: 1,
			cache_read_input_tokens: 0,
			cache_creation_input_tokens: 0,
		},
	},
	{ type: "message_stop" },
];

function createSseResponse(events: unknown[]): Response {
	const payload = `${events
		.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`)
		.join("\n\n")}\n\n`;
	return new Response(payload, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function createFetchResponse(events: unknown[]): FetchImpl {
	return Object.assign(
		vi.fn(async () => createSseResponse(events)),
		{ preconnect: fetch.preconnect },
	) as typeof fetch;
}

function recordEvent(events: RawSseEvent[]): (event: RawSseEvent) => void {
	return event => {
		events.push({ event: event.event, data: event.data, raw: [...event.raw] });
	};
}

async function* asyncEvents(events: RawMessageStreamEvent[]): AsyncGenerator<RawMessageStreamEvent> {
	for (const event of events) yield event;
}

function createAnthropicSdkClient(events: RawMessageStreamEvent[]): AnthropicMessagesClientLike {
	return {
		messages: {
			create: () => ({
				async withResponse() {
					return {
						data: asyncEvents(events),
						response: new Response(null, { status: 200, headers: { "request-id": "req_sdk" } }),
						request_id: "req_sdk",
					};
				},
			}),
		},
	};
}

function sseFrame(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function createAnthropicRawClient(events: RawMessageStreamEvent[]): AnthropicMessagesClientLike {
	return {
		messages: {
			create: () => ({
				async asResponse() {
					return new Response(events.map(event => sseFrame(event.type, event)).join(""), {
						status: 200,
						headers: { "content-type": "text/event-stream", "request-id": "req_raw" },
					});
				},
			}),
		},
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("SDK raw SSE capture", () => {
	it("records OpenAI Responses SDK events from the decoded stream", async () => {
		const fetchMock = createFetchResponse(openAIResponsesEvents);
		const observed: RawSseEvent[] = [];

		const result = await streamOpenAIResponses(openAIResponsesModel, context, {
			apiKey: "test-key",
			fetch: fetchMock,
			onSseEvent: recordEvent(observed),
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(observed.map(event => event.event)).toEqual(openAIResponsesEvents.map(event => event.type));
		expect(JSON.parse(observed[0]!.data)).toEqual(openAIResponsesEvents[0]);
		expect(observed[0]!.raw).toEqual([
			"event: response.created",
			`data: ${JSON.stringify(openAIResponsesEvents[0])}`,
		]);
	});

	it("records OpenAI Chat Completions SDK events from the decoded stream", async () => {
		const chunks = [
			{
				id: "chatcmpl_raw_sse",
				object: "chat.completion.chunk",
				created: 0,
				model: openAICompletionsModel.id,
				choices: [{ index: 0, delta: { content: "Hello" } }],
			},
			{
				id: "chatcmpl_raw_sse",
				object: "chat.completion.chunk",
				created: 0,
				model: openAICompletionsModel.id,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 5,
					completion_tokens: 1,
					total_tokens: 6,
					prompt_tokens_details: { cached_tokens: 0 },
				},
			},
			"[DONE]",
		];
		const fetchMock = createFetchResponse(chunks);
		const observed: RawSseEvent[] = [];

		const result = await streamOpenAICompletions(openAICompletionsModel, context, {
			apiKey: "test-key",
			fetch: fetchMock,
			onSseEvent: recordEvent(observed),
		}).result();

		expect(result.stopReason).toBe("stop");
		// Observers receive every raw wire frame as it arrives (types.ts
		// `onSseEvent` contract), including the terminal `[DONE]` sentinel,
		// which carries no resolvable event name.
		expect(observed.map(event => event.event)).toEqual(["chat.completion.chunk", "chat.completion.chunk", null]);
		expect(JSON.parse(observed[0]!.data)).toEqual(chunks[0]);
		expect(observed[0]!.raw).toEqual(["event: chat.completion.chunk", `data: ${JSON.stringify(chunks[0])}`]);
		const sentinel = observed.at(-1);
		expect(sentinel?.data).toBe("[DONE]");
		expect(sentinel?.raw).toEqual(["data: [DONE]"]);
	});

	it("records Azure OpenAI Responses SDK events from the decoded stream", async () => {
		const fetchMock = createFetchResponse(openAIResponsesEvents);
		const observed: RawSseEvent[] = [];

		const result = await streamAzureOpenAIResponses(azureOpenAIResponsesModel, context, {
			apiKey: "test-key",
			fetch: fetchMock,
			azureBaseUrl: azureOpenAIResponsesModel.baseUrl,
			azureApiVersion: "v1",
			onSseEvent: recordEvent(observed),
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(observed.map(event => event.event)).toEqual(openAIResponsesEvents.map(event => event.type));
		expect(JSON.parse(observed.at(-1)!.data)).toEqual(openAIResponsesEvents.at(-1));
	});

	it("records Anthropic SDK events from the decoded stream", async () => {
		const observed: RawSseEvent[] = [];

		const result = await streamAnthropic(anthropicModel, context, {
			client: createAnthropicSdkClient(anthropicEvents),
			onSseEvent: recordEvent(observed),
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(observed.map(event => event.event)).toEqual(anthropicEvents.map(event => event.type));
		expect(JSON.parse(observed[0]!.data)).toEqual(anthropicEvents[0]);
		expect(observed[0]!.raw).toEqual(["event: message_start", `data: ${JSON.stringify(anthropicEvents[0])}`]);
	});

	it("does not synthesize raw SSE records when no observer is installed", async () => {
		const fetchMock = createFetchResponse(openAIResponsesEvents);

		const result = await streamOpenAIResponses(openAIResponsesModel, context, {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("stop");
	});

	it("keeps Anthropic direct SSE parsing wired to the raw observer", async () => {
		const observed: RawSseEvent[] = [];

		const result = await streamAnthropic(anthropicModel, context, {
			client: createAnthropicRawClient(anthropicEvents),
			onSseEvent: recordEvent(observed),
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(observed.map(event => event.event)).toEqual(anthropicEvents.map(event => event.type));
		expect(observed[0]!.raw).toEqual(["event: message_start", `data: ${JSON.stringify(anthropicEvents[0])}`]);
	});
});
