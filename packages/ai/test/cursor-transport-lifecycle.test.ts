import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as http2 from "node:http2";
import * as os from "node:os";
import * as path from "node:path";
import { ProviderResponseError } from "@oh-my-pi/pi-ai/error";
import { streamCursor } from "@oh-my-pi/pi-ai/providers/cursor";
import type { Context, Model, ToolResultMessage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	AgentServerMessageSchema,
	ExecServerMessageSchema,
	type GetServerConfigResponse,
	GetServerConfigResponseSchema,
	Http2Config,
	InteractionUpdateSchema,
	ReadArgsSchema,
	TurnEndedUpdateSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { create, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";
import { encodeConnectFrame } from "../src/providers/cursor/connect-frame";
import * as h2Pool from "../src/providers/cursor/h2-pool";
import { buildCursorRunHeaders } from "../src/providers/cursor/headers";
import * as serverConfig from "../src/providers/cursor/server-config";
import { fetchCursorBidiAvailability, resetCursorServerConfigCache } from "../src/providers/cursor/server-config";
import { __setCursorH2FrameQueueBytes, openCursorTransport } from "../src/providers/cursor/transport";

const RUN_PATH = "/agent.v1.AgentService/Run";
const GET_SERVER_CONFIG_PATH = "/agent.v1.AgentService/GetServerConfig";
const CONNECT_END_STREAM_FLAG = 0b00000010;
const API_KEY = "transport-lifecycle-key";

function testRunHeaders() {
	return buildCursorRunHeaders({
		apiKey: API_KEY,
		requestPath: RUN_PATH,
		gzipRequest: false,
	});
}

let h2Server: http2.Http2Server | undefined;
const h2Sessions = new Set<http2.Http2Session>();
let h2Config: Partial<GetServerConfigResponse> = {};

let h1Server: http.Server | undefined;
let h1Hits = 0;
let h1Paths: string[] = [];

function frameConnectMessage(data: Uint8Array, flags = 0): Buffer {
	const frame = Buffer.alloc(5 + data.length);
	frame[0] = flags;
	frame.writeUInt32BE(data.length, 1);
	frame.set(data, 5);
	return frame;
}

function endFrame(): Buffer {
	return frameConnectMessage(Buffer.from("{}", "utf8"), CONNECT_END_STREAM_FLAG);
}

function alpnCause(): Error {
	return Object.assign(new Error("h2 is not supported"), { code: "ERR_HTTP2_ERROR" });
}

async function startH2ConfigServer(): Promise<string> {
	h2Server = http2.createServer();
	h2Server.on("session", session => {
		h2Sessions.add(session);
		session.on("close", () => h2Sessions.delete(session));
	});
	h2Server.on("stream", (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
		stream.on("data", () => {});
		stream.on("error", () => {});
		if (headers[":path"] !== GET_SERVER_CONFIG_PATH) {
			stream.respond({ ":status": 404 });
			stream.end();
			return;
		}
		stream.respond({ ":status": 200, "content-type": "application/proto" });
		const message = create(GetServerConfigResponseSchema, h2Config);
		stream.write(Buffer.concat([frameConnectMessage(toBinary(GetServerConfigResponseSchema, message)), endFrame()]));
		stream.end();
	});
	const listening = Promise.withResolvers<void>();
	h2Server.once("error", listening.reject);
	h2Server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = h2Server.address();
	if (!address || typeof address === "string") throw new Error("expected h2 fixture to bind a tcp port");
	return `http://127.0.0.1:${address.port}`;
}

async function stopH2ConfigServer(): Promise<void> {
	for (const session of h2Sessions) session.destroy();
	h2Sessions.clear();
	if (!h2Server) return;
	const closing = h2Server;
	h2Server = undefined;
	const closed = Promise.withResolvers<void>();
	closing.close(error => (error ? closed.reject(error) : closed.resolve()));
	await closed.promise;
}

async function startH1Fixture(
	handler?: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<string> {
	h1Hits = 0;
	h1Paths = [];
	h1Server = http.createServer((req, res) => {
		h1Hits++;
		h1Paths.push(req.url ?? "");
		if (handler) {
			handler(req, res);
			return;
		}
		res.statusCode = 200;
		res.end();
	});
	const listening = Promise.withResolvers<void>();
	h1Server.once("error", listening.reject);
	h1Server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = h1Server.address();
	if (!address || typeof address === "string") throw new Error("expected h1 fixture to bind a tcp port");
	return `http://127.0.0.1:${address.port}`;
}

async function stopH1Fixture(): Promise<void> {
	if (!h1Server) return;
	const closing = h1Server;
	h1Server = undefined;
	const closed = Promise.withResolvers<void>();
	closing.close(error => (error ? closed.reject(error) : closed.resolve()));
	await closed.promise;
}

function encodePollResponse(seqno: bigint, data: string, eof: boolean): Uint8Array {
	const parts: Uint8Array[] = [];
	parts.push(encodeVarint(BigInt(1 << 3)), encodeVarint(seqno));
	const dataBytes = Buffer.from(data);
	parts.push(encodeVarint(BigInt((2 << 3) | 2)), encodeVarint(BigInt(dataBytes.length)), dataBytes);
	if (eof) parts.push(encodeVarint(BigInt(3 << 3)), encodeVarint(1n));
	return concatBytes(parts);
}

function encodeVarint(value: bigint): Uint8Array {
	const bytes: number[] = [];
	let remaining = value;
	do {
		let byte = Number(remaining & 0x7fn);
		remaining >>= 7n;
		if (remaining !== 0n) byte |= 0x80;
		bytes.push(byte);
	} while (remaining !== 0n);
	return Uint8Array.from(bytes);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
	let length = 0;
	for (const part of parts) length += part.length;
	const out = new Uint8Array(length);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

beforeEach(async () => {
	vi.restoreAllMocks();
	await h2Pool.disposeCursorH2Pool();
	resetCursorServerConfigCache();
	h2Config = {};
	h1Hits = 0;
	h1Paths = [];
});

afterEach(async () => {
	vi.restoreAllMocks();
	await h2Pool.disposeCursorH2Pool();
	await stopH2ConfigServer();
	await stopH1Fixture();
	resetCursorServerConfigCache();
});

describe("openCursorTransport lifecycle", () => {
	it("throws on ALPN failure when GetServerConfig is unspecified and never opens the HTTP/1.1 Run bridge", async () => {
		const h1Url = await startH1Fixture();
		vi.spyOn(h2Pool, "acquireCursorH2").mockResolvedValue({
			ok: false,
			unavailable: { reason: "alpn", cause: alpnCause() },
		});

		await expect(
			openCursorTransport({
				baseUrl: h1Url,
				apiKey: API_KEY,
				requestPath: RUN_PATH,
				runHeaders: testRunHeaders(),
				gzipRequest: false,
				provider: "cursor",
			}),
		).rejects.toBeInstanceOf(ProviderResponseError);

		expect(h1Paths).toContain(GET_SERVER_CONFIG_PATH);
		expect(h1Paths.some(path => path.includes("Run"))).toBe(false);
	});

	it("opens the HTTP/1.1 bridge when ALPN fails and GetServerConfig is discovered over HTTP/1", async () => {
		const payload = Buffer.from("server-frame", "utf8");
		const h1Url = await startH1Fixture((req, res) => {
			if (req.url === GET_SERVER_CONFIG_PATH) {
				const message = create(GetServerConfigResponseSchema, {
					http2Config: Http2Config.FORCE_BIDI_DISABLED,
				});
				res.writeHead(200, { "content-type": "application/proto" });
				res.end(Buffer.concat([frameConnectMessage(toBinary(GetServerConfigResponseSchema, message)), endFrame()]));
				return;
			}
			if (req.url?.endsWith("RunPoll")) {
				const body = Buffer.concat([
					encodeConnectFrame(encodePollResponse(0n, payload.toString("base64"), false), false),
					encodeConnectFrame(encodePollResponse(1n, "", true), false),
					frameConnectMessage(Buffer.from("{}", "utf8"), CONNECT_END_STREAM_FLAG),
				]);
				res.writeHead(200, { "content-type": "application/connect+proto" });
				res.end(body);
				return;
			}
			res.statusCode = 200;
			res.end();
		});

		vi.spyOn(h2Pool, "acquireCursorH2").mockResolvedValue({
			ok: false,
			unavailable: { reason: "alpn", cause: alpnCause() },
		});

		const attempt = await openCursorTransport({
			baseUrl: h1Url,
			apiKey: API_KEY,
			requestPath: RUN_PATH,
			runHeaders: testRunHeaders(),
			gzipRequest: false,
			provider: "cursor",
		});

		attempt.write(encodeConnectFrame(Buffer.from("client-request", "utf8"), false));

		const frames: Array<{ kind: string }> = [];
		for await (const frame of attempt.frames()) frames.push(frame);
		expect(frames.some(frame => frame.kind === "data")).toBe(true);
		expect(h1Paths).toContain(GET_SERVER_CONFIG_PATH);
		expect(h1Paths.some(path => path.includes("RunPoll"))).toBe(true);
		attempt.close();
	});

	it("opens the HTTP/1.1 bridge when ALPN fails and GetServerConfig is bidi-disabled", async () => {
		h2Config = { http2Config: Http2Config.FORCE_BIDI_DISABLED };
		const h2Url = await startH2ConfigServer();
		expect(await fetchCursorBidiAvailability({ apiKey: API_KEY, baseUrl: h2Url })).toBe("bidi-disabled");
		await h2Pool.disposeCursorH2Pool();
		await stopH2ConfigServer();

		const payload = Buffer.from("server-frame", "utf8");
		const h1Url = await startH1Fixture((req, res) => {
			if (req.url?.endsWith("RunPoll")) {
				const body = Buffer.concat([
					encodeConnectFrame(encodePollResponse(0n, payload.toString("base64"), false), false),
					encodeConnectFrame(encodePollResponse(1n, "", true), false),
					frameConnectMessage(Buffer.from("{}", "utf8"), CONNECT_END_STREAM_FLAG),
				]);
				res.writeHead(200, { "content-type": "application/connect+proto" });
				res.end(body);
				return;
			}
			res.statusCode = 200;
			res.end();
		});

		vi.spyOn(h2Pool, "acquireCursorH2").mockResolvedValue({
			ok: false,
			unavailable: { reason: "alpn", cause: alpnCause() },
		});
		// The cache is now endpoint-scoped (apiKey + baseUrl), so the priming
		// fetch above (against h2Url) does not satisfy the transport's lookup
		// (against h1Url). Mock the transport's internal call directly — the
		// wire-fetch correctness is already asserted by the priming fetch.
		vi.spyOn(serverConfig, "fetchCursorBidiAvailability").mockResolvedValue("bidi-disabled");

		const attempt = await openCursorTransport({
			baseUrl: h1Url,
			apiKey: API_KEY,
			requestPath: RUN_PATH,
			runHeaders: testRunHeaders(),
			gzipRequest: false,
			provider: "cursor",
		});

		// The Run path always writes the request body; the bridge poll is gated
		// behind the first append's settlement, so a write is required to start it.
		attempt.write(encodeConnectFrame(Buffer.from("client-request", "utf8"), false));

		const frames: Array<{ kind: string }> = [];
		for await (const frame of attempt.frames()) frames.push(frame);
		expect(frames.some(frame => frame.kind === "data")).toBe(true);
		expect(h1Paths.some(path => path.includes("RunPoll"))).toBe(true);
		attempt.close();
	});

	it("never downgrades a non-ALPN acquisition failure even when config would disable bidi", async () => {
		h2Config = { http2Config: Http2Config.FORCE_BIDI_DISABLED };
		const h2Url = await startH2ConfigServer();
		expect(await fetchCursorBidiAvailability({ apiKey: API_KEY, baseUrl: h2Url })).toBe("bidi-disabled");
		await h2Pool.disposeCursorH2Pool();
		await stopH2ConfigServer();

		const h1Url = await startH1Fixture();
		const tunnelCause = new Error("CONNECT tunnel failed");
		vi.spyOn(h2Pool, "acquireCursorH2").mockResolvedValue({
			ok: false,
			unavailable: { reason: "connect-tunnel", cause: tunnelCause },
		});

		await expect(
			openCursorTransport({
				baseUrl: h1Url,
				apiKey: API_KEY,
				requestPath: RUN_PATH,
				runHeaders: testRunHeaders(),
				gzipRequest: false,
				provider: "cursor",
			}),
		).rejects.toBe(tunnelCause);
		expect(h1Hits).toBe(0);
	});

	it("surfaces a post-frame HTTP/2 error without opening HTTP/1.1", async () => {
		await startH1Fixture();

		let server: http2.Http2Server | undefined;
		const sessions = new Set<http2.Http2Session>();
		server = http2.createServer();
		server.on("session", session => {
			sessions.add(session);
			session.on("close", () => sessions.delete(session));
		});
		server.on("stream", (stream: http2.ServerHttp2Stream) => {
			stream.on("data", () => {});
			stream.on("error", () => {});
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			stream.write(encodeConnectFrame(Buffer.from("first-frame", "utf8"), false));
			// Leave the stream open; the client tears it down after the first frame.
		});
		const listening = Promise.withResolvers<void>();
		server.once("error", listening.reject);
		server.listen(0, "127.0.0.1", listening.resolve);
		await listening.promise;
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("expected live h2 fixture");
		const h2Url = `http://127.0.0.1:${address.port}`;

		try {
			const attempt = await openCursorTransport({
				baseUrl: h2Url,
				apiKey: API_KEY,
				requestPath: RUN_PATH,
				runHeaders: testRunHeaders(),
				gzipRequest: false,
				provider: "cursor",
			});
			const iter = attempt.frames()[Symbol.asyncIterator]();
			const first = await iter.next();
			expect(first.done).toBe(false);
			expect(first.value?.kind).toBe("data");
			attempt.close();
			await expect(iter.next()).rejects.toBeTruthy();
			expect(h1Hits).toBe(0);
		} finally {
			for (const session of sessions) session.destroy();
			const closing = server;
			server = undefined;
			const closed = Promise.withResolvers<void>();
			closing.close(error => (error ? closed.reject(error) : closed.resolve()));
			await closed.promise;
		}
	});

	it("fails the eager H2 frame pump on its queued-byte budget while the consumer stalls", async () => {
		let server: http2.Http2Server | undefined;
		const sessions = new Set<http2.Http2Session>();
		server = http2.createServer();
		server.on("session", session => {
			sessions.add(session);
			session.on("close", () => sessions.delete(session));
		});
		const filler = Buffer.alloc(200, 0x61);
		server.on("stream", (stream: http2.ServerHttp2Stream) => {
			stream.on("data", () => {});
			stream.on("error", () => {});
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			// Six 200-byte frames against a 512-byte budget: the pump must
			// fail on queued bytes, not retain the whole response. No end
			// envelope — the budget is what stops the hostile stream.
			const parts: Buffer[] = [];
			for (let index = 0; index < 6; index++) {
				parts.push(frameConnectMessage(filler));
			}
			stream.end(Buffer.concat(parts));
		});
		const listening = Promise.withResolvers<void>();
		server.once("error", listening.reject);
		server.listen(0, "127.0.0.1", listening.resolve);
		await listening.promise;
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("expected live h2 fixture");
		const h2Url = `http://127.0.0.1:${address.port}`;

		__setCursorH2FrameQueueBytes(512);
		try {
			const attempt = await openCursorTransport({
				baseUrl: h2Url,
				apiKey: API_KEY,
				requestPath: RUN_PATH,
				runHeaders: testRunHeaders(),
				gzipRequest: false,
				provider: "cursor",
			});
			attempt.write(encodeConnectFrame(Buffer.from("client-request", "utf8"), false));
			// Do not drain: the reader keeps decoding while frames sit
			// unconsumed, which is exactly the retention the budget bounds.
			let error: unknown;
			try {
				for await (const frame of attempt.frames()) void frame;
			} catch (cause) {
				error = cause;
			}
			expect(error).toBeInstanceOf(Error);
			expect(String(error)).toContain("frame queue exceeded");
			attempt.close();
		} finally {
			__setCursorH2FrameQueueBytes(undefined);
			for (const session of sessions) session.destroy();
			const closing = server;
			server = undefined;
			const closed = Promise.withResolvers<void>();
			closing.close(error => (error ? closed.reject(error) : closed.resolve()));
			await closed.promise;
		}
	}, 10_000);
});

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

function execReadPayload(toolCallId = "call-hang", path = "/tmp/hang"): Uint8Array {
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
						value: create(ReadArgsSchema, { path, toolCallId }),
					},
				}),
			},
		}),
	);
}

function makeModel(baseUrl: string): Model<"cursor-agent"> {
	return buildModel({
		id: "cursor-transport-lifecycle",
		name: "Cursor transport lifecycle",
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

const streamContext: Context = {
	messages: [{ role: "user", content: "lifecycle", timestamp: 1 }],
};

function alpnUnavailable(): { ok: false; unavailable: { reason: "alpn"; cause: Error } } {
	return { ok: false, unavailable: { reason: "alpn", cause: alpnCause() } };
}

describe("cursor heartbeat and outbound write lifecycle", () => {
	it("holds an h1 end-stream drain across the heartbeat boundary without an uncaught write", async () => {
		const uncaught: unknown[] = [];
		const onUncaught = (error: unknown): void => {
			uncaught.push(error);
		};
		process.on("uncaughtException", onUncaught);
		try {
			const execB64 = Buffer.from(execReadPayload()).toString("base64");
			const turnB64 = Buffer.from(turnEndedPayload()).toString("base64");
			const h1Url = await startH1Fixture((req, res) => {
				if (req.url?.includes("RunPoll")) {
					const body = Buffer.concat([
						encodeConnectFrame(encodePollResponse(0n, execB64, false), false),
						encodeConnectFrame(encodePollResponse(1n, turnB64, false), false),
						encodeConnectFrame(encodePollResponse(2n, "", true), false),
						endFrame(),
					]);
					res.writeHead(200, { "content-type": "application/connect+proto" });
					res.end(body);
					return;
				}
				res.statusCode = 200;
				res.end();
			});
			vi.spyOn(h2Pool, "acquireCursorH2").mockResolvedValue(alpnUnavailable());
			vi.spyOn(serverConfig, "fetchCursorBidiAvailability").mockResolvedValue("bidi-disabled");

			const started = Date.now();
			const stream = streamCursor(makeModel(h1Url), streamContext, {
				apiKey: API_KEY,
				execHandlers: {
					read: () => Promise.withResolvers<ToolResultMessage>().promise,
				},
			});
			const eventTypes: string[] = [];
			for await (const event of stream) eventTypes.push(event.type);
			const elapsed = Date.now() - started;
			const result = await stream.result();
			expect(elapsed).toBeLessThan(7000);
			expect(elapsed).toBeGreaterThanOrEqual(4500);
			expect(eventTypes).toContain("done");
			expect(eventTypes).not.toContain("error");
			expect(result.stopReason).toBe("stop");
			expect(uncaught).toHaveLength(0);
		} finally {
			process.off("uncaughtException", onUncaught);
		}
	}, 15_000);

	it("surfaces a synchronous transport write failure through stream error output", async () => {
		const uncaught: unknown[] = [];
		const onUncaught = (error: unknown): void => {
			uncaught.push(error);
		};
		process.on("uncaughtException", onUncaught);
		try {
			const request = new EventEmitter() as EventEmitter & {
				write: (frame: Buffer) => boolean;
				destroy: () => void;
			};
			request.write = () => {
				throw new Error("forced synchronous write failure");
			};
			request.destroy = () => {
				request.emit("close");
			};
			vi.spyOn(h2Pool, "acquireCursorH2").mockResolvedValue({
				ok: true,
				lease: {
					request: request as unknown as http2.ClientHttp2Stream,
					release() {
						request.destroy();
					},
				},
			});
			const h1Url = await startH1Fixture();
			const stream = streamCursor(makeModel(h1Url), streamContext, { apiKey: API_KEY });
			const eventTypes: string[] = [];
			for await (const event of stream) eventTypes.push(event.type);
			const result = await stream.result();
			expect(eventTypes.at(-1)).toBe("error");
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("forced synchronous write failure");
			expect(uncaught).toHaveLength(0);
		} finally {
			process.off("uncaughtException", onUncaught);
		}
	});

	it("lets a late handler result win over the drain-timeout synthesis", async () => {
		const sessions = new Set<http2.Http2Session>();
		const server = http2.createServer();
		server.on("session", session => {
			sessions.add(session);
			session.on("close", () => sessions.delete(session));
		});
		server.on("stream", (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
			stream.on("data", () => {});
			stream.on("error", () => {});
			if (headers[":path"] !== RUN_PATH) {
				stream.respond({ ":status": 404 });
				stream.end();
				return;
			}
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			stream.write(
				Buffer.concat([
					frameConnectMessage(execReadPayload("call-done", "/tmp/done")),
					frameConnectMessage(execReadPayload("call-slow", "/tmp/slow")),
					frameConnectMessage(execReadPayload("call-never", "/tmp/hang")),
					frameConnectMessage(turnEndedPayload()),
				]),
			);
			stream.end();
		});
		const listening = Promise.withResolvers<void>();
		server.once("error", listening.reject);
		server.listen(0, "127.0.0.1", listening.resolve);
		await listening.promise;
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("expected h2 run fixture to bind a tcp port");
		const baseUrl = `http://127.0.0.1:${address.port}`;

		const releaseSlow = Promise.withResolvers<ToolResultMessage>();
		const slowPaired = Promise.withResolvers<void>();
		const paired: ToolResultMessage[] = [];
		try {
			const stream = streamCursor(makeModel(baseUrl), streamContext, {
				apiKey: API_KEY,
				execHandlers: {
					read(args) {
						if (args.toolCallId === "call-done") {
							return Promise.resolve({
								role: "toolResult" as const,
								toolCallId: "call-done",
								toolName: "read",
								content: [{ type: "text" as const, text: "done-body" }],
								isError: false,
								timestamp: 1,
							});
						}
						if (args.toolCallId === "call-slow") {
							return releaseSlow.promise;
						}
						return Promise.withResolvers<ToolResultMessage>().promise;
					},
				},
				onToolResult: result => {
					paired.push(result);
					if (result.toolCallId === "call-slow") slowPaired.resolve();
					return result;
				},
			});
			const eventTypes: string[] = [];
			for await (const event of stream) {
				eventTypes.push(event.type);
				if (event.type === "done") {
					// The 5-second drain has timed out and the stream ended. The
					// slow handler is still live; releasing it now proves a late
					// real result beats any synthetic "Tool not available".
					releaseSlow.resolve({
						role: "toolResult" as const,
						toolCallId: "call-slow",
						toolName: "read",
						content: [{ type: "text" as const, text: "slow-body" }],
						isError: false,
						timestamp: 1,
					});
				}
			}
			const result = await stream.result();
			// The done event has already released the slow handler; wait for its
			// real result to pair before we assert the absence of "Tool not
			// available".
			await slowPaired.promise;
			expect(eventTypes).toContain("done");
			expect(eventTypes).not.toContain("error");
			expect(result.stopReason).toBe("stop");

			const doneResults = paired.filter(entry => entry.toolCallId === "call-done");
			const slowResults = paired.filter(entry => entry.toolCallId === "call-slow");
			const hangResults = paired.filter(entry => entry.toolCallId === "call-never");
			expect(doneResults).toHaveLength(1);
			expect(doneResults[0]?.content).toEqual([{ type: "text", text: "done-body" }]);
			expect(doneResults[0]?.isError).toBe(false);
			expect(slowResults).toHaveLength(1);
			expect(slowResults[0]?.content).toEqual([{ type: "text", text: "slow-body" }]);
			expect(slowResults[0]?.isError).toBe(false);
			expect(hangResults).toHaveLength(0);
			expect(
				paired.filter(entry =>
					entry.content.some(part => part.type === "text" && part.text === "Tool not available"),
				),
			).toHaveLength(0);
		} finally {
			for (const session of sessions) session.destroy();
			const closed = Promise.withResolvers<void>();
			server.close(error => (error ? closed.reject(error) : closed.resolve()));
			await closed.promise;
		}
	}, 15_000);

	it("synthesizes a drain-timeout pair when onToolResult rejects", async () => {
		const sessions = new Set<http2.Http2Session>();
		const server = http2.createServer();
		server.on("session", session => {
			sessions.add(session);
			session.on("close", () => sessions.delete(session));
		});
		server.on("stream", (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
			stream.on("data", () => {});
			stream.on("error", () => {});
			if (headers[":path"] !== RUN_PATH) {
				stream.respond({ ":status": 404 });
				stream.end();
				return;
			}
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			stream.write(
				Buffer.concat([
					frameConnectMessage(execReadPayload("call-fail", "/tmp/fail")),
					frameConnectMessage(execReadPayload("call-never", "/tmp/hang")),
					frameConnectMessage(turnEndedPayload()),
				]),
			);
			stream.end();
		});
		const listening = Promise.withResolvers<void>();
		server.once("error", listening.reject);
		server.listen(0, "127.0.0.1", listening.resolve);
		await listening.promise;
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("expected h2 run fixture to bind a tcp port");
		const baseUrl = `http://127.0.0.1:${address.port}`;

		const paired: ToolResultMessage[] = [];
		const rejectFirstSink = Promise.withResolvers<void>();
		const sawSynthetic = Promise.withResolvers<void>();
		try {
			const stream = streamCursor(makeModel(baseUrl), streamContext, {
				apiKey: API_KEY,
				execHandlers: {
					read(args) {
						if (args.toolCallId === "call-fail") {
							return Promise.resolve({
								role: "toolResult" as const,
								toolCallId: "call-fail",
								toolName: "read",
								content: [{ type: "text" as const, text: "fail-body" }],
								isError: false,
								timestamp: 1,
							});
						}
						return Promise.withResolvers<ToolResultMessage>().promise;
					},
				},
				onToolResult: result => {
					if (
						result.toolCallId === "call-fail" &&
						!result.content.some(part => part.type === "text" && part.text === "Tool not available")
					) {
						return rejectFirstSink.promise.then(() => {
							throw new Error("sink-fail");
						});
					}
					paired.push(result);
					if (result.toolCallId === "call-fail") sawSynthetic.resolve();
					return result;
				},
			});
			for await (const event of stream) {
				if (event.type === "done") rejectFirstSink.resolve();
			}
			await sawSynthetic.promise;
			expect(
				paired.filter(
					entry =>
						entry.toolCallId === "call-fail" &&
						entry.content.some(part => part.type === "text" && part.text === "Tool not available"),
				),
			).toHaveLength(1);
		} finally {
			for (const session of sessions) session.destroy();
			const closed = Promise.withResolvers<void>();
			server.close(error => (error ? closed.reject(error) : closed.resolve()));
			await closed.promise;
		}
	}, 15_000);

	it("writes Connect data-frame payloads into the PI_REQ_DEBUG response log", async () => {
		const previousDebugFlag = Bun.env.PI_REQ_DEBUG;
		const previousCwd = process.cwd();
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-req-debug-body-"));
		const sessions = new Set<http2.Http2Session>();
		const server = http2.createServer();
		server.on("session", session => {
			sessions.add(session);
			session.on("close", () => sessions.delete(session));
		});
		const payload = turnEndedPayload();
		server.on("stream", (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
			stream.on("data", () => {});
			stream.on("error", () => {});
			if (headers[":path"] !== RUN_PATH) {
				stream.respond({ ":status": 404 });
				stream.end();
				return;
			}
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			stream.write(frameConnectMessage(payload));
			stream.end();
		});
		const listening = Promise.withResolvers<void>();
		server.once("error", listening.reject);
		server.listen(0, "127.0.0.1", listening.resolve);
		await listening.promise;
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("expected h2 run fixture to bind a tcp port");
		const baseUrl = `http://127.0.0.1:${address.port}`;

		try {
			process.chdir(tempDir);
			Bun.env.PI_REQ_DEBUG = "1";
			const stream = streamCursor(makeModel(baseUrl), streamContext, { apiKey: API_KEY });
			for await (const _event of stream) {
				/* drain */
			}
			const entries = await fs.readdir(tempDir);
			const jsonFiles = entries.filter(name => /^rr-session-\d+\.json$/.test(name));
			const requestDumpName = jsonFiles[0];
			if (!requestDumpName) throw new Error("expected request dump");
			const dump = JSON.parse(await fs.readFile(path.join(tempDir, requestDumpName), "utf8")) as {
				protocol?: string;
			};
			expect(dump.protocol).toBe("http2");
			const resLogs = entries.filter(name => /^rr-session-\d+\.res\.log$/.test(name));
			expect(resLogs.length).toBeGreaterThan(0);
			const responseLogName = resLogs[0];
			if (!responseLogName) throw new Error("expected response log");
			const bytes = await fs.readFile(path.join(tempDir, responseLogName));
			const separator = Buffer.from("\r\n\r\n");
			const separatorIndex = bytes.indexOf(separator);
			expect(separatorIndex).toBeGreaterThanOrEqual(0);
			const body = bytes.subarray(separatorIndex + separator.length);
			expect(body.length).toBeGreaterThan(0);
			expect(body.includes(payload)).toBe(true);
		} finally {
			process.chdir(previousCwd);
			if (previousDebugFlag === undefined) delete Bun.env.PI_REQ_DEBUG;
			else Bun.env.PI_REQ_DEBUG = previousDebugFlag;
			await fs.rm(tempDir, { recursive: true, force: true });
			for (const session of sessions) session.destroy();
			const closed = Promise.withResolvers<void>();
			server.close(error => (error ? closed.reject(error) : closed.resolve()));
			await closed.promise;
		}
	});

	it("writes poll-stream payloads into the HTTP/1 bridge PI_REQ_DEBUG response log", async () => {
		const previousDebugFlag = Bun.env.PI_REQ_DEBUG;
		const previousCwd = process.cwd();
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-req-debug-h1-body-"));
		const turnBytes = turnEndedPayload();
		const turnB64 = Buffer.from(turnBytes).toString("base64");

		const h1Url = await startH1Fixture((req, res) => {
			if (req.url?.includes("RunPoll")) {
				const body = Buffer.concat([
					encodeConnectFrame(encodePollResponse(0n, turnB64, false), false),
					encodeConnectFrame(encodePollResponse(1n, "", true), false),
					frameConnectMessage(Buffer.from("{}", "utf8"), CONNECT_END_STREAM_FLAG),
				]);
				res.writeHead(200, { "content-type": "application/connect+proto" });
				res.end(body);
				return;
			}
			res.statusCode = 200;
			res.end();
		});
		vi.spyOn(h2Pool, "acquireCursorH2").mockResolvedValue(alpnUnavailable());
		vi.spyOn(serverConfig, "fetchCursorBidiAvailability").mockResolvedValue("bidi-disabled");

		try {
			process.chdir(tempDir);
			Bun.env.PI_REQ_DEBUG = "1";
			const stream = streamCursor(makeModel(h1Url), streamContext, { apiKey: API_KEY });
			for await (const _event of stream) {
				/* drain */
			}
			const entries = await fs.readdir(tempDir);
			const jsonFiles = entries.filter(name => /^rr-session-\d+\.json$/.test(name));
			const requestDumpName = jsonFiles[0];
			if (!requestDumpName) throw new Error("expected request dump");
			const dump = JSON.parse(await fs.readFile(path.join(tempDir, requestDumpName), "utf8")) as {
				protocol?: string;
			};
			expect(dump.protocol).toBe("http");
			const resLogs = entries.filter(name => /^rr-session-\d+\.res\.log$/.test(name));
			if (resLogs.length === 0) throw new Error("expected at least one response log");
			const responseLogName = resLogs[0];
			if (!responseLogName) throw new Error("expected response log");
			const bytes = await fs.readFile(path.join(tempDir, responseLogName));
			const separator = Buffer.from("\r\n\r\n");
			const separatorIndex = bytes.indexOf(separator);
			expect(separatorIndex).toBeGreaterThanOrEqual(0);
			const body = bytes.subarray(separatorIndex + separator.length);
			expect(body.length).toBeGreaterThan(0);
			expect(body.includes(turnBytes)).toBe(true);
		} finally {
			process.chdir(previousCwd);
			if (previousDebugFlag === undefined) delete Bun.env.PI_REQ_DEBUG;
			else Bun.env.PI_REQ_DEBUG = previousDebugFlag;
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("does not emit an unhandled rejection when HTTP/2 trailers reject", async () => {
		const rejections: unknown[] = [];
		const onUnhandled = (reason: unknown): void => {
			rejections.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			const request = new EventEmitter() as EventEmitter & {
				write: (frame: Buffer) => boolean;
				destroy: () => void;
			};
			let failed = false;
			request.write = () => {
				if (!failed) {
					failed = true;
					queueMicrotask(() => {
						request.emit("response", { ":status": "200" });
						request.emit("error", new Error("mid-stream network error"));
					});
				}
				return true;
			};
			request.destroy = () => {
				request.emit("close");
			};
			vi.spyOn(h2Pool, "acquireCursorH2").mockResolvedValue({
				ok: true,
				lease: {
					request: request as unknown as http2.ClientHttp2Stream,
					release() {
						request.destroy();
					},
				},
			});
			const h1Url = await startH1Fixture();
			const stream = streamCursor(makeModel(h1Url), streamContext, { apiKey: API_KEY });
			for await (const _event of stream) {
				/* drain */
			}
			await Promise.resolve();
			await Promise.resolve();
			expect(rejections).toHaveLength(0);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
});
