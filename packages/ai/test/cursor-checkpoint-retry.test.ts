import { expect, it } from "bun:test";
import * as http2 from "node:http2";
import { streamCursor } from "@oh-my-pi/pi-ai/providers/cursor";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	AgentClientMessageSchema,
	type AgentRunRequest,
	AgentServerMessageSchema,
	ConversationStateStructureSchema,
	ConversationTokenDetailsSchema,
	ExecServerMessageSchema,
	InteractionUpdateSchema,
	ReadArgsSchema,
	TextDeltaUpdateSchema,
	TurnEndedUpdateSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { create, fromBinary, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";

function frameConnectMessage(data: Uint8Array): Buffer {
	const frame = Buffer.alloc(5 + data.length);
	frame.writeUInt32BE(data.length, 1);
	frame.set(data, 5);
	return frame;
}

function textDeltaFrame(text: string): Buffer {
	return frameConnectMessage(
		toBinary(
			AgentServerMessageSchema,
			create(AgentServerMessageSchema, {
				message: {
					case: "interactionUpdate",
					value: create(InteractionUpdateSchema, {
						message: { case: "textDelta", value: create(TextDeltaUpdateSchema, { text }) },
					}),
				},
			}),
		),
	);
}

// Server-owned blob ids for the partial turn: nothing `context.messages` could rebuild.
const checkpointRootPrompt = [Uint8Array.of(0xc0, 0xff, 0xee, 1)];
const checkpointTurns = [Uint8Array.of(0xc0, 0xff, 0xee, 2), Uint8Array.of(0xc0, 0xff, 0xee, 3)];

function checkpointFrame(): Buffer {
	return frameConnectMessage(
		toBinary(
			AgentServerMessageSchema,
			create(AgentServerMessageSchema, {
				message: {
					case: "conversationCheckpointUpdate",
					value: create(ConversationStateStructureSchema, {
						rootPromptMessagesJson: checkpointRootPrompt,
						turns: checkpointTurns,
						tokenDetails: create(ConversationTokenDetailsSchema, { usedTokens: 42 }),
					}),
				},
			}),
		),
	);
}

function turnEndedFrame(): Buffer {
	return frameConnectMessage(
		toBinary(
			AgentServerMessageSchema,
			create(AgentServerMessageSchema, {
				message: {
					case: "interactionUpdate",
					value: create(InteractionUpdateSchema, {
						message: { case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) },
					}),
				},
			}),
		),
	);
}

function decodeRunRequest(chunk: Buffer): AgentRunRequest | undefined {
	const length = chunk.readUInt32BE(1);
	const message = fromBinary(AgentClientMessageSchema, chunk.subarray(5, 5 + length));
	return message.message.case === "runRequest" ? message.message.value : undefined;
}

function makeModel(baseUrl: string): Model<"cursor-agent"> {
	return buildModel({
		id: "cursor-checkpoint-retry-fixture",
		name: "Cursor checkpoint retry fixture",
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

const context: Context = { messages: [{ role: "user", content: "retry", timestamp: 1 }] };

it("resumes from the latest replay-safe checkpoint after an incomplete stream", async () => {
	const sessions = new Set<http2.Http2Session>();
	const requestIds: string[] = [];
	const originalRequestIds: string[] = [];
	const runRequests: (AgentRunRequest | undefined)[] = [];
	let requestCount = 0;
	const server = http2.createServer();
	server.on("session", session => {
		sessions.add(session);
		session.on("close", () => sessions.delete(session));
	});
	server.on("stream", (providerStream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
		requestCount++;
		requestIds.push(String(headers["x-request-id"] ?? ""));
		originalRequestIds.push(String(headers["x-original-request-id"] ?? ""));
		let handled = false;
		providerStream.on("data", (chunk: Buffer) => {
			if (handled) return;
			handled = true;
			runRequests.push(decodeRunRequest(chunk));
			providerStream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			if (requestCount === 1) {
				providerStream.end(Buffer.concat([textDeltaFrame("before"), checkpointFrame()]));
				return;
			}
			providerStream.end(Buffer.concat([textDeltaFrame(" after"), turnEndedFrame()]));
		});
	});
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("expected HTTP/2 fixture server address");

	try {
		const delays: number[] = [];
		const response = streamCursor(makeModel(`http://127.0.0.1:${address.port}`), context, {
			apiKey: "test-token",
			providerRetryWait: async delayMs => {
				delays.push(delayMs);
			},
		});
		let startEvents = 0;
		for await (const event of response) {
			if (event.type === "start") startEvents++;
		}
		const result = await response.result();

		expect(requestCount).toBe(2);
		expect(result.content).toEqual([expect.objectContaining({ type: "text", text: "before after" })]);
		expect(runRequests.map(request => request?.action?.action.case)).toEqual(["userMessageAction", "resumeAction"]);
		// The first request rebuilds history from `context`, which never matches
		// the checkpoint; the resume sends the checkpoint's partial turn verbatim.
		expect(runRequests[0]?.conversationState?.turns).not.toEqual(checkpointTurns);
		expect(runRequests[1]?.conversationState?.turns).toEqual(checkpointTurns);
		expect(runRequests[1]?.conversationState?.rootPromptMessagesJson).toEqual(checkpointRootPrompt);
		expect(delays).toEqual([500]);
		expect(startEvents).toBe(1);
		expect(originalRequestIds).toEqual(["", requestIds[0]]);
	} finally {
		for (const session of sessions) session.destroy();
		server.close();
	}
});

function execReadFrame(): Buffer {
	return frameConnectMessage(
		toBinary(
			AgentServerMessageSchema,
			create(AgentServerMessageSchema, {
				message: {
					case: "execServerMessage",
					value: create(ExecServerMessageSchema, {
						id: 1,
						execId: "exec-stale",
						message: {
							case: "readArgs",
							value: create(ReadArgsSchema, { path: "/tmp/stale", toolCallId: "call-stale" }),
						},
					}),
				},
			}),
		),
	);
}

function decodeClientCases(buffer: Buffer): string[] {
	const cases: string[] = [];
	let offset = 0;
	while (buffer.length - offset >= 5) {
		const length = buffer.readUInt32BE(offset + 1);
		if (buffer.length - offset < 5 + length) break;
		const message = fromBinary(AgentClientMessageSchema, buffer.subarray(offset + 5, offset + 5 + length));
		cases.push(message.message.case ?? "");
		offset += 5 + length;
	}
	return cases;
}

/**
 * Attempt one: exec → checkpoint with the call still pending → drop without an
 * end frame. `dropAfterResult` waits for the client's exec result before the
 * drop; otherwise the drop lands while the handler is still running.
 * Any later attempt re-issues the same exec, as Cursor does on resume.
 */
async function runStaleCheckpointScenario(dropAfterResult: boolean) {
	const sessions = new Set<http2.Http2Session>();
	let requestCount = 0;
	const dropped = Promise.withResolvers<void>();
	const server = http2.createServer();
	server.on("session", session => {
		sessions.add(session);
		session.on("close", () => sessions.delete(session));
	});
	server.on("stream", (providerStream: http2.ServerHttp2Stream) => {
		requestCount++;
		const attempt = requestCount;
		let received = Buffer.alloc(0);
		let responded = false;
		providerStream.on("data", (chunk: Buffer) => {
			received = Buffer.concat([received, chunk]);
			const cases = decodeClientCases(received);
			if (!responded && cases.includes("runRequest")) {
				responded = true;
				providerStream.respond({ ":status": 200, "content-type": "application/connect+proto" });
				if (attempt > 1) {
					providerStream.end(Buffer.concat([execReadFrame(), turnEndedFrame()]));
					return;
				}
				providerStream.write(Buffer.concat([execReadFrame(), checkpointFrame()]));
				if (!dropAfterResult) providerStream.end(() => dropped.resolve());
				return;
			}
			if (attempt === 1 && dropAfterResult && cases.includes("execClientMessage") && !providerStream.closed) {
				providerStream.end(() => dropped.resolve());
			}
		});
	});
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("expected HTTP/2 fixture server address");

	try {
		let handlerRuns = 0;
		const response = streamCursor(makeModel(`http://127.0.0.1:${address.port}`), context, {
			apiKey: "test-token",
			providerRetryWait: async () => {},
			execHandlers: {
				async read() {
					handlerRuns++;
					if (!dropAfterResult && handlerRuns === 1) {
						await dropped.promise;
						// Real-socket gap: the client exposes no signal for "drop
						// observed". Too short only degrades this into the
						// result-before-drop case, which must pass as well.
						await Bun.sleep(50);
					}
					return {
						role: "toolResult",
						toolCallId: "call-stale",
						toolName: "read",
						content: [{ type: "text", text: "file body" }],
						isError: false,
						timestamp: 1,
					};
				},
			},
		});
		for await (const _event of response) {
			// drain to completion
		}
		const result = await response.result();
		return { requestCount, handlerRuns, result };
	} finally {
		for (const session of sessions) session.destroy();
		server.close();
	}
}

it("does not resume from a checkpoint that predates the client's exec result", async () => {
	const { requestCount, handlerRuns, result } = await runStaleCheckpointScenario(true);

	expect(handlerRuns).toBe(1);
	expect(requestCount).toBe(1);
	expect(result.stopReason).toBe("error");
});

it("does not resume from a checkpoint while the exec handler is still running at the drop", async () => {
	const { requestCount, handlerRuns, result } = await runStaleCheckpointScenario(false);

	expect(handlerRuns).toBe(1);
	expect(requestCount).toBe(1);
	expect(result.stopReason).toBe("error");
});
