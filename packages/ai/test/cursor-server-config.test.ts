import { afterEach, beforeEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import * as http from "node:http";
import * as http2 from "node:http2";
import * as h2Pool from "@oh-my-pi/pi-ai/providers/cursor/h2-pool";
import { buildCursorRunHeaders, buildCursorUnaryHeaders } from "@oh-my-pi/pi-ai/providers/cursor/headers";
import type { CursorBidiAvailability } from "@oh-my-pi/pi-ai/providers/cursor/server-config";
import {
	__cursorServerConfigCacheSize,
	fetchCursorBidiAvailability,
	readServerConfigResponse,
	resetCursorServerConfigCache,
} from "@oh-my-pi/pi-ai/providers/cursor/server-config";
import { openCursorTransport } from "@oh-my-pi/pi-ai/providers/cursor/transport";
import * as proxy from "@oh-my-pi/pi-ai/utils/proxy";
import {
	GetServerConfigRequestSchema,
	type GetServerConfigResponse,
	GetServerConfigResponseSchema,
	Http2Config,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { create, fromBinary, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";

const GET_SERVER_CONFIG_PATH = "/agent.v1.AgentService/GetServerConfig";
const CONNECT_END_STREAM_FLAG = 0b00000010;

type Scenario =
	| { kind: "bidi-disabled" }
	| { kind: "all-disabled" }
	| { kind: "absent-directive" }
	| { kind: "http-500" }
	| { kind: "hang" }
	| { kind: "oversized" }
	| { kind: "route-required" }
	| { kind: "gated"; released: Promise<void> }
	| { kind: "raw-unary" }
	| { kind: "double-data" }
	| { kind: "trailer-failure" };

let server: http2.Http2Server | undefined;
const sessions = new Set<http2.Http2Session>();
let scenario: Scenario = { kind: "absent-directive" };
let invocations = 0;

function frameConnectMessage(data: Uint8Array, flags = 0): Buffer {
	const frame = Buffer.alloc(5 + data.length);
	frame[0] = flags;
	frame.writeUInt32BE(data.length, 1);
	frame.set(data, 5);
	return frame;
}

function responseFrame(value: Partial<GetServerConfigResponse>): Buffer {
	const message = create(GetServerConfigResponseSchema, value);
	return frameConnectMessage(toBinary(GetServerConfigResponseSchema, message));
}

/** Clean end-of-stream envelope (no `error`, so the decoder reports a clean end). */
function endFrame(): Buffer {
	return frameConnectMessage(Buffer.from("{}", "utf8"), CONNECT_END_STREAM_FLAG);
}

async function startServer(): Promise<string> {
	server = http2.createServer();
	server.on("session", session => {
		sessions.add(session);
		session.on("close", () => sessions.delete(session));
	});
	server.on("stream", async (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
		stream.on("data", () => {});
		// Writing to a stream the client already destroyed emits an error on the
		// server side; swallow it so the closed-leak test does not surface one.
		stream.on("error", () => {});
		if (headers[":path"] !== GET_SERVER_CONFIG_PATH) {
			stream.respond({ ":status": 404 });
			stream.end();
			return;
		}
		invocations++;
		if (scenario.kind === "http-500") {
			stream.respond({ ":status": 500 });
			stream.end();
			return;
		}
		if (scenario.kind === "gated" || scenario.kind === "raw-unary") {
			// Unary requests carry the raw serialized message: the gated variant
			// holds the (enveloped) response until the test releases it, and the
			// raw-unary variant answers with the bare protobuf message — the plain
			// Connect unary response shape.
			const body = await readH2RequestBody(stream);
			if (!isRawUnaryRequest(body)) {
				stream.respond({ ":status": 400 });
				stream.end();
				return;
			}
			if (scenario.kind === "gated") await scenario.released;
			stream.respond({ ":status": 200, "content-type": "application/proto" });
			if (scenario.kind === "raw-unary") {
				stream.write(
					toBinary(
						GetServerConfigResponseSchema,
						create(GetServerConfigResponseSchema, { http2Config: Http2Config.FORCE_BIDI_DISABLED }),
					),
				);
			} else {
				stream.write(Buffer.concat([responseFrame({ http2Config: Http2Config.FORCE_BIDI_DISABLED }), endFrame()]));
			}
			stream.end();
			return;
		}
		if (scenario.kind === "hang") {
			// Accept the body, never respond: the client must fail open on abort.
			return;
		}
		if (scenario.kind === "oversized") {
			// A single data frame > 1 MiB exercises the cumulative decoded-byte
			// cap: the per-frame cap (16 MiB) does not catch it, but the
			// cumulative cap (1 MiB) does. The client must destroy the stream
			// and fail open.
			stream.respond({ ":status": 200, "content-type": "application/proto" });
			stream.write(frameConnectMessage(Buffer.alloc(1_048_577)));
			stream.write(endFrame());
			stream.end();
			return;
		}
		if (scenario.kind === "route-required") {
			// A gateway demanding a caller-supplied routing header: without it the
			// probe is rejected and availability collapses to "unspecified".
			if (headers["x-gateway-route"] !== "east") {
				stream.respond({ ":status": 403 });
				stream.end();
				return;
			}
			stream.respond({ ":status": 200, "content-type": "application/proto" });
			stream.write(Buffer.concat([responseFrame({ http2Config: Http2Config.FORCE_BIDI_DISABLED }), endFrame()]));
			stream.end();
			return;
		}
		if (scenario.kind === "double-data") {
			// A valid end envelope cannot rescue two data envelopes; the unary
			// decoder must fail open rather than concatenate two payloads.
			stream.respond({ ":status": 200, "content-type": "application/proto" });
			stream.write(
				Buffer.concat([
					responseFrame({ http2Config: Http2Config.FORCE_BIDI_DISABLED }),
					responseFrame({ http2Config: Http2Config.FORCE_ALL_DISABLED }),
					endFrame(),
				]),
			);
			stream.end();
			return;
		}
		if (scenario.kind === "trailer-failure") {
			// A valid force-disable directive body, but the terminal grpc-status
			// trailer reports failure: the body must never become authoritative.
			stream.respond({ ":status": 200, "content-type": "application/proto" }, { waitForTrailers: true });
			stream.once("wantTrailers", () => {
				stream.sendTrailers({ "grpc-status": "8", "grpc-message": "resource_exhausted" });
			});
			stream.write(Buffer.concat([responseFrame({ http2Config: Http2Config.FORCE_BIDI_DISABLED }), endFrame()]));
			stream.end();
			return;
		}
		stream.respond({
			":status": 200,
			"content-type": "application/proto",
		});
		const config =
			scenario.kind === "bidi-disabled"
				? { http2Config: Http2Config.FORCE_BIDI_DISABLED }
				: scenario.kind === "all-disabled"
					? { http2Config: Http2Config.FORCE_ALL_DISABLED }
					: {};
		stream.write(Buffer.concat([responseFrame(config), endFrame()]));
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

/** Collects one HTTP/2 request body; resolves on end or error. */
async function readH2RequestBody(stream: http2.ServerHttp2Stream): Promise<Buffer> {
	const parts: Buffer[] = [];
	const ended = Promise.withResolvers<void>();
	stream.on("data", (chunk: Buffer) => parts.push(chunk));
	stream.on("end", () => ended.resolve());
	stream.on("error", () => ended.resolve());
	await ended.promise;
	return Buffer.concat(parts);
}

/**
 * True when `body` is a raw unary protobuf request. The empty
 * `GetServerConfigRequest` serializes to 0 bytes; the streaming-envelope form
 * wraps it in five zero bytes, which is not valid protobuf.
 */
function isRawUnaryRequest(body: Buffer): boolean {
	try {
		fromBinary(GetServerConfigRequestSchema, body);
		return true;
	} catch {
		return false;
	}
}

/** Polls a real HTTP/2 stream arrival. Fake timers cannot advance the server. */
async function waitFor(predicate: () => boolean): Promise<void> {
	for (let i = 0; i < 50; i++) {
		if (predicate()) return;
		await Bun.sleep(10);
	}
	throw new Error("timed out waiting for condition");
}

async function stopServer(): Promise<void> {
	for (const session of sessions) {
		session.destroy();
	}
	sessions.clear();
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

beforeEach(async () => {
	scenario = { kind: "absent-directive" };
	invocations = 0;
	await h2Pool.disposeCursorH2Pool();
	resetCursorServerConfigCache();
});

afterEach(async () => {
	await h2Pool.disposeCursorH2Pool();
	await stopServer();
	setSystemTime();
});

async function fetchFor(baseUrl: string, signal?: AbortSignal): Promise<CursorBidiAvailability> {
	return fetchCursorBidiAvailability({ apiKey: "test-token", baseUrl, signal });
}

describe("fetchCursorBidiAvailability", () => {
	it("maps FORCE_BIDI_DISABLED to bidi-disabled", async () => {
		scenario = { kind: "bidi-disabled" };
		const baseUrl = await startServer();
		expect(await fetchFor(baseUrl)).toBe("bidi-disabled");
	});

	it("maps FORCE_ALL_DISABLED to all-disabled", async () => {
		scenario = { kind: "all-disabled" };
		const baseUrl = await startServer();
		expect(await fetchFor(baseUrl)).toBe("all-disabled");
	});

	it("returns unspecified when the directive is absent", async () => {
		scenario = { kind: "absent-directive" };
		const baseUrl = await startServer();
		expect(await fetchFor(baseUrl)).toBe("unspecified");
	});

	it("fails open to unspecified on a unary body with more than one data envelope", async () => {
		scenario = { kind: "double-data" };
		const baseUrl = await startServer();
		expect(await fetchFor(baseUrl)).toBe("unspecified");
	});

	it("fails open to unspecified on a non-2xx status", async () => {
		scenario = { kind: "http-500" };
		const baseUrl = await startServer();
		expect(await fetchFor(baseUrl)).toBe("unspecified");
	});

	it("fails open to unspecified when aborted mid-request", async () => {
		scenario = { kind: "hang" };
		const baseUrl = await startServer();
		const controller = new AbortController();
		const pending = fetchFor(baseUrl, controller.signal);
		controller.abort();
		expect(await pending).toBe("unspecified");
	});

	it("caches per apiKey within the TTL: two calls make one wire request", async () => {
		scenario = { kind: "absent-directive" };
		const baseUrl = await startServer();
		const first = await fetchFor(baseUrl);
		const second = await fetchFor(baseUrl);
		expect(first).toBe("unspecified");
		expect(second).toBe("unspecified");
		expect(invocations).toBe(1);
	});

	it("caches the resolved value, not just the wire result", async () => {
		scenario = { kind: "bidi-disabled" };
		const baseUrl = await startServer();
		expect(await fetchFor(baseUrl)).toBe("bidi-disabled");
		// Re-scenario the fixture so a second round-trip would disagree: the cache
		// must serve the first answer.
		scenario = { kind: "all-disabled" };
		expect(await fetchFor(baseUrl)).toBe("bidi-disabled");
		expect(invocations).toBe(1);
	});

	it("fails open to unspecified when the terminal grpc-status trailer reports failure", async () => {
		// Trailers are the END_STREAM HEADERS frame: the client reads the valid
		// force-disable body first and only then the failed terminal status. The
		// reader must consult the trailers before trusting the body — only a
		// successful RPC status can authorize a downgrade directive.
		scenario = { kind: "trailer-failure" };
		const baseUrl = await startServer();
		expect(await fetchFor(baseUrl)).toBe("unspecified");
		// The failed RPC's directive body was never published as authority: the
		// cached answer is fail-open `unspecified`, so the re-fetch within the
		// TTL serves the cache (one wire request) and would disagree with the
		// freshly served scenario.
		scenario = { kind: "all-disabled" };
		expect(await fetchFor(baseUrl)).toBe("unspecified");
		expect(invocations).toBe(1);
	});

	it("releases the lease when the acquired stream is closed before handlers install", async () => {
		const baseUrl = await startServer();
		const acquisition = await h2Pool.acquireCursorH2({
			baseUrl,
			requestPath: GET_SERVER_CONFIG_PATH,
			headers: buildCursorUnaryHeaders({ apiKey: "test-token" }),
			provider: "cursor",
			signal: AbortSignal.timeout(5000),
		});
		expect(acquisition.ok).toBe(true);
		if (!acquisition.ok) return;
		// Simulate the pool (or a peer) closing the issued request stream in the
		// window between acquisition and handler installation: destroy it
		// synchronously, then hand it to the reader. This deterministically
		// exercises the `request.closed || request.destroyed` early-return — the
		// branch that previously returned "unspecified" without releasing the
		// lease, leaking the draining pool entry forever.
		acquisition.lease.request.destroy();
		const availability = await readServerConfigResponse(acquisition.lease);
		expect(availability).toBe("unspecified");
	});

	it("scopes the cache by apiKey + baseUrl, not apiKey alone", async () => {
		// Same apiKey against endpoint A (bidi-disabled) then B (all-disabled)
		// within the TTL: B must make its own wire fetch and get B's policy,
		// not A's cached answer.
		scenario = { kind: "bidi-disabled" };
		const baseUrlA = await startServer();
		expect(await fetchFor(baseUrlA)).toBe("bidi-disabled");
		expect(invocations).toBe(1);

		await stopServer();
		await h2Pool.disposeCursorH2Pool();
		scenario = { kind: "all-disabled" };
		const baseUrlB = await startServer();
		expect(await fetchFor(baseUrlB)).toBe("all-disabled");
		// B made its own wire request — it was not served from A's cache entry.
		expect(invocations).toBe(2);
	});

	it("fails open to unspecified when the cumulative response exceeds 1 MiB", async () => {
		scenario = { kind: "oversized" };
		const baseUrl = await startServer();
		expect(await fetchFor(baseUrl)).toBe("unspecified");
		// The stream was destroyed to stop consumption; the lease must be released.
		expect(h2Pool.__cursorH2PoolSnapshot().reduce((n, entry) => n + entry.outstanding, 0)).toBe(0);
	});

	it("bounds the cache at 8 entries (LRU) and prunes expired entries on write", async () => {
		scenario = { kind: "absent-directive" };
		const baseUrl = await startServer();
		// Insert 9 distinct keys (same baseUrl, distinct apiKeys). The cap is 8,
		// so the LRU evicts the oldest after the 9th insert.
		for (let i = 0; i < 9; i++) {
			await fetchCursorBidiAvailability({ apiKey: `key-${i}`, baseUrl });
		}
		expect(__cursorServerConfigCacheSize()).toBe(8);

		// Advance past the TTL so every existing entry is expired, then insert
		// one more. The write prunes all expired entries before setting the new
		// one, leaving exactly 1 entry.
		setSystemTime(new Date(Date.now() + 31_000));
		await fetchCursorBidiAvailability({ apiKey: `key-fresh`, baseUrl });
		expect(__cursorServerConfigCacheSize()).toBe(1);
	});
});

describe("acquireCursorH2 aborted acquisition", () => {
	beforeEach(async () => {
		await h2Pool.disposeCursorH2Pool();
	});

	afterEach(async () => {
		await h2Pool.disposeCursorH2Pool();
		await stopServer();
	});

	it("rejects an already-aborted acquisition before the pooled fast path", async () => {
		scenario = { kind: "bidi-disabled" };
		const baseUrl = await startServer();
		// Establish a session and return it to the pool so the next acquisition
		// hits the pooled fast path.
		const first = await h2Pool.acquireCursorH2({
			baseUrl,
			requestPath: GET_SERVER_CONFIG_PATH,
			headers: buildCursorUnaryHeaders({ apiKey: "test-token" }),
			provider: "cursor",
			signal: AbortSignal.timeout(5000),
		});
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		first.lease.release();
		// The pool now has a warm, non-draining entry. An already-aborted signal
		// must reject before issueLease runs, so no pooled lease is handed out.
		const controller = new AbortController();
		controller.abort();
		await expect(
			h2Pool.acquireCursorH2({
				baseUrl,
				requestPath: GET_SERVER_CONFIG_PATH,
				headers: buildCursorUnaryHeaders({ apiKey: "test-token" }),
				provider: "cursor",
				signal: controller.signal,
			}),
		).rejects.toBeInstanceOf(Error);
		// The pool entry must not have a lease outstanding.
		expect(h2Pool.__cursorH2PoolSnapshot().reduce((n, entry) => n + entry.outstanding, 0)).toBe(0);
	});
});

describe("fetchCursorBidiAvailability concurrent miss coalescing", () => {
	beforeEach(async () => {
		scenario = { kind: "absent-directive" };
		invocations = 0;
		await h2Pool.disposeCursorH2Pool();
		resetCursorServerConfigCache();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await h2Pool.disposeCursorH2Pool();
		await stopServer();
		setSystemTime();
	});

	it("coalesces concurrent misses onto one fetch and one published value", async () => {
		scenario = { kind: "bidi-disabled" };
		const baseUrl = await startServer();
		const [a, b] = await Promise.all([fetchFor(baseUrl), fetchFor(baseUrl)]);
		expect(a).toBe("bidi-disabled");
		expect(b).toBe("bidi-disabled");
		// Without coalescing, each caller would start its own wire request.
		expect(invocations).toBe(1);
	});
	it("keeps the shared fetch alive when the first caller aborts, so survivors get the real answer", async () => {
		const gate = Promise.withResolvers<void>();
		scenario = { kind: "gated", released: gate.promise };
		const baseUrl = await startServer();
		const controller = new AbortController();
		const abandoned = fetchFor(baseUrl, controller.signal);
		const survivor = fetchFor(baseUrl);
		// Both callers coalesced onto the one gated wire request. The first
		// caller's abort must abandon only its own wait — not cancel the shared
		// fetch, and not publish the abort as the cached answer.
		controller.abort();
		gate.resolve();
		expect(await abandoned).toBe("unspecified");
		expect(await survivor).toBe("bidi-disabled");
		expect(invocations).toBe(1);
		expect(await fetchFor(baseUrl)).toBe("bidi-disabled");
		expect(invocations).toBe(1);
	});
	it("does not republish a reset in-flight probe into the cache", async () => {
		const gate = Promise.withResolvers<void>();
		scenario = { kind: "gated", released: gate.promise };
		const baseUrl = await startServer();
		const stale = fetchFor(baseUrl);
		await waitFor(() => invocations === 1);
		resetCursorServerConfigCache();
		scenario = { kind: "all-disabled" };
		expect(await fetchFor(baseUrl)).toBe("all-disabled");
		gate.resolve();
		expect(await stale).toBe("bidi-disabled");
		expect(await fetchFor(baseUrl)).toBe("all-disabled");
		expect(invocations).toBe(2);
	});
});

describe("fetchCursorBidiAvailability HTTP/1 truncated response", () => {
	let h1Server: http.Server | undefined;

	beforeEach(async () => {
		await h2Pool.disposeCursorH2Pool();
		resetCursorServerConfigCache();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await h2Pool.disposeCursorH2Pool();
		if (h1Server) {
			const closing = h1Server;
			h1Server = undefined;
			const closed = Promise.withResolvers<void>();
			closing.close(error => (error ? closed.reject(error) : closed.resolve()));
			await closed.promise;
		}
	});

	it("rejects a valid envelope followed by trailing bytes as unspecified", async () => {
		// Force the H1 fallback path by mocking the h2 acquisition to fail ALPN.
		vi.spyOn(h2Pool, "acquireCursorH2").mockResolvedValue({
			ok: false,
			unavailable: {
				reason: "alpn",
				cause: Object.assign(new Error("h2 is not supported"), { code: "ERR_HTTP2_ERROR" }),
			},
		});
		h1Server = http.createServer((_req, res) => {
			const message = create(GetServerConfigResponseSchema, {
				http2Config: Http2Config.FORCE_BIDI_DISABLED,
			});
			const dataFrame = frameConnectMessage(toBinary(GetServerConfigResponseSchema, message));
			// Three trailing bytes that look like the start of a frame header
			// but never form a complete envelope — a truncated response.
			const truncated = Buffer.from([0x00, 0x00, 0x01]);
			res.writeHead(200, { "content-type": "application/proto" });
			res.end(Buffer.concat([dataFrame, truncated]));
		});
		const listening = Promise.withResolvers<void>();
		h1Server.once("error", listening.reject);
		h1Server.listen(0, "127.0.0.1", listening.resolve);
		await listening.promise;
		const address = h1Server.address();
		if (!address || typeof address === "string") throw new Error("expected h1 fixture to bind");
		const baseUrl = `http://127.0.0.1:${address.port}`;
		// A valid bidi-disabled envelope followed by truncated bytes must not
		// be treated as authoritative permission to downgrade.
		expect(await fetchFor(baseUrl)).toBe("unspecified");
	});

	it("accepts a valid envelope without end-of-stream as bidi-disabled", async () => {
		vi.spyOn(h2Pool, "acquireCursorH2").mockResolvedValue({
			ok: false,
			unavailable: {
				reason: "alpn",
				cause: Object.assign(new Error("h2 is not supported"), { code: "ERR_HTTP2_ERROR" }),
			},
		});
		h1Server = http.createServer((_req, res) => {
			const message = create(GetServerConfigResponseSchema, {
				http2Config: Http2Config.FORCE_BIDI_DISABLED,
			});
			// A single data frame with no end-of-stream envelope: a legitimate
			// unary HTTP/1 omission that must still be decoded as authoritative.
			const dataFrame = frameConnectMessage(toBinary(GetServerConfigResponseSchema, message));
			res.writeHead(200, { "content-type": "application/proto" });
			res.end(dataFrame);
		});
		const listening = Promise.withResolvers<void>();
		h1Server.once("error", listening.reject);
		h1Server.listen(0, "127.0.0.1", listening.resolve);
		await listening.promise;
		const address = h1Server.address();
		if (!address || typeof address === "string") throw new Error("expected h1 fixture to bind");
		const baseUrl = `http://127.0.0.1:${address.port}`;
		expect(await fetchFor(baseUrl)).toBe("bidi-disabled");
	});
});

describe("unary wire framing", () => {
	let h1Server: http.Server | undefined;

	beforeEach(async () => {
		await h2Pool.disposeCursorH2Pool();
		resetCursorServerConfigCache();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await h2Pool.disposeCursorH2Pool();
		await stopServer();
		if (h1Server) {
			const closing = h1Server;
			h1Server = undefined;
			const closed = Promise.withResolvers<void>();
			closing.close(error => (error ? closed.reject(error) : closed.resolve()));
			await closed.promise;
		}
	});

	it("sends the raw protobuf request and decodes a raw response over HTTP/2", async () => {
		// The fixture rejects a streaming-envelope request body with 400 and
		// answers with the bare protobuf message — both halves of the unary
		// Connect contract on one wire.
		scenario = { kind: "raw-unary" };
		const baseUrl = await startServer();
		expect(await fetchFor(baseUrl)).toBe("bidi-disabled");
	});

	it("sends the raw protobuf request over HTTP/1", async () => {
		// Force the H1 fallback path by mocking the h2 acquisition to fail ALPN.
		vi.spyOn(h2Pool, "acquireCursorH2").mockResolvedValue({
			ok: false,
			unavailable: {
				reason: "alpn",
				cause: Object.assign(new Error("h2 is not supported"), { code: "ERR_HTTP2_ERROR" }),
			},
		});
		h1Server = http.createServer((req, res) => {
			const parts: Buffer[] = [];
			req.on("data", (chunk: Buffer) => parts.push(chunk));
			req.on("end", () => {
				// A conforming unary request is the raw serialized message; the
				// streaming-envelope form of the empty request is five zero bytes
				// of invalid protobuf and must be rejected here.
				if (!isRawUnaryRequest(Buffer.concat(parts))) {
					res.statusCode = 400;
					res.end();
					return;
				}
				res.writeHead(200, { "content-type": "application/proto" });
				res.end(responseFrame({ http2Config: Http2Config.FORCE_BIDI_DISABLED }));
			});
		});
		const listening = Promise.withResolvers<void>();
		h1Server.once("error", listening.reject);
		h1Server.listen(0, "127.0.0.1", listening.resolve);
		await listening.promise;
		const address = h1Server.address();
		if (!address || typeof address === "string") throw new Error("expected h1 fixture to bind");
		const baseUrl = `http://127.0.0.1:${address.port}`;
		expect(await fetchFor(baseUrl)).toBe("bidi-disabled");
	});

	it("decodes a raw unary response over HTTP/1", async () => {
		vi.spyOn(h2Pool, "acquireCursorH2").mockResolvedValue({
			ok: false,
			unavailable: {
				reason: "alpn",
				cause: Object.assign(new Error("h2 is not supported"), { code: "ERR_HTTP2_ERROR" }),
			},
		});
		h1Server = http.createServer((_req, res) => {
			// The bare protobuf message with no envelope — the plain Connect
			// unary response shape. An envelope-only decoder fails open here.
			const message = create(GetServerConfigResponseSchema, {
				http2Config: Http2Config.FORCE_BIDI_DISABLED,
			});
			res.writeHead(200, { "content-type": "application/proto" });
			res.end(toBinary(GetServerConfigResponseSchema, message));
		});
		const listening = Promise.withResolvers<void>();
		h1Server.once("error", listening.reject);
		h1Server.listen(0, "127.0.0.1", listening.resolve);
		await listening.promise;
		const address = h1Server.address();
		if (!address || typeof address === "string") throw new Error("expected h1 fixture to bind");
		const baseUrl = `http://127.0.0.1:${address.port}`;
		expect(await fetchFor(baseUrl)).toBe("bidi-disabled");
	});
});

describe("HTTP/1 fallback provider proxy routing", () => {
	let proxyServer: http.Server | undefined;

	beforeEach(async () => {
		await h2Pool.disposeCursorH2Pool();
		resetCursorServerConfigCache();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await h2Pool.disposeCursorH2Pool();
		if (proxyServer) {
			const closing = proxyServer;
			proxyServer = undefined;
			const closed = Promise.withResolvers<void>();
			closing.close(error => (error ? closed.reject(error) : closed.resolve()));
			await closed.promise;
		}
	});

	it("routes the GetServerConfig HTTP/1 probe through the provider proxy", async () => {
		let proxiedRequests = 0;
		let forwardedTarget = "";
		proxyServer = http.createServer((req, res) => {
			proxiedRequests++;
			forwardedTarget = req.url ?? "";
			const message = create(GetServerConfigResponseSchema, {
				http2Config: Http2Config.FORCE_BIDI_DISABLED,
			});
			res.writeHead(200, { "content-type": "application/proto" });
			res.end(toBinary(GetServerConfigResponseSchema, message));
		});
		const listening = Promise.withResolvers<void>();
		proxyServer.once("error", listening.reject);
		proxyServer.listen(0, "127.0.0.1", listening.resolve);
		await listening.promise;
		const address = proxyServer.address();
		if (!address || typeof address === "string") throw new Error("expected proxy fixture to bind");
		vi.spyOn(proxy, "getProxyForUrl").mockReturnValue(`http://127.0.0.1:${address.port}`);
		vi.spyOn(h2Pool, "acquireCursorH2").mockResolvedValue({
			ok: false,
			unavailable: {
				reason: "alpn",
				cause: Object.assign(new Error("h2 is not supported"), { code: "ERR_HTTP2_ERROR" }),
			},
		});
		const baseUrl = "http://cursor-config-proxy-probe.invalid:1";
		expect(await fetchFor(baseUrl)).toBe("bidi-disabled");
		expect(proxiedRequests).toBe(1);
		expect(forwardedTarget).toContain(GET_SERVER_CONFIG_PATH);
	});
});

describe("caller header forwarding to the config probe", () => {
	const ROUTE_HEADER = { "x-gateway-route": "east" };
	let h1Server: http.Server | undefined;

	afterEach(async () => {
		vi.restoreAllMocks();
		await h2Pool.disposeCursorH2Pool();
		if (h1Server) {
			const closing = h1Server;
			h1Server = undefined;
			const closed = Promise.withResolvers<void>();
			closing.close(error => (error ? closed.reject(error) : closed.resolve()));
			await closed.promise;
		}
	});

	it("forwards caller headers on the HTTP/2 probe", async () => {
		scenario = { kind: "route-required" };
		const baseUrl = await startServer();
		// Without forwarding, the gateway rejects the probe (403) and the
		// availability collapses to "unspecified".
		expect(await fetchCursorBidiAvailability({ apiKey: "test-token", baseUrl, callerHeaders: ROUTE_HEADER })).toBe(
			"bidi-disabled",
		);
	});

	it("forwards the Run header set's caller fields through the HTTP/1 probe to open the bridge", async () => {
		// Force the ALPN failure that routes the probe to plain HTTP/1.
		vi.spyOn(h2Pool, "acquireCursorH2").mockResolvedValue({
			ok: false,
			unavailable: {
				reason: "alpn",
				cause: Object.assign(new Error("h2 is not supported"), { code: "ERR_HTTP2_ERROR" }),
			},
		});
		h1Server = http.createServer((req, res) => {
			if (req.headers["x-gateway-route"] !== "east") {
				res.statusCode = 403;
				res.end();
				return;
			}
			const message = create(GetServerConfigResponseSchema, {
				http2Config: Http2Config.FORCE_BIDI_DISABLED,
			});
			res.writeHead(200, { "content-type": "application/proto" });
			res.end(frameConnectMessage(toBinary(GetServerConfigResponseSchema, message)));
		});
		const listening = Promise.withResolvers<void>();
		h1Server.once("error", listening.reject);
		h1Server.listen(0, "127.0.0.1", listening.resolve);
		await listening.promise;
		const address = h1Server.address();
		if (!address || typeof address === "string") throw new Error("expected h1 fixture to bind");
		const baseUrl = `http://127.0.0.1:${address.port}`;
		// The Run header set carries the gateway's routing field among the caller
		// extras; without forwarding, the probe is rejected (403), availability
		// becomes "unspecified", and openCursorTransport throws instead of
		// returning the HTTP/1 bridge.
		const attempt = await openCursorTransport({
			baseUrl,
			apiKey: "test-token",
			requestPath: "/agent.v1.AgentService/Run",
			runHeaders: buildCursorRunHeaders({
				apiKey: "test-token",
				requestPath: "/agent.v1.AgentService/Run",
				callerHeaders: { "X-Gateway-Route": "east" },
				gzipRequest: false,
			}),
			gzipRequest: false,
			provider: "cursor",
		});
		attempt.close();
		await expect(attempt.trailers()).resolves.toEqual({});
	});

	it("does not reuse a cached directive across different caller header sets", async () => {
		// One endpoint, two routes distinguished only by the caller header: the
		// gateway serves route "east" a bidi-disabled directive and rejects every
		// other route value with 403 (→ unspecified). A cache key that omits the
		// headers hands route west east's directive — authorizing the HTTP/1
		// bridge for the wrong route.
		scenario = { kind: "route-required" };
		const baseUrl = await startServer();
		expect(
			await fetchCursorBidiAvailability({
				apiKey: "test-token",
				baseUrl,
				callerHeaders: { "x-gateway-route": "east" },
			}),
		).toBe("bidi-disabled");
		expect(
			await fetchCursorBidiAvailability({
				apiKey: "test-token",
				baseUrl,
				callerHeaders: { "x-gateway-route": "west" },
			}),
		).toBe("unspecified");
		// West made its own wire request; it was not served east's cache entry.
		expect(invocations).toBe(2);
	});

	it("does not coalesce concurrent callers with different caller header sets", async () => {
		scenario = { kind: "route-required" };
		const baseUrl = await startServer();
		const [east, west] = await Promise.all([
			fetchCursorBidiAvailability({ apiKey: "test-token", baseUrl, callerHeaders: { "x-gateway-route": "east" } }),
			fetchCursorBidiAvailability({ apiKey: "test-token", baseUrl, callerHeaders: { "x-gateway-route": "west" } }),
		]);
		// Coalescing onto one wire request would publish east's directive to
		// west — the wrong route authorized off one probe.
		expect(east).toBe("bidi-disabled");
		expect(west).toBe("unspecified");
		expect(invocations).toBe(2);
	});

	it("keys undefined and empty caller headers identically", async () => {
		scenario = { kind: "bidi-disabled" };
		const baseUrl = await startServer();
		expect(await fetchFor(baseUrl)).toBe("bidi-disabled");
		expect(await fetchCursorBidiAvailability({ apiKey: "test-token", baseUrl, callerHeaders: {} })).toBe(
			"bidi-disabled",
		);
		// Both hit the no-header cache entry: one wire request, not two.
		expect(invocations).toBe(1);
	});

	it("is insensitive to caller header insertion order in the cache key", async () => {
		scenario = { kind: "route-required" };
		const baseUrl = await startServer();
		expect(
			await fetchCursorBidiAvailability({
				apiKey: "test-token",
				baseUrl,
				callerHeaders: { "x-gateway-route": "east", "x-trace-id": "t1" },
			}),
		).toBe("bidi-disabled");
		expect(
			await fetchCursorBidiAvailability({
				apiKey: "test-token",
				baseUrl,
				callerHeaders: { "x-trace-id": "t1", "x-gateway-route": "east" },
			}),
		).toBe("bidi-disabled");
		// Same header set in a different insertion order: same key, one wire request.
		expect(invocations).toBe(1);
	});
});
