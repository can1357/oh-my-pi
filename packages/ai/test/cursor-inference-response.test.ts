import { describe, expect, test } from "bun:test";
import type { InferenceStreamResponse, RunInferenceServerMessage } from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import {
	InferenceExtendedUsageInfoSchema,
	InferenceMessageRole,
	InferenceReasoningPartSchema,
	InferenceResponseInfoSchema,
	InferenceResponseMessageSchema,
	InferenceStreamErrorSchema,
	InferenceStreamErrorType,
	InferenceStreamResponseSchema,
	InferenceTextStreamPartSchema,
	InferenceThinkingStreamPartSchema,
	InferenceToolCallStreamPartSchema,
	InferenceUsageInfoSchema,
	RunInferenceInvocationResponseSchema,
	RunInferenceServerMessageSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { create } from "@oh-my-pi/pi-catalog/discovery/protobuf";
import type { AssistantMessage, AssistantMessageEvent } from "../src/types";
import { type InferenceMapperResult, CursorInferenceMapper } from "../src/providers/cursor/response";
import { AssistantMessageEventStream } from "../src/utils/event-stream";

const TOOL = "join_fragments";

function output(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "cursor-agent",
		provider: "cursor",
		model: "composer-2.5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

function response(value: Partial<InferenceStreamResponse>): RunInferenceServerMessage {
	return create(RunInferenceServerMessageSchema, {
		message: {
			case: "invocationResponse",
			value: create(RunInferenceInvocationResponseSchema, {
				invocationId: "invocation",
				response: create(InferenceStreamResponseSchema, value),
			}),
		},
	});
}

async function map(messages: readonly RunInferenceServerMessage[]): Promise<{
	readonly result: AssistantMessage;
	readonly terminal: InferenceMapperResult;
	readonly events: AssistantMessageEvent[];
}> {
	const stream = new AssistantMessageEventStream();
	const result = output();
	const mapper = new CursorInferenceMapper(stream, result, new Set([TOOL]), "invocation", () => undefined);
	const events: AssistantMessageEvent[] = [];
	const collecting = (async () => {
		for await (const event of stream) events.push(event);
	})();
	for (const message of messages) mapper.handle(message);
	const terminal = mapper.finish();
	stream.end();
	await collecting;
	return { result, terminal, events };
}

describe("Cursor managed-inference response", () => {
	test("emits genuine argument deltas and one authoritative tool call", async () => {
		const parts = [
			{ toolCallId: "tool-1", toolName: TOOL, args: "", isComplete: false },
			{ toolCallId: "tool-1", args: '{"left":"A', isComplete: false },
			{ toolCallId: "tool-1", args: '","right":"B"}', isComplete: false },
			{ toolCallId: "tool-1", toolName: TOOL, args: '{"left":"A","right":"B"}', isComplete: true },
		].map(part =>
			response({
				response: { case: "toolCallPart", value: create(InferenceToolCallStreamPartSchema, part) },
			}),
		);
		const { result, terminal, events } = await map(parts);
		expect(events.filter(({ type }) => type === "toolcall_start")).toHaveLength(1);
		expect(events.flatMap(event => (event.type === "toolcall_delta" ? [event.delta] : []))).toEqual([
			'{"left":"A',
			'","right":"B"}',
		]);
		expect(terminal.stopReason).toBe("toolUse");
		expect(result.content).toEqual([
			{ type: "toolCall", id: "tool-1", name: TOOL, arguments: { left: "A", right: "B" } },
		]);
	});

	test("rejects a final response that drops a completed streamed tool", async () => {
		const stream = new AssistantMessageEventStream();
		const result = output();
		const mapper = new CursorInferenceMapper(stream, result, new Set([TOOL]), "invocation", () => undefined);
		mapper.handle(
			response({
				response: {
					case: "toolCallPart",
					value: create(InferenceToolCallStreamPartSchema, {
						toolCallId: "tool-1",
						toolName: TOOL,
						args: "{}",
						isComplete: true,
					}),
				},
			}),
		);
		mapper.handle(
			response({
				response: {
					case: "responseInfo",
					value: create(InferenceResponseInfoSchema, {
						messages: [
							create(InferenceResponseMessageSchema, {
								role: InferenceMessageRole.ASSISTANT,
								content: "tool omitted",
							}),
						],
					}),
				},
			}),
		);
		expect(() => mapper.finish()).toThrow("Cursor final response tool set disagrees");
		stream.end();
	});

	test("preserves streamed thinking when final reasoning is redacted", async () => {
		const { result } = await map([
			response({
				response: {
					case: "thinkingPart",
					value: create(InferenceThinkingStreamPartSchema, { text: "streamed analysis", isFinal: true }),
				},
			}),
			response({
				response: {
					case: "textPart",
					value: create(InferenceTextStreamPartSchema, { text: "draft", isFinal: true }),
				},
			}),
			response({
				response: {
					case: "responseInfo",
					value: create(InferenceResponseInfoSchema, {
						id: "response-1",
						model: "cursor-grok-4.6-high",
						createdAt: 1234n,
						messages: [
							create(InferenceResponseMessageSchema, {
								role: InferenceMessageRole.ASSISTANT,
								content: "final answer",
								reasoningParts: [
									create(InferenceReasoningPartSchema, {
										isRedacted: true,
										redactedData: "opaque",
									}),
								],
							}),
						],
					}),
				},
			}),
		]);
		expect(result.content).toEqual([
			{ type: "thinking", thinking: "streamed analysis" },
			{ type: "redactedThinking", data: "opaque" },
			{ type: "text", text: "final answer" },
		]);
		expect(result).toMatchObject({
			responseId: "response-1",
			upstreamModel: "cursor-grok-4.6-high",
			timestamp: 1234,
		});
	});

	test("strips only terminal Cursor end-of-sequence markers from visible text", async () => {
		const { result, events } = await map([
			response({
				response: {
					case: "textPart",
					value: create(InferenceTextStreamPartSchema, { text: "GROK-MEDIUM-112", isFinal: false }),
				},
			}),
			response({
				response: {
					case: "textPart",
					value: create(InferenceTextStreamPartSchema, { text: "<|eo", isFinal: false }),
				},
			}),
			response({
				response: {
					case: "textPart",
					value: create(InferenceTextStreamPartSchema, { text: "s|><|eos|>", isFinal: false }),
				},
			}),
			response({
				response: {
					case: "responseInfo",
					value: create(InferenceResponseInfoSchema, {
						messages: [
							create(InferenceResponseMessageSchema, {
								role: InferenceMessageRole.ASSISTANT,
								content: "GROK-MEDIUM-112<|eos|><|eos|>",
							}),
						],
					}),
				},
			}),
		]);
		expect(events.flatMap(event => (event.type === "text_delta" ? [event.delta] : []))).toEqual(["GROK-MEDIUM-112"]);
		expect(result.content).toEqual([{ type: "text", text: "GROK-MEDIUM-112" }]);

		const embedded = await map([
			response({
				response: {
					case: "textPart",
					value: create(InferenceTextStreamPartSchema, { text: "literal <|eos|>", isFinal: false }),
				},
			}),
			response({
				response: {
					case: "textPart",
					value: create(InferenceTextStreamPartSchema, { text: " marker in prose", isFinal: false }),
				},
			}),
			response({
				response: {
					case: "responseInfo",
					value: create(InferenceResponseInfoSchema, {
						messages: [
							create(InferenceResponseMessageSchema, {
								role: InferenceMessageRole.ASSISTANT,
								content: "literal <|eos|> marker in prose",
							}),
						],
					}),
				},
			}),
		]);
		expect(embedded.events.flatMap(event => (event.type === "text_delta" ? [event.delta] : []))).toEqual([
			"literal ",
			"<|eos|> marker in prose",
		]);
		expect(embedded.result.content).toEqual([{ type: "text", text: "literal <|eos|> marker in prose" }]);

		const incomplete = await map([
			response({
				response: {
					case: "textPart",
					value: create(InferenceTextStreamPartSchema, { text: "literal <|eo", isFinal: false }),
				},
			}),
		]);
		expect(incomplete.events.flatMap(event => (event.type === "text_delta" ? [event.delta] : []))).toEqual([
			"literal ",
			"<|eo",
		]);
		expect(incomplete.result.content).toEqual([{ type: "text", text: "literal <|eo" }]);
	});

	test("gives extended usage precedence", async () => {
		const { result } = await map([
			response({
				response: {
					case: "extendedUsage",
					value: create(InferenceExtendedUsageInfoSchema, {
						inputTokens: 10,
						outputTokens: 4,
						cacheReadTokens: 3,
						cacheWriteTokens: 2,
					}),
				},
			}),
		]);
		expect(result.usage).toMatchObject({ input: 10, output: 4, cacheRead: 3, cacheWrite: 2, totalTokens: 19 });
	});

	test("uses ordinary usage only until extended usage arrives", async () => {
		const { result } = await map([
			response({
				response: {
					case: "usage",
					value: create(InferenceUsageInfoSchema, { promptTokens: 8, completionTokens: 3 }),
				},
			}),
		]);
		expect(result.usage).toMatchObject({ input: 8, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 11 });
	});

	test("accepts an empty success and turns an output limit with content into length", async () => {
		const empty = await map([]);
		expect(empty.terminal).toEqual({ stopReason: "stop" });
		expect(empty.result.content).toEqual([]);

		const limited = await map([
			response({
				response: {
					case: "textPart",
					value: create(InferenceTextStreamPartSchema, { text: "partial", isFinal: false }),
				},
			}),
			response({
				response: {
					case: "error",
					value: create(InferenceStreamErrorSchema, {
						message: "output cap",
						errorType: InferenceStreamErrorType.OUTPUT_TOKEN_LIMIT,
					}),
				},
			}),
		]);
		expect(limited.terminal).toEqual({ stopReason: "length" });
		expect(limited.result.content).toEqual([{ type: "text", text: "partial" }]);
	});

	test("preserves interleaved tool calls and rejects malformed or unadvertised calls", async () => {
		const messages = [
			{ id: "first", left: "A", complete: false },
			{ id: "second", left: "C", complete: false },
			{ id: "first", left: "A", complete: true },
			{ id: "second", left: "C", complete: true },
		].map(({ id, left, complete }) =>
			response({
				response: {
					case: "toolCallPart",
					value: create(InferenceToolCallStreamPartSchema, {
						toolCallId: id,
						toolName: TOOL,
						args: `{"left":"${left}","right":"B"}`,
						isComplete: complete,
					}),
				},
			}),
		);
		const interleaved = await map(messages);
		expect(interleaved.terminal.stopReason).toBe("toolUse");
		expect(interleaved.result.content).toEqual([
			{ type: "toolCall", id: "first", name: TOOL, arguments: { left: "A", right: "B" } },
			{ type: "toolCall", id: "second", name: TOOL, arguments: { left: "C", right: "B" } },
		]);

		const stream = new AssistantMessageEventStream();
		const malformed = new CursorInferenceMapper(stream, output(), new Set([TOOL]), "invocation", () => undefined);
		expect(() =>
			malformed.handle(
				response({
					response: {
						case: "toolCallPart",
						value: create(InferenceToolCallStreamPartSchema, {
							toolCallId: "bad",
							toolName: TOOL,
							args: "{",
							isComplete: true,
						}),
					},
				}),
			),
		).toThrow("invalid JSON arguments");
		const unadvertised = new CursorInferenceMapper(stream, output(), new Set(), "invocation", () => undefined);
		expect(() =>
			unadvertised.handle(
				response({
					response: {
						case: "toolCallPart",
						value: create(InferenceToolCallStreamPartSchema, {
							toolCallId: "unknown",
							toolName: "unknown_tool",
						}),
					},
				}),
			),
		).toThrow("unadvertised tool 'unknown_tool'");
		stream.end();
	});

	test("rejects a nested invocation id that disagrees with its outer envelope", () => {
		const stream = new AssistantMessageEventStream();
		const mapper = new CursorInferenceMapper(stream, output(), new Set(), "invocation", () => undefined);
		expect(() =>
			mapper.handle(response({ response: { case: "invocationId", value: { invocationId: "other" } } })),
		).toThrow("nested invocation identity disagrees");
		stream.end();
	});

	test("preserves repeated final response messages instead of guessing they are transport copies", async () => {
		const { result } = await map([
			response({
				response: {
					case: "responseInfo",
					value: create(InferenceResponseInfoSchema, {
						messages: [
							create(InferenceResponseMessageSchema, {
								role: InferenceMessageRole.ASSISTANT,
								content: "answer",
							}),
							create(InferenceResponseMessageSchema, {
								role: InferenceMessageRole.ASSISTANT,
								reasoningParts: [create(InferenceReasoningPartSchema, { signature: "opaque" })],
							}),
							create(InferenceResponseMessageSchema, {
								role: InferenceMessageRole.ASSISTANT,
								content: "answer",
							}),
						],
					}),
				},
			}),
		]);
		expect(result.content).toEqual([
			{ type: "thinking", thinking: "", thinkingSignature: "opaque" },
			{ type: "text", text: "answer" },
			{ type: "text", text: "answer" },
		]);
	});

	test("preserves equal streamed text blocks separated by opaque thinking", async () => {
		const { result, events } = await map([
			response({
				response: {
					case: "textPart",
					value: create(InferenceTextStreamPartSchema, { text: "answer", isFinal: false }),
				},
			}),
			response({
				response: {
					case: "thinkingPart",
					value: create(InferenceThinkingStreamPartSchema, {
						text: "pause",
						signature: "opaque",
						isFinal: true,
					}),
				},
			}),
			response({
				response: {
					case: "textPart",
					value: create(InferenceTextStreamPartSchema, { text: "answer", isFinal: false }),
				},
			}),
		]);
		expect(result.content).toEqual([
			{ type: "text", text: "answer" },
			{ type: "thinking", thinking: "pause", thinkingSignature: "opaque" },
			{ type: "text", text: "answer" },
		]);
		expect(events.filter(event => event.type === "text_delta")).toHaveLength(2);
	});

	test("ignores a final text marker before a later non-final text delta", async () => {
		const { result, events } = await map([
			response({
				response: {
					case: "textPart",
					value: create(InferenceTextStreamPartSchema, { text: "answer", isFinal: true }),
				},
			}),
			response({
				response: {
					case: "thinkingPart",
					value: create(InferenceThinkingStreamPartSchema, { signature: "opaque", isFinal: true }),
				},
			}),
			response({
				response: {
					case: "textPart",
					value: create(InferenceTextStreamPartSchema, { text: "answer", isFinal: false }),
				},
			}),
		]);
		expect(result.content).toEqual([{ type: "text", text: "answer" }]);
		expect(events.filter(event => event.type === "text_delta")).toHaveLength(1);
	});

	test("treats a cumulative final text frame as a finish marker", async () => {
		const { result, events } = await map([
			response({
				response: {
					case: "textPart",
					value: create(InferenceTextStreamPartSchema, { text: "answer", isFinal: false }),
				},
			}),
			response({
				response: {
					case: "textPart",
					value: create(InferenceTextStreamPartSchema, { text: "answer", isFinal: true }),
				},
			}),
		]);
		expect(result.content).toEqual([{ type: "text", text: "answer" }]);
		expect(events.filter(event => event.type === "text_delta")).toHaveLength(1);
	});

	test("preserves typed stream error classification when final metadata updates its message", async () => {
		const authentication = await map([
			response({
				response: {
					case: "error",
					value: create(InferenceStreamErrorSchema, {
						message: "generic authentication failure",
						errorType: InferenceStreamErrorType.AUTHENTICATION,
					}),
				},
			}),
			response({
				response: {
					case: "responseInfo",
					value: create(InferenceResponseInfoSchema, { errorMessage: "refresh the Cursor credential" }),
				},
			}),
		]);
		expect(authentication.terminal).toEqual({
			stopReason: "error",
			errorMessage: "refresh the Cursor credential",
			errorStatus: 401,
		});

		const outputLimit = await map([
			response({
				response: {
					case: "textPart",
					value: create(InferenceTextStreamPartSchema, { text: "partial", isFinal: false }),
				},
			}),
			response({
				response: {
					case: "error",
					value: create(InferenceStreamErrorSchema, {
						message: "generic output limit",
						errorType: InferenceStreamErrorType.OUTPUT_TOKEN_LIMIT,
					}),
				},
			}),
			response({
				response: {
					case: "responseInfo",
					value: create(InferenceResponseInfoSchema, { errorMessage: "maximum output reached" }),
				},
			}),
		]);
		expect(outputLimit.terminal).toEqual({ stopReason: "length" });
		expect(outputLimit.result.content).toEqual([{ type: "text", text: "partial" }]);
	});

	test("maps structured authentication failures for credential rotation", async () => {
		const { terminal } = await map([
			response({
				response: {
					case: "error",
					value: create(InferenceStreamErrorSchema, {
						message: "expired",
						errorType: InferenceStreamErrorType.AUTHENTICATION,
					}),
				},
			}),
		]);
		expect(terminal).toEqual({ stopReason: "error", errorMessage: "expired", errorStatus: 401 });
	});
});
