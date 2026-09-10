import { expect, it } from "bun:test";
import { streamCursor } from "@oh-my-pi/pi-ai/providers/cursor";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	AgentClientMessageSchema,
	AgentServerMessageSchema,
	BidiAppendRequestSchema,
	BidiRequestIdSchema,
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

function readConnectMessage(frame: Uint8Array): Uint8Array {
	if (frame.length < 5) throw new Error("truncated Connect frame");
	const length = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(1, false);
	if (frame.length !== length + 5) throw new Error("invalid Connect frame length");
	return frame.subarray(5);
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
				const append = fromBinary(BidiAppendRequestSchema, readConnectMessage(body));
				appendRequestIds.push(append.requestId?.requestId ?? "");
				appendSeqnos.push(append.appendSeqno);
				appendedCases.push(fromBinary(AgentClientMessageSchema, append.dataBinary).message.case ?? "");
				const controller = await streamReady.promise;
				controller.enqueue(textDeltaFrame("http1 ok"));
				controller.enqueue(turnEndedFrame());
				controller.close();
				return new Response(null, { headers: { "content-type": "application/connect+proto" } });
			}
			return new Response(null, { status: 404 });
		},
	});

	try {
		const response = streamCursor(makeModel(server.url.toString()), context, {
			apiKey: "test-token",
			transport: "http1",
		});
		for await (const _event of response) {
			// Drain the full provider stream.
		}
		const result = await response.result();

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
