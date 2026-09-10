import { afterEach, describe, expect, it } from "bun:test";
import * as http2 from "node:http2";
import { streamCursor } from "@oh-my-pi/pi-ai/providers/cursor";
import type { Context, Model, StreamOptions, Tool } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	AgentServerMessageSchema,
	InteractionUpdateSchema,
	TextDeltaUpdateSchema,
	TurnEndedUpdateSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { create, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";

// Cursor forwards caller headers (including `before_provider_headers` extension
// edits), and it speaks HTTP/2. These assert the TRANSPORT contract against a
// real local HTTP/2 server rather than the sanitizer in isolation: if
// `streamCursor` stopped merging caller headers, or merged the wrong ones, a
// helper-level test would still pass while the wire lost them.
//
// Two classes must never reach `http2.request()`, because node THROWS on them
// rather than ignoring them, turning a harmless header into a dead request:
// pseudo-headers and HTTP/1 connection-specific headers. A third class —
// headers the request sets for itself — must not arrive duplicated, since names
// are matched case-insensitively on the wire.

let server: http2.Http2Server | undefined;
const sessions = new Set<http2.Http2Session>();
let received: http2.IncomingHttpHeaders = {};

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

/** Records the headers the client actually sent, then replies with a clean turn. */
async function startServer(): Promise<string> {
	server = http2.createServer();
	server.on("session", session => {
		sessions.add(session);
		session.on("close", () => sessions.delete(session));
	});
	server.on("stream", (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
		stream.on("data", () => {});
		received = headers;
		stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
		stream.write(textDeltaFrame("ok"));
		stream.write(turnEndedFrame());
		stream.end();
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
		id: "cursor-caller-headers-fixture",
		name: "Cursor caller headers fixture",
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

const context: Context = { messages: [{ role: "user", content: "headers", timestamp: 1 }] };

/** Drive one request to completion and hand back the headers the server saw. */
async function send(
	headers: Record<string, string> = {},
	extras: {
		context?: Context;
		options?: Omit<StreamOptions, "apiKey" | "headers"> & Record<string, unknown>;
	} = {},
): Promise<http2.IncomingHttpHeaders> {
	const baseUrl = await startServer();
	const stream = streamCursor(makeModel(baseUrl), extras.context ?? context, {
		apiKey: "test-token",
		headers,
		...extras.options,
	});
	for await (const _event of stream) {
		// drain
	}
	await stream.result();
	return received;
}

const passthroughTools = [
	{ name: "bash", description: "run", parameters: { type: "object", properties: {} } },
	{ name: "read", description: "read", parameters: { type: "object", properties: {} } },
] as Tool[];

afterEach(async () => {
	received = {};
	await stopServer();
});

describe("Cursor caller headers reach the wire", () => {
	it("delivers an ordinary caller header to the server", async () => {
		const sent = await send({ "x-trace": "abc", "x-waygate-activity": "mode=plan" });
		expect(sent["x-trace"]).toBe("abc");
		expect(sent["x-waygate-activity"]).toBe("mode=plan");
	});

	it("normalizes a caller header name to lower case", async () => {
		const sent = await send({ "X-Trace": "abc" });
		expect(sent["x-trace"]).toBe("abc");
	});

	// The request still has to go out. Node throws on these rather than dropping
	// them, so a leak here is a dead request, not a missing header.
	it("survives HTTP/1 connection-specific headers and pseudo-headers", async () => {
		const sent = await send({
			connection: "keep-alive",
			"keep-alive": "timeout=5",
			"transfer-encoding": "chunked",
			upgrade: "h2c",
			":path": "/evil",
			"x-trace": "kept",
		});
		// The request completed, and the benign header still landed.
		expect(sent["x-trace"]).toBe("kept");
		expect(sent[":path"]).toBe("/agent.v1.AgentService/Run");
		expect(sent.connection).toBeUndefined();
		expect(sent["transfer-encoding"]).toBeUndefined();
	});

	it("does not let a caller override the headers the request sets itself", async () => {
		const sent = await send({
			Authorization: "Bearer stolen",
			"Content-Type": "text/plain",
			TE: "gzip",
			"X-Request-Id": "forged",
			// The Connect body is streamed after the headers, so no caller length can
			// describe it; an HTTP/2 peer resets the stream once the body diverges.
			"Content-Length": "999",
			"x-trace": "kept",
		});
		expect(sent.authorization).toBe("Bearer test-token");
		expect(sent["content-type"]).toBe("application/connect+proto");
		expect(sent.te).toBe("trailers");
		expect(sent["x-request-id"]).not.toBe("forged");
		expect(sent["content-length"]).toBeUndefined();
		expect(sent["x-trace"]).toBe("kept");
	});

	// A plain `host` header suppresses the `:authority` node derives from the URL,
	// so a caller value would silently retarget the request at another vhost.
	it("does not let a caller header retarget the request authority", async () => {
		const sent = await send({ Host: "evil.example.com", "x-trace": "kept" });
		expect(sent[":authority"]).not.toBe("evil.example.com");
		expect(sent[":authority"]).toContain("127.0.0.1");
		expect(sent.host).toBeUndefined();
		expect(sent["x-trace"]).toBe("kept");
	});
});

describe("Cursor passthrough allowed-tools header", () => {
	it("lists caller-declared tools when toolChoice is unrestricted", async () => {
		const sent = await send(
			{},
			{
				context: { ...context, tools: passthroughTools },
				options: { cursorToolPassthrough: true },
			},
		);
		expect(sent["x-cursor-agent-allowed-tools"]).toBe("bash,read");
	});

	it("sends __none__ when toolChoice is none even if tools are declared", async () => {
		const sent = await send(
			{},
			{
				context: { ...context, tools: passthroughTools },
				options: { cursorToolPassthrough: true, toolChoice: "none" },
			},
		);
		expect(sent["x-cursor-agent-allowed-tools"]).toBe("__none__");
	});

	it("restricts allowlist to a named forced toolChoice", async () => {
		const sent = await send(
			{},
			{
				context: { ...context, tools: passthroughTools },
				options: { cursorToolPassthrough: true, toolChoice: { type: "tool", name: "read" } },
			},
		);
		expect(sent["x-cursor-agent-allowed-tools"]).toBe("read");
	});

	it("advertises a forced tool name even when it is absent from context.tools", async () => {
		const sent = await send(
			{},
			{
				context: { ...context, tools: passthroughTools },
				options: {
					cursorToolPassthrough: true,
					toolChoice: { type: "function", name: "report_delivery" },
				},
			},
		);
		expect(sent["x-cursor-agent-allowed-tools"]).toBe("report_delivery");
	});

	it("rejects toolChoice required under passthrough instead of weakening to auto", async () => {
		const baseUrl = await startServer();
		const stream = streamCursor(
			makeModel(baseUrl),
			{ ...context, tools: passthroughTools },
			{
				apiKey: "test-token",
				cursorToolPassthrough: true,
				toolChoice: "required",
			},
		);
		for await (const _event of stream) {
			// drain
		}
		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage ?? "").toMatch(/toolChoice "required"/);
		// Request must not go out with the weakened full allowlist.
		expect(received["x-cursor-agent-allowed-tools"]).toBeUndefined();
	});

	it("sends __none__ for empty tools under passthrough", async () => {
		const sent = await send(
			{},
			{
				context: { ...context, tools: [] },
				options: { cursorToolPassthrough: true },
			},
		);
		expect(sent["x-cursor-agent-allowed-tools"]).toBe("__none__");
	});

	it("excludes server-only connect_scm from the passthrough allowlist", async () => {
		const sent = await send(
			{},
			{
				context: {
					...context,
					tools: [
						...passthroughTools,
						{ name: "connect_scm", description: "scm", parameters: { type: "object" as const } },
					],
				},
				options: { cursorToolPassthrough: true },
			},
		);
		expect(sent["x-cursor-agent-allowed-tools"]).toBe("bash,read");
	});

	it("excludes native todo tools from the passthrough allowlist", async () => {
		const sent = await send(
			{},
			{
				context: {
					...context,
					tools: [
						...passthroughTools,
						{ name: "todo", description: "todos", parameters: { type: "object" as const } },
						{ name: "update_todos", description: "update", parameters: { type: "object" as const } },
						{ name: "read_todos", description: "read", parameters: { type: "object" as const } },
					],
				},
				options: { cursorToolPassthrough: true },
			},
		);
		expect(sent["x-cursor-agent-allowed-tools"]).toBe("bash,read");
	});
});
