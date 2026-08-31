import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { buildZedProviderRequest, streamZed } from "../src/providers/zed";
import { invalidateZedLlmToken } from "../src/registry/oauth/zed-token-pool";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	FetchImpl,
	Model,
	ModelSpec,
	ProviderResponseMetadata,
	ToolChoice,
	ToolResultMessage,
} from "../src/types";
import { mockFetch } from "./helpers/fetch-mock";

const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function makeModel(id: string, reasoning = false, cost: ModelSpec<"zed-agent">["cost"] = zeroCost): Model<"zed-agent"> {
	return buildModel({
		id,
		name: id,
		api: "zed-agent",
		provider: "zed-agent",
		baseUrl: "https://cloud.zed.dev",
		reasoning,
		contextWindow: 1_000_000,
		maxTokens: 66_000,
		input: ["text", "image"],
		cost,
	});
}

function ndjsonResponse(frames: unknown[], init: { status?: number; headers?: Record<string, string> } = {}): Response {
	return new Response(`${frames.map(frame => JSON.stringify(frame)).join("\n")}\n`, {
		status: init.status ?? 200,
		headers: { "content-type": "application/x-ndjson", ...init.headers },
	});
}

function userContext(): Context {
	return { messages: [{ role: "user", content: "hello", timestamp: 1 }] };
}

function toolResult(toolCallId: string, toolName: string, text: string, isError: boolean): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError,
		timestamp: 1,
	};
}

async function runZedStream(
	model: Model<"zed-agent">,
	frames: unknown[],
	context: Context = userContext(),
	apiKey = "direct-zed-token",
): Promise<{
	events: AssistantMessageEvent[];
	result: AssistantMessage;
	requests: Array<{ input: string; init?: RequestInit }>;
}> {
	const requests: Array<{ input: string; init?: RequestInit }> = [];
	const fetchMock: FetchImpl = mockFetch(async (input, init) => {
		requests.push({ input: String(input), init });
		return ndjsonResponse(frames);
	});
	const stream = streamZed(model, context, { apiKey, fetch: fetchMock });
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return { events, result: await stream.result(), requests };
}

describe("Zed provider protocol regressions", () => {
	it("groups parallel Gemini tool results and preserves error responses", () => {
		const payload = buildZedProviderRequest(
			"google",
			{
				messages: [
					toolResult("call_read", "read_file", "contents", false),
					toolResult("call_write", "write_file", "permission denied", true),
				],
			},
			makeModel("gemini-3-flash", true),
		) as { contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> };

		expect(payload.contents).toEqual([
			{
				role: "user",
				parts: [
					{ functionResponse: { name: "read_file", response: { output: "contents" } } },
					{ functionResponse: { name: "write_file", response: { error: "permission denied" } } },
				],
			},
		]);
	});

	it("routes interleaved OpenAI Responses argument deltas to each parallel call", async () => {
		const argsA = '{"path":"a.txt"}';
		const argsB = '{"path":"b.txt"}';
		const firstA = argsA.slice(0, 10);
		const secondA = argsA.slice(10);
		const run = await runZedStream(makeModel("gpt-5.6-luna"), [
			{
				event: {
					type: "response.output_item.added",
					output_index: 0,
					item: { type: "function_call", id: "fc_a", call_id: "call_a", name: "read_file", arguments: "" },
				},
			},
			{
				event: {
					type: "response.output_item.added",
					output_index: 1,
					item: { type: "function_call", id: "fc_b", call_id: "call_b", name: "read_file", arguments: "" },
				},
			},
			{ event: { type: "response.function_call_arguments.delta", item_id: "fc_a", output_index: 0, delta: firstA } },
			{ event: { type: "response.function_call_arguments.delta", item_id: "fc_b", output_index: 1, delta: argsB } },
			{
				event: { type: "response.function_call_arguments.delta", item_id: "fc_a", output_index: 0, delta: secondA },
			},
			{
				event: {
					type: "response.function_call_arguments.done",
					item_id: "fc_b",
					output_index: 1,
					arguments: argsB,
				},
			},
			{
				event: {
					type: "response.function_call_arguments.done",
					item_id: "fc_a",
					output_index: 0,
					arguments: argsA,
				},
			},
			{ status: "stream_ended" },
		]);

		expect(run.result.stopReason).toBe("toolUse");
		expect(run.result.content).toHaveLength(2);
		expect(run.result.content[0]).toMatchObject({
			type: "toolCall",
			id: "call_a",
			name: "read_file",
			arguments: { path: "a.txt" },
		});
		expect(run.result.content[1]).toMatchObject({
			type: "toolCall",
			id: "call_b",
			name: "read_file",
			arguments: { path: "b.txt" },
		});
		const deltas = run.events.filter(
			(event): event is Extract<AssistantMessageEvent, { type: "toolcall_delta" }> =>
				event.type === "toolcall_delta",
		);
		expect(deltas.map(event => [event.contentIndex, event.delta])).toEqual([
			[0, firstA],
			[1, argsB],
			[0, secondA],
		]);
	});

	it("replays the complete OpenAI Responses reasoning item on a Zed tool turn", async () => {
		const reasoningText = "Inspect README before reading it.";
		const reasoningItem = {
			type: "reasoning",
			id: "rs_zed_reasoning",
			status: "completed",
			summary: [{ type: "summary_text", text: reasoningText }],
			content: [{ type: "reasoning_text", text: reasoningText }],
			metadata: { source: "zed", turn: 7 },
		};
		const functionCall = {
			type: "function_call",
			id: "fc_zed_read",
			call_id: "call_zed_read",
			name: "read_file",
			arguments: '{"path":"README.md"}',
			status: "completed",
		};
		const run = await runZedStream(makeModel("gpt-5.6-luna", true), [
			{
				event: {
					type: "response.output_item.added",
					output_index: 0,
					item: { ...reasoningItem, status: "in_progress", summary: [] },
				},
			},
			{
				event: {
					type: "response.reasoning_summary_text.delta",
					item_id: reasoningItem.id,
					output_index: 0,
					summary_index: 0,
					delta: "Inspect README ",
				},
			},
			{
				event: {
					type: "response.reasoning_summary_text.delta",
					item_id: reasoningItem.id,
					output_index: 0,
					summary_index: 0,
					delta: "before reading it.",
				},
			},
			{
				event: {
					type: "response.reasoning_summary_text.done",
					item_id: reasoningItem.id,
					output_index: 0,
					summary_index: 0,
					text: reasoningText,
				},
			},
			{ event: { type: "response.output_item.done", output_index: 0, item: reasoningItem } },
			{
				event: {
					type: "response.output_item.added",
					output_index: 1,
					item: { ...functionCall, status: "in_progress" },
				},
			},
			{
				event: {
					type: "response.function_call_arguments.delta",
					item_id: functionCall.id,
					output_index: 1,
					delta: functionCall.arguments,
				},
			},
			{ event: { type: "response.output_item.done", output_index: 1, item: functionCall } },
			{ status: "stream_ended" },
		]);

		const thinking = run.result.content.find(block => block.type === "thinking");
		if (thinking?.type !== "thinking") throw new Error("Zed reasoning block was not emitted");
		expect(thinking).toMatchObject({
			thinking: reasoningText,
			thinkingSignature: JSON.stringify(reasoningItem),
			itemId: reasoningItem.id,
		});
		expect(JSON.parse(thinking.thinkingSignature ?? "")).toEqual(reasoningItem);
		expect(run.result.content).toContainEqual({
			type: "toolCall",
			id: functionCall.call_id,
			name: functionCall.name,
			arguments: { path: "README.md" },
		});

		const payload = buildZedProviderRequest(
			"open_ai",
			{
				messages: [run.result, toolResult(functionCall.call_id, functionCall.name, "README contents", false)],
			},
			makeModel("gpt-5.6-luna", true),
		) as { input: Array<Record<string, unknown>> };

		expect(payload.input.map(item => item.type)).toEqual(["reasoning", "function_call", "function_call_output"]);
		expect(payload.input[0]).toEqual(reasoningItem);
		expect(payload.input[0]).not.toEqual({
			type: "reasoning",
			id: reasoningItem.id,
			summary: reasoningItem.summary,
		});
		expect(payload.input[1]).toMatchObject({
			type: "function_call",
			call_id: functionCall.call_id,
			name: functionCall.name,
			arguments: functionCall.arguments,
		});
		expect(payload.input[2]).toEqual({
			type: "function_call_output",
			call_id: functionCall.call_id,
			output: "README contents",
		});
	});

	it("emits OpenAI Responses refusal deltas as visible assistant text", async () => {
		const refusalText = "I can't help with that request.";
		const run = await runZedStream(makeModel("gpt-5.6-luna"), [
			{ event: { type: "response.refusal.delta", delta: "I can't help " } },
			{ event: { type: "response.refusal.delta", delta: "with that request." } },
			{ status: "stream_ended" },
		]);

		expect(run.result.stopReason).toBe("stop");
		expect(run.result.content).toEqual([{ type: "text", text: refusalText }]);
		const textDeltas = run.events.filter(
			(event): event is Extract<AssistantMessageEvent, { type: "text_delta" }> => event.type === "text_delta",
		);
		expect(textDeltas.map(event => event.delta)).toEqual(["I can't help ", "with that request."]);
	});

	it("assembles fragmented xAI streamed tool_calls by delta index", async () => {
		const run = await runZedStream(makeModel("grok-4.6"), [
			{
				event: {
					choices: [
						{
							delta: {
								tool_calls: [
									{
										index: 0,
										id: "call_search",
										type: "function",
										function: { name: "search", arguments: '{"q":"g' },
									},
									{
										index: 1,
										id: "call_math",
										type: "function",
										function: { name: "calculate", arguments: '{"expr":"2+' },
									},
								],
							},
						},
					],
				},
			},
			{
				event: {
					choices: [
						{
							delta: {
								tool_calls: [
									{ index: 1, function: { arguments: '2"}' } },
									{ index: 0, function: { arguments: 'pt"}' } },
								],
							},
						},
					],
				},
			},
			{ event: { choices: [{ delta: {}, finish_reason: "tool_calls" }] } },
			{ status: "stream_ended" },
		]);

		expect(run.result.stopReason).toBe("toolUse");
		expect(run.result.content).toEqual([
			{ type: "toolCall", id: "call_search", name: "search", arguments: { q: "gpt" } },
			{ type: "toolCall", id: "call_math", name: "calculate", arguments: { expr: "2+2" } },
		]);
	});
	it("treats an xAI content filter finish as an error without promoting tool calls", async () => {
		const run = await runZedStream(makeModel("grok-4.6"), [
			{
				event: {
					choices: [
						{
							delta: {
								tool_calls: [
									{
										index: 0,
										id: "call_filtered",
										type: "function",
										function: { name: "write_file", arguments: '{"path":"secret.txt"}' },
									},
								],
							},
						},
					],
				},
			},
			{ event: { choices: [{ delta: {}, finish_reason: "content_filter" }] } },
			{ status: "stream_ended" },
		]);

		expect(run.result.stopReason).toBe("error");
		expect(run.result.errorMessage).toContain("content_filter");
		expect(run.result.content.some(block => block.type === "toolCall")).toBe(false);
		expect(run.events.filter(event => event.type === "toolcall_end")).toHaveLength(0);
		expect(run.events.some(event => event.type === "done")).toBe(false);
		expect(run.events.at(-1)?.type).toBe("error");
	});

	it("emits Gemini thought text as ThinkingContent and retains its signature", async () => {
		const run = await runZedStream(makeModel("gemini-3-flash", true), [
			{
				event: {
					candidates: [
						{ content: { role: "model", parts: [{ thought: true, text: "plan ", thoughtSignature: "sig-1" }] } },
					],
				},
			},
			{ event: { candidates: [{ content: { role: "model", parts: [{ thought: true, text: "execute" }] } }] } },
			{ status: "stream_ended" },
		]);

		expect(run.result.content).toEqual([{ type: "thinking", thinking: "plan execute", thinkingSignature: "sig-1" }]);
		expect(run.events.filter(event => event.type === "thinking_start")).toHaveLength(1);
		expect(run.events.filter(event => event.type === "thinking_end")).toHaveLength(1);
	});
	it("decodes redacted Anthropic thinking and replays it only for the originating model", async () => {
		const model = makeModel("claude-sonnet-4-6", true);
		const run = await runZedStream(model, [
			{
				event: {
					type: "content_block_start",
					content_block: { type: "redacted_thinking", data: "opaque-thinking-blob" },
				},
			},
			{ event: { type: "content_block_stop" } },
			{
				event: {
					type: "content_block_start",
					content_block: { type: "tool_use", id: "call_read", name: "read" },
				},
			},
			{
				event: {
					type: "content_block_delta",
					delta: { type: "input_json_delta", partial_json: '{"path":"README.md"}' },
				},
			},
			{ event: { type: "content_block_stop" } },
			{ status: "stream_ended" },
		]);

		expect(run.result.content).toEqual([
			{ type: "redactedThinking", data: "opaque-thinking-blob" },
			{ type: "toolCall", id: "call_read", name: "read", arguments: { path: "README.md" } },
		]);

		const sameModelPayload = buildZedProviderRequest("anthropic", { messages: [run.result] }, model) as {
			messages: Array<{ role: string; content: unknown }>;
		};
		expect(sameModelPayload.messages).toEqual([
			{
				role: "assistant",
				content: [
					{ type: "redacted_thinking", data: "opaque-thinking-blob" },
					{ type: "tool_use", id: "call_read", name: "read", input: { path: "README.md" } },
				],
			},
		]);

		const foreignModelPayload = buildZedProviderRequest(
			"anthropic",
			{ messages: [run.result] },
			makeModel("claude-sonnet-5", true),
		) as {
			messages: Array<{ role: string; content: unknown }>;
		};
		expect(foreignModelPayload.messages).toEqual([
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "call_read", name: "read", input: { path: "README.md" } }],
			},
		]);
	});

	it("promotes a final Gemini function call to the toolUse stop reason", async () => {
		const run = await runZedStream(makeModel("gemini-3-flash", true), [
			{
				event: {
					candidates: [
						{ content: { role: "model", parts: [{ functionCall: { name: "search", args: { q: "zed" } } }] } },
					],
				},
			},
			{ status: "stream_ended" },
		]);

		expect(run.result.stopReason).toBe("toolUse");
		expect(run.result.content[0]).toMatchObject({
			type: "toolCall",
			name: "search",
			arguments: { q: "zed" },
		});
	});

	it("returns a protocol error when the Gemini status envelope reports failure", async () => {
		const run = await runZedStream(makeModel("gemini-3-flash", true), [
			{ status: { failed: { message: "Gemini upstream rejected the request" } } },
		]);

		expect(run.result.stopReason).toBe("error");
		expect(run.result.errorMessage).toBe("Gemini upstream rejected the request");
		expect(run.events.at(-1)?.type).toBe("error");
	});

	it("surfaces OpenAI Responses response.failed errors instead of completing", async () => {
		const run = await runZedStream(makeModel("gpt-5.6-luna"), [
			{
				event: {
					type: "response.failed",
					response: {
						status: "failed",
						error: { code: "server_error", message: "Zed Responses backend exploded" },
					},
				},
			},
			{ status: "stream_ended" },
		]);

		expect(run.result.stopReason).toBe("error");
		expect(run.result.errorMessage).toContain("server_error");
		expect(run.result.errorMessage).toContain("Zed Responses backend exploded");
		expect(run.events.some(event => event.type === "done")).toBe(false);
		expect(run.events.at(-1)?.type).toBe("error");
	});

	it("rejects prompt-level Gemini safety blocks instead of completing", async () => {
		const run = await runZedStream(makeModel("gemini-3-flash", true), [
			{
				event: {
					candidates: [],
					promptFeedback: {
						blockReason: "SAFETY",
						blockReasonMessage: "Prompt blocked by safety policy",
					},
				},
			},
			{ status: "stream_ended" },
		]);

		expect(run.result.stopReason).toBe("error");
		expect(run.result.errorMessage).toContain("SAFETY");
		expect(run.events.some(event => event.type === "done")).toBe(false);
		expect(run.events.at(-1)?.type).toBe("error");
	});

	it("maps OpenAI Responses incomplete reasons and never promotes a truncated tool call", async () => {
		const cases = [
			{ reason: "max_output_tokens", stopReason: "length" },
			{ reason: "content_filter", stopReason: "error" },
		] as const;

		for (const testCase of cases) {
			const run = await runZedStream(makeModel("gpt-5.6-luna"), [
				{
					event: {
						type: "response.output_item.added",
						output_index: 0,
						item: {
							type: "function_call",
							id: "fc_truncated",
							call_id: "call_truncated",
							name: "write_file",
							arguments: "",
						},
					},
				},
				{
					event: {
						type: "response.function_call_arguments.delta",
						item_id: "fc_truncated",
						output_index: 0,
						delta: '{"path":"README.md"',
					},
				},
				{
					event: {
						type: "response.incomplete",
						response: {
							status: "incomplete",
							incomplete_details: { reason: testCase.reason },
						},
					},
				},
				{ status: "stream_ended" },
			]);

			expect(run.result.stopReason).toBe(testCase.stopReason);
			expect(run.result.stopReason).not.toBe("toolUse");
			expect(run.events.filter(event => event.type === "toolcall_end")).toHaveLength(0);
			if (testCase.stopReason === "error") {
				expect(run.result.errorMessage).toContain("content_filter");
				expect(run.events.at(-1)?.type).toBe("error");
			} else {
				expect(run.events.at(-1)?.type).toBe("done");
			}
		}
	});

	it("surfaces blocked Gemini finish reasons as errors without promoting tool calls", async () => {
		const finishReasons = ["SAFETY", "RECITATION", "MALFORMED_FUNCTION_CALL"] as const;
		for (const finishReason of finishReasons) {
			const run = await runZedStream(makeModel("gemini-3-flash", true), [
				{
					event: {
						candidates: [
							{
								content: {
									role: "model",
									parts: [{ functionCall: { name: "write_file", args: { path: "README.md" } } }],
								},
								finishReason,
							},
						],
					},
				},
				{ status: "stream_ended" },
			]);

			expect(run.result.stopReason).toBe("error");
			expect(run.result.stopReason).not.toBe("toolUse");
			expect(run.result.errorMessage).toContain(`finish reason: ${finishReason}`);
			expect(run.events.some(event => event.type === "done")).toBe(false);
			expect(run.events.at(-1)?.type).toBe("error");
		}
	});

	it("fails instead of completing when EOF arrives before stream_ended", async () => {
		const run = await runZedStream(makeModel("gpt-5.6-luna"), [
			{ event: { type: "response.output_text.delta", delta: "partial" } },
		]);

		expect(run.result.stopReason).toBe("error");
		expect(run.result.errorMessage).toBe("Zed stream closed before stream_ended status was received");
		expect(run.events.at(-1)?.type).toBe("error");
		expect(run.events.some(event => event.type === "done")).toBe(false);
	});

	it("reads nested xAI cached-token usage before completing the stream", async () => {
		const model: Model<"zed-agent"> = makeModel("grok-4.6", false, {
			input: 1,
			output: 2,
			cacheRead: 0.25,
			cacheWrite: 0,
		});
		const run = await runZedStream(model, [
			{ event: { choices: [{ delta: { content: "answer" } }] } },
			{ event: { choices: [{ delta: {}, finish_reason: "stop" }] } },
			{
				event: {
					usage: {
						prompt_tokens: 120,
						completion_tokens: 8,
						prompt_tokens_details: { cached_tokens: 75 },
					},
				},
			},
			{ status: "stream_ended" },
		]);

		expect(run.result.stopReason).toBe("stop");
		expect(run.result.usage).toMatchObject({
			input: 45,
			output: 8,
			cacheRead: 75,
			cacheWrite: 0,
			totalTokens: 128,
		});
		expect(run.result.usage.cost.input).toBeCloseTo(45 / 1_000_000, 12);
		expect(run.result.usage.cost.cacheRead).toBeCloseTo((75 * 0.25) / 1_000_000, 12);
	});

	it("reads nested OpenAI cached-token usage before completing the stream", async () => {
		const model: Model<"zed-agent"> = makeModel("gpt-5.6-luna", false, {
			input: 1,
			output: 2,
			cacheRead: 0.25,
			cacheWrite: 0,
		});
		const run = await runZedStream(model, [
			{
				event: {
					type: "response.completed",
					response: {
						usage: {
							input_tokens: 120,
							output_tokens: 8,
							input_tokens_details: { cached_tokens: 75 },
						},
					},
				},
			},
			{ status: "stream_ended" },
		]);

		expect(run.result.stopReason).toBe("stop");
		expect(run.result.usage).toMatchObject({
			input: 45,
			output: 8,
			cacheRead: 75,
			cacheWrite: 0,
			totalTokens: 128,
		});
		expect(run.result.usage.cost.input).toBeCloseTo(45 / 1_000_000, 12);
		expect(run.result.usage.cost.cacheRead).toBeCloseTo((75 * 0.25) / 1_000_000, 12);
	});

	it("includes Gemini thought tokens in output usage and reasoning accounting", async () => {
		const run = await runZedStream(makeModel("gemini-3-flash", true), [
			{
				event: {
					candidates: [
						{
							content: { role: "model", parts: [{ text: "answer" }] },
							finishReason: "STOP",
						},
					],
					usageMetadata: {
						promptTokenCount: 120,
						cachedContentTokenCount: 20,
						candidatesTokenCount: 8,
						thoughtsTokenCount: 5,
						totalTokenCount: 133,
					},
				},
			},
			{ status: "stream_ended" },
		]);

		expect(run.result.stopReason).toBe("stop");
		expect(run.result.usage).toMatchObject({
			input: 100,
			output: 13,
			cacheRead: 20,
			cacheWrite: 0,
			totalTokens: 133,
			reasoningTokens: 5,
		});
	});

	it("uses a direct bearer token without minting an LLM token", async () => {
		const requests: Array<{ input: string; init?: RequestInit }> = [];
		const fetchMock: FetchImpl = mockFetch(async (input, init) => {
			requests.push({ input: String(input), init });
			return ndjsonResponse([{ status: "stream_ended" }]);
		});
		const stream = streamZed(
			makeModel("gpt-5.6-luna"),
			{ messages: [] },
			{ apiKey: "raw-access-token", fetch: fetchMock },
		);
		const result = await stream.result();

		expect(result.stopReason).toBe("stop");
		expect(requests).toHaveLength(1);
		expect(requests[0]?.input).toBe("https://cloud.zed.dev/completions");
		expect(requests[0]?.init?.headers).toMatchObject({ Authorization: "Bearer raw-access-token" });
	});

	it("notifies onResponse when a completion response succeeds", async () => {
		const model = makeModel("gpt-5.6-luna");
		const responses: ProviderResponseMetadata[] = [];
		const responseModelIds: Array<string | undefined> = [];
		const fetchMock: FetchImpl = mockFetch(async () =>
			ndjsonResponse([{ status: "stream_ended" }], {
				headers: {
					"x-test-response": "success",
					"x-zed-request-id": "req_success",
				},
			}),
		);

		const stream = streamZed(model, userContext(), {
			apiKey: "raw-zed-token",
			fetch: fetchMock,
			onResponse: (response, responseModel) => {
				responses.push(response);
				responseModelIds.push(responseModel?.id);
			},
		});
		const result = await stream.result();

		expect(result.stopReason).toBe("stop");
		expect(responses).toHaveLength(1);
		expect(responses[0]).toMatchObject({
			status: 200,
			headers: {
				"x-test-response": "success",
				"x-zed-request-id": "req_success",
			},
		});
		expect(responseModelIds).toEqual([model.id]);
	});

	it("notifies onResponse for each initial 401 or expired-token response and its successful retry", async () => {
		const cases: Array<{
			name: string;
			status: number;
			headers: Record<string, string>;
		}> = [
			{
				name: "401",
				status: 401,
				headers: { "x-test-attempt": "initial-401" },
			},
			{
				name: "expired-token",
				status: 200,
				headers: {
					"x-zed-expired-token": "true",
					"x-test-attempt": "initial-expired-token",
				},
			},
		];

		for (const [caseIndex, testCase] of cases.entries()) {
			const userId = `user_on_response_retry_${caseIndex}`;
			const accessToken = `access-token-on-response-retry-${caseIndex}`;
			const model = makeModel("gpt-5.6-luna");
			const responses: ProviderResponseMetadata[] = [];
			const responseModelIds: Array<string | undefined> = [];
			let mintCount = 0;
			let completionCount = 0;
			invalidateZedLlmToken(userId, accessToken);

			const fetchMock: FetchImpl = mockFetch(async input => {
				const url = String(input);
				if (url.endsWith("/client/llm_tokens")) {
					mintCount++;
					return new Response(JSON.stringify({ token: `llm-token-${caseIndex}-${mintCount}` }), {
						status: 200,
						headers: { "content-type": "application/json" },
					});
				}
				if (!url.endsWith("/completions")) {
					throw new Error(`Unexpected Zed request in ${testCase.name} case: ${url}`);
				}

				completionCount++;
				if (completionCount === 1) {
					return ndjsonResponse([{ status: "stream_ended" }], {
						status: testCase.status,
						headers: testCase.headers,
					});
				}
				if (completionCount === 2) {
					return ndjsonResponse([{ status: "stream_ended" }], {
						headers: { "x-test-attempt": `retry-after-${testCase.name}` },
					});
				}
				throw new Error(`Unexpected extra completion request in ${testCase.name} case`);
			});

			try {
				const stream = streamZed(model, userContext(), {
					apiKey: `${userId} ${accessToken}`,
					fetch: fetchMock,
					onResponse: (response, responseModel) => {
						responses.push(response);
						responseModelIds.push(responseModel?.id);
					},
				});
				const result = await stream.result();

				expect(result.stopReason).toBe("stop");
				expect(mintCount).toBe(2);
				expect(completionCount).toBe(2);
				expect(responses.map(response => response.status)).toEqual([testCase.status, 200]);
				expect(responses.map(response => response.headers["x-test-attempt"])).toEqual([
					testCase.headers["x-test-attempt"],
					`retry-after-${testCase.name}`,
				]);
				expect(responseModelIds).toEqual([model.id, model.id]);
			} finally {
				invalidateZedLlmToken(userId, accessToken);
			}
		}
	});

	it("sends an asynchronous onPayload replacement in the outgoing completion request", async () => {
		let sentBody: Record<string, unknown> | undefined;
		let hookPayload: Record<string, unknown> | undefined;
		const fetchMock: FetchImpl = mockFetch(async (_input, init) => {
			sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return ndjsonResponse([{ status: "stream_ended" }]);
		});

		const stream = streamZed(makeModel("gpt-5.6-luna"), userContext(), {
			apiKey: "raw-zed-token",
			fetch: fetchMock,
			onPayload: async payload => {
				hookPayload = payload as Record<string, unknown>;
				const completionPayload = payload as { provider_request: Record<string, unknown> };
				const providerRequest = completionPayload.provider_request;
				return {
					...(payload as Record<string, unknown>),
					provider_request: {
						...providerRequest,
						input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "replacement" }] }],
					},
				};
			},
		});
		await stream.result();

		expect(hookPayload?.model).toBe("gpt-5.6-luna");
		const sentProviderRequest = sentBody?.provider_request as Record<string, unknown> | undefined;
		expect(sentProviderRequest?.input).toEqual([
			{ type: "message", role: "user", content: [{ type: "input_text", text: "replacement" }] },
		]);
	});

	it("maps none, required, and named tool choices for every Zed protocol flavor", () => {
		const tools = [
			{
				name: "search",
				description: "Search the web",
				parameters: { type: "object", properties: { query: { type: "string" } } },
			},
		];
		const anthropicTools = tools.map(({ name, description, parameters }) => ({
			name,
			description,
			input_schema: parameters,
		}));
		const openAiTools = tools.map(tool => ({ type: "function", ...tool }));
		const googleTools = [
			{
				functionDeclarations: tools.map(({ name, description, parameters }) => ({
					name,
					description,
					parameters,
				})),
			},
		];
		const xAiTools = tools.map(tool => ({ type: "function", function: tool }));
		const context: Context = {
			messages: [{ role: "user", content: "find this", timestamp: 1 }],
			tools,
		};
		const choices: ToolChoice[] = ["none", "required", { type: "function", name: "search" }];
		const cases: Array<{
			kind: "anthropic" | "open_ai" | "google" | "x_ai";
			model: string;
			expected: [Record<string, unknown>, Record<string, unknown>, Record<string, unknown>];
		}> = [
			{
				kind: "anthropic",
				model: "claude-sonnet-5",
				expected: [
					{ tool_choice: { type: "none" } },
					{ tools: anthropicTools, tool_choice: { type: "any" } },
					{ tools: anthropicTools, tool_choice: { type: "tool", name: "search" } },
				],
			},
			{
				kind: "open_ai",
				model: "gpt-5.6-luna",
				expected: [
					{ tool_choice: "none" },
					{ tools: openAiTools, tool_choice: "required" },
					{
						tools: openAiTools,
						tool_choice: { type: "function", name: "search" },
					},
				],
			},
			{
				kind: "google",
				model: "gemini-3-flash",
				expected: [
					{ toolConfig: { functionCallingConfig: { mode: "NONE" } } },
					{
						tools: googleTools,
						toolConfig: { functionCallingConfig: { mode: "ANY" } },
					},
					{
						tools: googleTools,
						toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["search"] } },
					},
				],
			},
			{
				kind: "x_ai",
				model: "grok-4.6",
				expected: [
					{ tool_choice: "none" },
					{ tools: xAiTools, tool_choice: "required" },
					{
						tools: xAiTools,
						tool_choice: { type: "function", function: { name: "search" } },
					},
				],
			},
		];

		for (const testCase of cases) {
			for (const [index, choice] of choices.entries()) {
				const payload = buildZedProviderRequest(testCase.kind, { ...context }, makeModel(testCase.model), {
					toolChoice: choice,
				}) as Record<string, unknown>;
				expect(payload).toMatchObject(testCase.expected[index]);
				if (choice === "none") {
					expect(payload.tools).toBeUndefined();
				} else {
					expect(payload.tools).toBeDefined();
				}
			}
		}
	});

	it("preserves aborted status when the response body fails during a caller cancellation", async () => {
		const abortController = new AbortController();
		const encoder = new TextEncoder();
		const responseReady = Promise.withResolvers<void>();
		const readStarted = Promise.withResolvers<void>();
		let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
		const fetchMock: FetchImpl = mockFetch(async () => {
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					bodyController = controller;
					const firstFrame = JSON.stringify({
						event: { type: "response.output_text.delta", delta: "partial" },
					});
					controller.enqueue(encoder.encode(`${firstFrame}\n`));
				},
				pull() {
					readStarted.resolve();
				},
			});
			responseReady.resolve();
			return new Response(body, { status: 200, headers: { "content-type": "application/x-ndjson" } });
		});

		const stream = streamZed(makeModel("gpt-5.6-luna"), userContext(), {
			apiKey: "raw-zed-token",
			fetch: fetchMock,
			signal: abortController.signal,
		});
		await responseReady.promise;
		await readStarted.promise;
		abortController.abort();
		bodyController?.error(new DOMException("The operation was aborted.", "AbortError"));
		const result = await stream.result();

		expect(result.stopReason).toBe("aborted");
		expect(result.errorStatus).toBeUndefined();
		expect(result.errorMessage).toMatch(/aborted/i);
	});
});
