import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as http2 from "node:http2";
import * as net from "node:net";
import { cursorTransportTunables, streamCursor } from "@oh-my-pi/pi-ai/providers/cursor";
import type { Context, CursorExecHandlers, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	type AgentClientMessage,
	AgentClientMessageSchema,
	AgentServerMessageSchema,
	ConversationStateStructureSchema,
	ExecServerMessageSchema,
	InteractionUpdateSchema,
	McpArgsSchema,
	TextDeltaUpdateSchema,
	TurnEndedUpdateSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { create, fromBinary, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";

// Real timers are required here to exercise HTTP/2 TCP loopback socket I/O,
// session PING/ACK exchange, and connection teardown across real network events.

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

function checkpointFrame(pendingToolCalls: string[] = []): Buffer {
	const message = create(AgentServerMessageSchema, {
		message: {
			case: "conversationCheckpointUpdate",
			value: create(ConversationStateStructureSchema, {
				pendingToolCalls,
			}),
		},
	});
	return frameConnectMessage(toBinary(AgentServerMessageSchema, message));
}

function mcpRequestFrame(toolCallId: string, name = "e2e_probe", execId = 1): Buffer {
	const message = create(AgentServerMessageSchema, {
		message: {
			case: "execServerMessage",
			value: create(ExecServerMessageSchema, {
				id: execId,
				execId: `exec-${toolCallId}-${execId}`,
				message: {
					case: "mcpArgs",
					value: create(McpArgsSchema, {
						toolCallId,
						name,
						toolName: name,
						providerIdentifier: "test",
						args: {},
					}),
				},
			}),
		},
	});
	return frameConnectMessage(toBinary(AgentServerMessageSchema, message));
}

let server: http2.Http2Server | undefined;
const sessions = new Set<http2.Http2Session>();

interface StreamRecord {
	headers: http2.IncomingHttpHeaders;
	runRequest?: AgentClientMessage;
	body: Buffer;
}

const recordedStreams: StreamRecord[] = [];
let streamHandler:
	| ((stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders, record: StreamRecord) => void)
	| undefined;

async function startServer(): Promise<string> {
	server = http2.createServer();
	server.on("session", session => {
		sessions.add(session);
		session.on("close", () => sessions.delete(session));
		session.on("error", () => {});
	});
	server.on("stream", (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
		stream.on("error", () => {});
		const record: StreamRecord = {
			headers,
			body: Buffer.alloc(0),
		};
		recordedStreams.push(record);

		stream.on("data", (chunk: Buffer) => {
			record.body = Buffer.concat([record.body, chunk]);
			if (record.body.length >= 5 && !record.runRequest) {
				const msgLen = record.body.readUInt32BE(1);
				if (record.body.length >= 5 + msgLen) {
					try {
						record.runRequest = fromBinary(AgentClientMessageSchema, record.body.subarray(5, 5 + msgLen));
					} catch {}
				}
			}
		});

		if (headers[":path"] !== "/agent.v1.AgentService/Run") {
			stream.respond({ ":status": 404 });
			stream.end();
			return;
		}

		if (streamHandler) {
			streamHandler(stream, headers, record);
		}
	});

	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("expected http2 fixture server to bind a tcp port");
	}
	return `http://127.0.0.1:${address.port}`;
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

function makeModel(baseUrl: string): Model<"cursor-agent"> {
	return buildModel({
		id: "cursor-resume-fixture",
		name: "Cursor resume fixture",
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
	messages: [{ role: "user", content: "test prompt", timestamp: 1 }],
};

const defaultTunables = { ...cursorTransportTunables };

beforeEach(() => {
	recordedStreams.length = 0;
	streamHandler = undefined;
	Object.assign(cursorTransportTunables, defaultTunables);
});

afterEach(async () => {
	Object.assign(cursorTransportTunables, defaultTunables);
	await stopServer();
});

describe("Cursor transport mid-stream connection loss and resume", () => {
	it("RST after a checkpoint that lists a pending tool while tool handler runs: resumes, deduplicates execution, preserves request ids", async () => {
		cursorTransportTunables.initialBackoffMs = 10;
		cursorTransportTunables.maxBackoffMs = 20;

		let probeExecutions = 0;
		const execHandlers: CursorExecHandlers = {
			mcp: async call => {
				probeExecutions++;
				// Simulate asynchronous tool work that takes 60ms
				const delay = Promise.withResolvers<void>();
				setTimeout(() => delay.resolve(), 60);
				await delay.promise;
				return {
					role: "toolResult",
					toolCallId: call.toolCallId,
					toolName: call.toolName,
					content: [{ type: "text", text: "PROBE_SUCCESS" }],
					isError: false,
					timestamp: Date.now(),
				};
			},
		};

		let streamIndex = 0;
		streamHandler = stream => {
			const current = streamIndex++;
			if (current === 0) {
				stream.respond({
					":status": 200,
					"content-type": "application/connect+proto",
				});
				// Send tool call, then checkpoint with pending tool
				stream.write(mcpRequestFrame("tool-probe-1", "e2e_probe", 1));
				stream.write(checkpointFrame(["tool-probe-1"]));
				// RST the stream while the handler is still executing in background
				setTimeout(() => {
					stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
				}, 15);
			} else if (current === 1) {
				stream.respond({
					":status": 200,
					"content-type": "application/connect+proto",
				});
				// Re-issue the tool call on the resumed stream
				stream.write(mcpRequestFrame("tool-probe-1", "e2e_probe", 2));
				// When client answers mcpResult, send clean completion
				stream.on("data", () => {
					setTimeout(() => {
						if (!stream.closed) {
							stream.write(checkpointFrame([]));
							stream.write(textDeltaFrame("DONE"));
							stream.write(turnEndedFrame());
							stream.end();
						}
					}, 20);
				});
			}
		};

		const baseUrl = await startServer();
		const model = makeModel(baseUrl);

		const stream = streamCursor(model, context, {
			apiKey: "test-token",
			execHandlers,
		});

		const events: string[] = [];
		for await (const event of stream) {
			events.push(event.type);
		}
		const result = await stream.result();

		// Consumer visible result: clean completion, done event, no error surfaced
		expect(result.stopReason).toBe("stop");
		expect(events.filter(e => e === "done").length).toBe(1);
		expect(events.filter(e => e === "error").length).toBe(0);

		// Exactly one execution of the tool handler (no duplicate execution!)
		expect(probeExecutions).toBe(1);

		// Exactly one tool call block in content
		const toolCalls = result.content.filter(c => c.type === "toolCall");
		expect(toolCalls.length).toBe(1);
		expect(toolCalls[0].id).toBe("tool-probe-1");

		// Exactly two streams (attempt 0 and attempt 1)
		expect(recordedStreams.length).toBe(2);

		const s1 = recordedStreams[0];
		const s2 = recordedStreams[1];

		// x-original-request-id constant across attempts, x-request-id different
		expect(s1.headers["x-original-request-id"]).toBeDefined();
		expect(s2.headers["x-original-request-id"]).toBe(s1.headers["x-original-request-id"]);
		expect(s2.headers["x-request-id"]).not.toBe(s1.headers["x-request-id"]);

		// Second request was resumeAction carrying the checkpoint state
		expect(s2.runRequest?.message.case).toBe("runRequest");
		if (s2.runRequest?.message.case === "runRequest") {
			const runReq = s2.runRequest.message.value;
			expect(runReq.action?.action?.case).toBe("resumeAction");
			expect(runReq.conversationState?.pendingToolCalls).toEqual(["tool-probe-1"]);
		}
	});

	it("RST after a text delta that followed the latest checkpoint: does not retry, surfaces failure to session recovery", async () => {
		cursorTransportTunables.initialBackoffMs = 10;
		cursorTransportTunables.maxBackoffMs = 20;

		let streamIndex = 0;
		streamHandler = stream => {
			streamIndex++;
			stream.respond({
				":status": 200,
				"content-type": "application/connect+proto",
			});
			// Send checkpoint, then text delta, then reset
			stream.write(checkpointFrame([]));
			stream.write(textDeltaFrame("already displayed text"));
			setTimeout(() => {
				stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
			}, 10);
		};

		const baseUrl = await startServer();
		const model = makeModel(baseUrl);

		const stream = streamCursor(model, context, { apiKey: "test-token" });

		const events: string[] = [];
		for await (const event of stream) {
			events.push(event.type);
		}
		const result = await stream.result();

		// No second request: prevents duplicate text delivery
		expect(streamIndex).toBe(1);
		expect(recordedStreams.length).toBe(1);

		// Surfaces failure to caller
		expect(result.stopReason).toBe("error");
		expect(events.filter(e => e === "error").length).toBe(1);
		expect(result.errorMessage).toContain("Cursor stream ended before turnEnded");
	});

	it("Failure before any progress: resends original request unchanged and completes", async () => {
		cursorTransportTunables.initialBackoffMs = 10;
		cursorTransportTunables.maxBackoffMs = 20;

		let streamIndex = 0;
		streamHandler = stream => {
			const current = streamIndex++;
			if (current === 0) {
				// Immediate stream reset before any response or data
				stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
			} else {
				stream.respond({
					":status": 200,
					"content-type": "application/connect+proto",
				});
				stream.write(textDeltaFrame("resend success"));
				stream.write(turnEndedFrame());
				stream.end();
			}
		};

		const baseUrl = await startServer();
		const model = makeModel(baseUrl);

		const stream = streamCursor(model, context, { apiKey: "test-token" });

		for await (const _event of stream) {
		}
		const result = await stream.result();

		expect(result.stopReason).toBe("stop");
		const textContent = result.content.find(c => c.type === "text");
		expect(textContent?.text).toBe("resend success");

		expect(recordedStreams.length).toBe(2);
		const s1 = recordedStreams[0];
		const s2 = recordedStreams[1];

		expect(s1.headers["x-original-request-id"]).toBeDefined();
		expect(s2.headers["x-original-request-id"]).toBe(s1.headers["x-original-request-id"]);
		expect(s2.headers["x-request-id"]).not.toBe(s1.headers["x-request-id"]);

		// Second request was original request (userMessageAction, not resumeAction)
		expect(s2.runRequest?.message.case).toBe("runRequest");
		if (s2.runRequest?.message.case === "runRequest") {
			const runReq = s2.runRequest.message.value;
			expect(runReq.action?.action?.case).toBe("userMessageAction");
		}
	});

	it("closes the HTTP/2 connection once a turn completes", async () => {
		// The bidi request body is never ended, so without an explicit client
		// close every successful turn would leave its connection open.
		const serverSessionClosed = Promise.withResolvers<"closed">();
		streamHandler = stream => {
			stream.session?.once("close", () => serverSessionClosed.resolve("closed"));
			stream.respond({
				":status": 200,
				"content-type": "application/connect+proto",
			});
			stream.write(textDeltaFrame("done"));
			stream.write(turnEndedFrame());
			stream.end();
		};

		const baseUrl = await startServer();
		const result = await streamCursor(makeModel(baseUrl), context, { apiKey: "test-token" }).result();

		expect(result.stopReason).toBe("stop");
		const connection = await Promise.race([
			serverSessionClosed.promise,
			Bun.sleep(2_000).then(() => "still open" as const),
		]);
		expect(connection).toBe("closed");
	});

	it("Non-graceful GOAWAY mid-stream resumes, while graceful GOAWAY completes on original stream", async () => {
		cursorTransportTunables.initialBackoffMs = 10;
		cursorTransportTunables.maxBackoffMs = 20;

		// Part A: Non-graceful GOAWAY
		let streamIndex = 0;
		streamHandler = stream => {
			const current = streamIndex++;
			if (current === 0) {
				stream.respond({
					":status": 200,
					"content-type": "application/connect+proto",
				});
				stream.write(checkpointFrame([]));
				setTimeout(() => {
					// Non-graceful GOAWAY
					stream.session?.goaway(http2.constants.NGHTTP2_INTERNAL_ERROR, stream.id);
				}, 10);
			} else {
				stream.respond({
					":status": 200,
					"content-type": "application/connect+proto",
				});
				stream.write(textDeltaFrame("recovered from goaway"));
				stream.write(turnEndedFrame());
				stream.end();
			}
		};

		const baseUrl = await startServer();
		const model = makeModel(baseUrl);

		const stream1 = streamCursor(model, context, { apiKey: "test-token" });
		for await (const _event of stream1) {
		}
		const result1 = await stream1.result();

		expect(result1.stopReason).toBe("stop");
		expect(result1.content.find(c => c.type === "text")?.text).toBe("recovered from goaway");
		expect(recordedStreams.length).toBe(2);

		// Part B: Graceful GOAWAY
		recordedStreams.length = 0;
		streamIndex = 0;
		streamHandler = stream => {
			streamIndex++;
			stream.respond({
				":status": 200,
				"content-type": "application/connect+proto",
			});
			// Graceful GOAWAY: errorCode 0, our stream id is processed
			setTimeout(() => {
				stream.session?.goaway(http2.constants.NGHTTP2_NO_ERROR, stream.id);
				stream.write(textDeltaFrame("graceful completion"));
				stream.write(turnEndedFrame());
				stream.end();
			}, 10);
		};

		const stream2 = streamCursor(model, context, { apiKey: "test-token" });
		for await (const _event of stream2) {
		}
		const result2 = await stream2.result();

		expect(result2.stopReason).toBe("stop");
		expect(result2.content.find(c => c.type === "text")?.text).toBe("graceful completion");
		// Exactly one stream used — no second request issued!
		expect(streamIndex).toBe(1);
		expect(recordedStreams.length).toBe(1);
	});

	it("Keepalive: server that stops ACKing PINGs is detected and retried without hang", async () => {
		cursorTransportTunables.keepalivePingIntervalMs = 20;
		cursorTransportTunables.keepalivePingTimeoutMs = 40;
		cursorTransportTunables.initialBackoffMs = 10;
		cursorTransportTunables.maxBackoffMs = 20;

		let streamIndex = 0;
		streamHandler = stream => {
			const idx = streamIndex++;
			if (idx === 0) {
				stream.respond({
					":status": 200,
					"content-type": "application/connect+proto",
				});
				// Leave stream 0 open without turnEnded to test keepalive ping timeout
			} else {
				stream.respond({
					":status": 200,
					"content-type": "application/connect+proto",
				});
				stream.write(textDeltaFrame("pong"));
				stream.write(turnEndedFrame());
				stream.end();
			}
		};

		await startServer();
		const address = server!.address() as net.AddressInfo;
		const targetPort = address.port;

		let connectionCount = 0;
		let haltFirst = false;
		const relaySockets: net.Socket[] = [];
		const relay = net.createServer(clientSock => {
			relaySockets.push(clientSock);
			const conn = connectionCount++;
			const upstreamSock = net.connect(targetPort, "127.0.0.1");
			relaySockets.push(upstreamSock);
			clientSock.on("data", chunk => {
				if (conn === 0 && haltFirst) return;
				upstreamSock.write(chunk);
			});
			upstreamSock.on("data", chunk => {
				if (conn === 0 && haltFirst) return;
				clientSock.write(chunk);
			});
			clientSock.on("error", () => {});
			upstreamSock.on("error", () => {});
		});

		const relayListening = Promise.withResolvers<void>();
		relay.listen(0, "127.0.0.1", () => relayListening.resolve());
		await relayListening.promise;
		const relayAddress = relay.address() as net.AddressInfo;
		const relayUrl = `http://127.0.0.1:${relayAddress.port}`;

		// Trigger blackhole after initial handshake completes
		setTimeout(() => {
			haltFirst = true;
		}, 10);

		try {
			const model = makeModel(relayUrl);
			const startTime = performance.now();
			const stream = streamCursor(model, context, { apiKey: "test-token" });

			for await (const _event of stream) {
			}
			const result = await stream.result();
			const elapsed = performance.now() - startTime;

			expect(result.stopReason).toBe("stop");
			expect(result.content.find(c => c.type === "text")?.text).toBe("pong");
			expect(connectionCount).toBe(2);
			expect(elapsed).toBeLessThan(1500);
		} finally {
			for (const s of relaySockets) s.destroy();
			const closed = Promise.withResolvers<void>();
			relay.close(() => closed.resolve());
			await closed.promise;
		}
	});

	it("Retry cap / no-progress cap: gives up and surfaces error when limits reached", async () => {
		cursorTransportTunables.initialBackoffMs = 5;
		cursorTransportTunables.maxBackoffMs = 10;
		cursorTransportTunables.maxTransportRetries = 2;

		let streamIndex = 0;
		streamHandler = stream => {
			streamIndex++;
			stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
		};

		const baseUrl = await startServer();
		const model = makeModel(baseUrl);

		const stream = streamCursor(model, context, { apiKey: "test-token" });
		for await (const _event of stream) {
		}
		const result = await stream.result();

		// Max retries 2 -> attempt 0 + 2 retries = 3 total streams
		expect(streamIndex).toBe(3);
		expect(result.stopReason).toBe("error");

		// Test consecutive no-progress resumes cap
		cursorTransportTunables.maxNoProgressResumes = 2;
		cursorTransportTunables.maxTransportRetries = 5;
		recordedStreams.length = 0;
		streamIndex = 0;

		streamHandler = stream => {
			const current = streamIndex++;
			if (current === 0) {
				stream.respond({
					":status": 200,
					"content-type": "application/connect+proto",
				});
				stream.write(checkpointFrame([]));
				setTimeout(() => {
					stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
				}, 10);
			} else {
				// Resumed attempts produce no checkpoint and immediately reset
				stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
			}
		};

		const stream2 = streamCursor(model, context, { apiKey: "test-token" });
		for await (const _event of stream2) {
		}
		const result2 = await stream2.result();

		// Attempt 0 (got checkpoint) + Attempt 1 (no checkpoint) + Attempt 2 (no checkpoint -> limit 2 hit!)
		expect(streamIndex).toBe(3);
		expect(result2.stopReason).toBe("error");
	});

	it("Caller abort during backoff: yields aborted result without issuing further requests", async () => {
		cursorTransportTunables.initialBackoffMs = 400;
		cursorTransportTunables.maxBackoffMs = 800;

		let streamIndex = 0;
		streamHandler = stream => {
			streamIndex++;
			// Immediate reset triggering backoff
			stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
		};

		const baseUrl = await startServer();
		const model = makeModel(baseUrl);

		const abortController = new AbortController();
		// Abort during backoff sleep (after stream 1 fails)
		setTimeout(() => {
			abortController.abort();
		}, 60);

		const stream = streamCursor(model, context, {
			apiKey: "test-token",
			signal: abortController.signal,
		});

		for await (const _event of stream) {
		}
		const result = await stream.result();

		expect(result.stopReason as string).toBe("aborted");
		// No second stream was opened because caller aborted during backoff
		expect(streamIndex).toBe(1);
		expect(recordedStreams.length).toBe(1);
	});
});
