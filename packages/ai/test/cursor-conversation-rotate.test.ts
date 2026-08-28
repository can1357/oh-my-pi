import { afterEach, describe, expect, it } from "bun:test";
import * as http2 from "node:http2";
import { streamCursor } from "@oh-my-pi/pi-ai/providers/cursor";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	AgentClientMessageSchema,
	AgentServerMessageSchema,
	InteractionUpdateSchema,
	TextDeltaUpdateSchema,
	TurnEndedUpdateSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { create, fromBinary, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";

// #8345: a server-side per-conversation rejection (bare resource_exhausted,
// zero tokens) poisons the wire conversationId; the next attempt must rotate
// to a fresh id and succeed, instead of failing forever until /fork.

let server: http2.Http2Server | undefined;
const sessions = new Set<http2.Http2Session>();

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
				message: { case: "textDelta", value: create(TextDeltaUpdateSchema, { text }) },
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
				message: { case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) },
			}),
		},
	});
	return frameConnectMessage(toBinary(AgentServerMessageSchema, message));
}

/** Decode the wire conversationId from the first client frame of a request. */
function connectPayload(chunk: Buffer): Uint8Array {
	const length = chunk.readUInt32BE(1);
	const body = chunk.subarray(5, 5 + length);
	return (chunk[0] & 0x01) !== 0 ? Bun.gunzipSync(new Uint8Array(body)) : body;
}

function decodeConversationId(chunk: Buffer): string | undefined {
	const msg = fromBinary(AgentClientMessageSchema, connectPayload(chunk));
	if (msg.message.case !== "runRequest") return undefined;
	return msg.message.value.conversationId;
}

type WireRequest = {
	conversationId?: string;
	action?: string;
	userText?: string;
	pendingToolCalls: number;
};

function decodeRunRequest(chunk: Buffer): WireRequest | undefined {
	const msg = fromBinary(AgentClientMessageSchema, connectPayload(chunk));
	if (msg.message.case !== "runRequest") return undefined;
	const req = msg.message.value;
	const action = req.action?.action;
	return {
		conversationId: req.conversationId,
		action: req.action?.action.case,
		userText: action?.case === "userMessageAction" ? action.value.userMessage?.text : undefined,
		pendingToolCalls: req.conversationState?.pendingToolCalls?.length ?? 0,
	};
}

/** /retry after restart: trailing tool results, no active user message. */
function resumeContext(): Context {
	return {
		messages: [
			{ role: "user", content: "Use the read tool.", timestamp: 1 },
			{
				role: "assistant",
				api: "cursor-agent",
				provider: "cursor",
				model: "cursor-rotation-fixture",
				content: [{ type: "toolCall", id: "call-read", name: "read", arguments: { path: "package.json" } }],
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 2,
			},
			{
				role: "toolResult",
				toolCallId: "call-read",
				toolName: "read",
				content: [{ type: "text", text: "package contents" }],
				isError: false,
				timestamp: 3,
			},
		],
	};
}

/** First request ends with a bare resource_exhausted; later ones turn normally. */
async function startServer(seenConversationIds: string[]): Promise<string> {
	server = http2.createServer();
	server.on("session", session => {
		sessions.add(session);
		session.on("close", () => sessions.delete(session));
	});
	let requestCount = 0;
	server.on("stream", (stream: http2.ServerHttp2Stream) => {
		stream.on("data", (chunk: Buffer) => {
			const conversationId = decodeConversationId(chunk);
			if (conversationId !== undefined) seenConversationIds.push(conversationId);
			requestCount++;
			if (requestCount === 1) {
				stream.respond({ ":status": 200, "content-type": "application/connect+proto" }, { waitForTrailers: true });
				stream.once("wantTrailers", () => {
					stream.sendTrailers({ "grpc-status": "8", "grpc-message": "resource_exhausted" });
				});
				stream.end();
			} else {
				stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
				stream.write(textDeltaFrame("recovered"));
				stream.write(turnEndedFrame());
				stream.end();
			}
		});
	});

	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("expected the fixture server to bind a tcp port");
	return `http://127.0.0.1:${address.port}`;
}

/** Scripted fixture: each entry is a clean turn, rejection, or turn followed by a rejecting trailer. */
async function startScriptedServer(
	seen: WireRequest[],
	script: Array<"reject" | "ok" | "turnEndedReject">,
): Promise<string> {
	server = http2.createServer();
	server.on("session", session => {
		sessions.add(session);
		session.on("close", () => sessions.delete(session));
	});
	let requestCount = 0;
	server.on("stream", (stream: http2.ServerHttp2Stream) => {
		stream.on("data", (chunk: Buffer) => {
			const decoded = decodeRunRequest(chunk);
			if (decoded !== undefined) seen.push(decoded);
			requestCount++;
			const decision = script[Math.min(requestCount - 1, script.length - 1)] ?? "reject";
			if (decision === "reject") {
				stream.respond({ ":status": 200, "content-type": "application/connect+proto" }, { waitForTrailers: true });
				stream.once("wantTrailers", () => {
					stream.sendTrailers({ "grpc-status": "8", "grpc-message": "resource_exhausted" });
				});
				stream.end();
			} else if (decision === "turnEndedReject") {
				stream.respond({ ":status": 200, "content-type": "application/connect+proto" }, { waitForTrailers: true });
				stream.once("wantTrailers", () => {
					stream.sendTrailers({ "grpc-status": "8", "grpc-message": "resource_exhausted" });
				});
				stream.write(turnEndedFrame());
				stream.end();
			} else {
				stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
				stream.write(textDeltaFrame("recovered"));
				stream.write(turnEndedFrame());
				stream.end();
			}
		});
	});

	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("expected the fixture server to bind a tcp port");
	return `http://127.0.0.1:${address.port}`;
}

async function stopServer(): Promise<void> {
	for (const session of sessions) session.destroy();
	sessions.clear();
	if (!server) return;
	const closing = server;
	server = undefined;
	const closed = Promise.withResolvers<void>();
	closing.close(error => (error ? closed.reject(error) : closed.resolve()));
	await closed.promise;
}

function makeModel(baseUrl: string): Model<"cursor-agent"> {
	return buildModel({
		id: "cursor-rotation-fixture",
		name: "Cursor rotation fixture",
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

const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };

/** Drain a stream and return its terminal event (done / error). */
async function runToEnd(
	baseUrl: string,
	sessionId: string,
	ctx: Context = context,
): Promise<{ type: "done" | "error"; message?: string }> {
	const stream = streamCursor(makeModel(baseUrl), ctx, { apiKey: "test-token", sessionId });
	let terminal: { type: "done" | "error"; message?: string } = { type: "done" };
	for await (const event of stream) {
		if (event.type === "error") {
			terminal = { type: "error", message: event.error.errorMessage };
		}
	}
	await stream.result().catch(() => {});
	return terminal;
}

afterEach(async () => {
	await stopServer();
});

describe("Cursor conversationId rotation (issue #8345)", () => {
	it("rotates the poisoned conversationId and recovers on the next attempt", async () => {
		const seenConversationIds: string[] = [];
		const baseUrl = await startServer(seenConversationIds);

		const first = await runToEnd(baseUrl, "sess-poisoned");
		expect(first.type).toBe("error");
		expect(first.message).toMatch(/resource.?exhausted/i);

		const second = await runToEnd(baseUrl, "sess-poisoned");
		expect(second.type).toBe("done");

		expect(seenConversationIds).toHaveLength(2);
		expect(seenConversationIds[0]).toBe("sess-poisoned");
		expect(seenConversationIds[1]).not.toBe(seenConversationIds[0]);
	});

	it("keeps the rotated id when the new conversation is also rejected", async () => {
		const seenConversationIds: string[] = [];
		// Fail every request: rotation must happen exactly once.
		server = http2.createServer();
		server.on("session", session => {
			sessions.add(session);
			session.on("close", () => sessions.delete(session));
		});
		server.on("stream", (stream: http2.ServerHttp2Stream) => {
			stream.on("data", (chunk: Buffer) => {
				const conversationId = decodeConversationId(chunk);
				if (conversationId !== undefined) seenConversationIds.push(conversationId);
				stream.respond({ ":status": 200, "content-type": "application/connect+proto" }, { waitForTrailers: true });
				stream.once("wantTrailers", () => {
					stream.sendTrailers({ "grpc-status": "8", "grpc-message": "resource_exhausted" });
				});
				stream.end();
			});
		});
		const listening = Promise.withResolvers<void>();
		server.once("error", listening.reject);
		server.listen(0, "127.0.0.1", listening.resolve);
		await listening.promise;
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("expected the fixture server to bind a tcp port");
		const baseUrl = `http://127.0.0.1:${address.port}`;

		const r1 = await runToEnd(baseUrl, "sess-sticky");
		const r2 = await runToEnd(baseUrl, "sess-sticky");
		const r3 = await runToEnd(baseUrl, "sess-sticky");
		console.log(
			"[test] results:",
			JSON.stringify([r1.type, r1.message, r2.type, r2.message, r3.type, r3.message]),
			"seen:",
			JSON.stringify(seenConversationIds),
		);

		expect(seenConversationIds).toHaveLength(3);
		expect(seenConversationIds[0]).toBe("sess-sticky");
		expect(seenConversationIds[1]).toBe(seenConversationIds[2]);
		expect(seenConversationIds[1]).not.toBe("sess-sticky");
	});

	it("rotated retry recovers a resume-action turn", async () => {
		const seen: WireRequest[] = [];
		const baseUrl = await startScriptedServer(seen, ["reject", "ok"]);
		const ctx = resumeContext();

		const first = await runToEnd(baseUrl, "sess-resume", ctx);
		expect(first.type).toBe("error");
		expect(first.message).toMatch(/resource.?exhausted/i);

		const second = await runToEnd(baseUrl, "sess-resume", ctx);
		expect(second.type).toBe("done");

		expect(seen).toHaveLength(2);
		expect(seen[0]?.conversationId).toBe("sess-resume");
		expect(seen[0]?.action).toBe("resumeAction");
		expect(seen[1]?.conversationId).not.toBe(seen[0]?.conversationId);
		expect(seen[1]?.action).toBe("userMessageAction");
		expect(seen[1]?.userText).toBe("Use the read tool.");
		expect(seen[1]?.pendingToolCalls).toBe(0);
	});

	it("re-rotates when the rotated conversation is poisoned later", async () => {
		const seen: WireRequest[] = [];
		const baseUrl = await startScriptedServer(seen, ["reject", "ok", "reject", "ok"]);

		const first = await runToEnd(baseUrl, "sess-rerotate");
		expect(first.type).toBe("error");
		const second = await runToEnd(baseUrl, "sess-rerotate");
		expect(second.type).toBe("done");
		const third = await runToEnd(baseUrl, "sess-rerotate");
		expect(third.type).toBe("error");
		const fourth = await runToEnd(baseUrl, "sess-rerotate");
		expect(fourth.type).toBe("done");

		expect(seen).toHaveLength(4);
		expect(seen[0]?.conversationId).toBe("sess-rerotate");
		expect(seen[1]?.conversationId).not.toBe(seen[0]?.conversationId);
		expect(seen[2]?.conversationId).toBe(seen[1]?.conversationId);
		expect(seen[3]?.conversationId).not.toBe(seen[1]?.conversationId);
		expect(seen[3]?.conversationId).not.toBe(seen[0]?.conversationId);
	});

	it("does not re-rotate when turnEnded is followed by a rejecting trailer", async () => {
		const seen: WireRequest[] = [];
		const baseUrl = await startScriptedServer(seen, ["reject", "turnEndedReject", "reject"]);

		expect((await runToEnd(baseUrl, "sess-failed-rotation")).type).toBe("error");
		expect((await runToEnd(baseUrl, "sess-failed-rotation")).type).toBe("error");
		expect((await runToEnd(baseUrl, "sess-failed-rotation")).type).toBe("error");

		expect(seen).toHaveLength(3);
		expect(seen[0]?.conversationId).toBe("sess-failed-rotation");
		expect(seen[1]?.conversationId).not.toBe(seen[0]?.conversationId);
		expect(seen[2]?.conversationId).toBe(seen[1]?.conversationId);
	});
});
