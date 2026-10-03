import { afterEach, describe, expect, it } from "bun:test";
import { callTool, connectToServer, listTools } from "@oh-my-pi/pi-coding-agent/mcp/client";

const GUARD_TIMEOUT_MS = 2_000;
const MODERN_VERSION = "2026-07-28";
const ENVELOPE_KEY = "io.modelcontextprotocol/protocolVersion";

interface RecordedRequest {
	method: string;
	headers: Headers;
	body: Record<string, unknown>;
}

let server: Bun.Server<undefined> | null = null;

afterEach(() => {
	server?.stop(true);
	server = null;
});

/** The `_meta` envelope a modern request must carry. */
function envelopeOf(body: Record<string, unknown>): Record<string, unknown> | undefined {
	const params = body.params;
	if (typeof params !== "object" || params === null) return undefined;
	const meta = (params as { _meta?: unknown })._meta;
	return typeof meta === "object" && meta !== null ? (meta as Record<string, unknown>) : undefined;
}

/**
 * A modern-only endpoint: `server/discover` instead of `initialize`, no
 * session id, per-request envelopes. Records every request for assertions.
 */
function startModernServer(options: { toolName?: string } = {}): RecordedRequest[] {
	const recorded: RecordedRequest[] = [];
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			if (req.method !== "POST") return new Response(null, { status: 405 });
			const body = (await req.json()) as Record<string, unknown>;
			recorded.push({ method: body.method as string, headers: req.headers, body });
			const id = body.id as string | number;
			const reply = (result: unknown) =>
				new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
					headers: { "Content-Type": "application/json" },
				});
			switch (body.method) {
				case "server/discover":
					return reply({
						supportedVersions: [MODERN_VERSION],
						capabilities: { tools: {} },
						_meta: { "io.modelcontextprotocol/serverInfo": { name: "modern-server", version: "4.2.0" } },
					});
				case "tools/list":
					return reply({ tools: [{ name: options.toolName ?? "echo", inputSchema: { type: "object" } }] });
				case "tools/call": {
					const params = body.params as { arguments?: { message?: string } };
					return reply({ content: [{ type: "text", text: params.arguments?.message ?? "ok" }] });
				}
				default:
					return new Response(null, { status: 202 });
			}
		},
	});
	return recorded;
}

/**
 * A 2025-era endpoint: the probe fails with `probeError`, then the plain
 * `initialize` handshake serves the session.
 */
function startLegacyServer(probeError: { status: number; code: number }): RecordedRequest[] {
	const recorded: RecordedRequest[] = [];
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			if (req.method === "GET") return new Response(null, { status: 405 });
			if (req.method === "DELETE") return new Response(null, { status: 204 });
			const body = (await req.json()) as Record<string, unknown>;
			recorded.push({ method: body.method as string, headers: req.headers, body });
			const id = body.id as string | number;
			if (body.method === "server/discover") {
				return new Response(
					JSON.stringify({
						jsonrpc: "2.0",
						id,
						error: {
							code: probeError.code,
							message: probeError.status === 500 ? "boom" : `Unsupported protocol version: ${MODERN_VERSION}`,
							data: { supported: ["2025-11-25"] },
						},
					}),
					{ status: probeError.status, headers: { "Content-Type": "application/json" } },
				);
			}
			if (body.method === "initialize") {
				return new Response(
					JSON.stringify({
						jsonrpc: "2.0",
						id,
						result: {
							protocolVersion: "2025-11-25",
							capabilities: { tools: {} },
							serverInfo: { name: "legacy-server", version: "1.0.0" },
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json", "Mcp-Session-Id": "legacy-1" } },
				);
			}
			if (body.method === "tools/list") {
				return new Response(
					JSON.stringify({
						jsonrpc: "2.0",
						id,
						result: { tools: [{ name: "legacy-tool", inputSchema: { type: "object" } }] },
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			return new Response(null, { status: 202 });
		},
	});
	return recorded;
}

describe("MCP streamable-http modern era", () => {
	it("negotiates 2026-07-28, synthesizes initialize from server/discover, and sends per-request envelopes", async () => {
		const recorded = startModernServer();
		const connection = await connectToServer("modern", {
			type: "streamable-http",
			url: `http://127.0.0.1:${server!.port}/mcp-new`,
			timeout: GUARD_TIMEOUT_MS,
		});

		expect(connection.serverInfo).toEqual({ name: "modern-server", version: "4.2.0" });

		const tools = await listTools(connection);
		expect(tools.map(tool => tool.name)).toEqual(["echo"]);

		const result = await callTool(connection, "echo", { message: "hello" });
		expect(result.content[0]).toMatchObject({ type: "text", text: "hello" });

		// No initialize on the wire: the probe result backs the handshake locally.
		expect(recorded.map(request => request.method)).toEqual([
			"server/discover",
			"notifications/initialized",
			"tools/list",
			"tools/call",
		]);
		for (const request of recorded) {
			const envelope = envelopeOf(request.body);
			expect(envelope?.[ENVELOPE_KEY]).toBe(MODERN_VERSION);
			expect(request.headers.get("MCP-Protocol-Version")).toBe(MODERN_VERSION);
			expect(request.headers.get("Mcp-Method")).toBe(request.method);
			// Stateless era: no session header is ever sent.
			expect(request.headers.get("Mcp-Session-Id")).toBeNull();
		}
		// Mcp-Name mirrors the addressed entity and is absent for list methods.
		const call = recorded.find(request => request.method === "tools/call");
		expect(call?.headers.get("Mcp-Name")).toBe("echo");
		const list = recorded.find(request => request.method === "tools/list");
		expect(list?.headers.get("Mcp-Name")).toBeNull();

		await connection.transport.close();
	});

	it("base64-wraps a non-ASCII Mcp-Name so the header stays field-value safe", async () => {
		const recorded = startModernServer({ toolName: "эхо" });
		const connection = await connectToServer("modern-unicode", {
			type: "streamable-http",
			url: `http://127.0.0.1:${server!.port}/mcp-new`,
			timeout: GUARD_TIMEOUT_MS,
		});
		await callTool(connection, "эхо", { message: "hi" });

		const call = recorded.find(request => request.method === "tools/call");
		expect(call?.headers.get("Mcp-Name")).toBe(`=?base64?${Buffer.from("эхо", "utf8").toString("base64")}?=`);
		await connection.transport.close();
	});

	it("downgrades to the 2025 handshake when the probe answers UnsupportedProtocolVersion", async () => {
		const recorded = startLegacyServer({ status: 400, code: -32022 });
		const connection = await connectToServer("legacy", {
			type: "streamable-http",
			url: `http://127.0.0.1:${server!.port}/mcp`,
			timeout: GUARD_TIMEOUT_MS,
		});

		expect(connection.serverInfo.name).toBe("legacy-server");
		const tools = await listTools(connection);
		expect(tools.map(tool => tool.name)).toEqual(["legacy-tool"]);

		expect(recorded.map(request => request.method)).toEqual([
			"server/discover",
			"initialize",
			"notifications/initialized",
			"tools/list",
		]);
		// The legacy slot speaks 2025: no envelope, no Mcp-Method.
		const initialize = recorded.find(request => request.method === "initialize");
		expect(envelopeOf(initialize!.body)).toBeUndefined();
		expect(initialize?.headers.get("Mcp-Method")).toBeNull();
		await connection.transport.close();
	});

	it("probe refuses an unknown method with a 200-carried JSON-RPC error and still downgrades", async () => {
		// A legacy server may answer the probe with HTTP 200 + error body.
		server = Bun.serve({
			port: 0,
			async fetch(req) {
				if (req.method !== "POST") return new Response(null, { status: 405 });
				const body = (await req.json()) as { id?: string | number; method: string };
				const id = body.id as string | number;
				if (body.method === "server/discover") {
					return new Response(
						JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } }),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				return new Response(
					JSON.stringify({
						jsonrpc: "2.0",
						id,
						result:
							body.method === "initialize"
								? {
										protocolVersion: "2025-11-25",
										capabilities: { tools: {} },
										serverInfo: { name: "legacy-200", version: "1.0.0" },
									}
								: { tools: [] },
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			},
		});
		const connection = await connectToServer("legacy-200", {
			type: "streamable-http",
			url: `http://127.0.0.1:${server!.port}/mcp`,
			timeout: GUARD_TIMEOUT_MS,
		});
		expect(connection.serverInfo.name).toBe("legacy-200");
		await connection.transport.close();
	});

	it("downgrades when the probe itself fails with an HTTP error", async () => {
		const recorded = startLegacyServer({ status: 500, code: -32603 });
		const connection = await connectToServer("legacy-error", {
			type: "streamable-http",
			url: `http://127.0.0.1:${server!.port}/mcp`,
			timeout: GUARD_TIMEOUT_MS,
		});

		expect(connection.serverInfo.name).toBe("legacy-server");
		expect(recorded.map(request => request.method)).toEqual([
			"server/discover",
			"initialize",
			"notifications/initialized",
		]);
		await connection.transport.close();
	});

	it("keeps plain http configs on the legacy handshake without probing", async () => {
		const recorded = startLegacyServer({ status: 400, code: -32022 });
		const connection = await connectToServer("plain-http", {
			type: "http",
			url: `http://127.0.0.1:${server!.port}/mcp`,
			timeout: GUARD_TIMEOUT_MS,
		});

		expect(recorded[0]?.method).toBe("initialize");
		await connection.transport.close();
	});
});

describe("MCP streamable-http SSE-framed responses", () => {
	it("reads a result framed as SSE and matches it by id", async () => {
		server = Bun.serve({
			port: 0,
			async fetch(req) {
				if (req.method !== "POST") return new Response(null, { status: 405 });
				const body = (await req.json()) as { id?: string | number; method: string };
				const id = body.id as string | number;
				const sse = (payload: unknown) =>
					new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
						headers: { "Content-Type": "text/event-stream" },
					});
				if (body.method === "server/discover") {
					return sse({
						jsonrpc: "2.0",
						id,
						result: { supportedVersions: ["2026-07-28"], capabilities: { tools: {} } },
					});
				}
				if (body.method === "tools/list")
					return sse({ jsonrpc: "2.0", id, result: { tools: [{ name: "s", inputSchema: { type: "object" } }] } });
				// Deliberately interleave a stale different-id frame plus a carrier notification.
				return new Response(
					`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: "stale-999", result: { content: [{ type: "text", text: "wrong" }] } })}\n\n` +
						`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: {} })}\n\n` +
						`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "right" }] } })}\n\n`,
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			},
		});
		const connection = await connectToServer("sse-modern", {
			type: "streamable-http",
			url: `http://127.0.0.1:${server.port}/mcp-new`,
			timeout: 2000,
		});
		const result = await callTool(connection, "s", {});
		expect(result.content[0]).toMatchObject({ text: "right" });
		await connection.transport.close();
	});
});
