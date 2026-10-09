import * as http2 from "node:http2";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	AgentClientMessageSchema,
	AgentRunRequestSchema,
	AgentServerMessageSchema,
	type AgentRunRequest,
	InteractionUpdateSchema,
	TextDeltaUpdateSchema,
	TurnEndedUpdateSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { create, fromBinary, pb, toBinary, type ProtoMessage } from "@oh-my-pi/pi-catalog/discovery/protobuf";
import { streamSimple } from "../../src/stream";
import * as piNative from "../../src/providers/pi-native-server";
import { ConnectFrameDecoder, frameConnectMessage } from "../../src/providers/connect-frame";
import type { Context, SimpleStreamOptions } from "../../src/types";

interface VendorTiming extends ProtoMessage {
	serverFirstTokenMs: number;
	preStreamSetupMs: number;
	waitForFirstEventMs: number;
	providerTtftMs: number;
	slowPoolWaitMs: number;
}
const vendorTiming = pb<VendorTiming>("fixture.vendor.Timing", [
	{ no: 1, name: "serverFirstTokenMs", kind: "double" },
	{ no: 2, name: "preStreamSetupMs", kind: "double" },
	{ no: 3, name: "waitForFirstEventMs", kind: "double" },
	{ no: 4, name: "providerTtftMs", kind: "double" },
	{ no: 5, name: "slowPoolWaitMs", kind: "double" },
]);
interface VendorFirstPacket extends ProtoMessage {
	timing: Uint8Array;
	interaction: Uint8Array;
}
// Timing is independent of the message oneof: both wire orders must retain text.
const vendorFirstPacket = pb<VendorFirstPacket>("fixture.vendor.FirstPacket", [
	{ no: 1, name: "interaction", kind: "bytes" },
	{ no: 8, name: "timing", kind: "bytes" },
]);
const vendorTimingFirstPacket = pb<VendorFirstPacket>("fixture.vendor.TimingFirstPacket", [
	{ no: 8, name: "timing", kind: "bytes" },
	{ no: 1, name: "interaction", kind: "bytes" },
]);

async function main(): Promise<void> {
	const received: { run: AgentRunRequest; requestId: string }[] = [];
	const sessions = new Set<http2.Http2Session>();
	const server = http2.createServer();
	server.on("session", session => {
		sessions.add(session);
		session.on("close", () => sessions.delete(session));
	});
	server.on("stream", (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
		const decoder = new ConnectFrameDecoder();
		let handled = false;
		stream.on("data", (chunk: Buffer) => {
			if (handled) return;
			for (const frame of decoder.decode(chunk)) {
				const message = fromBinary(AgentClientMessageSchema, frame.payload);
				if (message.message.case !== "runRequest") continue;
				handled = true;
				received.push({ run: message.message.value, requestId: String(headers["x-request-id"]) });
				stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
				const packetCodec = received.length === 2 ? vendorTimingFirstPacket : vendorFirstPacket;
				const firstPacket = packetCodec.encode({
					timing: vendorTiming.encode({
						serverFirstTokenMs: 0.5,
						preStreamSetupMs: 1.25,
						waitForFirstEventMs: 2.5,
						providerTtftMs: 3.75,
						slowPoolWaitMs: 4.25,
					}),
					interaction: toBinary(
						InteractionUpdateSchema,
						create(InteractionUpdateSchema, {
							message: { case: "textDelta", value: create(TextDeltaUpdateSchema, { text: "first-" }) },
						}),
					),
				});
				const text = create(AgentServerMessageSchema, {
					message: {
						case: "interactionUpdate",
						value: create(InteractionUpdateSchema, {
							message: { case: "textDelta", value: create(TextDeltaUpdateSchema, { text: "wire verified" }) },
						}),
					},
				});
				const end = create(AgentServerMessageSchema, {
					message: {
						case: "interactionUpdate",
						value: create(InteractionUpdateSchema, {
							message: { case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) },
						}),
					},
				});
				stream.end(
					Buffer.concat([
						frameConnectMessage(firstPacket),
						frameConnectMessage(toBinary(AgentServerMessageSchema, text)),
						frameConnectMessage(toBinary(AgentServerMessageSchema, end)),
						frameConnectMessage(Buffer.from("{}"), 2),
					]),
				);
			}
		});
	});
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected fixture TCP address");
	const model = buildModel({
		id: "cursor-wire-fixture",
		name: "Cursor fixture",
		provider: "cursor",
		api: "cursor-agent",
		baseUrl: `http://127.0.0.1:${address.port}`,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	});
	const context: Context = { messages: [{ role: "user", content: "fixture", timestamp: 0 }] };
	const gateway = Bun.serve({
		port: 0,
		async fetch(request) {
			const parsed = piNative.parseRequest(await request.json());
			const events = streamSimple(model, parsed.context, {
				...parsed.options,
				apiKey: "fixture-token",
				signal: request.signal,
			});
			return new Response(piNative.encodeStream(events), { headers: { "content-type": "text/event-stream" } });
		},
	});
	const conversationId = crypto.randomUUID();
	const invoke = async (options: SimpleStreamOptions = {}) => {
		const result = await streamSimple(model, context, {
			apiKey: "fixture-token",
			sessionId: conversationId,
			signal: AbortSignal.timeout(10000),
			...options,
		}).result();
		if (result.stopReason !== "stop") {
			throw new Error(
				`Cursor wire fixture failed after ${received.length} requests: ${result.stopReason}; ${result.errorMessage}`,
			);
		}
		const text = result.content
			.filter(block => block.type === "text")
			.map(block => block.text)
			.join("");
		if (text !== "first-wire verified") throw new Error("Cursor dropped text bundled with vendor timing fields");
	};
	try {
		await invoke({
			cursorClientSupportsInlineImages: true,
			cursorClientSupportsRoutedModelUpdate: true,
			cursorClientSupportsPromptContextUsageRpc: true,
			cursorAgentSessionId: "wire-session",
		});
		await invoke();
		await invoke({
			cursorRunId: "caller-run",
			onPayload: payload => create(AgentRunRequestSchema, { ...(payload as AgentRunRequest), runId: "hook-run" }),
		});
		const remote = await streamSimple(
			{ ...model, baseUrl: gateway.url.toString(), transport: "pi-native" },
			context,
			{
				apiKey: "gateway-fixture-token",
				sessionId: conversationId,
				cursorRunId: "remote-run",
				cursorAgentSessionId: "remote-session",
				cursorClientSupportsInlineImages: true,
				cursorClientSupportsRoutedModelUpdate: true,
				cursorClientSupportsPromptContextUsageRpc: true,
				signal: AbortSignal.timeout(10000),
			},
		).result();
		if (remote.stopReason !== "stop") throw new Error(`Remote Cursor dispatch failed: ${remote.errorMessage}`);
		const remoteText = remote.content
			.filter(block => block.type === "text")
			.map(block => block.text)
			.join("");
		if (remoteText !== "first-wire verified") throw new Error("Remote Cursor dispatch lost the first text packet");
		console.log(
			JSON.stringify(
				received.map(row => ({
					requestId: row.requestId,
					userMessage:
						row.run.action?.action.case === "userMessageAction"
							? row.run.action.action.value.userMessage
							: undefined,
					run: {
						runId: row.run.runId,
						conversationId: row.run.conversationId,
						conversationGroupId: row.run.conversationGroupId,
						agentSessionId: row.run.agentSessionId,
						clientSupportsInlineImages: row.run.clientSupportsInlineImages,
						clientSupportsRoutedModelUpdate: row.run.clientSupportsRoutedModelUpdate,
						clientSupportsPromptContextUsageRpc: row.run.clientSupportsPromptContextUsageRpc,
					},
				})),
			),
		);
	} finally {
		gateway.stop(true);
		for (const session of sessions) session.destroy();
		server.close();
	}
}

await main();
