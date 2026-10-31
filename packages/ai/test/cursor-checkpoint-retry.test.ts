import { describe, expect, it } from "bun:test";
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

/** A terminal Connect error frame (END_STREAM), as the gateway sends one. */
function connectErrorFrame(code: string, message: string): Buffer {
	const body = Buffer.from(JSON.stringify({ error: { code, message } }));
	const frame = Buffer.alloc(5 + body.length);
	frame[0] = 2;
	frame.writeUInt32BE(body.length, 1);
	frame.set(body, 5);
	return frame;
}

it("reports the wire-model replay it spent before a later wire failure", async () => {
	// The rejected wire model is replayed on the discovered one, so the stream
	// that finally dies is the second request. Its own retry context is empty —
	// the replay happened on another stream — so a per-stream counter reads this
	// as a first and only request and recovery above replays it again.
	const sessions = new Set<http2.Http2Session>();
	let requestCount = 0;
	const server = http2.createServer();
	server.on("session", session => {
		sessions.add(session);
		session.on("close", () => sessions.delete(session));
	});
	server.on("stream", (providerStream: http2.ServerHttp2Stream) => {
		requestCount++;
		const attempt = requestCount;
		let handled = false;
		providerStream.on("data", () => {
			if (handled) return;
			handled = true;
			providerStream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			if (attempt === 1) {
				providerStream.end(connectErrorFrame("not_found", "Error"));
				return;
			}
			providerStream.end(Buffer.concat([textDeltaFrame("after"), connectErrorFrame("unknown", "read ECONNRESET")]));
		});
	});
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("expected HTTP/2 fixture server address");

	try {
		// A reasoning model whose normalized effort route differs from the
		// discovered one is what arms the replay this test measures.
		const model = buildModel({
			id: "gpt-5.6-sol",
			requestModelId: "gpt-5.6-sol-none",
			name: "Cursor wire fallback fixture",
			api: "cursor-agent",
			provider: "cursor",
			baseUrl: `http://127.0.0.1:${address.port}`,
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_000_000,
			maxTokens: 64_000,
		}) as Model<"cursor-agent">;
		const response = streamCursor(model, context, {
			apiKey: "test-token",
			wireModelId: "gpt-5.6-sol-medium",
			providerRetryWait: async () => {},
		});
		for await (const _event of response) {
			// drain to completion
		}
		const result = await response.result();

		expect(requestCount).toBe(2);
		expect(result.stopReason).toBe("error");
		expect(result.providerReplays).toBe(1);
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

/** A Connect end-stream frame carrying a transient error whose message states the wait. */
function unavailableEndStreamFrame(wait: string): Buffer {
	const frame = frameConnectMessage(
		new TextEncoder().encode(
			JSON.stringify({
				error: { code: "unavailable", message: `Service temporarily unavailable. Please try again in ${wait}.` },
			}),
		),
	);
	frame[0] = 0x02;
	return frame;
}

/** Answers attempt one with `answerFirst`; any later attempt completes the turn. */
async function runFirstAttemptScenario(
	answerFirst: (providerStream: http2.ServerHttp2Stream) => void,
	maxRetryDelayMs: number,
	extra: { ceilingMs?: number } = {},
) {
	const sessions = new Set<http2.Http2Session>();
	let requestCount = 0;
	const server = http2.createServer();
	server.on("session", session => {
		sessions.add(session);
		session.on("close", () => sessions.delete(session));
	});
	server.on("stream", (providerStream: http2.ServerHttp2Stream) => {
		requestCount++;
		let handled = false;
		providerStream.on("error", () => {});
		providerStream.on("data", () => {
			if (handled) return;
			handled = true;
			if (requestCount === 1) {
				answerFirst(providerStream);
				return;
			}
			providerStream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			providerStream.end(Buffer.concat([textDeltaFrame("after wait"), turnEndedFrame()]));
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
		const result = await streamCursor(makeModel(`http://127.0.0.1:${address.port}`), context, {
			apiKey: "test-token",
			maxRetryDelayMs,
			providerRetryWaitCeilingMs: extra.ceilingMs,
			providerRetryWait: async delayMs => {
				delays.push(delayMs);
			},
		}).result();
		return { requestCount, delays, result };
	} finally {
		for (const session of sessions) session.destroy();
		server.close();
	}
}

/** Attempt one ends with a replay-safe failure whose end-stream text states `wait`. */
function answerStatedWait(wait: string) {
	return (providerStream: http2.ServerHttp2Stream) => {
		providerStream.respond({ ":status": 200, "content-type": "application/connect+proto" });
		providerStream.end(unavailableEndStreamFrame(wait));
	};
}

/** Attempt one is refused with `status`, a 750 ms `retry-after-ms` and a Connect error JSON body. */
function answerRefusal(status: number, body: Record<string, unknown>) {
	return (providerStream: http2.ServerHttp2Stream) => {
		providerStream.respond({ ":status": status, "content-type": "application/json", "retry-after-ms": "750" });
		providerStream.end(JSON.stringify(body));
	};
}

it("surfaces a failure whose stated wait exceeds maxRetryDelayMs after one request", async () => {
	const { requestCount, delays, result } = await runFirstAttemptScenario(answerStatedWait("9s"), 1);

	expect(requestCount).toBe(1);
	expect(delays).toEqual([]);
	expect(result.stopReason).toBe("error");
	expect(result.errorMessage).toContain("Please try again in 9s");
});

it("waits a failure's stated wait when it outlasts the backoff within maxRetryDelayMs", async () => {
	const { requestCount, delays, result } = await runFirstAttemptScenario(answerStatedWait("0.8s"), 1_000);

	expect(requestCount).toBe(2);
	expect(delays).toEqual([800]);
	expect(result.stopReason).toBe("stop");
	expect(result.content).toEqual([expect.objectContaining({ type: "text", text: "after wait" })]);
});

it("surfaces an end-stream failure whose wait only the HTTP/2 200's headers state, over the cap, after one request", async () => {
	const { requestCount, delays, result } = await runFirstAttemptScenario(providerStream => {
		providerStream.respond({ ":status": 200, "content-type": "application/connect+proto", "retry-after-ms": "750" });
		const frame = frameConnectMessage(
			new TextEncoder().encode(
				JSON.stringify({ error: { code: "unavailable", message: "Service temporarily unavailable" } }),
			),
		);
		frame[0] = 0x02;
		providerStream.end(frame);
	}, 10);

	expect(requestCount).toBe(1);
	expect(delays).toEqual([]);
	expect(result.stopReason).toBe("error");
	expect(result.errorStatus).toBeUndefined();
	expect(result.errorRetryAfterMs).toBe(750);
});

it("reads an HTTP/2 429's Connect error body as the failure, with its status and wait, after one request", async () => {
	const { requestCount, delays, result } = await runFirstAttemptScenario(
		answerRefusal(429, { code: "resource_exhausted", message: "Please try again in 750ms." }),
		10,
	);

	expect(requestCount).toBe(1);
	expect(delays).toEqual([]);
	expect(result.stopReason).toBe("error");
	expect(result.errorStatus).toBe(429);
	expect(result.errorRetryAfterMs).toBe(750);
	expect(result.errorMessage).toContain("resource_exhausted");
	expect(result.errorMessage).toContain("Please try again in 750ms.");
});

it("retries an HTTP/2 503 whose Connect error body names no details, after its 750 ms wait", async () => {
	const { requestCount, delays, result } = await runFirstAttemptScenario(
		answerRefusal(503, { code: "unavailable", message: "busy" }),
		1_000,
	);

	expect(requestCount).toBe(2);
	expect(delays).toEqual([750]);
	expect(result.stopReason).toBe("stop");
	expect(result.content).toEqual([expect.objectContaining({ type: "text", text: "after wait" })]);
});

describe("the providerRetryWaitCeilingMs opt-in", () => {
	const FIVE_MINUTES_MS = 5 * 60 * 1_000;
	const REFUSAL_NOTE =
		"(server asked to wait 15 s before retrying; the caller's 10 s providerRetryWaitCeilingMs refused it, so the provider did not retry)";

	it("unset: sleeps a stated 15 s, as before", async () => {
		const { requestCount, delays, result } = await runFirstAttemptScenario(answerStatedWait("15s"), FIVE_MINUTES_MS);

		expect(requestCount).toBe(2);
		expect(delays).toEqual([15_000]);
		expect(result.stopReason).toBe("stop");
	});

	it("set to 20 s and not exceeded: sleeps a stated 15 s", async () => {
		const { requestCount, delays } = await runFirstAttemptScenario(answerStatedWait("15s"), FIVE_MINUTES_MS, {
			ceilingMs: 20_000,
		});

		expect(requestCount).toBe(2);
		expect(delays).toEqual([15_000]);
	});

	it("set to 10 s and exceeded: surfaces a stated 15 s after one request, saying so, with its classification kept", async () => {
		const { requestCount, delays, result } = await runFirstAttemptScenario(answerStatedWait("15s"), FIVE_MINUTES_MS, {
			ceilingMs: 10_000,
		});

		expect(requestCount).toBe(1);
		expect(delays).toEqual([]);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Please try again in 15s");
		expect(result.errorMessage?.endsWith(` ${REFUSAL_NOTE}`)).toBe(true);
		expect(result.errorClassificationMessage).toBeDefined();
		expect(result.errorClassificationMessage).not.toContain("server asked");
	});
});
