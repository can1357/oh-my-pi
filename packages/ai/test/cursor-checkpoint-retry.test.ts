import { expect, it } from "bun:test";
import * as http2 from "node:http2";
import { streamCursor } from "@oh-my-pi/pi-ai/providers/cursor";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	AgentClientMessageSchema,
	AgentServerMessageSchema,
	ConversationStateStructureSchema,
	ConversationTokenDetailsSchema,
	InteractionUpdateSchema,
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

function checkpointFrame(): Buffer {
	return frameConnectMessage(
		toBinary(
			AgentServerMessageSchema,
			create(AgentServerMessageSchema, {
				message: {
					case: "conversationCheckpointUpdate",
					value: create(ConversationStateStructureSchema, {
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

function decodeRunAction(chunk: Buffer): string | undefined {
	const length = chunk.readUInt32BE(1);
	const message = fromBinary(AgentClientMessageSchema, chunk.subarray(5, 5 + length));
	return message.message.case === "runRequest" ? message.message.value.action?.action.case : undefined;
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
	const actions: (string | undefined)[] = [];
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
			actions.push(decodeRunAction(chunk));
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
		expect(actions).toEqual(["userMessageAction", "resumeAction"]);
		expect(delays).toEqual([500]);
		expect(startEvents).toBe(1);
		expect(originalRequestIds).toEqual(["", requestIds[0]]);
	} finally {
		for (const session of sessions) session.destroy();
		server.close();
	}
});
