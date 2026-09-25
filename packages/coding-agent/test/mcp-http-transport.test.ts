import { afterEach, describe, expect, it, vi } from "bun:test";
import { connectToServer } from "@oh-my-pi/pi-coding-agent/mcp/client";
import { MCPTransportError } from "@oh-my-pi/pi-coding-agent/mcp/errors";
import { HttpTransport } from "@oh-my-pi/pi-coding-agent/mcp/transports/http";
import { postmortem } from "@oh-my-pi/pi-utils";

const encoder = new TextEncoder();
const REQUEST_TIMEOUT_MS = 50;
const GUARD_TIMEOUT_MS = 500;

let server: Bun.Server<undefined> | null = null;

type ToolList = {
	tools: { name: string; inputSchema: { type: string } }[];
};

afterEach(() => {
	server?.stop(true);
	server = null;
});

async function connectedTransport(timeout = REQUEST_TIMEOUT_MS): Promise<HttpTransport> {
	if (!server) throw new Error("Test server was not started");
	const transport = new HttpTransport({
		type: "http",
		url: `http://127.0.0.1:${server.port}/mcp`,
		timeout,
	});
	await transport.connect();
	return transport;
}

function stalledBodyResponse(bodyPrefix: string, init?: ResponseInit): Response {
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(bodyPrefix));
			},
		}),
		init,
	);
}

// Real time is intentional: this exercises Bun fetch aborting a live HTTP body stream,
// which fake timers do not drive through the socket/readable-stream stack.
async function withPendingGuard<T>(promise: Promise<T>, label: string): Promise<T> {
	return await Promise.race([
		promise,
		Bun.sleep(GUARD_TIMEOUT_MS).then(() => {
			throw new Error(`${label} stayed pending past ${GUARD_TIMEOUT_MS}ms`);
		}),
	]);
}

describe("MCP Streamable HTTP initialization", () => {
	it("sends initialized before opening the optional GET SSE stream", async () => {
		const requests: string[] = [];
		let initialized = false;
		let sessionValid = true;
		server = Bun.serve({
			port: 0,
			async fetch(req) {
				if (req.method === "GET") {
					requests.push("GET");
					if (initialized) return new Response(null, { status: 405 });
					sessionValid = false;
					return new Response("session is not initialized", { status: 400 });
				}
				if (req.method === "DELETE") return new Response(null, { status: 204 });

				const body = (await req.json()) as { id?: string | number; method: string };
				requests.push(body.method);
				if (body.method === "initialize") {
					const response = {
						jsonrpc: "2.0",
						id: body.id,
						result: {
							protocolVersion: "2025-11-25",
							capabilities: {},
							serverInfo: { name: "session-order", version: "1.0.0" },
						},
					};
					return new Response(`event: message\ndata: ${JSON.stringify(response)}\n\n`, {
						headers: {
							"Content-Type": "text/event-stream",
							"Mcp-Session-Id": "session-order",
						},
					});
				}
				if (!sessionValid) return new Response("session terminated", { status: 409 });
				initialized = true;
				return new Response(null, { status: 202 });
			},
		});

		const connection = await connectToServer("session-order", {
			type: "http",
			url: `http://127.0.0.1:${server.port}/mcp`,
			timeout: GUARD_TIMEOUT_MS,
		});

		expect(requests).toEqual(["initialize", "notifications/initialized", "GET"]);
		await connection.transport.close();
	});
});

describe("MCP Streamable HTTP failure diagnostics", () => {
	it("classifies an abrupt socket reset without leaking Bun fetch advice", async () => {
		const tcp = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				open(socket) {
					socket.end();
				},
				data() {},
			},
		});
		const transport = new HttpTransport({
			type: "http",
			url: `http://127.0.0.1:${tcp.port}/mcp`,
			timeout: GUARD_TIMEOUT_MS,
		});
		try {
			await transport.connect();
			const error = await transport.request("tools/list").then(
				() => undefined,
				reason => reason,
			);
			if (!(error instanceof MCPTransportError)) throw error;
			expect(error).toMatchObject({
				transport: "http",
				stage: "send",
				failure: "reset",
				retryable: true,
				code: "ECONNRESET",
			});
			expect(error.message).not.toContain("verbose");
		} finally {
			await transport.close();
			tcp.stop(true);
		}
	});

	it("distinguishes connection refusal from a reset", async () => {
		const unused = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: { data() {} },
		});
		const port = unused.port;
		unused.stop(true);
		const transport = new HttpTransport({
			type: "http",
			url: `http://127.0.0.1:${port}/mcp`,
			timeout: GUARD_TIMEOUT_MS,
		});
		await transport.connect();

		await expect(transport.request("tools/list")).rejects.toMatchObject({
			transport: "http",
			stage: "connect",
			failure: "connect",
			retryable: true,
		});
		await transport.close();
	});

	it("classifies malformed JSON-RPC responses at the decode stage", async () => {
		server = Bun.serve({
			port: 0,
			fetch() {
				return new Response("{not-json", { headers: { "Content-Type": "application/json" } });
			},
		});
		const transport = await connectedTransport();

		await expect(transport.request("tools/list")).rejects.toMatchObject({
			transport: "http",
			stage: "decode",
			failure: "malformed_response",
			retryable: false,
		});
	});

	it("preserves bounded redacted JSON-RPC data and a response trace ID", async () => {
		server = Bun.serve({
			port: 0,
			async fetch(req) {
				const body = (await req.json()) as { id: string | number };
				return Response.json(
					{
						jsonrpc: "2.0",
						id: body.id,
						error: {
							code: -32042,
							message: "upstream rejected the call",
							data: { detail: "x".repeat(3_000), token: "server-secret", traceId: "data-trace" },
						},
					},
					{ headers: { "X-Request-Id": "request-abc123" } },
				);
			},
		});
		const transport = await connectedTransport();
		const error = await transport.request("tools/list").then(
			() => undefined,
			reason => reason,
		);
		if (!(error instanceof MCPTransportError)) throw error;

		expect(error).toMatchObject({
			transport: "http",
			stage: "protocol",
			failure: "json_rpc",
			retryable: false,
			code: -32042,
			traceId: "request-abc123",
		});
		expect(error.data?.length).toBeLessThanOrEqual(2_000);
		expect(error.data).toContain("[redacted]");
		expect(error.data).not.toContain("server-secret");
	});
});

describe("MCP Streamable HTTP transport timeouts", () => {
	it("keeps the request timeout active until a JSON response body is fully read", async () => {
		server = Bun.serve({
			port: 0,
			fetch() {
				return stalledBodyResponse('{"jsonrpc":"2.0","id":"', {
					headers: { "Content-Type": "application/json" },
				});
			},
		});
		const transport = await connectedTransport();

		await expect(withPendingGuard(transport.request("tools/list"), "request")).rejects.toMatchObject({
			transport: "http",
			stage: "decode",
			failure: "timeout",
			retryable: false,
			message: `Request timeout after ${REQUEST_TIMEOUT_MS}ms`,
		});
	});

	it("uses one deadline across delayed SSE headers and a stalled response body", async () => {
		// Real time is required here: fake timers do not drive Bun's fetch/socket
		// abort path, and elapsed time is the end-to-end contract under test.
		const timeoutMs = 250;
		const headerDelayMs = 160;
		server = Bun.serve({
			port: 0,
			async fetch() {
				await Bun.sleep(headerDelayMs);
				return stalledBodyResponse(": accepted\n\n", {
					headers: { "Content-Type": "text/event-stream" },
				});
			},
		});
		const transport = await connectedTransport(timeoutMs);
		const startedAt = performance.now();

		try {
			await expect(withPendingGuard(transport.request("tools/list"), "SSE request")).rejects.toMatchObject({
				transport: "http",
				stage: "receive",
				failure: "timeout",
				retryable: false,
			});
			expect(performance.now() - startedAt).toBeLessThan(timeoutMs + 100);
		} finally {
			await transport.close();
		}
	});

	it("keeps the timeout result when the caller aborts before the JSON body rejection propagates", async () => {
		vi.useFakeTimers();
		const caller = new AbortController();
		const originalFetch = globalThis.fetch;
		const jsonStarted = Promise.withResolvers<void>();
		globalThis.fetch = (async (_input, init) => {
			const response = new Response(null, { headers: { "Content-Type": "application/json" } });
			Object.assign(response, {
				json: () => {
					const { promise, reject } = Promise.withResolvers<unknown>();
					const rejectBodyRead = () => {
						caller.abort();
						reject(new SyntaxError("Unexpected end of JSON input"));
					};
					if (init?.signal?.aborted) rejectBodyRead();
					else init?.signal?.addEventListener("abort", rejectBodyRead, { once: true });
					jsonStarted.resolve();
					return promise;
				},
			});
			return response;
		}) as typeof globalThis.fetch;
		try {
			const transport = new HttpTransport({
				type: "http",
				url: "http://mcp.invalid",
				timeout: REQUEST_TIMEOUT_MS,
			});
			await transport.connect();
			const request = transport.request("tools/list", undefined, { signal: caller.signal });
			await jsonStarted.promise;
			vi.advanceTimersByTime(REQUEST_TIMEOUT_MS);

			await expect(request).rejects.toThrow(`Request timeout after ${REQUEST_TIMEOUT_MS}ms`);
		} finally {
			globalThis.fetch = originalFetch;
			vi.useRealTimers();
		}
	});

	it("does not report a timeout when caller cancellation wins a delayed JSON body rejection", async () => {
		vi.useFakeTimers();
		const caller = new AbortController();
		const originalFetch = globalThis.fetch;
		const jsonStarted = Promise.withResolvers<void>();
		globalThis.fetch = (async (_input, init) => {
			const response = new Response(null, { headers: { "Content-Type": "application/json" } });
			Object.assign(response, {
				json: () => {
					const { promise, reject } = Promise.withResolvers<unknown>();
					init?.signal?.addEventListener(
						"abort",
						() => {
							setTimeout(() => reject(new SyntaxError("Unexpected end of JSON input")), REQUEST_TIMEOUT_MS + 20);
						},
						{ once: true },
					);
					jsonStarted.resolve();
					return promise;
				},
			});
			return response;
		}) as typeof globalThis.fetch;
		try {
			const transport = new HttpTransport({
				type: "http",
				url: "http://mcp.invalid",
				timeout: REQUEST_TIMEOUT_MS,
			});
			await transport.connect();
			const request = transport.request("tools/list", undefined, { signal: caller.signal });
			await jsonStarted.promise;
			caller.abort();
			vi.advanceTimersByTime(REQUEST_TIMEOUT_MS + 20);

			await expect(request).rejects.toThrow("Unexpected end of JSON input");
		} finally {
			globalThis.fetch = originalFetch;
			vi.useRealTimers();
		}
	});

	it("keeps the notify timeout active while reading HTTP error bodies", async () => {
		server = Bun.serve({
			port: 0,
			fetch() {
				return stalledBodyResponse("partial failure body", {
					status: 500,
					headers: { "Content-Type": "text/plain" },
				});
			},
		});
		const transport = await connectedTransport();

		await expect(withPendingGuard(transport.notify("notifications/initialized"), "notify")).rejects.toThrow(
			`Notify timeout after ${REQUEST_TIMEOUT_MS}ms`,
		);
	});

	it("still resolves normal JSON response bodies", async () => {
		server = Bun.serve({
			port: 0,
			fetch() {
				return Response.json({
					jsonrpc: "2.0",
					id: 1,
					result: { tools: [{ name: "fast", inputSchema: { type: "object" } }] },
				});
			},
		});
		const transport = await connectedTransport();

		await expect(withPendingGuard(transport.request<ToolList>("tools/list"), "request")).resolves.toEqual({
			tools: [{ name: "fast", inputSchema: { type: "object" } }],
		});
	});

	it("close aborts and drains an in-flight SSE POST request", async () => {
		const requestReceived = Promise.withResolvers<void>();
		server = Bun.serve({
			port: 0,
			fetch() {
				requestReceived.resolve();
				return stalledBodyResponse("", {
					headers: { "Content-Type": "text/event-stream" },
				});
			},
		});
		if (!server) throw new Error("Test server was not started");
		const transport = new HttpTransport({
			type: "http",
			url: `http://127.0.0.1:${server.port}/mcp`,
			timeout: GUARD_TIMEOUT_MS,
		});
		await transport.connect();

		const request = transport.request("tools/list");
		await requestReceived.promise;
		const closing = transport.close();

		const requestError = await withPendingGuard(request, "aborted request").then(
			() => undefined,
			error => error,
		);
		expect(requestError).toMatchObject({ name: "AbortError" });
		expect(postmortem.isExpectedCleanupError(requestError)).toBe(true);
		await withPendingGuard(closing, "transport close");
	});

	it("preserves caller cancellation when it wins a stalled SSE response", async () => {
		const requestReceived = Promise.withResolvers<void>();
		const caller = new AbortController();
		server = Bun.serve({
			port: 0,
			fetch() {
				requestReceived.resolve();
				return stalledBodyResponse(": accepted\n\n", {
					headers: { "Content-Type": "text/event-stream" },
				});
			},
		});
		const transport = await connectedTransport(GUARD_TIMEOUT_MS);

		try {
			const request = transport.request("tools/list", undefined, { signal: caller.signal });
			await requestReceived.promise;
			const nextTurn = Promise.withResolvers<void>();
			setImmediate(nextTurn.resolve);
			await nextTurn.promise;
			caller.abort();

			const error = await withPendingGuard(request, "caller-aborted SSE request").then(
				() => undefined,
				reason => reason,
			);
			expect(error).toMatchObject({ name: "AbortError" });
			expect(error).not.toBeInstanceOf(MCPTransportError);
		} finally {
			await transport.close();
		}
	});

	it("keeps draining an accepted request stream after its caller aborts", async () => {
		const caller = new AbortController();
		const notificationReceived = Promise.withResolvers<void>();
		const sendNotification = Promise.withResolvers<void>();
		server = Bun.serve({
			port: 0,
			async fetch(req) {
				const body = (await req.json()) as { id: string | number };
				let cancelled = false;
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(
								encoder.encode(`data: {"jsonrpc":"2.0","id":${JSON.stringify(body.id)},"result":{}}\n\n`),
							);
							void sendNotification.promise.then(() => {
								if (cancelled) return;
								try {
									controller.enqueue(
										encoder.encode('data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n'),
									);
									controller.close();
								} catch {
									// The negative path intentionally cancels the client stream.
								}
							});
						},
						cancel() {
							cancelled = true;
						},
					}),
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			},
		});
		const transport = await connectedTransport(GUARD_TIMEOUT_MS);
		transport.onNotification = method => {
			if (method === "notifications/progress") notificationReceived.resolve();
		};

		try {
			await transport.request("tools/list", undefined, { signal: caller.signal });
			caller.abort();
			sendNotification.resolve();
			await withPendingGuard(notificationReceived.promise, "post-response notification");
		} finally {
			await transport.close();
		}
	});

	it("keeps draining an accepted notification stream past the POST deadline", async () => {
		const notificationReceived = Promise.withResolvers<void>();
		const sendNotification = Promise.withResolvers<void>();
		server = Bun.serve({
			port: 0,
			fetch() {
				let cancelled = false;
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(encoder.encode(": accepted\n\n"));
							void sendNotification.promise.then(() => {
								if (cancelled) return;
								try {
									controller.enqueue(
										encoder.encode('data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n'),
									);
									controller.close();
								} catch {
									// The negative path intentionally cancels the client stream.
								}
							});
						},
						cancel() {
							cancelled = true;
						},
					}),
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			},
		});
		const transport = await connectedTransport();
		transport.onNotification = method => {
			if (method === "notifications/progress") notificationReceived.resolve();
		};

		try {
			await transport.notify("notifications/initialized");
			// Let the former read timeout expire on the real fetch/body stream,
			// then prove the accepted response remains owned by the transport.
			await Bun.sleep(REQUEST_TIMEOUT_MS * 2);
			sendNotification.resolve();
			await withPendingGuard(notificationReceived.promise, "notification response drain");
		} finally {
			await transport.close();
		}
	});

	it("keeps an abandoned SSE request rejection observed after caller cancellation", async () => {
		const requestReceived = Promise.withResolvers<void>();
		const caller = new AbortController();
		server = Bun.serve({
			port: 0,
			fetch() {
				requestReceived.resolve();
				return stalledBodyResponse("", {
					headers: { "Content-Type": "text/event-stream" },
				});
			},
		});
		const transport = await connectedTransport();
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			void transport.request("tools/list", undefined, { signal: caller.signal });
			await requestReceived.promise;
			caller.abort();
			const nextTurn = Promise.withResolvers<void>();
			setImmediate(nextTurn.resolve);
			await nextTurn.promise;

			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
			await transport.close();
		}
	});
});

describe("MCP Streamable HTTP protocol version header", () => {
	it("omits MCP-Protocol-Version until the version is negotiated", async () => {
		const seen: { version: string | null; present: boolean } = { version: null, present: true };
		server = Bun.serve({
			port: 0,
			fetch(req) {
				seen.present = req.headers.has("MCP-Protocol-Version");
				seen.version = req.headers.get("MCP-Protocol-Version");
				return Response.json({ jsonrpc: "2.0", id: 1, result: {} });
			},
		});
		const transport = await connectedTransport();

		// No setProtocolVersion yet: this stands in for the initialize request,
		// which must not carry the header before negotiation completes.
		await withPendingGuard(transport.request("initialize"), "request");
		expect(seen.present).toBe(false);
		expect(seen.version).toBeNull();
	});

	it("echoes the negotiated version on requests after setProtocolVersion", async () => {
		const seen: { version: string | null } = { version: null };
		server = Bun.serve({
			port: 0,
			fetch(req) {
				seen.version = req.headers.get("MCP-Protocol-Version");
				return Response.json({ jsonrpc: "2.0", id: 1, result: {} });
			},
		});
		const transport = await connectedTransport();
		transport.setProtocolVersion("2025-06-18");

		await withPendingGuard(transport.request("tools/list"), "request");
		expect(seen.version).toBe("2025-06-18");
	});

	it("never lets a configured MCP-Protocol-Version reach the server", async () => {
		const seen: { pre: string | null; post: string | null } = { pre: null, post: null };
		server = Bun.serve({
			port: 0,
			fetch(req) {
				const body = req.headers.get("MCP-Protocol-Version");
				return Response.json({ jsonrpc: "2.0", id: 1, result: { seen: body } });
			},
		});
		if (!server) throw new Error("Test server was not started");
		const transport = new HttpTransport({
			type: "http",
			url: `http://127.0.0.1:${server.port}/mcp`,
			timeout: REQUEST_TIMEOUT_MS,
			headers: { "MCP-Protocol-Version": "1999-01-01" },
		});
		await transport.connect();

		// Pre-negotiation: configured header must be stripped, not leaked.
		seen.pre = await withPendingGuard(transport.request<{ seen: string | null }>("initialize"), "request").then(
			r => r.seen,
		);
		// Post-negotiation: the negotiated version wins over the configured one.
		transport.setProtocolVersion("2025-11-25");
		seen.post = await withPendingGuard(transport.request<{ seen: string | null }>("tools/list"), "request").then(
			r => r.seen,
		);

		expect(seen.pre).toBeNull();
		expect(seen.post).toBe("2025-11-25");
	});
});

describe("MCP Streamable HTTP POST response resumption", () => {
	it("reports a timeout when a resumed HTTP error body stalls", async () => {
		let posts = 0;
		server = Bun.serve({
			port: 0,
			fetch(req) {
				if (req.method === "POST") {
					posts++;
					return new Response("id: stream-1\nretry: 0\ndata:\n\n", {
						headers: { "Content-Type": "text/event-stream" },
					});
				}
				return stalledBodyResponse("unavailable", { status: 503 });
			},
		});
		const transport = await connectedTransport();
		try {
			await expect(
				withPendingGuard(transport.request("tools/call"), "stalled resume error body"),
			).rejects.toMatchObject({
				failure: "timeout",
				retryable: false,
			});
			expect(posts).toBe(1);
		} finally {
			await transport.close();
		}
	});

	it("bounds resumed-stream auth refresh by the original request deadline", async () => {
		const refresh = Promise.withResolvers<Record<string, string> | null>();
		let posts = 0;
		server = Bun.serve({
			port: 0,
			fetch(req) {
				if (req.method === "POST") {
					posts++;
					return new Response("id: stream-1\nretry: 0\ndata:\n\n", {
						headers: { "Content-Type": "text/event-stream" },
					});
				}
				return new Response("expired", { status: 401 });
			},
		});
		const transport = await connectedTransport();
		transport.onAuthError = () => refresh.promise;
		try {
			await expect(
				withPendingGuard(transport.request("tools/call"), "stalled resume auth refresh"),
			).rejects.toMatchObject({
				failure: "timeout",
				retryable: false,
			});
			expect(posts).toBe(1);
		} finally {
			refresh.resolve(null);
			await transport.close();
		}
	});

	it("resumes a closed response stream with Last-Event-ID after the requested retry delay", async () => {
		const observed: {
			lastEventId: string | null;
			protocolVersion: string | null;
			postClosedAt: number;
			resumedAt: number;
		} = { lastEventId: null, protocolVersion: null, postClosedAt: 0, resumedAt: 0 };
		server = Bun.serve({
			port: 0,
			fetch(req) {
				if (req.method === "POST") {
					observed.postClosedAt = performance.now();
					return new Response("id: stream-1\nretry: 20\ndata:\n\n", {
						headers: { "Content-Type": "text/event-stream" },
					});
				}
				observed.resumedAt = performance.now();
				observed.lastEventId = req.headers.get("Last-Event-ID");
				observed.protocolVersion = req.headers.get("MCP-Protocol-Version");
				return new Response(
					'id: stream-2\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"resumed","inputSchema":{"type":"object"}}]}}\n\n',
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			},
		});
		if (!server) throw new Error("Test server was not started");
		const transport = new HttpTransport({
			type: "http",
			url: `http://127.0.0.1:${server.port}/mcp`,
			timeout: GUARD_TIMEOUT_MS,
		});
		await transport.connect();
		transport.setProtocolVersion("2025-11-25");

		await expect(withPendingGuard(transport.request<ToolList>("tools/list"), "request")).resolves.toEqual({
			tools: [{ name: "resumed", inputSchema: { type: "object" } }],
		});
		expect(observed.lastEventId).toBe("stream-1");
		expect(observed.protocolVersion).toBe("2025-11-25");
		expect(observed.resumedAt - observed.postClosedAt).toBeGreaterThanOrEqual(15);
	});
	it("refreshes auth on a 401 resume GET without replaying the POST", async () => {
		const observed = { posts: 0, gets: 0, auth: [] as (string | null)[], lastEventId: null as string | null };
		server = Bun.serve({
			port: 0,
			fetch(req) {
				if (req.method === "POST") {
					observed.posts++;
					return new Response("id: stream-1\nretry: 10\ndata:\n\n", {
						headers: { "Content-Type": "text/event-stream" },
					});
				}
				observed.gets++;
				observed.auth.push(req.headers.get("Authorization"));
				observed.lastEventId = req.headers.get("Last-Event-ID");
				if (req.headers.get("Authorization") !== "Bearer fresh") {
					return new Response("expired", { status: 401 });
				}
				return new Response(
					'id: stream-2\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"resumed","inputSchema":{"type":"object"}}]}}\n\n',
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			},
		});
		if (!server) throw new Error("Test server was not started");
		const transport = new HttpTransport({
			type: "http",
			url: `http://127.0.0.1:${server.port}/mcp`,
			timeout: GUARD_TIMEOUT_MS,
			headers: { Authorization: "Bearer stale" },
		});
		transport.onAuthError = async () => ({ Authorization: "Bearer fresh" });
		await transport.connect();

		await expect(withPendingGuard(transport.request<ToolList>("tools/list"), "request")).resolves.toEqual({
			tools: [{ name: "resumed", inputSchema: { type: "object" } }],
		});
		// One POST only: replaying it after the server accepted the request
		// could double-execute a state-changing tool.
		expect(observed.posts).toBe(1);
		expect(observed.gets).toBe(2);
		expect(observed.auth).toEqual(["Bearer stale", "Bearer fresh"]);
		expect(observed.lastEventId).toBe("stream-1");
	});

	it("never replays the POST when a resume GET stays unauthorized", async () => {
		const observed = { posts: 0, gets: 0, refreshes: 0 };
		server = Bun.serve({
			port: 0,
			fetch(req) {
				if (req.method === "POST") {
					observed.posts++;
					return new Response("id: stream-1\nretry: 10\ndata:\n\n", {
						headers: { "Content-Type": "text/event-stream" },
					});
				}
				observed.gets++;
				return new Response("expired", { status: 401 });
			},
		});
		if (!server) throw new Error("Test server was not started");
		const transport = new HttpTransport({
			type: "http",
			url: `http://127.0.0.1:${server.port}/mcp`,
			timeout: GUARD_TIMEOUT_MS,
			headers: { Authorization: "Bearer stale" },
		});
		// A live refresh would tempt #requestWithAuthRetry to re-POST if the
		// SSEResumeError identity were lost during normalization.
		transport.onAuthError = async () => {
			observed.refreshes++;
			return { Authorization: "Bearer fresh" };
		};
		await transport.connect();

		await expect(withPendingGuard(transport.request("tools/call"), "request")).rejects.toBeDefined();
		// The server accepted the POST once; auth refresh happens inside the resume
		// GET only, and the originating POST is never replayed.
		expect(observed.posts).toBe(1);
		expect(observed.gets).toBe(2);
		expect(observed.refreshes).toBe(1);
	});
	it("marks a clean accepted SSE EOF without an event ID as non-replayable", async () => {
		let posts = 0;
		server = Bun.serve({
			port: 0,
			fetch() {
				posts++;
				return new Response("", { headers: { "Content-Type": "text/event-stream" } });
			},
		});
		const transport = await connectedTransport();

		await expect(withPendingGuard(transport.request("tools/call"), "request")).rejects.toMatchObject({
			transport: "http",
			stage: "receive",
			failure: "eof",
			retryable: false,
		});
		expect(posts).toBe(1);
	});
});

describe("MCP Streamable HTTP GET listener resumption", () => {
	it("resumes the long-lived GET stream with Last-Event-ID instead of reconnecting", async () => {
		const observed = { gets: 0, lastEventIds: [] as (string | null)[] };
		server = Bun.serve({
			port: 0,
			fetch(req) {
				if (req.method !== "GET") {
					return Response.json({ jsonrpc: "2.0", id: 1, result: {} });
				}
				observed.gets++;
				observed.lastEventIds.push(req.headers.get("Last-Event-ID"));
				if (observed.gets === 1) {
					// Polling-style server: deliver one notification with an
					// event ID, then close the physical connection.
					return new Response(
						'id: poll-1\nretry: 10\ndata: {"jsonrpc":"2.0","method":"notifications/first"}\n\n',
						{ headers: { "Content-Type": "text/event-stream" } },
					);
				}
				const response = new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(
								encoder.encode('id: poll-2\ndata: {"jsonrpc":"2.0","method":"notifications/second"}\n\n'),
							);
							// Held open: the logical stream continues.
						},
					}),
					{ headers: { "Content-Type": "text/event-stream" } },
				);
				return response;
			},
		});
		// This is a resumption test, not a deadline test. The 50ms request
		// fixture above gives the optional GET only 12ms to connect, so a busy
		// runner can abort it before any stream exists to resume.
		const transport = await connectedTransport(0);
		const notifications: string[] = [];
		let closed = false;
		const secondNotification = Promise.withResolvers<void>();
		transport.onNotification = method => {
			notifications.push(method);
			if (notifications.length === 2) secondNotification.resolve();
		};
		transport.onError = error => secondNotification.reject(error);
		transport.onClose = () => {
			closed = true;
			secondNotification.reject(new Error("Logical SSE listener closed before the resumed notification"));
		};

		try {
			await transport.startSSEListener();
			await secondNotification.promise;

			expect(notifications).toEqual(["notifications/first", "notifications/second"]);
			expect(observed.lastEventIds).toEqual([null, "poll-1"]);
			// The resume replaced the manager-level reconnect: no close fired.
			expect(closed).toBe(false);
		} finally {
			await transport.close();
		}
	});
});
