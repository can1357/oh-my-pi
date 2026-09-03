import { afterEach, describe, expect, it } from "bun:test";
import * as http2 from "node:http2";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { streamCursor } from "@oh-my-pi/pi-ai/providers/cursor";
import type { Context, CursorToolResultHandler, Model, ToolResultMessage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	AgentServerMessageSchema,
	ExecServerMessageSchema,
	InteractionUpdateSchema,
	ReadArgsSchema,
	TextDeltaUpdateSchema,
	ToolCallSchema,
	ToolCallStartedUpdateSchema,
	TurnEndedUpdateSchema,
	UpdateTodosArgsSchema,
	UpdateTodosToolCallSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { create, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";

const CONNECT_END_STREAM_FLAG = 0b00000010;

type Scenario =
	| { kind: "success" }
	| { kind: "connect-error-after-turn" }
	| { kind: "connect-detailed-error-after-turn" }
	| { kind: "connect-classification-detail-after-turn" }
	| { kind: "grpc-trailer-after-turn" }
	| { kind: "end-before-turn" }
	| { kind: "hang-after-turn" }
	| { kind: "exec-in-final-chunk"; responseFinished: PromiseWithResolvers<void> }
	| { kind: "exec-then-transport-error"; responseFinished: PromiseWithResolvers<void> }
	| { kind: "exec-then-hang" }
	| { kind: "todo-start-then-death" };

let server: http2.Http2Server | undefined;
const sessions = new Set<http2.Http2Session>();
let scenario: Scenario = { kind: "success" };

function frameConnectMessage(data: Uint8Array, flags = 0): Buffer {
	const frame = Buffer.alloc(5 + data.length);
	frame[0] = flags;
	frame.writeUInt32BE(data.length, 1);
	frame.set(data, 5);
	return frame;
}

function textDeltaFrame(text: string): Buffer {
	const message = create(AgentServerMessageSchema, {
		message: {
			case: "interactionUpdate",
			value: create(InteractionUpdateSchema, {
				message: {
					case: "textDelta",
					value: create(TextDeltaUpdateSchema, { text }),
				},
			}),
		},
	});
	return frameConnectMessage(toBinary(AgentServerMessageSchema, message));
}

function turnEndedFrame(): Buffer {
	const message = create(AgentServerMessageSchema, {
		message: {
			case: "interactionUpdate",
			value: create(InteractionUpdateSchema, {
				message: {
					case: "turnEnded",
					value: create(TurnEndedUpdateSchema, {}),
				},
			}),
		},
	});
	return frameConnectMessage(toBinary(AgentServerMessageSchema, message));
}

function connectEndErrorFrame(code: string, message: string, details?: unknown): Buffer {
	const payload = Buffer.from(
		JSON.stringify({ error: { code, message, ...(details === undefined ? {} : { details }) } }),
		"utf8",
	);
	return frameConnectMessage(payload, CONNECT_END_STREAM_FLAG);
}

/**
 * A `read` exec request. The provider parses every frame in a chunk
 * synchronously and dispatches each `handleServerMessage` fire-and-forget, so
 * pairing this with a terminal frame in ONE chunk leaves the exec handler
 * running while the transport settles.
 */
function execRequestFrame(): Buffer {
	const message = create(AgentServerMessageSchema, {
		message: {
			case: "execServerMessage",
			value: create(ExecServerMessageSchema, {
				id: 1,
				execId: "exec-final",
				message: {
					case: "readArgs",
					value: create(ReadArgsSchema, { path: "/tmp/final", toolCallId: "call-final" }),
				},
			}),
		},
	});
	return frameConnectMessage(toBinary(AgentServerMessageSchema, message));
}

/**
 * Exec request + `turnEnded` in one chunk: the clean-completion race. Without a
 * barrier before `done`, the Agent drains its Cursor result buffer first and
 * the call is never paired.
 */
function execAndTurnEndedFrame(): Buffer {
	return Buffer.concat([execRequestFrame(), turnEndedFrame()]);
}

/**
 * A native `update_todos` call announcement. Cursor runs these server-side, so
 * the block is stamped resolved at start and only its `toolCallCompleted`
 * frame pairs a result — nothing downstream synthesizes one.
 */
function todoStartFrame(): Buffer {
	const message = create(AgentServerMessageSchema, {
		message: {
			case: "interactionUpdate",
			value: create(InteractionUpdateSchema, {
				message: {
					case: "toolCallStarted",
					value: create(ToolCallStartedUpdateSchema, {
						callId: "todo-envelope",
						toolCall: create(ToolCallSchema, {
							tool: {
								case: "updateTodosToolCall",
								value: create(UpdateTodosToolCallSchema, {
									args: create(UpdateTodosArgsSchema, { todos: [] }),
								}),
							},
						}),
					}),
				},
			}),
		},
	});
	return frameConnectMessage(toBinary(AgentServerMessageSchema, message));
}

async function startServer(): Promise<string> {
	server = http2.createServer();
	server.on("session", session => {
		sessions.add(session);
		session.on("close", () => sessions.delete(session));
	});
	server.on("stream", (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
		stream.on("data", () => {});

		if (headers[":path"] !== "/agent.v1.AgentService/Run") {
			stream.respond({ ":status": 404 });
			stream.end();
			return;
		}

		if (scenario.kind === "grpc-trailer-after-turn") {
			stream.respond(
				{
					":status": 200,
					"content-type": "application/connect+proto",
				},
				{ waitForTrailers: true },
			);
			stream.on("wantTrailers", () => {
				stream.sendTrailers({
					"grpc-status": "13",
					"grpc-message": encodeURIComponent("post-turn trailer failure"),
				});
			});
			stream.write(textDeltaFrame("hello"));
			stream.write(turnEndedFrame());
			stream.end();
			return;
		}

		stream.respond({
			":status": 200,
			"content-type": "application/connect+proto",
		});

		if (scenario.kind === "end-before-turn") {
			stream.write(textDeltaFrame("partial"));
			stream.end();
			return;
		}

		if (scenario.kind === "todo-start-then-death") {
			// The server announces a native todo call, then the stream dies
			// without `turnEnded` and without the call's completion frame. This
			// is the real interrupted-call shape: `settleH2` rejects, so the
			// success-path flush never runs.
			stream.write(todoStartFrame());
			stream.end();
			return;
		}

		if (scenario.kind === "exec-in-final-chunk") {
			const { responseFinished } = scenario;
			// Resolves once the server has flushed the whole response, so the test
			// never guesses at timing.
			stream.on("finish", () => responseFinished.resolve());
			stream.write(execAndTurnEndedFrame());
			stream.end();
			return;
		}

		if (scenario.kind === "exec-then-transport-error") {
			const { responseFinished } = scenario;
			stream.on("finish", () => responseFinished.resolve());
			// The exec request and the failure land in ONE chunk: the handler is
			// dispatched fire-and-forget and is still running when the transport
			// rejects. `turnEnded` is deliberately absent — this is the turn dying,
			// not ending.
			stream.write(
				Buffer.concat([execRequestFrame(), connectEndErrorFrame("unavailable", "mid-exec transport failure")]),
			);
			stream.end();
			return;
		}

		if (scenario.kind === "exec-then-hang") {
			// Exec request, then the stream stays open: the only way this turn
			// ends is the client aborting.
			stream.write(execRequestFrame());
			return;
		}

		stream.write(Buffer.concat([textDeltaFrame("hello"), turnEndedFrame()]));

		if (scenario.kind === "connect-error-after-turn") {
			stream.write(connectEndErrorFrame("unavailable", "post-turn connect failure"));
			stream.end();
			return;
		}

		if (scenario.kind === "connect-detailed-error-after-turn") {
			stream.write(
				connectEndErrorFrame("invalid_argument", "Error", [
					{ type: "google.rpc.ErrorInfo", value: "quota exceeded for request field tools" },
				]),
			);
			stream.end();
			return;
		}

		if (scenario.kind === "connect-classification-detail-after-turn") {
			stream.write(
				connectEndErrorFrame("invalid_argument", "Error", [
					{ type: "google.rpc.ErrorInfo", debug: "quota exceeded for this account" },
				]),
			);
			stream.end();
			return;
		}

		if (scenario.kind === "hang-after-turn") {
			return;
		}

		stream.end();
	});

	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("expected http2 fixture server to bind a tcp port");
	}
	return `http://127.0.0.1:${address.port}`;
}

function makeModel(baseUrl: string): Model<"cursor-agent"> {
	return buildModel({
		id: "cursor-terminal-fixture",
		name: "Cursor terminal fixture",
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

const context: Context = {
	messages: [{ role: "user", content: "terminal lifecycle", timestamp: 1 }],
};

async function collectStream(
	model: Model<"cursor-agent">,
	options?: { signal?: AbortSignal; onToolResult?: CursorToolResultHandler },
) {
	const stream = streamCursor(model, context, {
		apiKey: "test-token",
		signal: options?.signal,
		onToolResult: options?.onToolResult,
	});
	const eventTypes: string[] = [];
	for await (const event of stream) {
		eventTypes.push(event.type);
	}
	const result = await stream.result();
	return { eventTypes, result };
}

async function stopServer(): Promise<void> {
	for (const session of sessions) {
		session.destroy();
	}
	sessions.clear();
	if (!server) return;
	const closing = server;
	server = undefined;
	const closed = Promise.withResolvers<void>();
	closing.close(error => {
		if (error) {
			closed.reject(error);
		} else {
			closed.resolve();
		}
	});
	await closed.promise;
}

afterEach(async () => {
	scenario = { kind: "success" };
	await stopServer();
});

describe("Cursor terminal lifecycle after turnEnded", () => {
	it("emits done only after turnEnded and a clean protocol end", async () => {
		scenario = { kind: "success" };
		const baseUrl = await startServer();
		const { eventTypes, result } = await collectStream(makeModel(baseUrl));
		expect(eventTypes).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
	});

	it("surfaces CONNECT end-stream errors that arrive after turnEnded", async () => {
		scenario = { kind: "connect-error-after-turn" };
		const baseUrl = await startServer();
		const { eventTypes, result } = await collectStream(makeModel(baseUrl));
		expect(eventTypes[0]).toBe("start");
		expect(eventTypes.at(-1)).toBe("error");
		expect(eventTypes).not.toContain("done");
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Connect error unavailable: post-turn connect failure");
	});

	it("surfaces standard Connect detail values without changing recovery classification", async () => {
		scenario = { kind: "connect-detailed-error-after-turn" };
		const baseUrl = await startServer();
		const { result } = await collectStream(makeModel(baseUrl));
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("google.rpc.ErrorInfo");
		expect(result.errorMessage).toContain("quota exceeded for request field tools");
		expect(AIError.is(result.errorId, AIError.Flag.UsageLimit)).toBe(false);
	});

	it("keeps appended Connect diagnostics out of recovery classification", async () => {
		scenario = { kind: "connect-classification-detail-after-turn" };
		const baseUrl = await startServer();
		const { result } = await collectStream(makeModel(baseUrl));
		expect(result.errorMessage).toContain("quota exceeded for this account");
		expect(AIError.is(result.errorId, AIError.Flag.UsageLimit)).toBe(false);
	});

	it("surfaces nonzero gRPC trailers that arrive after turnEnded", async () => {
		scenario = { kind: "grpc-trailer-after-turn" };
		const baseUrl = await startServer();
		const { eventTypes, result } = await collectStream(makeModel(baseUrl));
		expect(eventTypes[0]).toBe("start");
		expect(eventTypes.at(-1)).toBe("error");
		expect(eventTypes).not.toContain("done");
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("gRPC error 13: post-turn trailer failure");
	});

	it("rejects when the stream ends before turnEnded", async () => {
		scenario = { kind: "end-before-turn" };
		const baseUrl = await startServer();
		const { eventTypes, result } = await collectStream(makeModel(baseUrl));
		expect(eventTypes[0]).toBe("start");
		expect(eventTypes.at(-1)).toBe("error");
		expect(eventTypes).not.toContain("done");
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Cursor stream ended before turnEnded");
	});

	it("pairs and closes a server-owned call the dying stream left open", async () => {
		// The failure this guards: a native todo block is stamped resolved at
		// start, so `agent-loop.ts` synthesizes no placeholder for it and only
		// its completion frame pairs a result. When the transport dies first the
		// call went unpaired and its card stayed animating — and
		// `buildSessionContext` strips a dangling call, so the interaction
		// vanished from every rebuilt transcript.
		//
		// This must run against the real terminal-error path: `settleH2` rejects
		// on a stream that ends before `turnEnded`, so the success path's flush
		// is never reached.
		scenario = { kind: "todo-start-then-death" };
		const baseUrl = await startServer();
		const paired: ToolResultMessage[] = [];
		const { eventTypes, result } = await collectStream(makeModel(baseUrl), {
			onToolResult: toolResult => void paired.push(toolResult),
		});

		expect(eventTypes.at(-1)).toBe("error");
		expect(result.stopReason).toBe("error");

		const call = result.content.find(block => block.type === "toolCall");
		if (!call) throw new Error("expected the announced todo call in the output");
		// Closed, so no live card is left animating.
		expect(eventTypes).toContain("toolcall_end");
		// Paired, so replay keeps the interaction.
		expect(paired).toHaveLength(1);
		expect(paired[0].toolCallId).toBe(call.id);
		expect(paired[0].isError).toBe(true);
	});

	it("aborts without emitting done when the signal fires", async () => {
		scenario = { kind: "hang-after-turn" };
		const baseUrl = await startServer();
		const controller = new AbortController();
		const stream = streamCursor(makeModel(baseUrl), context, {
			apiKey: "test-token",
			signal: controller.signal,
		});
		const eventTypes: string[] = [];
		for await (const event of stream) {
			eventTypes.push(event.type);
			if (event.type === "text_delta") controller.abort();
		}
		const result = await stream.result();
		expect(eventTypes[0]).toBe("start");
		expect(eventTypes.at(-1)).toBe("error");
		expect(eventTypes).not.toContain("done");
		expect(result.stopReason).toBe("aborted");
	});

	it("waits for an exec handler decoded from the final chunk before done", async () => {
		// The provider dispatches every decoded message fire-and-forget so the
		// socket keeps draining. When the exec request, `turnEnded` and the close
		// arrive in ONE chunk, the transport completes while the handler is still
		// running. `done` must not be pushed first: the Agent drains its Cursor
		// result buffer on the terminal event, so a result reserved afterwards
		// misses the drain and the synthesized (already resolved) toolCall block
		// is stripped from every rebuilt transcript as dangling.
		//
		// No wall-clock delay. The handler is released only after the server has
		// flushed its whole response AND the handler is known to be running, so
		// the transport has genuinely completed while the handler is in flight.
		const responseFinished = Promise.withResolvers<void>();
		scenario = { kind: "exec-in-final-chunk", responseFinished };
		const baseUrl = await startServer();
		const paired: string[] = [];
		const handlerStarted = Promise.withResolvers<void>();
		const handlerDone = Promise.withResolvers<void>();
		const stream = streamCursor(makeModel(baseUrl), context, {
			apiKey: "test-token",
			execHandlers: {
				async read() {
					handlerStarted.resolve();
					await handlerDone.promise;
					return {
						role: "toolResult",
						toolCallId: "call-final",
						toolName: "read",
						content: [{ type: "text", text: "file body" }],
						isError: false,
						timestamp: 1,
					};
				},
			},
			onToolResult: result => {
				paired.push(result.toolCallId);
				return result;
			},
		});

		const gate = (async () => {
			await Promise.all([handlerStarted.promise, responseFinished.promise]);
			// `finish` means the server flushed its bytes, not that the client has
			// processed the end. Yield so the client's `end` handler and every
			// queued continuation run first: a provider that does not await the
			// handler settles the stream in exactly that window.
			await Bun.sleep(0);
			try {
				expect(stream.resultSettled).toBe(false);
				expect(paired).toEqual([]);
			} finally {
				// Always release: a failing assertion here must surface as that
				// failure, not as a hung `for await` that waits for a handler
				// nobody will ever unblock.
				handlerDone.resolve();
			}
		})();

		const eventTypes: string[] = [];
		for await (const event of stream) {
			// The result must already be paired by the time `done` is observed.
			if (event.type === "done") expect(paired).toEqual(["call-final"]);
			eventTypes.push(event.type);
		}
		await gate;

		expect(eventTypes).toContain("done");
		expect(paired).toEqual(["call-final"]);
	});

	it("waits for an in-flight exec handler before emitting the transport error", async () => {
		// Same race as above, but the turn DIES instead of ending: the exec request
		// and the transport failure arrive in one chunk. The Agent finalizes the
		// synthesized call from the terminal error and clears its Cursor result
		// buffer, so a handler still running would land its real result after
		// `agent_end` and have it discarded — even though the tool may already
		// have performed side effects. The error must not be pushed first.
		const responseFinished = Promise.withResolvers<void>();
		scenario = { kind: "exec-then-transport-error", responseFinished };
		const baseUrl = await startServer();
		const paired: string[] = [];
		const handlerStarted = Promise.withResolvers<void>();
		const handlerDone = Promise.withResolvers<void>();
		const stream = streamCursor(makeModel(baseUrl), context, {
			apiKey: "test-token",
			execHandlers: {
				async read() {
					handlerStarted.resolve();
					await handlerDone.promise;
					return {
						role: "toolResult",
						toolCallId: "call-final",
						toolName: "read",
						content: [{ type: "text", text: "file body" }],
						isError: false,
						timestamp: 1,
					};
				},
			},
			onToolResult: result => {
				paired.push(result.toolCallId);
				return result;
			},
		});

		const gate = (async () => {
			await Promise.all([handlerStarted.promise, responseFinished.promise]);
			await Bun.sleep(0);
			try {
				expect(stream.resultSettled).toBe(false);
				expect(paired).toEqual([]);
			} finally {
				handlerDone.resolve();
			}
		})();

		const eventTypes: string[] = [];
		for await (const event of stream) {
			// The handler's result must already exist by the time the terminal
			// error is observed — that is the event the Agent drains on.
			if (event.type === "error") expect(paired).toEqual(["call-final"]);
			eventTypes.push(event.type);
		}
		await gate;
		const result = await stream.result();

		expect(eventTypes.at(-1)).toBe("error");
		expect(eventTypes).not.toContain("done");
		expect(result.errorMessage).toContain("mid-exec transport failure");
		expect(paired).toEqual(["call-final"]);
	});

	it("does not hold the abort hostage to a hung exec handler", async () => {
		// Exec handlers have no cancellation contract — the coding-agent bridge
		// invokes `tool.execute` with no signal — so a hung or long-running tool
		// cannot be interrupted. Once the user aborts, the drain must not wait
		// for it: the Agent finalizes from the abort error and discards late
		// results regardless, so waiting only delays the terminal event the
		// user asked for. Without the abort-bounded drain this test times out
		// with the stream never settling.
		scenario = { kind: "exec-then-hang" };
		const baseUrl = await startServer();
		const controller = new AbortController();
		const handlerStarted = Promise.withResolvers<void>();
		const handlerDone = Promise.withResolvers<void>();
		const stream = streamCursor(makeModel(baseUrl), context, {
			apiKey: "test-token",
			signal: controller.signal,
			execHandlers: {
				async read() {
					handlerStarted.resolve();
					await handlerDone.promise;
					return {
						role: "toolResult",
						toolCallId: "call-final",
						toolName: "read",
						content: [{ type: "text", text: "late result" }],
						isError: false,
						timestamp: 1,
					};
				},
			},
		});

		const gate = (async () => {
			await handlerStarted.promise;
			controller.abort();
		})();

		const eventTypes: string[] = [];
		for await (const event of stream) {
			eventTypes.push(event.type);
		}
		await gate;
		const result = await stream.result();
		// Released only AFTER the stream settled: reaching this line at all
		// proves the terminal error did not wait for the handler.
		handlerDone.resolve();

		expect(eventTypes.at(-1)).toBe("error");
		expect(eventTypes).not.toContain("done");
		expect(result.stopReason).toBe("aborted");
	});
});
