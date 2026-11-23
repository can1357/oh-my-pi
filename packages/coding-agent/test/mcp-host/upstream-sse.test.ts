import { afterEach, describe, expect, it } from "bun:test";
import { MCPTransportError } from "@oh-my-pi/pi-coding-agent/mcp/errors";
import type { McpRemoteSpec } from "@oh-my-pi/pi-coding-agent/mcp/host/contract";
import type { McpPeer } from "@oh-my-pi/pi-coding-agent/mcp/host/peer";
import { mcpUpstreams } from "@oh-my-pi/pi-coding-agent/mcp/host/peers";
import { SseUpstream } from "@oh-my-pi/pi-coding-agent/mcp/host/sse-upstream";
import { MCP_LEGACY_TTL_MS } from "@oh-my-pi/pi-coding-agent/mcp/host/store";
import { requestMeta } from "@oh-my-pi/pi-coding-agent/mcp/protocol";
import { isRetriableConnectionError } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import { withTimeout } from "@oh-my-pi/pi-utils";
import { rejectionOf } from "../helpers/rejection";
import { httpSpec, realDeps } from "./upstream-support";

type Frame = Record<string, unknown>;

const encoder = new TextEncoder();
const SSE = { headers: { "Content-Type": "text/event-stream" } };
/** Long enough for a hung promise to be a bug, short enough to fail fast. */
const SETTLE_MS = 2_000;

const servers: { stop(force: boolean): unknown }[] = [];
const peers: McpPeer[] = [];
const upstreams: SseUpstream[] = [];

afterEach(async () => {
	for (const peer of peers.splice(0)) await peer.close("test over");
	for (const upstream of upstreams.splice(0)) await upstream.close();
	for (const server of servers.splice(0)) await server.stop(true);
});

function sseSpec(url: string, overrides: Partial<McpRemoteSpec> = {}): McpRemoteSpec {
	return { ...httpSpec(url), transport: "sse", ...overrides };
}

function upstreamOf(spec: McpRemoteSpec): SseUpstream {
	const upstream = new SseUpstream(spec);
	upstreams.push(upstream);
	return upstream;
}

/** Whatever answers the GET that should open the event stream. */
function serveStream(open: (request: Request) => Response | Promise<Response>): string {
	const server = Bun.serve({ port: 0, idleTimeout: 0, fetch: open });
	servers.push(server);
	return `http://127.0.0.1:${server.port}/mcp/sse`;
}

interface SseServer {
	url: string;
	/** Path and query of every POST received. */
	targets: string[];
	/** Write one message to the event stream. */
	send(frame: Frame): void;
	/** End the event stream from the server's side. */
	end(): void;
}

/**
 * A 2024-11-05 server: its event stream announces the POST endpoint and
 * carries every answer. It completes the handshake itself; `answer` reacts to
 * every other request.
 */
function serveSse(answer: (request: Frame, server: SseServer) => void): SseServer {
	const endpoint = "/mcp/messages/?session_id=legacy-session";
	let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
	const server = Bun.serve({
		port: 0,
		idleTimeout: 0,
		async fetch(request) {
			const url = new URL(request.url);
			if (request.method === "GET") {
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							stream = controller;
							controller.enqueue(encoder.encode(`event: endpoint\ndata: ${endpoint}\n\n`));
						},
					}),
					SSE,
				);
			}
			handle.targets.push(`${url.pathname}${url.search}`);
			const body: Frame = JSON.parse(await request.text());
			if (body.method === "initialize") {
				handle.send({
					jsonrpc: "2.0",
					id: body.id,
					result: {
						protocolVersion: "2024-11-05",
						capabilities: { tools: {} },
						serverInfo: { name: "legacy-sse", version: "1.0.0" },
					},
				});
			} else if (body.id !== undefined) {
				answer(body, handle);
			}
			return new Response(null, { status: 202 });
		},
	});
	servers.push(server);
	const handle: SseServer = {
		url: `http://127.0.0.1:${server.port}/mcp/sse`,
		targets: [],
		send: frame => stream?.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(frame)}\n\n`)),
		end: () => stream?.close(),
	};
	return handle;
}

async function legacyPeer(server: SseServer): Promise<McpPeer> {
	const peer = await mcpUpstreams.start(sseSpec(server.url), "legacy", realDeps());
	peers.push(peer);
	return peer;
}

describe("HTTP+SSE upstream (2024-11-05)", () => {
	it("posts to the endpoint its event stream announces and takes the answers from the stream", async () => {
		const server = serveSse((request, self) =>
			self.send({
				jsonrpc: "2.0",
				id: request.id,
				result: { tools: [{ name: "crawl", inputSchema: { type: "object" } }] },
			}),
		);
		const peer = await legacyPeer(server);

		const list = await peer.request("tools/list", { _meta: requestMeta() });

		expect(list).toEqual({
			tools: [{ name: "crawl", inputSchema: { type: "object" } }],
			resultType: "complete",
			ttlMs: MCP_LEGACY_TTL_MS,
			cacheScope: "private",
		});
		// initialize, the initialized notification and the request: all to the announced endpoint, query included.
		const endpoint = "/mcp/messages/?session_id=legacy-session";
		expect(server.targets).toEqual([endpoint, endpoint, endpoint]);
	});

	it("delivers stream progress to its request only until that request is answered", async () => {
		const server = serveSse((request, self) => {
			if (request.method !== "tools/call") {
				self.send({ jsonrpc: "2.0", id: request.id, result: { tools: [] } });
				return;
			}
			const params = request.params;
			const meta = typeof params === "object" && params !== null && "_meta" in params ? params._meta : undefined;
			const token =
				typeof meta === "object" && meta !== null && "progressToken" in meta ? meta.progressToken : undefined;
			const progress = (progressToken: unknown, amount: number, message?: string) =>
				self.send({
					jsonrpc: "2.0",
					method: "notifications/progress",
					params: { progressToken, progress: amount, message },
				});
			progress(String(token), 99);
			progress(token, 1, "working");
			self.send({ jsonrpc: "2.0", id: request.id, result: { done: true } });
			progress(token, 2);
		});
		const peer = await legacyPeer(server);
		const progress: Record<string, unknown>[] = [];

		const result = await peer.request(
			"tools/call",
			{ name: "crawl", arguments: { steps: 1 }, _meta: requestMeta() },
			{ onProgress: update => progress.push(update) },
		);
		// Answered behind the late progress on the same stream.
		await peer.request("tools/list", { _meta: requestMeta() });

		expect(result).toEqual({ done: true, resultType: "complete" });
		expect(progress).toEqual([{ progress: 1, message: "working" }]);
	});

	it("fails the connect when no endpoint event arrives within the spec's bound", async () => {
		const url = serveStream(() => new Response(new ReadableStream<Uint8Array>(), SSE));
		const upstream = upstreamOf(sseSpec(url, { timeoutMs: 50 }));

		const error = await withTimeout(rejectionOf(upstream.connect()), SETTLE_MS, "the connect outlived its bound");

		expect(error).toBeInstanceOf(MCPTransportError);
		expect(error).toMatchObject({
			transport: "http",
			stage: "connect",
			failure: "timeout",
			message: "Legacy SSE endpoint timeout after 50ms",
		});
		expect(upstream.connected).toBe(false);
	});

	it("ends the wait for the endpoint event on the caller's signal, and the GET with it, when no bound is set", async () => {
		const requested = Promise.withResolvers<void>();
		const cancelled = Promise.withResolvers<void>();
		const url = serveStream(request => {
			requested.resolve();
			request.signal.addEventListener("abort", () => cancelled.resolve(), { once: true });
			return new Response(new ReadableStream<Uint8Array>(), SSE);
		});
		const upstream = upstreamOf(sseSpec(url, { timeoutMs: 0 }));
		const caller = new AbortController();
		const reason = new Error("nobody is waiting");
		const connecting = rejectionOf(upstream.connect(caller.signal));
		await requested.promise;

		caller.abort(reason);

		expect(await withTimeout(connecting, SETTLE_MS, "the connect ignored the abort")).toBe(reason);
		await withTimeout(cancelled.promise, SETTLE_MS, "the GET outlived the abort");
	});

	it("refuses an endpoint on another origin, where the configured credentials would be sent", async () => {
		const url = serveStream(
			() => new Response("event: endpoint\ndata: https://attacker.example/mcp/messages/?session_id=stolen\n\n", SSE),
		);
		const upstream = upstreamOf(sseSpec(url, { headers: { Authorization: "Bearer secret" } }));

		const error = await rejectionOf(upstream.connect());

		expect(error).toBeInstanceOf(MCPTransportError);
		expect(error).toMatchObject({
			message: `Legacy SSE endpoint origin mismatch: expected ${new URL(url).origin}, received https://attacker.example`,
		});
		expect(upstream.connected).toBe(false);
	});

	it("fails a request the server accepted as not replayable when the stream closes, and reports the session gone", async () => {
		const server = serveSse((_request, self) => self.end());
		const peer = await legacyPeer(server);

		const error = await rejectionOf(peer.request("tools/list", { _meta: requestMeta() }));

		expect(error).toBeInstanceOf(MCPTransportError);
		expect(error).toMatchObject({
			transport: "http",
			stage: "receive",
			failure: "closed",
			message: "Transport closed: legacy SSE stream closed",
			retryable: false,
		});
		expect(isRetriableConnectionError(error)).toBe(false);
		// The session lived on that stream: the unit must start a new peer.
		expect(await withTimeout(peer.closed, SETTLE_MS, "the peer outlived its stream")).toEqual({ stderr: "" });
	});

	it("does not offer a request for replay when its POST connection closes after it was sent", async () => {
		// Raw TCP: the GET announces the endpoint, then every POST connection is closed once its request arrived.
		const listener = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				data(socket, chunk) {
					if (chunk.toString().startsWith("GET ")) {
						socket.write(
							"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\n\r\nevent: endpoint\ndata: /messages\n\n",
						);
					} else {
						socket.end();
					}
				},
			},
		});
		servers.push(listener);
		const upstream = upstreamOf(sseSpec(`http://127.0.0.1:${listener.port}/sse`));
		await upstream.connect();

		const error = await rejectionOf(upstream.request("tools/call", { name: "write" }));

		expect(error).toBeInstanceOf(MCPTransportError);
		if (!(error instanceof MCPTransportError)) return;
		expect(error).toMatchObject({ transport: "http", stage: "send", retryable: false });
		expect(["reset", "eof"]).toContain(error.failure);
		expect(isRetriableConnectionError(error)).toBe(false);
	});

	it("keeps a server error that mentions a fetch failure a server error, not a lost connection", async () => {
		const server = serveSse((request, self) =>
			self.send({
				jsonrpc: "2.0",
				id: request.id,
				error: { code: -32603, message: "fetch failed inside the tool" },
			}),
		);
		const peer = await legacyPeer(server);

		const error = await rejectionOf(peer.request("tools/list", { _meta: requestMeta() }));

		expect(error).toBeInstanceOf(MCPTransportError);
		expect(error).toMatchObject({
			transport: "http",
			stage: "protocol",
			failure: "json_rpc",
			retryable: false,
			code: -32603,
			message: "MCP error -32603: fetch failed inside the tool",
		});
		expect(isRetriableConnectionError(error)).toBe(false);
	});

	it("ends every POST the server is still holding when the upstream closes", async () => {
		// The answers travel on the GET stream, so nothing but close() knows about a POST a server sits on.
		const arrived = Promise.withResolvers<void>();
		const server = Bun.serve({
			port: 0,
			idleTimeout: 0,
			async fetch(request) {
				if (request.method === "GET") {
					return new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								controller.enqueue(encoder.encode("event: endpoint\ndata: /messages\n\n"));
							},
						}),
						SSE,
					);
				}
				await request.text();
				arrived.resolve();
				return Promise.withResolvers<Response>().promise;
			},
		});
		servers.push(server);
		const upstream = upstreamOf(sseSpec(`http://127.0.0.1:${server.port}/sse`, { timeoutMs: 0 }));
		await upstream.connect();
		const notified = rejectionOf(upstream.notify("notifications/initialized"));
		const requested = rejectionOf(upstream.request("tools/call"));
		await arrived.promise;

		await upstream.close();

		expect(await withTimeout(notified, SETTLE_MS, "the notification outlived close()")).toMatchObject({
			name: "AbortError",
		});
		expect(await withTimeout(requested, SETTLE_MS, "the request outlived close()")).toMatchObject({
			name: "AbortError",
		});
	});
});
