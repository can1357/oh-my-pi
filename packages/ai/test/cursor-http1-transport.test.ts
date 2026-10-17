import { expect, it } from "bun:test";
import type { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { streamCursor } from "@oh-my-pi/pi-ai/providers/cursor";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	AgentClientMessageSchema,
	AgentServerMessageSchema,
	BidiAppendRequestSchema,
	BidiRequestIdSchema,
	ConversationStateStructureSchema,
	ConversationTokenDetailsSchema,
	ExecServerMessageSchema,
	type InteractionUpdate,
	InteractionUpdateSchema,
	McpArgsSchema,
	McpToolCallSchema,
	ReadArgsSchema,
	StepCompletedUpdateSchema,
	TextDeltaUpdateSchema,
	ToolCallSchema,
	ToolCallStartedUpdateSchema,
	TurnEndedUpdateSchema,
	type TurnEndedUpdate,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { create, fromBinary, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";

const CONNECT_END_STREAM_FLAG = 0x02;

function frameConnectMessage(data: Uint8Array, flags = 0): Buffer {
	const frame = Buffer.alloc(5 + data.length);
	frame[0] = flags;
	frame.writeUInt32BE(data.length, 1);
	frame.set(data, 5);
	return frame;
}

function readConnectMessage(frame: Uint8Array): Uint8Array {
	if (frame.length < 5) throw new Error("truncated Connect frame");
	const length = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(1, false);
	if (frame.length !== length + 5) throw new Error("invalid Connect frame length");
	return frame.subarray(5);
}

function interactionFrame(message: InteractionUpdate["message"]): Buffer {
	return frameConnectMessage(
		toBinary(
			AgentServerMessageSchema,
			create(AgentServerMessageSchema, {
				message: { case: "interactionUpdate", value: create(InteractionUpdateSchema, { message }) },
			}),
		),
	);
}

function textDeltaFrame(text: string): Buffer {
	return interactionFrame({ case: "textDelta", value: create(TextDeltaUpdateSchema, { text }) });
}

function turnEndedFrame(usage: Partial<TurnEndedUpdate> = {}): Buffer {
	return interactionFrame({ case: "turnEnded", value: create(TurnEndedUpdateSchema, usage) });
}

function checkpointFrame(usedTokens: number): Buffer {
	return frameConnectMessage(
		toBinary(
			AgentServerMessageSchema,
			create(AgentServerMessageSchema, {
				message: {
					case: "conversationCheckpointUpdate",
					value: create(ConversationStateStructureSchema, {
						tokenDetails: create(ConversationTokenDetailsSchema, { usedTokens }),
					}),
				},
			}),
		),
	);
}

function connectEndErrorFrame(code: string): Buffer {
	return frameConnectMessage(Buffer.from(JSON.stringify({ error: { code } }), "utf8"), CONNECT_END_STREAM_FLAG);
}

function makeModel(baseUrl: string): Model<"cursor-agent"> {
	return buildModel({
		id: "cursor-http1-fixture",
		name: "Cursor HTTP1 fixture",
		api: "cursor-agent",
		provider: "cursor",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1,
		maxTokens: 1,
	});
}

const context: Context = { messages: [{ role: "user", content: "transport", timestamp: 1 }] };

/**
 * Serves RunSSE and hands its response controller to `onRunRequest` once the
 * client's first BidiAppend (the run request) arrives.
 */
function startRunSseServer(onRunRequest: (controller: ReadableStreamDefaultController<Uint8Array>) => void) {
	const streamReady = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
	let runRequestSeen = false;
	return Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			await request.arrayBuffer();
			if (url.pathname === "/agent.v1.AgentService/RunSSE") {
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							streamReady.resolve(controller);
						},
					}),
					{ headers: { "content-type": "application/connect+proto" } },
				);
			}
			if (url.pathname === "/aiserver.v1.BidiService/BidiAppend") {
				if (!runRequestSeen) {
					runRequestSeen = true;
					onRunRequest(await streamReady.promise);
				}
				return new Response(null, { headers: { "content-type": "application/proto" } });
			}
			return new Response(null, { status: 404 });
		},
	});
}

/** A turn that never settles fails the test at this bound instead of hanging the suite. */
const SETTLE_TIMEOUT_MS = 2_000;

/** Drains the stream, recording every terminal event it emits. */
async function drain(response: AssistantMessageEventStream, onEvent?: (type: string) => void) {
	const terminalEvents: string[] = [];
	for await (const event of response) {
		onEvent?.(event.type);
		if (event.type === "done" || event.type === "error") terminalEvents.push(event.type);
	}
	return { result: await response.result(), terminalEvents };
}

it("streams through RunSSE and sends AgentClientMessage frames through BidiAppend", async () => {
	const streamReady = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
	const runRequestIds: string[] = [];
	const appendRequestIds: string[] = [];
	const appendSeqnos: bigint[] = [];
	const appendedCases: string[] = [];
	const streamingHeaders: string[] = [];

	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			streamingHeaders.push(request.headers.get("x-cursor-streaming") ?? "");
			const body = new Uint8Array(await request.arrayBuffer());
			if (url.pathname === "/agent.v1.AgentService/RunSSE") {
				const requestId = fromBinary(BidiRequestIdSchema, readConnectMessage(body));
				runRequestIds.push(requestId.requestId);
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							streamReady.resolve(controller);
						},
					}),
					{ headers: { "content-type": "application/connect+proto" } },
				);
			}
			if (url.pathname === "/aiserver.v1.BidiService/BidiAppend") {
				// BidiAppend is a unary RPC: the live service answers 415 to a
				// streaming-framed `application/connect+proto` body and accepts only
				// an unframed `application/proto` message.
				if (request.headers.get("content-type") !== "application/proto") {
					return new Response(null, { status: 415 });
				}
				const append = fromBinary(BidiAppendRequestSchema, body);
				appendRequestIds.push(append.requestId?.requestId ?? "");
				appendSeqnos.push(append.appendSeqno);
				appendedCases.push(fromBinary(AgentClientMessageSchema, append.dataBinary).message.case ?? "");
				const controller = await streamReady.promise;
				controller.enqueue(textDeltaFrame("http1 ok"));
				controller.enqueue(turnEndedFrame());
				controller.close();
				return new Response(null, { headers: { "content-type": "application/proto" } });
			}
			return new Response(null, { status: 404 });
		},
	});

	try {
		const response = streamCursor(makeModel(server.url.toString()), context, {
			apiKey: "test-token",
			transport: "http1",
		});
		const { result, terminalEvents } = await drain(response);

		expect(terminalEvents).toEqual(["done"]);
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([expect.objectContaining({ type: "text", text: "http1 ok" })]);
		expect(runRequestIds).toHaveLength(1);
		expect(appendRequestIds).toEqual(runRequestIds);
		expect(appendSeqnos).toEqual([0n]);
		expect(appendedCases).toEqual(["runRequest"]);
		expect(streamingHeaders).toEqual(["true", "true"]);
	} finally {
		server.stop(true);
	}
});

it(
	"settles a turn with the error an end-stream frame carries",
	async () => {
		const server = startRunSseServer(controller => {
			controller.enqueue(textDeltaFrame("partial"));
			controller.enqueue(connectEndErrorFrame("resource_exhausted"));
			controller.close();
		});

		try {
			const response = streamCursor(makeModel(server.url.toString()), context, {
				apiKey: "test-token",
				transport: "http1",
			});
			const { result, terminalEvents } = await drain(response);

			expect(terminalEvents).toEqual(["error"]);
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("resource_exhausted");
		} finally {
			server.stop(true);
		}
	},
	SETTLE_TIMEOUT_MS,
);

it(
	"settles a caller abort on a live RunSSE stream as aborted",
	async () => {
		const server = startRunSseServer(controller => {
			// `turnEnded` arrives but the transport never ends, so the turn is still
			// waiting on a clean end when the caller aborts. Closing the transport
			// must not turn that abort into a successful completion.
			controller.enqueue(Buffer.concat([textDeltaFrame("partial"), turnEndedFrame()]));
		});
		const abort = new AbortController();

		try {
			const response = streamCursor(makeModel(server.url.toString()), context, {
				apiKey: "test-token",
				transport: "http1",
				signal: abort.signal,
			});
			const { result, terminalEvents } = await drain(response, type => {
				if (type === "text_delta") abort.abort();
			});

			expect(terminalEvents).toEqual(["error"]);
			expect(result.stopReason).toBe("aborted");
		} finally {
			server.stop(true);
		}
	},
	SETTLE_TIMEOUT_MS,
);

it.each([
	{
		name: "text progress then bill echo",
		progress: true,
		echo: true,
		echoFirst: false,
		refreshed: false,
		expected: 0,
	},
	{
		name: "text progress after a bill echo",
		progress: true,
		echo: true,
		echoFirst: true,
		refreshed: false,
		expected: 0,
	},
	{
		name: "text progress without another checkpoint",
		progress: true,
		echo: false,
		echoFirst: false,
		refreshed: false,
		expected: 0,
	},
	{
		name: "fresh checkpoint after text progress",
		progress: true,
		echo: true,
		echoFirst: false,
		refreshed: true,
		expected: 427_000,
	},
	{
		name: "bill echo without later progress",
		progress: false,
		echo: true,
		echoFirst: false,
		refreshed: false,
		expected: 424_000,
	},
	{
		name: "usage and keepalives after a checkpoint",
		progress: false,
		echo: false,
		echoFirst: false,
		refreshed: false,
		expected: 424_000,
	},
])("does not publish stale context occupancy: $name", async scenario => {
	const server = startRunSseServer(controller => {
		controller.enqueue(textDeltaFrame("prefix"));
		controller.enqueue(checkpointFrame(424_000));
		if (scenario.echoFirst) controller.enqueue(checkpointFrame(892_018));
		if (scenario.progress) controller.enqueue(textDeltaFrame(" tail"));
		controller.enqueue(interactionFrame({ case: "heartbeat", value: {} }));
		controller.enqueue(interactionFrame({ case: "tokenDelta", value: { tokens: 10 } }));
		controller.enqueue(interactionFrame({ case: "stepCompleted", value: create(StepCompletedUpdateSchema, {}) }));
		if (scenario.refreshed) controller.enqueue(checkpointFrame(427_000));
		controller.enqueue(turnEndedFrame({ inputTokens: 889_190n, outputTokens: 2_828n, cacheReadTokens: 882_816n }));
		if (scenario.echo && !scenario.echoFirst) controller.enqueue(checkpointFrame(892_018));
		controller.close();
	});
	try {
		const model = { ...makeModel(server.url.toString()), contextWindow: 500_000, maxTokens: 8_192 };
		const response = streamCursor(model, context, {
			apiKey: "test-token",
			transport: "http1",
			signal: AbortSignal.timeout(SETTLE_TIMEOUT_MS),
		});
		const { result, terminalEvents } = await drain(response);

		expect(terminalEvents).toEqual(["done"]);
		expect(result.content).toEqual([
			expect.objectContaining({ type: "text", text: scenario.progress ? "prefix tail" : "prefix" }),
		]);
		expect(result.usage.contextTokens).toBe(scenario.expected);
		expect(result.usage.totalTokens).toBe(892_018);
	} finally {
		server.stop(true);
	}
});

it("invalidates a checkpoint when a pending exec result advances the completed turn", async () => {
	const releaseRead = Promise.withResolvers<void>();
	const server = startRunSseServer(controller => {
		controller.enqueue(
			Buffer.concat([
				frameConnectMessage(
					toBinary(
						AgentServerMessageSchema,
						create(AgentServerMessageSchema, {
							message: {
								case: "execServerMessage",
								value: create(ExecServerMessageSchema, {
									id: 1,
									execId: "pending-read",
									message: {
										case: "readArgs",
										value: create(ReadArgsSchema, { path: "/fixture", toolCallId: "read-1" }),
									},
								}),
							},
						}),
					),
				),
				checkpointFrame(424_000),
				turnEndedFrame({ inputTokens: 889_190n, outputTokens: 2_828n, cacheReadTokens: 882_816n }),
				checkpointFrame(892_018),
			]),
		);
		controller.close();
	});
	try {
		const response = streamCursor(
			{ ...makeModel(server.url.toString()), contextWindow: 500_000, maxTokens: 8_192 },
			context,
			{
				apiKey: "test-token",
				transport: "http1",
				signal: AbortSignal.timeout(SETTLE_TIMEOUT_MS),
				execHandlers: {
					async read() {
						await releaseRead.promise;
						return {
							role: "toolResult",
							toolCallId: "read-1",
							toolName: "read",
							content: [{ type: "text", text: "file contents" }],
							isError: false,
							timestamp: 1,
						};
					},
				},
			},
		);
		const { result, terminalEvents } = await drain(response, type => {
			if (type === "toolcall_start") releaseRead.resolve();
		});

		expect(terminalEvents).toEqual(["done"]);
		expect(result.content).toEqual([expect.objectContaining({ type: "toolCall", id: "read-1", name: "read" })]);
		expect(result.usage.contextTokens).toBe(0);
		expect(result.usage.totalTokens).toBe(892_018);
	} finally {
		releaseRead.resolve();
		server.stop(true);
	}
});

it("invalidates a checkpoint when teardown settles an unfinished tool call", async () => {
	const server = startRunSseServer(controller => {
		controller.enqueue(
			Buffer.concat([
				interactionFrame({
					case: "toolCallStarted",
					value: create(ToolCallStartedUpdateSchema, {
						callId: "pending-mcp",
						toolCall: create(ToolCallSchema, {
							tool: {
								case: "mcpToolCall",
								value: create(McpToolCallSchema, { args: create(McpArgsSchema, { toolCallId: "mcp-1" }) }),
							},
						}),
					}),
				}),
				checkpointFrame(424_000),
				turnEndedFrame({ inputTokens: 889_190n, outputTokens: 2_828n, cacheReadTokens: 882_816n }),
				checkpointFrame(892_018),
			]),
		);
		controller.close();
	});
	try {
		const response = streamCursor(
			{ ...makeModel(server.url.toString()), contextWindow: 500_000, maxTokens: 8_192 },
			context,
			{
				apiKey: "test-token",
				transport: "http1",
				signal: AbortSignal.timeout(SETTLE_TIMEOUT_MS),
			},
		);
		const { result, terminalEvents } = await drain(response);

		expect(terminalEvents).toEqual(["done"]);
		expect(result.content).toEqual([expect.objectContaining({ type: "toolCall", id: "mcp-1" })]);
		expect(result.usage.contextTokens).toBe(0);
		expect(result.usage.totalTokens).toBe(892_018);
	} finally {
		server.stop(true);
	}
});
