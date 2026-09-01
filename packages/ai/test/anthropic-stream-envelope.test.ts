import { afterEach, describe, expect, it, vi } from "bun:test";
import { scheduler } from "node:timers/promises";
import { convertAnthropicMessages, streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import {
	AnthropicMessages,
	type AnthropicMessagesClientLike,
	type AnthropicRequestOptions,
} from "@oh-my-pi/pi-ai/providers/anthropic-client";
import type {
	ToolSearchToolResultBlockParam,
	WebSearchToolResultBlockParam,
} from "@oh-my-pi/pi-ai/providers/anthropic-wire";
import type { AssistantMessageEvent, Context, Model, ModelSpec, ProviderSessionState } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { structuredCloneJSON } from "@oh-my-pi/pi-utils";
import { withEnv, withOfficialAnthropicEndpoint } from "./helpers";

const model: Model<"anthropic-messages"> = buildModel({
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

const umansModel: Model<"anthropic-messages"> = buildModel({
	id: "umans-kimi-k2.7",
	name: "Umans Kimi K2.7 Code",
	api: "anthropic-messages",
	provider: "umans",
	baseUrl: "https://api.code.umans.ai",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 262_144,
	maxTokens: 32_768,
});

const context: Context = {
	messages: [{ role: "user", content: "Say hi", timestamp: Date.now() }],
};
const queryObjectSchema = {
	type: "object",
	properties: { query: { type: "string" } },
	required: ["query"],
};

const cityObjectSchema = {
	type: "object",
	properties: { city: { type: "string" } },
	required: ["city"],
};

type MockAnthropicEvent = Record<string, unknown>;
type MockAnthropicStream = AsyncIterable<MockAnthropicEvent>;

// Provider session state is keyed per endpoint+model (`anthropic-messages:<baseUrl>\0<id>`),
// with a legacy unscoped `anthropic-messages` key still honored. Look up the strict-tools
// flag without depending on the exact key shape.
function anthropicStrictToolsDisabled(map: Map<string, ProviderSessionState>): boolean | undefined {
	for (const [key, value] of map) {
		if (key === "anthropic-messages" || key.startsWith("anthropic-messages:")) {
			return (value as { strictToolsDisabled?: boolean }).strictToolsDisabled;
		}
	}
	return undefined;
}
type MockAnthropicRequest = {
	withResponse(): Promise<{
		data: MockAnthropicStream;
		response: Response;
		request_id: string | null;
	}>;
};

function createMockRequest(events: MockAnthropicEvent[]): MockAnthropicRequest {
	const response = new Response(null, {
		status: 200,
		headers: { "request-id": "req_mock" },
	});

	const stream: MockAnthropicStream = {
		async *[Symbol.asyncIterator]() {
			for (const event of events) {
				yield event;
			}
		},
	};

	return {
		async withResponse() {
			return {
				data: stream,
				response,
				request_id: response.headers.get("request-id"),
			};
		},
	};
}
function createRawSseRequest(frames: string[]): { asResponse(): Promise<Response> } {
	const body = new TextEncoder().encode(frames.join(""));
	return {
		async asResponse() {
			return new Response(body, {
				status: 200,
				headers: {
					"content-type": "text/event-stream",
					"request-id": "req_raw_mock",
				},
			});
		},
	};
}

function createNeverClosingRawSseRequest(frames: string[]): { asResponse(): Promise<Response> } {
	return {
		async asResponse() {
			const encoder = new TextEncoder();
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					for (const frame of frames) controller.enqueue(encoder.encode(frame));
				},
			});
			return new Response(body, {
				status: 200,
				headers: {
					"content-type": "text/event-stream",
					"request-id": "req_raw_never_closes",
				},
			});
		},
	};
}

function sseFrame(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function sseRawFrame(event: string, data: string): string {
	return `event: ${event}\ndata: ${data}\n\n`;
}

function createTextSuccessSseFrames(text: string, preamble: string[] = []): string[] {
	return [...preamble, ...createTextSuccessEvents(text).map(event => sseFrame(String(event.type), event))];
}

function createRejectedMockRequest(error: Error): MockAnthropicRequest {
	return {
		async withResponse() {
			throw error;
		},
	};
}

function createStrictGrammarTooLargeError(): Error {
	const error = new Error(
		'400 {"type":"error","error":{"type":"invalid_request_error","message":"The compiled grammar is too large, which would cause performance issues. Simplify your tool schemas or reduce the number of strict tools."},"request_id":"req_test"}',
	);
	(error as Error & { status: number }).status = 400;
	return error;
}

function createOtherInvalidRequestError(): Error {
	const error = new Error(
		'400 {"type":"error","error":{"type":"invalid_request_error","message":"Some other validation error."},"request_id":"req_test"}',
	);
	(error as Error & { status: number }).status = 400;
	return error;
}

function getStrictFlags(params: unknown): boolean[] {
	const tools = (params as { tools?: Array<{ strict?: unknown }> }).tools ?? [];
	return tools.map(tool => tool.strict === true);
}

function createTextSuccessEvents(
	text: string,
	options: { duplicateMessageStart?: boolean; stopReason?: string } = {},
): MockAnthropicEvent[] {
	const events: MockAnthropicEvent[] = [
		{
			type: "message_start",
			message: {
				id: "msg_text_success",
				usage: {
					input_tokens: 12,
					output_tokens: 0,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				},
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: { stop_reason: options.stopReason ?? "end_turn" },
			usage: {
				input_tokens: 12,
				output_tokens: 4,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
		},
		{ type: "message_stop" },
	];
	if (options.duplicateMessageStart) {
		events.splice(2, 0, {
			type: "message_start",
			message: { id: "msg_duplicate", usage: { input_tokens: 99, output_tokens: 99 } },
		});
	}
	return events;
}
function createThinkingSuccessEvents(thinking: string): MockAnthropicEvent[] {
	return [
		{
			type: "message_start",
			message: {
				id: "msg_thinking_success",
				usage: {
					input_tokens: 12,
					output_tokens: 0,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				},
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking } },
		{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig_thinking" } },
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: {
				input_tokens: 12,
				output_tokens: 4,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
		},
		{ type: "message_stop" },
	];
}

function createTextSuccessEventsWithPreamble(text: string, preambleEvents: MockAnthropicEvent[]): MockAnthropicEvent[] {
	return [...preambleEvents, ...createTextSuccessEvents(text)];
}

function createMalformedPreMessageStartEvents(): MockAnthropicEvent[] {
	return [{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }];
}

function createMalformedToolUseEvents(): MockAnthropicEvent[] {
	return [
		{
			type: "message_start",
			message: {
				id: "msg_tool_broken",
				usage: {
					input_tokens: 12,
					output_tokens: 0,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				},
			},
		},
		{
			type: "content_block_start",
			index: 0,
			content_block: { type: "tool_use", id: "tool_broken", name: "lookup_weather", input: {} },
		},
		{
			type: "content_block_delta",
			index: 0,
			delta: { type: "input_json_delta", partial_json: '{"city":"Par' },
		},
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
		},
		{ type: "message_stop" },
	];
}

function createGenuinelyMalformedToolUseEvents(): MockAnthropicEvent[] {
	return [
		{
			type: "message_start",
			message: {
				id: "msg_tool_broken",
				usage: {
					input_tokens: 12,
					output_tokens: 0,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				},
			},
		},
		{
			type: "content_block_start",
			index: 0,
			content_block: { type: "tool_use", id: "tool_broken", name: "lookup_weather", input: {} },
		},
		{
			type: "content_block_delta",
			index: 0,
			delta: { type: "input_json_delta", partial_json: '{"city": Par' },
		},
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
		},
		{ type: "message_stop" },
	];
}

function createUnterminatedToolUseSplicedReconnectEvents(): MockAnthropicEvent[] {
	return [
		{
			type: "message_start",
			message: {
				id: "msg_tool_truncated",
				usage: { input_tokens: 12, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			},
		},
		// Tool call begins streaming but the transport drops before any argument
		// bytes — and before `content_block_stop` — arrive, so `arguments` is still
		// the seed `{}`.
		{
			type: "content_block_start",
			index: 0,
			content_block: { type: "tool_use", id: "tool_truncated", name: "lookup_weather", input: {} },
		},
		{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "" } },
		// A transparent reconnect splices a fresh message envelope onto the same
		// stream. The duplicate `message_start` is deduped, but the orphaned tool
		// block above is never closed and the reconnect supplies the terminal stop.
		{
			type: "message_start",
			message: {
				id: "msg_reconnect",
				usage: { input_tokens: 12, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			},
		},
		{
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
		},
		{ type: "message_stop" },
	];
}

function countEvents(events: AssistantMessageEvent[], type: AssistantMessageEvent["type"]): number {
	return events.filter(event => event.type === type).length;
}

afterEach(() => {
	vi.restoreAllMocks();
});

withOfficialAnthropicEndpoint();

describe("anthropic stream envelope handling", () => {
	it("ignores duplicate message_start envelopes without resetting streamed text", async () => {
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(
			() => createMockRequest(createTextSuccessEvents("hello", { duplicateMessageStart: true })) as never,
		);

		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const result = await stream.result();

		expect(countEvents(events, "text_start")).toBe(1);
		expect(countEvents(events, "text_delta")).toBe(1);
		expect(countEvents(events, "text_end")).toBe(1);
		expect(countEvents(events, "done")).toBe(1);
		expect(result.stopReason).toBe("stop");
		expect(result.responseId).toBe("msg_text_success");
		expect(JSON.parse(JSON.stringify(result.content))).toEqual([{ type: "text", text: "hello" }]);
	});

	it("decodes escaped Anthropic built-in tool names from compatible gateways", async () => {
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(
			() =>
				createMockRequest([
					{
						type: "message_start",
						message: {
							id: "msg_tool",
							usage: {
								input_tokens: 12,
								output_tokens: 0,
								cache_read_input_tokens: 0,
								cache_creation_input_tokens: 0,
							},
						},
					},
					{
						type: "content_block_start",
						index: 0,
						content_block: { type: "tool_use", id: "tool_1", name: "_web_search", input: {} },
					},
					{
						type: "content_block_delta",
						index: 0,
						delta: { type: "input_json_delta", partial_json: '{"query":"5+54"}' },
					},
					{ type: "content_block_stop", index: 0 },
					{
						type: "message_delta",
						delta: { stop_reason: "tool_use" },
						usage: {
							input_tokens: 12,
							output_tokens: 4,
							cache_read_input_tokens: 0,
							cache_creation_input_tokens: 0,
						},
					},
					{ type: "message_stop" },
				]) as never,
		);

		const stream = streamAnthropic(umansModel, context, { apiKey: "sk-ant-test" });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const result = await stream.result();

		expect(countEvents(events, "toolcall_start")).toBe(1);
		expect(result.stopReason).toBe("toolUse");
		expect(JSON.parse(JSON.stringify(result.content))).toEqual([
			{
				type: "toolCall",
				id: "tool_1",
				name: "web_search",
				arguments: { query: "5+54" },
			},
		]);
	});

	it("decodes escaped literal-prefixed Umans tool names", async () => {
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(
			() =>
				createMockRequest([
					{
						type: "message_start",
						message: {
							id: "msg_literal_tool",
							usage: {
								input_tokens: 12,
								output_tokens: 0,
								cache_read_input_tokens: 0,
								cache_creation_input_tokens: 0,
							},
						},
					},
					{
						type: "content_block_start",
						index: 0,
						content_block: { type: "tool_use", id: "tool_1", name: "__web_search", input: {} },
					},
					{
						type: "content_block_delta",
						index: 0,
						delta: { type: "input_json_delta", partial_json: '{"query":"literal"}' },
					},
					{ type: "content_block_stop", index: 0 },
					{
						type: "message_delta",
						delta: { stop_reason: "tool_use" },
						usage: {
							input_tokens: 12,
							output_tokens: 4,
							cache_read_input_tokens: 0,
							cache_creation_input_tokens: 0,
						},
					},
					{ type: "message_stop" },
				]) as never,
		);

		const stream = streamAnthropic(umansModel, context, { apiKey: "sk-ant-test" });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const result = await stream.result();

		expect(countEvents(events, "toolcall_start")).toBe(1);
		expect(result.stopReason).toBe("toolUse");
		expect(JSON.parse(JSON.stringify(result.content))).toEqual([
			{
				type: "toolCall",
				id: "tool_1",
				name: "_web_search",
				arguments: { query: "literal" },
			},
		]);
	});

	it("ignores Umans gateway web search server blocks and keeps final text", async () => {
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(
			() =>
				createMockRequest([
					{
						type: "message_start",
						message: {
							id: "msg_server_search",
							usage: {
								input_tokens: 12,
								output_tokens: 0,
								cache_read_input_tokens: 0,
								cache_creation_input_tokens: 0,
							},
						},
					},
					{
						type: "content_block_start",
						index: 0,
						content_block: { type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "5+54" } },
					},
					{ type: "content_block_stop", index: 0 },
					{
						type: "content_block_start",
						index: 1,
						content_block: { type: "web_search_tool_result", tool_use_id: "srv_1", content: [] },
					},
					{ type: "content_block_stop", index: 1 },
					{ type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
					{ type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "59" } },
					{ type: "content_block_stop", index: 2 },
					{
						type: "message_delta",
						delta: { stop_reason: "end_turn" },
						usage: {
							input_tokens: 12,
							output_tokens: 4,
							cache_read_input_tokens: 0,
							cache_creation_input_tokens: 0,
						},
					},
					{ type: "message_stop" },
				]) as never,
		);

		const stream = streamAnthropic(umansModel, context, {
			apiKey: "sk-ant-test",
			headers: { "X-Umans-Websearch-Provider": "exa" },
		});
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const result = await stream.result();

		expect(countEvents(events, "toolcall_start")).toBe(0);
		expect(result.stopReason).toBe("stop");
		expect(JSON.parse(JSON.stringify(result.content))).toEqual([{ type: "text", text: "59" }]);
	});

	it("replays native server-tool blocks in their original assistant order", async () => {
		const searchResult: WebSearchToolResultBlockParam = {
			type: "web_search_tool_result",
			tool_use_id: "srvtoolu_1",
			content: [
				{
					type: "web_search_result",
					url: "https://example.com/result",
					title: "Search result",
					encrypted_content: "encrypted-result",
					page_age: "July 24, 2026",
				},
			],
		};
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(
			() =>
				createMockRequest([
					{
						type: "message_start",
						message: {
							id: "msg_native_search",
							usage: {
								input_tokens: 12,
								output_tokens: 0,
								cache_read_input_tokens: 0,
								cache_creation_input_tokens: 0,
							},
						},
					},
					{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
					{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Search first." } },
					{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-1" } },
					{ type: "content_block_stop", index: 0 },
					{
						type: "content_block_start",
						index: 1,
						content_block: { type: "server_tool_use", id: "srvtoolu_1", name: "web_search" },
					},
					{
						type: "content_block_delta",
						index: 1,
						delta: { type: "input_json_delta", partial_json: '{"query":"current weather"}' },
					},
					{ type: "content_block_stop", index: 1 },
					{ type: "content_block_start", index: 2, content_block: searchResult },
					{ type: "content_block_stop", index: 2 },
					{ type: "content_block_start", index: 3, content_block: { type: "thinking", thinking: "" } },
					{ type: "content_block_delta", index: 3, delta: { type: "thinking_delta", thinking: "Read the file." } },
					{ type: "content_block_delta", index: 3, delta: { type: "signature_delta", signature: "sig-2" } },
					{ type: "content_block_stop", index: 3 },
					{ type: "content_block_start", index: 4, content_block: { type: "text", text: "" } },
					{ type: "content_block_delta", index: 4, delta: { type: "text_delta", text: "I found the forecast." } },
					{ type: "content_block_stop", index: 4 },
					{
						type: "content_block_start",
						index: 5,
						content_block: { type: "tool_use", id: "tool_1", name: "read", input: {} },
					},
					{
						type: "content_block_delta",
						index: 5,
						delta: { type: "input_json_delta", partial_json: '{"path":"forecast.txt"}' },
					},
					{ type: "content_block_stop", index: 5 },
					{
						type: "message_delta",
						delta: { stop_reason: "tool_use" },
						usage: {
							input_tokens: 12,
							output_tokens: 20,
							cache_read_input_tokens: 0,
							cache_creation_input_tokens: 0,
							server_tool_use: { web_search_requests: 1 },
						},
					},
					{ type: "message_stop" },
				]) as never,
		);

		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
		for await (const _ of stream) {
			// drain stream
		}
		const result = await stream.result();
		const persistedResult = structuredCloneJSON(result);
		const replay = convertAnthropicMessages(
			[
				context.messages[0],
				persistedResult,
				{
					role: "toolResult",
					toolCallId: "tool_1",
					toolName: "read",
					content: [{ type: "text", text: "forecast contents" }],
					isError: false,
					timestamp: 2,
				},
			],
			model,
			false,
		);
		const assistant = replay.find(message => message.role === "assistant");

		expect(assistant?.content).toEqual([
			{ type: "thinking", thinking: "Search first.", signature: "sig-1" },
			{
				type: "server_tool_use",
				id: "srvtoolu_1",
				name: "web_search",
				input: { query: "current weather" },
			},
			searchResult,
			{ type: "thinking", thinking: "Read the file.", signature: "sig-2" },
			{ type: "text", text: "I found the forecast." },
			{ type: "tool_use", id: "tool_1", name: "read", input: { path: "forecast.txt" } },
		]);
		expect(replay.at(-1)?.content).toEqual([
			{
				type: "tool_result",
				tool_use_id: "tool_1",
				content: "forecast contents",
				is_error: false,
			},
		]);
	});

	it("replays tool-search server blocks between signed thinking and a client tool call", async () => {
		const toolSearchResult: ToolSearchToolResultBlockParam = {
			type: "tool_search_tool_result",
			tool_use_id: "srvtoolu_search",
			content: {
				type: "tool_search_tool_search_result",
				tool_references: [{ type: "tool_reference", tool_name: "_read" }],
			},
		};
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(
			() =>
				createMockRequest([
					{
						type: "message_start",
						message: {
							id: "msg_tool_search",
							usage: {
								input_tokens: 12,
								output_tokens: 0,
								cache_read_input_tokens: 0,
								cache_creation_input_tokens: 0,
							},
						},
					},
					{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
					{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Find read." } },
					{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-1" } },
					{ type: "content_block_stop", index: 0 },
					{
						type: "content_block_start",
						index: 1,
						content_block: {
							type: "server_tool_use",
							id: "srvtoolu_search",
							name: "tool_search_tool_regex",
						},
					},
					{
						type: "content_block_delta",
						index: 1,
						delta: { type: "input_json_delta", partial_json: '{"pattern":"read"}' },
					},
					{ type: "content_block_stop", index: 1 },
					{ type: "content_block_start", index: 2, content_block: toolSearchResult },
					{ type: "content_block_stop", index: 2 },
					{ type: "content_block_start", index: 3, content_block: { type: "thinking", thinking: "" } },
					{ type: "content_block_delta", index: 3, delta: { type: "thinking_delta", thinking: "Use read." } },
					{ type: "content_block_delta", index: 3, delta: { type: "signature_delta", signature: "sig-2" } },
					{ type: "content_block_stop", index: 3 },
					{
						type: "content_block_start",
						index: 4,
						content_block: { type: "tool_use", id: "tool_1", name: "_read", input: {} },
					},
					{
						type: "content_block_delta",
						index: 4,
						delta: { type: "input_json_delta", partial_json: '{"path":"notes.txt"}' },
					},
					{ type: "content_block_stop", index: 4 },
					{
						type: "message_delta",
						delta: { stop_reason: "tool_use" },
						usage: {
							input_tokens: 12,
							output_tokens: 20,
							cache_read_input_tokens: 0,
							cache_creation_input_tokens: 0,
						},
					},
					{ type: "message_stop" },
				]) as never,
		);

		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
		for await (const _ of stream) {
			// drain stream
		}
		const result = structuredCloneJSON(await stream.result());
		const replay = convertAnthropicMessages(
			[
				context.messages[0],
				result,
				{
					role: "toolResult",
					toolCallId: "tool_1",
					toolName: "_read",
					content: [{ type: "text", text: "notes" }],
					isError: false,
					timestamp: 2,
				},
			],
			model,
			false,
		);
		const assistant = replay.find(message => message.role === "assistant");

		expect(assistant?.content).toEqual([
			{ type: "thinking", thinking: "Find read.", signature: "sig-1" },
			{
				type: "server_tool_use",
				id: "srvtoolu_search",
				name: "tool_search_tool_regex",
				input: { pattern: "read" },
			},
			toolSearchResult,
			{ type: "thinking", thinking: "Use read.", signature: "sig-2" },
			{ type: "tool_use", id: "tool_1", name: "_read", input: { path: "notes.txt" } },
		]);
	});

	it("does not persist a code-execution call without its unsupported result block", async () => {
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(
			() =>
				createMockRequest([
					{
						type: "message_start",
						message: {
							id: "msg_code_execution",
							usage: {
								input_tokens: 12,
								output_tokens: 0,
								cache_read_input_tokens: 0,
								cache_creation_input_tokens: 0,
							},
						},
					},
					{
						type: "content_block_start",
						index: 0,
						content_block: {
							type: "server_tool_use",
							id: "srvtoolu_code",
							name: "bash_code_execution",
						},
					},
					{
						type: "content_block_delta",
						index: 0,
						delta: { type: "input_json_delta", partial_json: '{"command":"printf ok"}' },
					},
					{ type: "content_block_stop", index: 0 },
					{
						type: "content_block_start",
						index: 1,
						content_block: {
							type: "bash_code_execution_tool_result",
							tool_use_id: "srvtoolu_code",
							content: {
								type: "bash_code_execution_result",
								stdout: "ok",
								stderr: "",
								return_code: 0,
								content: [],
							},
						},
					},
					{ type: "content_block_stop", index: 1 },
					{ type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
					{ type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "done" } },
					{ type: "content_block_stop", index: 2 },
					{
						type: "message_delta",
						delta: { stop_reason: "end_turn" },
						usage: {
							input_tokens: 12,
							output_tokens: 8,
							cache_read_input_tokens: 0,
							cache_creation_input_tokens: 0,
						},
					},
					{ type: "message_stop" },
				]) as never,
		);

		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
		for await (const _ of stream) {
			// drain stream
		}
		const result = await stream.result();

		expect(JSON.parse(JSON.stringify(result.content))).toEqual([{ type: "text", text: "done" }]);
	});

	it("passes Umans gateway web search headers to custom clients", async () => {
		type CapturedPayload = { tools?: Array<{ name?: string }> };
		let capturedParams: CapturedPayload | undefined;
		let capturedOptions: AnthropicRequestOptions | undefined;
		const client: AnthropicMessagesClientLike = {
			messages: {
				create(params, options) {
					capturedParams = params as CapturedPayload;
					capturedOptions = options;
					return createMockRequest(createTextSuccessEvents("59"));
				},
			},
		};

		const stream = streamAnthropic(
			umansModel,
			{
				...context,
				tools: [
					{
						name: "web_search",
						description: "Search the web",
						parameters: queryObjectSchema,
					},
				],
			},
			{
				client,
				headers: { "X-Umans-Websearch-Provider": "exa" },
			},
		);
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const result = await stream.result();

		expect(JSON.parse(JSON.stringify(result.content))).toEqual([{ type: "text", text: "59" }]);
		expect(capturedParams?.tools?.map(tool => tool.name)).toEqual(["web_search"]);
		expect(capturedOptions?.headers).toEqual({ "X-Umans-Websearch-Provider": "exa" });
	});

	it("does not send context_management through injected clients", async () => {
		type CapturedPayload = {
			thinking?: { type?: string };
			context_management?: unknown;
		};
		let capturedParams: CapturedPayload | undefined;
		const client: AnthropicMessagesClientLike = {
			messages: {
				create(params) {
					capturedParams = params as CapturedPayload;
					return createMockRequest(createTextSuccessEvents("done"));
				},
			},
		};

		const stream = streamAnthropic(model, context, {
			client,
			thinkingEnabled: true,
		});
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const result = await stream.result();

		expect(JSON.parse(JSON.stringify(result.content))).toEqual([{ type: "text", text: "done" }]);
		expect(capturedParams?.thinking?.type).toBe("enabled");
		expect(capturedParams?.context_management).toBeUndefined();
	});
	it("unwraps thinking blocks that Anthropic streams with literal thinking tags", async () => {
		const wrappedThinking =
			"<thinking>\n<thinking>\nCheck logs before accepting container health.\n</thinking></thinking>";
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(
			() => createMockRequest(createThinkingSuccessEvents(wrappedThinking)) as never,
		);

		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const result = await stream.result();

		expect(countEvents(events, "thinking_start")).toBe(1);
		expect(countEvents(events, "thinking_end")).toBe(1);
		expect(result.stopReason).toBe("stop");
		expect(result.content).toHaveLength(1);
		const block = result.content[0];
		expect(block?.type).toBe("thinking");
		if (block?.type !== "thinking") {
			throw new Error("Expected thinking content after wrapped thinking stream");
		}
		expect(block.thinking).toBe("Check logs before accepting container health.");
		expect(block.thinkingSignature).toBeUndefined();

		const replayParams = convertAnthropicMessages(
			[
				{ role: "user", content: "Say hi", timestamp: 1 },
				result,
				{ role: "user", content: "follow up", timestamp: 2 },
			],
			model,
			false,
		);
		// The unwrapped thinking block carries no signature. On same-model replay to
		// signature-enforcing Anthropic an unsigned thinking block is dropped entirely — it cannot
		// replay natively (a "" signature 400s) and must not be demoted to text (demotion trips the
		// reasoning_extraction classifier). It was this turn's only content, so the whole assistant
		// message falls away, leaving just the two surrounding user turns with no leaked reasoning.
		const replayAssistant = replayParams.find(param => param.role === "assistant");
		expect(replayAssistant).toBeUndefined();
		expect(replayParams.map(param => param.role)).toEqual(["user", "user"]);
		expect(replayParams.every(param => !JSON.stringify(param.content).includes("Check logs"))).toBe(true);
	});
	it("preserves signed thinking bytes when no literal thinking envelope is present", async () => {
		const signedThinking = "\nCheck logs before accepting container health.\n";
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(
			() => createMockRequest(createThinkingSuccessEvents(signedThinking)) as never,
		);

		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
		for await (const _ of stream) {
			// drain stream
		}
		const result = await stream.result();

		expect(result.stopReason).toBe("stop");
		expect(result.content).toHaveLength(1);
		const block = result.content[0];
		expect(block?.type).toBe("thinking");
		if (block?.type !== "thinking") {
			throw new Error("Expected signed thinking content");
		}
		expect(block.thinking).toBe(signedThinking);
		expect(block.thinkingSignature).toBe("sig_thinking");

		const replayParams = convertAnthropicMessages(
			[
				{ role: "user", content: "Say hi", timestamp: 1 },
				result,
				{ role: "user", content: "follow up", timestamp: 2 },
			],
			model,
			false,
		);
		const replayAssistant = replayParams.find(param => param.role === "assistant");
		expect(replayAssistant?.content).toEqual([
			{ type: "thinking", thinking: signedThinking, signature: "sig_thinking" },
		]);
	});

	it("drops replayed closed blocks after a duplicate message_start instead of duplicating content", async () => {
		const events: MockAnthropicEvent[] = [
			{
				type: "message_start",
				message: { id: "msg_first", usage: { input_tokens: 12, output_tokens: 0 } },
			},
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
			{ type: "content_block_stop", index: 0 },
			// A replaying proxy splices the same envelope again before the
			// terminal message_delta arrives.
			{ type: "message_start", message: { id: "msg_replay", usage: { input_tokens: 12, output_tokens: 0 } } },
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
			{ type: "content_block_stop", index: 0 },
			{
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { input_tokens: 12, output_tokens: 4 },
			},
			{ type: "message_stop" },
		];
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(() => createMockRequest(events) as never);

		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
		const collected: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			collected.push(event);
		}
		const result = await stream.result();

		expect(countEvents(collected, "text_start")).toBe(1);
		expect(countEvents(collected, "text_end")).toBe(1);
		expect(countEvents(collected, "error")).toBe(0);
		expect(result.stopReason).toBe("stop");
		expect(result.responseId).toBe("msg_first");
		expect(JSON.parse(JSON.stringify(result.content))).toEqual([{ type: "text", text: "hello" }]);
	});

	it("ignores ping before message_start and streams the response once", async () => {
		let attempt = 0;
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(() => {
			attempt += 1;
			return createMockRequest(createTextSuccessEventsWithPreamble("hello", [{ type: "ping" }])) as never;
		});

		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const result = await stream.result();

		expect(attempt).toBe(1);
		expect(countEvents(events, "error")).toBe(0);
		expect(countEvents(events, "text_start")).toBe(1);
		expect(countEvents(events, "text_delta")).toBe(1);
		expect(countEvents(events, "text_end")).toBe(1);
		expect(countEvents(events, "done")).toBe(1);
		expect(result.stopReason).toBe("stop");
		expect(result.responseId).toBe("msg_text_success");
		expect(JSON.parse(JSON.stringify(result.content))).toEqual([{ type: "text", text: "hello" }]);
	});

	it("maps model_context_window_exceeded to a length stop", async () => {
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(
			() =>
				createMockRequest(
					createTextSuccessEvents("hello", { stopReason: "model_context_window_exceeded" }),
				) as never,
		);

		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const result = await stream.result();

		expect(countEvents(events, "error")).toBe(0);
		expect(countEvents(events, "done")).toBe(1);
		expect(result.stopReason).toBe("length");
		expect(JSON.parse(JSON.stringify(result.content))).toEqual([{ type: "text", text: "hello" }]);
	});

	it("completes the turn instead of failing when the API sends an unknown stop reason", async () => {
		let attempt = 0;
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(() => {
			attempt += 1;
			return createMockRequest(createTextSuccessEvents("hello", { stopReason: "weird_new_reason" })) as never;
		});

		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const result = await stream.result();

		// The unknown reason arrives after all content streamed; it must not burn
		// a retry or surface as an error.
		expect(attempt).toBe(1);
		expect(countEvents(events, "error")).toBe(0);
		expect(countEvents(events, "done")).toBe(1);
		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(JSON.parse(JSON.stringify(result.content))).toEqual([{ type: "text", text: "hello" }]);
	});

	it("ignores a spliced second envelope's message_delta after the terminal stop", async () => {
		const events: MockAnthropicEvent[] = [
			...createTextSuccessEvents("hello"),
			// Transparent reconnect splices a fresh envelope onto the same stream.
			{ type: "message_start", message: { id: "msg_second", usage: { input_tokens: 99, output_tokens: 99 } } },
			{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { input_tokens: 99, output_tokens: 99 } },
			{ type: "message_stop" },
		];
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(() => createMockRequest(events) as never);

		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
		const collected: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			collected.push(event);
		}
		const result = await stream.result();

		// The completed first envelope owns the stop reason and usage; the splice
		// must not relabel a finished turn or overwrite its counters.
		expect(countEvents(collected, "error")).toBe(0);
		expect(countEvents(collected, "done")).toBe(1);
		expect(result.stopReason).toBe("stop");
		expect(result.usage.output).toBe(4);
		expect(result.responseId).toBe("msg_text_success");
		expect(JSON.parse(JSON.stringify(result.content))).toEqual([{ type: "text", text: "hello" }]);
	});

	it("tolerates envelopes missing usage and delta payloads", async () => {
		const events: MockAnthropicEvent[] = [
			{ type: "message_start", message: { id: "msg_lenient" } },
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0 },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
			{ type: "content_block_stop", index: 0 },
			{ type: "message_delta" },
			{ type: "message_delta", delta: { stop_reason: "end_turn" } },
			{ type: "message_stop" },
		];
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(() => createMockRequest(events) as never);

		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
		const collected: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			collected.push(event);
		}
		const result = await stream.result();

		// Proxies that omit usage/delta objects must degrade to anomaly logs, not
		// TypeErrors that fail the turn.
		expect(countEvents(collected, "error")).toBe(0);
		expect(countEvents(collected, "done")).toBe(1);
		expect(result.stopReason).toBe("stop");
		expect(result.responseId).toBe("msg_lenient");
		expect(JSON.parse(JSON.stringify(result.content))).toEqual([{ type: "text", text: "hi" }]);
	});

	it("ignores unknown preamble events before message_start and streams the response once", async () => {
		let attempt = 0;
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(() => {
			attempt += 1;
			return createMockRequest(
				createTextSuccessEventsWithPreamble("hello", [{ type: "custom_preamble_event", trace_id: "trace_123" }]),
			) as never;
		});

		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const result = await stream.result();

		expect(attempt).toBe(1);
		expect(countEvents(events, "error")).toBe(0);
		expect(countEvents(events, "text_start")).toBe(1);
		expect(countEvents(events, "text_delta")).toBe(1);
		expect(countEvents(events, "text_end")).toBe(1);
		expect(countEvents(events, "done")).toBe(1);
		expect(result.stopReason).toBe("stop");
		expect(result.responseId).toBe("msg_text_success");
		expect(JSON.parse(JSON.stringify(result.content))).toEqual([{ type: "text", text: "hello" }]);
	});

	it("ignores unknown content block envelopes while preserving known blocks", async () => {
		const events: MockAnthropicEvent[] = [
			{
				type: "message_start",
				message: {
					id: "msg_unknown_block",
					usage: {
						input_tokens: 12,
						output_tokens: 0,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				},
			},
			{
				type: "content_block_start",
				index: 0,
				content_block: { type: "future_server_block", id: "srv_1", name: "web_search" },
			},
			{
				type: "content_block_delta",
				index: 0,
				delta: { type: "input_json_delta", partial_json: '{"query":"weather"}' },
			},
			{ type: "content_block_stop", index: 0 },
			{ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "hello" } },
			{ type: "content_block_stop", index: 1 },
			{
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: {
					input_tokens: 12,
					output_tokens: 4,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				},
			},
			{ type: "message_stop" },
		];
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(() => createMockRequest(events) as never);

		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
		const observed: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			observed.push(event);
		}
		const result = await stream.result();

		expect(countEvents(observed, "error")).toBe(0);
		expect(countEvents(observed, "done")).toBe(1);
		expect(result.stopReason).toBe("stop");
		expect(result.responseId).toBe("msg_unknown_block");
		expect(JSON.parse(JSON.stringify(result.content))).toEqual([{ type: "text", text: "hello" }]);
	});

	it("retries malformed envelopes before content starts without duplicating streamed text events", async () => {
		let attempt = 0;
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(() => {
			attempt += 1;
			return createMockRequest(
				attempt === 1 ? createMalformedPreMessageStartEvents() : createTextSuccessEvents("recovered"),
			) as never;
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const result = await stream.result();

		expect(attempt).toBe(2);
		expect(countEvents(events, "text_start")).toBe(1);
		expect(countEvents(events, "text_delta")).toBe(1);
		expect(countEvents(events, "text_end")).toBe(1);
		expect(countEvents(events, "done")).toBe(1);
		expect(result.stopReason).toBe("stop");
		expect(JSON.parse(JSON.stringify(result.content))).toEqual([{ type: "text", text: "recovered" }]);
	});

	it("retries without strict tools after Anthropic compiled grammar errors and keeps strict disabled", async () => {
		const toolContext: Context = {
			...context,
			tools: [
				{
					name: "edit",
					description: "Edit a value",
					strict: true,
					parameters: queryObjectSchema,
				},
			],
		};
		const providerSessionState = new Map<string, ProviderSessionState>();
		const strictFlags: boolean[][] = [];
		let attempt = 0;
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation((params: unknown) => {
			attempt += 1;
			strictFlags.push(getStrictFlags(params));
			if (attempt === 1) {
				return createRejectedMockRequest(createStrictGrammarTooLargeError()) as never;
			}
			return createMockRequest(createTextSuccessEvents(attempt === 2 ? "recovered" : "later")) as never;
		});

		const stream = streamAnthropic(model, toolContext, { apiKey: "sk-ant-test", providerSessionState });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const result = await stream.result();

		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(JSON.parse(JSON.stringify(result.content))).toEqual([{ type: "text", text: "recovered" }]);
		expect(countEvents(events, "done")).toBe(1);
		expect(countEvents(events, "error")).toBe(0);
		expect(strictFlags).toEqual([[true], [false]]);
		expect(anthropicStrictToolsDisabled(providerSessionState)).toBe(true);

		const nextStream = streamAnthropic(model, toolContext, { apiKey: "sk-ant-test", providerSessionState });
		const nextEvents: AssistantMessageEvent[] = [];
		for await (const event of nextStream) {
			nextEvents.push(event);
		}
		const nextResult = await nextStream.result();

		expect(nextResult.stopReason).toBe("stop");
		expect(JSON.parse(JSON.stringify(nextResult.content))).toEqual([{ type: "text", text: "later" }]);
		expect(countEvents(nextEvents, "done")).toBe(1);
		expect(countEvents(nextEvents, "error")).toBe(0);
		expect(strictFlags).toEqual([[true], [false], [false]]);
	});

	it.each([
		[
			"unsupported structured outputs",
			Object.assign(new Error('400 {"error":{"code":"BadRequest","message":"structured_outputs not supported"}}'), {
				status: 400,
			}),
		],
		[
			"an unsupported strict field",
			Object.assign(
				new Error(
					'400 {"error":{"message":"{\\"message\\":\\"tools.2.custom.strict: Extra inputs are not permitted\\"}"}}',
				),
				{ status: 400 },
			),
		],
	])("retries without strict tools when the endpoint rejects %s", async (_case, rejection) => {
		const toolContext: Context = {
			...context,
			tools: [
				{
					name: "edit",
					description: "Edit a value",
					strict: true,
					parameters: queryObjectSchema,
				},
			],
		};
		const providerSessionState = new Map<string, ProviderSessionState>();
		const strictFlags: boolean[][] = [];
		let attempt = 0;
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation((params: unknown) => {
			attempt += 1;
			strictFlags.push(getStrictFlags(params));
			if (attempt === 1) {
				return createRejectedMockRequest(rejection) as never;
			}
			return createMockRequest(createTextSuccessEvents("recovered")) as never;
		});

		const stream = streamAnthropic(model, toolContext, { apiKey: "sk-ant-test", providerSessionState });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const result = await stream.result();

		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(JSON.parse(JSON.stringify(result.content))).toEqual([{ type: "text", text: "recovered" }]);
		expect(countEvents(events, "error")).toBe(0);
		expect(strictFlags).toEqual([[true], [false]]);
		expect(anthropicStrictToolsDisabled(providerSessionState)).toBe(true);
	});

	it("does not disable strict tools for unrelated Anthropic invalid request errors", async () => {
		const toolContext: Context = {
			...context,
			tools: [
				{
					name: "edit",
					description: "Edit a value",
					strict: true,
					parameters: queryObjectSchema,
				},
			],
		};
		const providerSessionState = new Map<string, ProviderSessionState>();
		const strictFlags: boolean[][] = [];
		let attempt = 0;
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation((params: unknown) => {
			attempt += 1;
			strictFlags.push(getStrictFlags(params));
			return createRejectedMockRequest(createOtherInvalidRequestError()) as never;
		});

		const stream = streamAnthropic(model, toolContext, { apiKey: "sk-ant-test", providerSessionState });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const result = await stream.result();

		expect(attempt).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Some other validation error");
		expect(countEvents(events, "error")).toBe(1);
		expect(countEvents(events, "done")).toBe(0);
		expect(strictFlags).toEqual([[true]]);
		expect(anthropicStrictToolsDisabled(providerSessionState)).toBe(false);
	});

	it("finalizes a tool call with malformed argument JSON as best-effort content instead of erroring", async () => {
		let attempt = 0;
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(() => {
			attempt += 1;
			return createMockRequest(createMalformedToolUseEvents()) as never;
		});

		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const result = await stream.result();

		expect(attempt).toBe(1);
		expect(countEvents(events, "toolcall_start")).toBe(1);
		expect(countEvents(events, "toolcall_delta")).toBe(1);
		expect(countEvents(events, "toolcall_end")).toBe(1);
		expect(countEvents(events, "error")).toBe(0);
		expect(countEvents(events, "done")).toBe(1);
		expect(result.stopReason).toBe("stop");

		const toolCall = result.content[0];
		expect(toolCall?.type).toBe("toolCall");
		if (toolCall?.type !== "toolCall") {
			throw new Error("Expected toolCall content in degraded payload");
		}
		// Best-effort arguments recovered by the throttled streaming parser are retained.
		expect(toolCall.arguments).toEqual({ city: "Par" });
		expect((toolCall as unknown as Record<string, unknown>).partialJson).toBeUndefined();
	});

	it("records __parseError and pre-truncated __rawJson when partialParse fails on malformed JSON", async () => {
		let attempt = 0;
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(() => {
			attempt += 1;
			return createMockRequest(createGenuinelyMalformedToolUseEvents()) as never;
		});

		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const result = await stream.result();

		expect(attempt).toBe(1);

		const toolCall = result.content[0];
		expect(toolCall?.type).toBe("toolCall");
		if (toolCall?.type !== "toolCall") {
			throw new Error("Expected toolCall content");
		}
		expect(toolCall.arguments.__parseError).toBeDefined();
		expect(toolCall.arguments.__rawJson).toBeDefined();
		expect(toolCall.arguments.__rawJson).toContain('{"city": Par');
	});

	it("finalizes a tool call left open by a spliced reconnect instead of erroring", async () => {
		let attempt = 0;
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(() => {
			attempt += 1;
			return createMockRequest(createUnterminatedToolUseSplicedReconnectEvents()) as never;
		});

		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const result = await stream.result();

		// Non-fatal: the unterminated tool block is finalized with its seed `{}` arguments and the
		// turn completes rather than erroring. Downstream argument validation handles the incomplete call.
		expect(attempt).toBe(1);
		expect(countEvents(events, "toolcall_start")).toBe(1);
		expect(countEvents(events, "toolcall_end")).toBe(1);
		expect(countEvents(events, "done")).toBe(1);
		expect(countEvents(events, "error")).toBe(0);
		expect(result.stopReason).toBe("stop");

		const toolCall = result.content[0];
		expect(toolCall?.type).toBe("toolCall");
		if (toolCall?.type !== "toolCall") {
			throw new Error("Expected toolCall content in degraded payload");
		}
		expect(toolCall.arguments).toEqual({});
	});
	it("parses raw SSE directly so unknown events do not fail Anthropic streams", async () => {
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(
			() =>
				createRawSseRequest(
					createTextSuccessSseFrames("hello", [
						sseFrame("anthropic_internal_trace", { type: "anthropic_internal_trace", trace_id: "trace_123" }),
					]),
				) as never,
		);

		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const result = await stream.result();

		expect(countEvents(events, "error")).toBe(0);
		expect(countEvents(events, "done")).toBe(1);
		expect(result.stopReason).toBe("stop");
		expect(JSON.parse(JSON.stringify(result.content))).toEqual([{ type: "text", text: "hello" }]);
	});

	it("finishes on message_stop when the raw SSE connection stays open", async () => {
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(
			() => createNeverClosingRawSseRequest(createTextSuccessSseFrames("complete")) as never,
		);

		const stream = streamAnthropic(model, context, {
			apiKey: "sk-ant-test",
			signal: AbortSignal.timeout(500),
		});
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const result = await stream.result();

		expect(countEvents(events, "error")).toBe(0);
		expect(countEvents(events, "done")).toBe(1);
		expect(result.stopReason).toBe("stop");
		expect(JSON.parse(JSON.stringify(result.content))).toEqual([{ type: "text", text: "complete" }]);
	});

	it("degrades to best-effort content when a raw SSE stream closes before message_stop", async () => {
		const incompleteFrames = createTextSuccessSseFrames("partial").filter(
			frame => !frame.includes("event: message_stop"),
		);
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(
			() => createRawSseRequest(incompleteFrames) as never,
		);

		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const result = await stream.result();

		expect(countEvents(events, "error")).toBe(0);
		expect(countEvents(events, "done")).toBe(1);
		expect(result.stopReason).toBe("stop");
		expect(JSON.parse(JSON.stringify(result.content))).toEqual([{ type: "text", text: "partial" }]);
	});

	it("retries a stream cut before any stop_reason when no content streamed", async () => {
		const successEvents = createTextSuccessEvents("recovered");
		let attempt = 0;
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(() => {
			attempt += 1;
			if (attempt === 1) {
				// Connection died right after the envelope opened: only message_start
				// arrived — no blocks, no message_delta stop_reason, no message_stop.
				// (Any content_block_start already marks the stream replay-unsafe,
				// which forbids the transparent retry.)
				return createMockRequest([successEvents[0]]) as never;
			}
			return createMockRequest(createTextSuccessEvents("recovered")) as never;
		});

		const stream = streamAnthropic(model, context, {
			apiKey: "sk-ant-test",
			providerRetryWait: async () => {},
		});
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const result = await stream.result();

		expect(attempt).toBe(2);
		expect(countEvents(events, "error")).toBe(0);
		expect(countEvents(events, "done")).toBe(1);
		expect(result.stopReason).toBe("stop");
		expect(JSON.parse(JSON.stringify(result.content))).toEqual([{ type: "text", text: "recovered" }]);
	});

	it("fails the turn instead of finalizing a clean stop when the stream dies mid-generation", async () => {
		// message_start + content_block_start + text_delta, then the wire goes dead:
		// no content_block_stop, no message_delta stop_reason, no message_stop.
		const truncatedEvents = createTextSuccessEvents("partial").slice(0, 3);
		let attempt = 0;
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(() => {
			attempt += 1;
			return createMockRequest(truncatedEvents) as never;
		});

		const stream = streamAnthropic(model, context, {
			apiKey: "sk-ant-test",
			providerRetryWait: async () => {},
		});
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const result = await stream.result();

		// Streamed text is replay-unsafe, so no transparent retry — the turn must
		// surface as an error the agent loop can act on, never a silent "stop".
		expect(attempt).toBe(1);
		expect(countEvents(events, "done")).toBe(0);
		expect(countEvents(events, "error")).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("message_stop");
	});

	it("fails a truncated turn with mixed closed and half-streamed tool calls, keeping the closed call", async () => {
		// One tool call closes cleanly, a second is cut mid-arguments, and the
		// wire dies with no message_delta stop_reason and no message_stop. The
		// turn must error (never finalize the half-streamed sibling into an
		// executable call); the closed call stays in content so the agent loop's
		// `retainCompletedToolCalls` + envelope-aware salvage can run it.
		const truncatedEvents: MockAnthropicEvent[] = [
			{
				type: "message_start",
				message: {
					id: "msg_mixed_truncated",
					usage: {
						input_tokens: 12,
						output_tokens: 0,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				},
			},
			{
				type: "content_block_start",
				index: 0,
				content_block: { type: "tool_use", id: "tool_closed", name: "lookup_weather", input: {} },
			},
			{
				type: "content_block_delta",
				index: 0,
				delta: { type: "input_json_delta", partial_json: '{"city":"Paris"}' },
			},
			{ type: "content_block_stop", index: 0 },
			{
				type: "content_block_start",
				index: 1,
				content_block: { type: "tool_use", id: "tool_open", name: "lookup_weather", input: {} },
			},
			{
				type: "content_block_delta",
				index: 1,
				delta: { type: "input_json_delta", partial_json: '{"city":"Ber' },
			},
		];
		let attempt = 0;
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(() => {
			attempt += 1;
			return createMockRequest(truncatedEvents) as never;
		});

		const stream = streamAnthropic(model, context, {
			apiKey: "sk-ant-test",
			providerRetryWait: async () => {},
		});
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const result = await stream.result();

		expect(attempt).toBe(1);
		expect(countEvents(events, "done")).toBe(0);
		expect(countEvents(events, "error")).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("message_stop");
		const closedCall = result.content.find(block => block.type === "toolCall" && block.id === "tool_closed");
		expect(closedCall).toBeDefined();
		// The closed call emitted toolcall_end (loop-side completion marker);
		// the half-streamed sibling did not.
		const endedIds = events.filter(e => e.type === "toolcall_end").map(e => e.toolCall.id);
		expect(endedIds).toContain("tool_closed");
		expect(endedIds).not.toContain("tool_open");
	});

	it("skips malformed raw SSE event frames and degrades to best-effort content", async () => {
		const malformedTextDelta =
			'{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"line\\qbreak"}}';
		const successEvents = createTextSuccessEvents("unused");
		const frames = [
			sseFrame("message_start", successEvents[0]),
			sseFrame("content_block_start", successEvents[1]),
			sseRawFrame("content_block_delta", malformedTextDelta),
			sseFrame("content_block_stop", { type: "content_block_stop", index: 0 }),
			sseFrame("message_delta", successEvents[4]),
			sseFrame("message_stop", { type: "message_stop" }),
		];
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(() => createRawSseRequest(frames) as never);

		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const result = await stream.result();

		// The unparseable content_block_delta frame is dropped; the surrounding text block streams
		// empty and the turn completes normally.
		expect(countEvents(events, "error")).toBe(0);
		expect(countEvents(events, "done")).toBe(1);
		expect(result.stopReason).toBe("stop");
		expect(JSON.parse(JSON.stringify(result.content))).toEqual([{ type: "text", text: "" }]);
	});
	it("surfaces a refusal fallback message when stop_details is null", async () => {
		const refusalEvents: MockAnthropicEvent[] = [
			{
				type: "message_start",
				message: {
					id: "msg_refusal_no_details",
					usage: {
						input_tokens: 5,
						output_tokens: 0,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				},
			},
			{
				type: "message_delta",
				delta: { stop_reason: "refusal", stop_sequence: null, stop_details: null },
				usage: { input_tokens: 5, output_tokens: 0 },
			},
			{ type: "message_stop" },
		];
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(
			() => createMockRequest(refusalEvents) as never,
		);

		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const result = await stream.result();

		expect(result.stopReason).toBe("error");
		expect(result.stopDetails).toEqual({ type: "refusal" });
		expect(result.errorMessage).toContain("Refusal (no details provided)");
		expect(result.errorMessage).not.toContain("An unknown error occurred");
		expect(countEvents(events, "error")).toBe(1);
		expect(countEvents(events, "done")).toBe(0);
	});

	it("emits per-tool eager_input_streaming only when Anthropic compat allows it", async () => {
		const toolContext: Context = {
			...context,
			tools: [
				{
					name: "lookup_weather",
					description: "Lookup weather",
					parameters: cityObjectSchema,
				},
			],
		};
		const payloads: unknown[] = [];
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation((params: unknown) => {
			payloads.push(params);
			return createMockRequest(createTextSuccessEvents("ok")) as never;
		});

		const eagerStream = streamAnthropic(model, toolContext, { apiKey: "sk-ant-test" });
		for await (const _ of eagerStream) {
			// drain stream
		}
		await eagerStream.result();

		const disabledStream = streamAnthropic(
			buildModel({
				...model,
				compat: { ...model.compatConfig, supportsEagerToolInputStreaming: false },
			} as ModelSpec<"anthropic-messages">),
			toolContext,
			{ apiKey: "sk-ant-test" },
		);
		for await (const _ of disabledStream) {
			// drain stream
		}
		await disabledStream.result();

		const eagerTool = (payloads[0] as { tools?: Array<Record<string, unknown>> }).tools?.[0];
		const disabledTool = (payloads[1] as { tools?: Array<Record<string, unknown>> }).tools?.[0];
		expect(eagerTool?.eager_input_streaming).toBe(true);
		expect(disabledTool).not.toHaveProperty("eager_input_streaming");
	});

	it("emits 1h cache TTL only for canonical Anthropic API with compatible long-cache support", async () => {
		const payloads: unknown[] = [];
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation((params: unknown) => {
			payloads.push(params);
			return createMockRequest(createTextSuccessEvents("ok")) as never;
		});

		for (const testModel of [
			model,
			buildModel({
				...model,
				compat: { ...model.compatConfig, supportsLongCacheRetention: false },
			} as ModelSpec<"anthropic-messages">),
			buildModel({
				...model,
				baseUrl: "https://proxy.example.com/anthropic",
				compat: model.compatConfig,
			} as ModelSpec<"anthropic-messages">),
		]) {
			const stream = streamAnthropic(testModel, context, {
				apiKey: "sk-ant-test",
				cacheRetention: "long",
			});
			for await (const _ of stream) {
				// drain stream
			}
			await stream.result();
		}

		const cacheControls = payloads.map(payload => {
			const messages = (payload as { messages: Array<{ content: unknown }> }).messages;
			const content = messages.at(-1)?.content;
			if (!Array.isArray(content)) return undefined;
			return (content.at(-1) as { cache_control?: { ttl?: string; type: string } } | undefined)?.cache_control;
		});
		expect(cacheControls[0]).toEqual({ type: "ephemeral", ttl: "1h" });
		expect(cacheControls[1]).toEqual({ type: "ephemeral" });
		expect(cacheControls[2]).toEqual({ type: "ephemeral" });
	});

	it("defaults Anthropic requests to 5m writes and keeps 1h retention opt-in", async () => {
		type CapturedParams = { messages: Array<{ content: unknown }> };
		const payloads: CapturedParams[] = [];
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation((params: unknown) => {
			// Params captured verbatim at the mocked SDK boundary.
			const captured = params as CapturedParams;
			payloads.push(captured);
			return createMockRequest(createTextSuccessEvents("ok")) as never;
		});
		const proxyModel = buildModel({
			...model,
			compat: { ...model.compatConfig, supportsLongCacheRetention: false },
		} as ModelSpec<"anthropic-messages">);
		const drain = async (testModel: Model<"anthropic-messages">): Promise<void> => {
			const stream = streamAnthropic(testModel, context, { apiKey: "sk-ant-test" });
			for await (const _ of stream) {
				// drain stream
			}
			await stream.result();
		};

		await drain(model);
		await drain(proxyModel);
		await withEnv({ PI_CACHE_RETENTION: "long" }, () => drain(model));

		const cacheControls = payloads.map(payload => {
			const content = payload.messages.at(-1)?.content;
			if (!Array.isArray(content)) return undefined;
			const lastBlock: { cache_control?: { ttl?: string; type: string } } | undefined = content.at(-1);
			return lastBlock?.cache_control;
		});
		expect(cacheControls[0]).toEqual({ type: "ephemeral" });
		expect(cacheControls[1]).toEqual({ type: "ephemeral" });
		expect(cacheControls[2]).toEqual({ type: "ephemeral", ttl: "1h" });
	});
});
