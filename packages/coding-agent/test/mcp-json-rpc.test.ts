import { describe, expect, it } from "bun:test";
import { callMCP, parseSSE, redactUrlForLog } from "@pk-nerdsaver-ai/pi-coding-agent/mcp/json-rpc";
import { MCP_CLIENT_INFO, MCP_MODERN_PROTOCOL_VERSION } from "@pk-nerdsaver-ai/pi-coding-agent/mcp/types";

describe("redactUrlForLog", () => {
	it("redacts credential-bearing query params but keeps the rest", () => {
		const redacted = redactUrlForLog("https://mcp.exa.ai/mcp?exaApiKey=sk-secret-123&foo=bar");
		expect(redacted).not.toContain("sk-secret-123");
		expect(redacted).toContain("foo=bar");
		expect(redacted).toContain("https://mcp.exa.ai/mcp");
	});

	it("drops the query string entirely for unparseable URLs", () => {
		expect(redactUrlForLog("not a url?apiKey=zzz")).toBe("not a url");
	});
});

describe("parseSSE", () => {
	it("skips non-JSON data lines (keep-alives) and returns the first JSON payload", () => {
		const text = 'data: ping\n\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n';
		expect(parseSSE(text)).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
	});

	it("returns null when nothing parses", () => {
		expect(parseSSE("data: ping\nnot json either")).toBeNull();
	});
});

describe("callMCP modern direct helper", () => {
	it("uses the explicit request context and skips request-scoped notifications until the matching SSE response", async () => {
		const notifications: Array<{ method: string; params: unknown }> = [];
		const originalFetch = globalThis.fetch;
		let capturedHeaders: Headers | undefined;
		let capturedBody: Record<string, unknown> | undefined;
		globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
			capturedHeaders = new Headers(init?.headers);
			capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return new Response(
				[
					'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":1}}\n\n',
					`data: ${JSON.stringify({ jsonrpc: "2.0", id: capturedBody.id, result: { complete: true } })}\n\n`,
				].join(""),
				{ headers: { "Content-Type": "text/event-stream" } },
			);
		}) as typeof fetch;
		try {
			await expect(
				callMCP(
					"https://mcp.example.test/mcp",
					"tools/call",
					{ name: "tool-世界", arguments: {} },
					{
						context: { version: MCP_MODERN_PROTOCOL_VERSION, clientCapabilities: {} },
						onNotification: (method, params) => notifications.push({ method, params }),
					},
				),
			).resolves.toMatchObject({ result: { complete: true } });
		} finally {
			globalThis.fetch = originalFetch;
		}

		expect(capturedBody?.params).toEqual({
			name: "tool-世界",
			arguments: {},
			_meta: {
				"io.modelcontextprotocol/protocolVersion": MCP_MODERN_PROTOCOL_VERSION,
				"io.modelcontextprotocol/clientCapabilities": {},
				"io.modelcontextprotocol/clientInfo": MCP_CLIENT_INFO,
			},
		});
		expect(capturedHeaders?.get("mcp-protocol-version")).toBe(MCP_MODERN_PROTOCOL_VERSION);
		expect(capturedHeaders?.get("mcp-method")).toBe("tools/call");
		expect(capturedHeaders?.get("mcp-name")).toMatch(/^=\?base64\?.*\?=$/);
		expect(notifications).toEqual([{ method: "notifications/progress", params: { progress: 1 } }]);
	});

	it("rejects a JSON response whose ID does not match the emitted request", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ jsonrpc: "2.0", id: "wrong-id", result: {} }), {
				headers: { "Content-Type": "application/json" },
			})) as unknown as typeof fetch;
		try {
			await expect(
				callMCP("https://mcp.example.test/mcp", "tools/list", undefined, {
					context: { version: MCP_MODERN_PROTOCOL_VERSION, clientCapabilities: {} },
				}),
			).rejects.toThrow("Mismatched response ID");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("cancels non-2xx response body on direct-call failure", async () => {
		let bodyCancelled = false;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () => {
			const stream = new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode("Internal error"));
					controller.close();
				},
				cancel() {
					bodyCancelled = true;
				},
			});
			return new Response(stream, { status: 500, statusText: "Internal Server Error" });
		}) as unknown as typeof fetch;
		try {
			await expect(
				callMCP("https://mcp.example.test/mcp", "tools/list", undefined, {
					context: { version: MCP_MODERN_PROTOCOL_VERSION, clientCapabilities: {} },
				}),
			).rejects.toThrow("MCP request failed: 500 Internal Server Error");
			expect(bodyCancelled).toBeTrue();
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("validates SSE response envelope shape and rejects mutual result/error or invalid jsonrpc version", async () => {
		const originalFetch = globalThis.fetch;
		let bodyCapturedId: string | number | undefined;
		globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as { id: string | number };
			bodyCapturedId = body.id;
			return new Response(`data: ${JSON.stringify({ jsonrpc: "1.0", id: bodyCapturedId, result: {} })}\n\n`, {
				headers: { "Content-Type": "text/event-stream" },
			});
		}) as unknown as typeof fetch;
		try {
			await expect(
				callMCP("https://mcp.example.test/mcp", "tools/list", undefined, {
					context: { version: MCP_MODERN_PROTOCOL_VERSION, clientCapabilities: {} },
				}),
			).rejects.toThrow("Invalid JSON-RPC version in response");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
