import { describe, expect, it } from "bun:test";
import { buildZedProviderRequest, streamZed } from "../src/providers/zed";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	FetchImpl,
	Model,
	ToolChoice,
	ToolResultMessage,
} from "../src/types";
import { mockFetch } from "./helpers/fetch-mock";

const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function makeModel(id: string, reasoning = false): Model<"zed-agent"> {
	return {
		id,
		name: id,
		api: "zed-agent",
		provider: "zed-agent",
		baseUrl: "https://cloud.zed.dev",
		reasoning,
		contextWindow: 1_000_000,
		maxTokens: 66_000,
		input: ["text", "image"],
		cost: zeroCost,
		compat: undefined,
	};
}

function ndjsonResponse(frames: unknown[]): Response {
	return new Response(`${frames.map(frame => JSON.stringify(frame)).join("\n")}\n`, {
		status: 200,
		headers: { "content-type": "application/x-ndjson" },
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

	it("fails instead of completing when EOF arrives before stream_ended", async () => {
		const run = await runZedStream(makeModel("gpt-5.6-luna"), [
			{ event: { type: "response.output_text.delta", delta: "partial" } },
		]);

		expect(run.result.stopReason).toBe("error");
		expect(run.result.errorMessage).toBe("Zed stream closed before stream_ended status was received");
		expect(run.events.at(-1)?.type).toBe("error");
		expect(run.events.some(event => event.type === "done")).toBe(false);
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
