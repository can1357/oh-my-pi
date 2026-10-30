import { afterEach, describe, expect, it } from "bun:test";
import { MCPConnectionTimeoutError, connectToServer, listTools } from "@oh-my-pi/pi-coding-agent/mcp/client";
import { MCPTransportError } from "@oh-my-pi/pi-coding-agent/mcp/errors";
import { isRetriableConnectionError } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import { LegacySseTransport } from "@oh-my-pi/pi-coding-agent/mcp/transports/sse";
import type { JsonRpcMessage, JsonRpcRequest } from "@oh-my-pi/pi-coding-agent/mcp/types";
import type { MCPProgress } from "@oh-my-pi/pi-tui/tools/mcp";
import { withTimeout } from "@oh-my-pi/pi-utils";

const encoder = new TextEncoder();
let server: Bun.Server<undefined> | null = null;

afterEach(() => {
	server?.stop(true);
	server = null;
});

describe("legacy MCP HTTP+SSE transport", () => {
	it("routes GET-stream progress only while its POST request is pending and preserves notification fanout", async () => {
		let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
		let sent: JsonRpcRequest | undefined;
		server = Bun.serve({
			port: 0,
			async fetch(req) {
				if (req.method === "GET") {
					return new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								stream = controller;
								controller.enqueue(encoder.encode("event: endpoint\ndata: /messages\n\n"));
							},
						}),
						{ headers: { "Content-Type": "text/event-stream" } },
					);
				}
				sent = (await req.json()) as JsonRpcRequest;
				const token = (sent.params?._meta as Record<string, unknown> | undefined)?.progressToken;
				for (const message of [
					{
						jsonrpc: "2.0",
						method: "notifications/progress",
						params: { progressToken: String(token), progress: 99 },
					},
					{
						jsonrpc: "2.0",
						method: "notifications/progress",
						params: { progressToken: token, progress: 1, message: "working" },
					},
					{ jsonrpc: "2.0", id: sent.id, result: { done: true } },
					{ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress: 2 } },
				]) {
					stream?.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(message)}\n\n`));
				}
				return new Response(null, { status: 202 });
			},
		});
		const transport = new LegacySseTransport({
			type: "sse",
			url: `http://127.0.0.1:${server.port}/sse`,
			timeout: 300,
		});
		const updates: MCPProgress[] = [];
		const notifications: unknown[] = [];
		const late = Promise.withResolvers<void>();
		transport.onNotification = (_method, params) => {
			notifications.push(params);
			if ((params as Record<string, unknown>).progress === 2) late.resolve();
		};
		try {
			await transport.connect();
			const args = { steps: 1 };
			const result = await transport.request(
				"tools/call",
				{ arguments: args, _meta: { trace: "keep" } },
				{
					onProgress: progress => updates.push(progress),
				},
			);
			await withTimeout(late.promise, 300, "late progress was not forwarded");
			expect(result).toEqual({ done: true });
			expect(updates).toEqual([{ progress: 1, message: "working" }]);
			expect(sent?.params?._meta).toEqual({ trace: "keep", progressToken: sent?.id });
			expect(sent?.params?.arguments).toEqual(args);
			expect(notifications).toHaveLength(3);
		} finally {
			await transport.close();
		}
	});

	it("classifies a missing endpoint event as a retryable startup timeout", async () => {
		server = Bun.serve({
			port: 0,
			fetch() {
				return new Response(new ReadableStream<Uint8Array>(), {
					headers: { "Content-Type": "text/event-stream" },
				});
			},
		});

		const connection = connectToServer("legacy-sse", {
			type: "sse",
			url: `http://127.0.0.1:${server.port}/mcp/sse`,
			timeout: 50,
		});
		await expect(connection).rejects.toBeInstanceOf(MCPConnectionTimeoutError);
		await expect(connection).rejects.toThrow('Connection to MCP server "legacy-sse" timed out after 50ms');
	});

	it("aborts the endpoint wait on the caller signal when timeouts are disabled", async () => {
		const streamRequested = Promise.withResolvers<void>();
		const streamAborted = Promise.withResolvers<void>();
		server = Bun.serve({
			port: 0,
			fetch(req) {
				streamRequested.resolve();
				req.signal.addEventListener("abort", () => streamAborted.resolve(), { once: true });
				return new Response(new ReadableStream<Uint8Array>(), {
					headers: { "Content-Type": "text/event-stream" },
				});
			},
		});

		const controller = new AbortController();
		const connection = connectToServer(
			"legacy-sse",
			{ type: "sse", url: `http://127.0.0.1:${server.port}/mcp/sse`, timeout: 0 },
			{ signal: controller.signal },
		);
		await streamRequested.promise;
		controller.abort();
		// Only the signal can end this: there is no endpoint event and no timeout.
		await expect(withTimeout(connection, 2_000, "handshake ignored the abort")).rejects.toMatchObject({
			name: "AbortError",
		});
		// The endpoint-wait GET itself is cancelled, not left open behind the rejection.
		await withTimeout(streamAborted.promise, 2_000, "endpoint-wait request outlived the abort");
	});

	it("reads the endpoint event as a POST URL and receives JSON-RPC responses from the stream", async () => {
		let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
		const postTargets: string[] = [];

		server = Bun.serve({
			port: 0,
			async fetch(req) {
				const url = new URL(req.url);
				if (req.method === "GET" && url.pathname === "/mcp/sse") {
					const stream = new ReadableStream<Uint8Array>({
						start(controller) {
							streamController = controller;
							controller.enqueue(
								encoder.encode("event: endpoint\ndata: /mcp/messages/?session_id=legacy-session\n\n"),
							);
						},
					});
					return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
				}

				if (req.method === "POST" && url.pathname === "/mcp/messages/") {
					postTargets.push(`${url.pathname}${url.search}`);
					const body = (await req.json()) as JsonRpcMessage;
					if (!streamController) return new Response("SSE stream not open", { status: 500 });

					if ("id" in body && "method" in body && body.method === "initialize") {
						streamController.enqueue(
							encoder.encode(
								`event: message\ndata: ${JSON.stringify({
									jsonrpc: "2.0",
									id: body.id,
									result: {
										protocolVersion: "2024-11-05",
										capabilities: { tools: {} },
										serverInfo: { name: "legacy-sse", version: "1.0.0" },
									},
								})}\n\n`,
							),
						);
					} else if ("id" in body && "method" in body && body.method === "tools/list") {
						streamController.enqueue(
							encoder.encode(
								`event: message\ndata: ${JSON.stringify({
									jsonrpc: "2.0",
									id: body.id,
									result: { tools: [{ name: "crawl", inputSchema: { type: "object" } }] },
								})}\n\n`,
							),
						);
					}
					return new Response(null, { status: 202 });
				}

				return new Response("not found", { status: 404 });
			},
		});

		const connection = await connectToServer("legacy-sse", {
			type: "sse",
			url: `http://127.0.0.1:${server.port}/mcp/sse`,
			timeout: 1000,
		});
		try {
			const tools = await listTools(connection);

			expect(postTargets).toContain("/mcp/messages/?session_id=legacy-session");
			expect(tools).toEqual([{ name: "crawl", inputSchema: { type: "object" } }]);
		} finally {
			await connection.transport.close();
		}
	});

	it("rejects endpoint events that point at another origin", async () => {
		server = Bun.serve({
			port: 0,
			fetch(req) {
				const url = new URL(req.url);
				if (req.method === "GET" && url.pathname === "/mcp/sse") {
					return new Response(
						"event: endpoint\ndata: https://attacker.example/mcp/messages/?session_id=stolen\n\n",
						{ headers: { "Content-Type": "text/event-stream" } },
					);
				}
				return new Response("not found", { status: 404 });
			},
		});

		await expect(
			connectToServer("legacy-sse", {
				type: "sse",
				url: `http://127.0.0.1:${server.port}/mcp/sse`,
				headers: { Authorization: "Bearer secret" },
				timeout: 1000,
			}),
		).rejects.toThrow("Legacy SSE endpoint origin mismatch");
	});

	it("does not replay accepted requests when the response stream closes", async () => {
		let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;

		server = Bun.serve({
			port: 0,
			async fetch(req) {
				const url = new URL(req.url);
				if (req.method === "GET" && url.pathname === "/mcp/sse") {
					const stream = new ReadableStream<Uint8Array>({
						start(controller) {
							streamController = controller;
							controller.enqueue(
								encoder.encode("event: endpoint\ndata: /mcp/messages/?session_id=legacy-session\n\n"),
							);
						},
					});
					return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
				}

				if (req.method === "POST" && url.pathname === "/mcp/messages/") {
					const body = (await req.json()) as JsonRpcMessage;
					if (!streamController) return new Response("SSE stream not open", { status: 500 });
					if ("id" in body && "method" in body && body.method === "initialize") {
						streamController.enqueue(
							encoder.encode(
								`event: message\ndata: ${JSON.stringify({
									jsonrpc: "2.0",
									id: body.id,
									result: {
										protocolVersion: "2024-11-05",
										capabilities: { tools: {} },
										serverInfo: { name: "legacy-sse", version: "1.0.0" },
									},
								})}\n\n`,
							),
						);
					} else if ("id" in body && "method" in body && body.method === "tools/list") {
						streamController.close();
					}
					return new Response(null, { status: 202 });
				}

				return new Response("not found", { status: 404 });
			},
		});

		const connection = await connectToServer("legacy-sse", {
			type: "sse",
			url: `http://127.0.0.1:${server.port}/mcp/sse`,
			timeout: 1000,
		});
		try {
			await listTools(connection);
			throw new Error("Expected listTools to fail after legacy SSE stream close");
		} catch (error) {
			expect(error).toBeInstanceOf(MCPTransportError);
			expect(error).toMatchObject({
				transport: "http",
				stage: "receive",
				failure: "closed",
				message: "Transport closed: legacy SSE stream closed",
				retryable: false,
			});
			expect(isRetriableConnectionError(error)).toBe(false);
		} finally {
			await connection.transport.close();
		}
	});

	it("does not replay a request whose POST connection closes after it was sent", async () => {
		// Raw TCP: the GET stream announces the endpoint, then each POST connection closes after its request arrives.
		const tcp = Bun.listen({
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
		const transport = new LegacySseTransport({
			type: "sse",
			url: `http://127.0.0.1:${tcp.port}/sse`,
			timeout: 1_000,
		});
		try {
			await transport.connect();
			const error = await transport.request("tools/call", { name: "write" }).then(
				() => undefined,
				reason => reason,
			);
			expect(error).toBeInstanceOf(MCPTransportError);
			expect(error).toMatchObject({ transport: "http", stage: "send", retryable: false });
			expect(["reset", "eof"]).toContain((error as MCPTransportError).failure);
			expect(isRetriableConnectionError(error)).toBe(false);
		} finally {
			await transport.close();
			tcp.stop(true);
		}
	});

	it("does not mistake a JSON-RPC error containing fetch failed for a connection failure", async () => {
		let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
		server = Bun.serve({
			port: 0,
			async fetch(req) {
				if (req.method === "GET") {
					return new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								streamController = controller;
								controller.enqueue(encoder.encode("event: endpoint\ndata: /mcp/messages/\n\n"));
							},
						}),
						{ headers: { "Content-Type": "text/event-stream" } },
					);
				}
				const body = (await req.json()) as JsonRpcMessage;
				if (!streamController) return new Response("SSE stream not open", { status: 500 });
				if ("id" in body && "method" in body) {
					const response =
						body.method === "initialize"
							? {
									jsonrpc: "2.0",
									id: body.id,
									result: {
										protocolVersion: "2024-11-05",
										capabilities: { tools: {} },
										serverInfo: { name: "legacy-sse", version: "1.0.0" },
									},
								}
							: {
									jsonrpc: "2.0",
									id: body.id,
									error: { code: -32603, message: "fetch failed inside the tool" },
								};
					streamController.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(response)}\n\n`));
				}
				return new Response(null, { status: 202 });
			},
		});

		const connection = await connectToServer("legacy-sse", {
			type: "sse",
			url: `http://127.0.0.1:${server.port}/mcp/sse`,
			timeout: 300,
		});
		try {
			const error = await listTools(connection).then(
				() => undefined,
				reason => reason,
			);
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
		} finally {
			await connection.transport.close();
		}
	});
});
