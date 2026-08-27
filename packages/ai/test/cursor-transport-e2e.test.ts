import { afterEach, describe, expect, it } from "bun:test";
import * as http2 from "node:http2";
import { streamCursor } from "@oh-my-pi/pi-ai/providers/cursor";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	AgentServerMessageSchema,
	ExecServerMessageSchema,
	InteractionUpdateSchema,
	ReadArgsSchema,
	TextDeltaUpdateSchema,
	TurnEndedUpdateSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { create, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";
import { encodeConnectFrame } from "../src/providers/cursor/connect-frame";
import { disposeCursorH2Pool } from "../src/providers/cursor/h2-pool";

type Scenario =
	| { kind: "gzip-round-trip" }
	| { kind: "reserved-flag" }
	| { kind: "bounded-drain" }
	| { kind: "trailing-after-turnEnded" };

let server: http2.Http2Server | undefined;
const sessions = new Set<http2.Http2Session>();
let scenario: Scenario = { kind: "gzip-round-trip" };
let observedClientVersion: string | undefined;

function textDeltaPayload(text: string): Uint8Array {
	return toBinary(
		AgentServerMessageSchema,
		create(AgentServerMessageSchema, {
			message: {
				case: "interactionUpdate",
				value: create(InteractionUpdateSchema, {
					message: {
						case: "textDelta",
						value: create(TextDeltaUpdateSchema, { text }),
					},
				}),
			},
		}),
	);
}

function turnEndedPayload(): Uint8Array {
	return toBinary(
		AgentServerMessageSchema,
		create(AgentServerMessageSchema, {
			message: {
				case: "interactionUpdate",
				value: create(InteractionUpdateSchema, {
					message: {
						case: "turnEnded",
						value: create(TurnEndedUpdateSchema, {}),
					},
				}),
			},
		}),
	);
}

function execReadPayload(): Uint8Array {
	return toBinary(
		AgentServerMessageSchema,
		create(AgentServerMessageSchema, {
			message: {
				case: "execServerMessage",
				value: create(ExecServerMessageSchema, {
					id: 1,
					execId: "exec-hang",
					message: {
						case: "readArgs",
						value: create(ReadArgsSchema, { path: "/tmp/hang", toolCallId: "call-hang" }),
					},
				}),
			},
		}),
	);
}

function gzippedEndStreamFrame(): Buffer {
	const payload = Bun.gzipSync(Buffer.from("{}", "utf8"));
	const frame = Buffer.alloc(5 + payload.length);
	frame[0] = 0x03; // compressed + end-stream
	frame.writeUInt32BE(payload.length, 1);
	frame.set(payload, 5);
	return frame;
}

async function startServer(): Promise<string> {
	observedClientVersion = undefined;
	server = http2.createServer();
	server.on("session", session => {
		sessions.add(session);
		session.on("close", () => sessions.delete(session));
	});
	server.on("stream", (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
		observedClientVersion = String(headers["x-cursor-client-version"] ?? "");
		stream.on("data", () => {});
		if (headers[":path"] !== "/agent.v1.AgentService/Run") {
			stream.respond({ ":status": 404 });
			stream.end();
			return;
		}
		stream.respond({ ":status": 200, "content-type": "application/connect+proto" });

		if (scenario.kind === "gzip-round-trip") {
			stream.write(encodeConnectFrame(textDeltaPayload("hello gzip"), true));
			stream.write(encodeConnectFrame(turnEndedPayload(), true));
			stream.write(gzippedEndStreamFrame());
			stream.end();
			return;
		}

		if (scenario.kind === "reserved-flag") {
			const bad = Buffer.alloc(5);
			bad[0] = 0x04;
			bad.writeUInt32BE(0, 1);
			stream.write(bad);
			stream.write(encodeConnectFrame(turnEndedPayload(), false));
			stream.end();
			return;
		}

		if (scenario.kind === "trailing-after-turnEnded") {
			// turnEnded, then a partial Connect frame that never completes. The
			// decoder must surface a protocol/envelope error, not an incomplete
			// stream that the consumer would tolerate as a clean done.
			stream.write(encodeConnectFrame(turnEndedPayload(), false));
			stream.write(Buffer.from([0x00, 0x00, 0x00, 0x00, 0x01])); // header claims 1 byte, no payload
			stream.end();
			return;
		}

		// bounded-drain: exec request + turnEnded, never a handler result.
		stream.write(encodeConnectFrame(execReadPayload(), false));
		stream.write(encodeConnectFrame(turnEndedPayload(), false));
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
		id: "cursor-transport-e2e",
		name: "Cursor transport e2e",
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
	messages: [{ role: "user", content: "e2e", timestamp: 1 }],
};

async function stopServer(): Promise<void> {
	for (const session of sessions) session.destroy();
	sessions.clear();
	await disposeCursorH2Pool();
	if (!server) return;
	const closing = server;
	server = undefined;
	const closed = Promise.withResolvers<void>();
	closing.close(error => {
		if (error) closed.reject(error);
		else closed.resolve();
	});
	await closed.promise;
}

afterEach(async () => {
	scenario = { kind: "gzip-round-trip" };
	await stopServer();
});

describe("Cursor pooled transport e2e", () => {
	it("completes a gzip data frame plus gzip end-stream round-trip", async () => {
		scenario = { kind: "gzip-round-trip" };
		const baseUrl = await startServer();
		const stream = streamCursor(makeModel(baseUrl), context, { apiKey: "test-token" });
		const eventTypes: string[] = [];
		for await (const event of stream) eventTypes.push(event.type);
		const result = await stream.result();
		expect(eventTypes).toContain("done");
		expect(eventTypes).not.toContain("error");
		expect(result.stopReason).toBe("stop");
		const text = result.content
			.filter(block => block.type === "text")
			.map(block => (block.type === "text" ? block.text : ""))
			.join("");
		expect(text).toContain("hello gzip");
	});

	it("surfaces reserved envelope flags as ConnectProtocolError with no done", async () => {
		scenario = { kind: "reserved-flag" };
		const baseUrl = await startServer();
		const stream = streamCursor(makeModel(baseUrl), context, { apiKey: "test-token" });
		const eventTypes: string[] = [];
		for await (const event of stream) eventTypes.push(event.type);
		const result = await stream.result();
		expect(eventTypes).not.toContain("done");
		expect(eventTypes.at(-1)).toBe("error");
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("invalid envelope flags");
	});

	it("observes x-cursor-client-version cli-2026.08.11-e8db854 on the wire", async () => {
		scenario = { kind: "gzip-round-trip" };
		const baseUrl = await startServer();
		const stream = streamCursor(makeModel(baseUrl), context, { apiKey: "test-token" });
		for await (const _event of stream) {
			/* drain */
		}
		expect(observedClientVersion).toBe("cli-2026.08.11-e8db854");
	});

	it("ends the turn within ~5s without synthesizing a result for a still-hung handler", async () => {
		scenario = { kind: "bounded-drain" };
		const baseUrl = await startServer();
		const started = Date.now();
		const paired: string[] = [];
		const stream = streamCursor(makeModel(baseUrl), context, {
			apiKey: "test-token",
			execHandlers: {
				read: () => Promise.withResolvers<never>().promise,
			},
			onToolResult: result => {
				paired.push(result.toolCallId);
				return result;
			},
		});
		const eventTypes: string[] = [];
		for await (const event of stream) eventTypes.push(event.type);
		const elapsed = Date.now() - started;
		const result = await stream.result();
		expect(elapsed).toBeLessThan(7000);
		expect(elapsed).toBeGreaterThanOrEqual(4500);
		expect(eventTypes).toContain("done");
		expect(result.content.some(block => block.type === "toolCall")).toBe(true);
		// A handler still running when the drain times out must not receive a
		// synthetic "Tool not available"; the real result is allowed to win if
		// it ever arrives, and a hung handler here never does.
		expect(paired.length).toBe(0);
	}, 15_000);
	it("rejects partial trailing bytes after turnEnded as a protocol error", async () => {
		scenario = { kind: "trailing-after-turnEnded" };
		const baseUrl = await startServer();
		const stream = streamCursor(makeModel(baseUrl), context, { apiKey: "test-token" });
		const eventTypes: string[] = [];
		for await (const event of stream) eventTypes.push(event.type);
		const result = await stream.result();
		expect(eventTypes).not.toContain("done");
		expect(eventTypes.at(-1)).toBe("error");
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/trailing|envelope|protocol/i);
	}, 15_000);
});
