import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { once } from "node:events";
import * as http from "node:http";
import * as http2 from "node:http2";
import * as path from "node:path";
import { Duplex } from "node:stream";
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
import { type ConnectFrame, encodeConnectFrame } from "../src/providers/cursor/connect-frame";
import * as h2Pool from "../src/providers/cursor/h2-pool";
import { buildCursorRunHeaders } from "../src/providers/cursor/headers";
import * as serverConfig from "../src/providers/cursor/server-config";
import { fetchCursorBidiAvailability, resetCursorServerConfigCache } from "../src/providers/cursor/server-config";
import { __setCursorH2FrameQueueBytes, openCursorTransport } from "../src/providers/cursor/transport";

const RUN_PATH = "/agent.v1.AgentService/Run";
const GET_SERVER_CONFIG_PATH = "/agent.v1.AgentService/GetServerConfig";
const CONNECT_END_STREAM_FLAG = 0b00000010;
const API_KEY = "transport-lifecycle-key";

async function runFixtureChild(
	argv: string[],
	label: string,
	marker?: RegExp,
	env?: Record<string, string>,
): Promise<string> {
	const child = Bun.spawn(argv, {
		cwd: path.resolve(import.meta.dir, "../../.."),
		stdout: "pipe",
		stderr: "pipe",
		...(env ? { env: { ...process.env, ...env } } : {}),
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(`${label} fixture exited ${exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
	}
	const json = marker ? stdout.match(marker)?.[1] : stdout.trim();
	if (!json) throw new Error(`${label} fixture produced no result\nstdout:\n${stdout}\nstderr:\n${stderr}`);
	return json;
}

async function runRequestDebugFixture(mode: "h2-body" | "h1-body"): Promise<{
	protocol?: string;
	bodyContainsPayload: boolean;
}> {
	const fixture = path.join(
		import.meta.dir,
		mode === "h1-body" ? "fixtures/cursor-request-debug-h1.fixture.ts" : "fixtures/cursor-request-debug.ts",
	);
	const argv = mode === "h1-body" ? [process.execPath, "test", fixture] : [process.execPath, fixture];
	const json = await runFixtureChild(
		argv,
		`request-debug ${mode}`,
		mode === "h1-body" ? /^REQUEST_DEBUG_RESULT=(.+)$/m : undefined,
	);
	return JSON.parse(json) as { protocol?: string; bodyContainsPayload: boolean };
}

type LifecycleScenario = "heartbeat-drain" | "sync-write-failure" | "trailers-rejection";

interface LifecycleFixtureResult {
	uncaught: number;
	unhandledRejections: number;
	elapsedMs?: number;
	eventTypes?: string[];
	stopReason?: string;
	errorMessage?: string;
}

async function runLifecycleFixture(scenario: LifecycleScenario): Promise<LifecycleFixtureResult> {
	const fixture = path.join(import.meta.dir, "fixtures/cursor-transport-lifecycle.fixture.ts");
	const json = await runFixtureChild(
		[process.execPath, "test", fixture],
		`lifecycle ${scenario}`,
		/^LIFECYCLE_RESULT=(.+)$/m,
		{ LIFECYCLE_SCENARIO: scenario },
	);
	return JSON.parse(json) as LifecycleFixtureResult;
}

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

	it("settles response and trailers to empty headers when the lease request is already terminal", async () => {
		// Destroying and awaiting close fires every terminal event before the
		// wrapper installs its listeners, so only reconciliation can settle.
		const request = new Duplex({ read() {} });
		request.destroy();
		await once(request, "close");
		vi.spyOn(h2Pool, "acquireCursorH2").mockResolvedValue({
			ok: true,
			lease: {
				request: request as http2.ClientHttp2Stream,
				release() {},
			},
		});

		const attempt = await openCursorTransport({
			baseUrl: "http://127.0.0.1:1",
			apiKey: API_KEY,
			requestPath: RUN_PATH,
			runHeaders: testRunHeaders(),
			gzipRequest: false,
			provider: "cursor",
		});

		expect(await attempt.responseHeaders?.()).toEqual({});
		expect(await attempt.trailers()).toEqual({});
		attempt.close();
	}, 10_000);

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

	it("drains admitted frames before surfacing the queued-byte budget failure", async () => {
		let server: http2.Http2Server | undefined;
		const overBudgetFrameFlushed = Promise.withResolvers<void>();
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
			// Two 100-byte frames fit the 512-byte budget ((64+100)*2 = 328);
			// the later 200-byte frame (64+200 = 264) tips admission over the
			// limit. The stream stays open: the failure is what ends the turn.
			// Real timers, deliberately: admission batches per 'data' event, so
			// the over-budget frame must arrive in its own TCP segment — fake
			// timers cannot force socket segmentation.
			stream.write(
				Buffer.concat([frameConnectMessage(Buffer.alloc(100, 0x61)), frameConnectMessage(Buffer.alloc(100, 0x62))]),
			);
			setTimeout(() => {
				stream.write(frameConnectMessage(Buffer.alloc(200, 0x63)), () => overBudgetFrameFlushed.resolve());
			}, 100);
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
			// Consume only after the over-budget frame was flushed: admitted
			// frames drain first and the stored failure surfaces after — the
			// same drain-before-error contract the HTTP/1 bridge pins, so the
			// failure is delayed but never masked. The residual sleep is
			// loopback delivery grace; the budget rejection never settles a
			// public promise, so no awaitable signal exists on the client.
			await overBudgetFrameFlushed.promise;
			await Bun.sleep(100);
			const consumed: ConnectFrame[] = [];
			let error: unknown;
			try {
				for await (const frame of attempt.frames()) consumed.push(frame);
			} catch (cause) {
				error = cause;
			}
			expect(consumed.filter(frame => frame.kind === "data")).toHaveLength(2);
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

	it("bounds retained zero-payload data frames when the consumer stalls", async () => {
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
			// 64 empty envelopes carry no payload bytes at all: only the fixed
			// per-frame retained cost keeps the pump from retaining unbounded
			// decoded objects. No end envelope — the budget is what stops the
			// hostile stream.
			const parts: Buffer[] = [];
			for (let index = 0; index < 64; index++) parts.push(frameConnectMessage(Buffer.alloc(0)));
			stream.end(Buffer.concat(parts));
		});
		const listening = Promise.withResolvers<void>();
		server.once("error", listening.reject);
		server.listen(0, "127.0.0.1", listening.resolve);
		await listening.promise;
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("expected live h2 fixture");
		const h2Url = `http://127.0.0.1:${address.port}`;

		__setCursorH2FrameQueueBytes(2048);
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
			// Do not drain: all 64 frames decode from one small chunk, so the
			// admission check must fail on their retained-object cost alone.
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

	it("accepts more than 1024 tiny frames when decoded bytes stay within budget", async () => {
		let server: http2.Http2Server | undefined;
		const sessions = new Set<http2.Http2Session>();
		server = http2.createServer();
		server.on("session", session => {
			sessions.add(session);
			session.on("close", () => sessions.delete(session));
		});
		server.on("stream", (stream: http2.ServerHttp2Stream) => {
			stream.on("data", () => {});
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			const parts: Buffer[] = [];
			for (let index = 0; index < 1025; index++) parts.push(frameConnectMessage(Buffer.from([index & 0xff])));
			parts.push(frameConnectMessage(Buffer.alloc(0)));
			parts.push(endFrame());
			stream.end(Buffer.concat(parts));
		});
		const listening = Promise.withResolvers<void>();
		server.once("error", listening.reject);
		server.listen(0, "127.0.0.1", listening.resolve);
		await listening.promise;
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("expected live h2 fixture");

		// 1027 envelopes (1025 tiny + 1 empty + end) charge payload bytes plus
		// the fixed per-frame retained cost; a 1024-frame count cap would fail
		// this test, as would a budget that ignored the per-frame overhead.
		__setCursorH2FrameQueueBytes(128 * 1024);
		try {
			const attempt = await openCursorTransport({
				baseUrl: `http://127.0.0.1:${address.port}`,
				apiKey: API_KEY,
				requestPath: RUN_PATH,
				runHeaders: testRunHeaders(),
				gzipRequest: false,
				provider: "cursor",
			});
			attempt.write(encodeConnectFrame(Buffer.from("client-request"), false));
			const frames = [];
			for await (const frame of attempt.frames()) frames.push(frame);
			expect(frames.filter(frame => frame.kind === "data")).toHaveLength(1026);
			expect(frames.filter(frame => frame.kind === "data" && frame.payload.length === 0)).toHaveLength(1);
			expect(frames.at(-1)).toEqual({ kind: "end", error: null });
			attempt.close();
		} finally {
			__setCursorH2FrameQueueBytes(undefined);
			for (const session of sessions) session.destroy();
			const closed = Promise.withResolvers<void>();
			server.close(error => (error ? closed.reject(error) : closed.resolve()));
			await closed.promise;
		}
	}, 10_000);

	it("fails the turn when stray bytes follow the end envelope in the same chunk, after delivering data frames", async () => {
		// The reviewer scenario: turnEnded data + clean end envelope + stray tail
		// in one DATA chunk. The decoder withholds the untrustworthy end frame,
		// so the consumer cannot break on it and report a clean turn; the pump
		// reaches stream EOF and finish() surfaces the protocol error instead.
		let server: http2.Http2Server | undefined;
		const sessions = new Set<http2.Http2Session>();
		server = http2.createServer();
		server.on("session", session => {
			sessions.add(session);
			session.on("close", () => sessions.delete(session));
		});
		server.on("stream", (stream: http2.ServerHttp2Stream) => {
			stream.on("data", () => {});
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			stream.end(
				Buffer.concat([frameConnectMessage(turnEndedPayload()), endFrame(), Buffer.from([0x01, 0x02, 0x03])]),
			);
		});
		const listening = Promise.withResolvers<void>();
		server.once("error", listening.reject);
		server.listen(0, "127.0.0.1", listening.resolve);
		await listening.promise;
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("expected live h2 fixture");

		try {
			const attempt = await openCursorTransport({
				baseUrl: `http://127.0.0.1:${address.port}`,
				apiKey: API_KEY,
				requestPath: RUN_PATH,
				runHeaders: testRunHeaders(),
				gzipRequest: false,
				provider: "cursor",
			});
			attempt.write(encodeConnectFrame(Buffer.from("client-request"), false));
			const frames: Array<{ kind: string }> = [];
			let error: unknown;
			try {
				for await (const frame of attempt.frames()) frames.push(frame);
			} catch (cause) {
				error = cause;
			}
			expect(frames.filter(frame => frame.kind === "data")).toHaveLength(1);
			expect(frames.some(frame => frame.kind === "end")).toBe(false);
			expect(String(error)).toContain("after end-of-stream");
			attempt.close();
		} finally {
			for (const session of sessions) session.destroy();
			const closed = Promise.withResolvers<void>();
			server.close(error => (error ? closed.reject(error) : closed.resolve()));
			await closed.promise;
		}
	}, 10_000);

	it("fails immediately when stray bytes follow the end envelope in a half-open stream, after delivering data frames", async () => {
		// The server sends the same turnEnded + end + tail shape as above, but
		// never closes the HTTP/2 stream. The decoder poison must fail the pump
		// before the client waits for an EOF/caller timeout, while the data
		// frame decoded ahead of the tail remains observable.
		let server: http2.Http2Server | undefined;
		const sessions = new Set<http2.Http2Session>();
		server = http2.createServer();
		server.on("session", session => {
			sessions.add(session);
			session.on("close", () => sessions.delete(session));
		});
		server.on("stream", (stream: http2.ServerHttp2Stream) => {
			stream.on("data", () => {});
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			stream.write(
				Buffer.concat([frameConnectMessage(turnEndedPayload()), endFrame(), Buffer.from([0x01, 0x02, 0x03])]),
			);
		});
		const listening = Promise.withResolvers<void>();
		server.once("error", listening.reject);
		server.listen(0, "127.0.0.1", listening.resolve);
		await listening.promise;
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("expected live h2 fixture");

		try {
			const attempt = await openCursorTransport({
				baseUrl: `http://127.0.0.1:${address.port}`,
				apiKey: API_KEY,
				requestPath: RUN_PATH,
				runHeaders: testRunHeaders(),
				gzipRequest: false,
				provider: "cursor",
			});
			attempt.write(encodeConnectFrame(Buffer.from("client-request"), false));
			const frames: Array<{ kind: string }> = [];
			let error: unknown;
			const started = Date.now();
			try {
				for await (const frame of attempt.frames()) frames.push(frame);
			} catch (cause) {
				error = cause;
			}
			// The half-open poison must surface well inside the caller/heartbeat budget.
			expect(Date.now() - started).toBeLessThan(2500);
			expect(frames.filter(frame => frame.kind === "data")).toHaveLength(1);
			expect(frames.some(frame => frame.kind === "end")).toBe(false);
			expect(String(error)).toContain("after end-of-stream");
			attempt.close();
		} finally {
			for (const session of sessions) session.destroy();
			const closed = Promise.withResolvers<void>();
			server.close(error => (error ? closed.reject(error) : closed.resolve()));
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

describe("cursor heartbeat and outbound write lifecycle", () => {
	it("holds an h1 end-stream drain across the heartbeat boundary without an uncaught write", async () => {
		const result = await runLifecycleFixture("heartbeat-drain");
		expect(result.uncaught).toBe(0);
		expect(result.elapsedMs).toBeGreaterThanOrEqual(4500);
		expect(result.elapsedMs).toBeLessThan(7000);
		expect(result.eventTypes).toContain("done");
		expect(result.eventTypes).not.toContain("error");
		expect(result.stopReason).toBe("stop");
	}, 60_000);

	it("surfaces a synchronous transport write failure through stream error output", async () => {
		const result = await runLifecycleFixture("sync-write-failure");
		expect(result.uncaught).toBe(0);
		expect(result.eventTypes?.at(-1)).toBe("error");
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("forced synchronous write failure");
	}, 60_000);

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
		const result = await runRequestDebugFixture("h2-body");
		expect(result.protocol).toBe("http2");
		expect(result.bodyContainsPayload).toBe(true);
	}, 60_000);

	it("writes poll-stream payloads into the HTTP/1 bridge PI_REQ_DEBUG response log", async () => {
		const result = await runRequestDebugFixture("h1-body");
		expect(result.protocol).toBe("http");
		expect(result.bodyContainsPayload).toBe(true);
	}, 60_000);

	it("does not emit an unhandled rejection when HTTP/2 trailers reject", async () => {
		const result = await runLifecycleFixture("trailers-rejection");
		expect(result.unhandledRejections).toBe(0);
	}, 60_000);
});
