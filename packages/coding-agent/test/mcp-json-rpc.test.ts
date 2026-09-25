import type { BodyInit } from "bun";
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { fetchExaTools } from "@oh-my-pi/pi-coding-agent/exa/mcp-client";
import { callMCP, redactUrlForLog } from "@oh-my-pi/pi-coding-agent/mcp/json-rpc";
import { isRecord } from "@oh-my-pi/pi-utils";
import { asGlobalFetch } from "./helpers/fetch-mock";

interface PostedJsonRpcRequest {
	id: string | number;
	method: string;
}

function parsePostedJsonRpcRequest(body: BodyInit | null | undefined): PostedJsonRpcRequest {
	const request: unknown = JSON.parse(String(body));
	if (
		!isRecord(request) ||
		(typeof request.id !== "string" && typeof request.id !== "number") ||
		typeof request.method !== "string"
	) {
		throw new Error("Expected a JSON-RPC request body");
	}
	return { id: request.id, method: request.method };
}

function mockMcpFetch(createResponse: (request: PostedJsonRpcRequest) => Response): void {
	vi.spyOn(globalThis, "fetch").mockImplementation(
		asGlobalFetch((_input, init) => createResponse(parsePostedJsonRpcRequest(init?.body))),
	);
}

function sseResponse(data: BodyInit | null): Response {
	return new Response(data, { headers: { "Content-Type": "text/event-stream" } });
}

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

describe("callMCP", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("accepts no-space SSE data and continues past valid notifications and requests", async () => {
		mockMcpFetch(request =>
			sseResponse(
				[
					'data:{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}',
					'data:{"jsonrpc":"2.0","id":"server-request","method":"sampling/createMessage","params":{}}',
					`data:${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { tools: ["matched"] } })}`,
					"",
				].join("\n\n"),
			),
		);

		await expect(callMCP("https://mcp.example.test", "tools/list")).resolves.toEqual({
			jsonrpc: "2.0",
			id: expect.any(String),
			result: { tools: ["matched"] },
		});
	});

	it("joins multiline SSE data before parsing the matching response", async () => {
		mockMcpFetch(request => {
			const payload = JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { value: 42 } }, null, 2);
			const event = `${payload
				.split("\n")
				.map(line => `data: ${line}`)
				.join("\n")}\n\n`;
			return sseResponse(event);
		});

		const response = await callMCP("https://mcp.example.test", "example/get");
		expect(response.result).toEqual({ value: 42 });
	});

	it("rejects an SSE response with only unmatched response IDs", async () => {
		mockMcpFetch(() => sseResponse('data: {"jsonrpc":"2.0","id":"different-request","result":{}}\n\n'));

		await expect(callMCP("https://mcp.example.test", "tools/list")).rejects.toThrow(
			"MCP response ID did not match request ID",
		);
	});

	it("rejects a malformed JSON-RPC message", async () => {
		mockMcpFetch(request => sseResponse(`data: ${JSON.stringify({ jsonrpc: "2.0", id: request.id })}\n\n`));

		await expect(callMCP("https://mcp.example.test", "tools/list")).rejects.toThrow("Malformed JSON-RPC response");
	});

	it("does not silently skip non-JSON MCP data", async () => {
		mockMcpFetch(() => sseResponse("data: ping\n\n"));

		await expect(callMCP("https://mcp.example.test", "tools/list")).rejects.toBeInstanceOf(SyntaxError);
	});

	it("preserves caller cancellation while reading a live SSE response", async () => {
		const reading = Promise.withResolvers<void>();
		const blocked = Promise.withResolvers<void>();
		const stream = new ReadableStream<Uint8Array>(
			{
				pull() {
					reading.resolve();
					return blocked.promise;
				},
				cancel() {
					blocked.resolve();
				},
			},
			{ highWaterMark: 0 },
		);
		mockMcpFetch(() => sseResponse(stream));
		const controller = new AbortController();

		const pending = callMCP("https://mcp.example.test", "tools/list", undefined, {
			signal: controller.signal,
		});
		await reading.promise;
		controller.abort();

		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
	});

	it("rejects an SSE stream with no result or error response", async () => {
		mockMcpFetch(() => sseResponse('data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n'));

		await expect(callMCP("https://mcp.example.test", "tools/list")).rejects.toThrow(
			"MCP response did not include a result or error",
		);
	});

	it("parses a matching application/json response without SSE framing", async () => {
		mockMcpFetch(
			request =>
				new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { mode: "json" } }), {
					headers: { "Content-Type": "application/json" },
				}),
		);

		await expect(callMCP("https://mcp.example.test", "tools/list")).resolves.toEqual({
			jsonrpc: "2.0",
			id: expect.any(String),
			result: { mode: "json" },
		});
	});

	it("uses injected fetch, merges custom headers, and forwards the caller signal", async () => {
		const signal = AbortSignal.timeout(1_000);
		let capturedUrl: string | undefined;
		let capturedRequest: RequestInit | undefined;
		const fetchMock: FetchImpl = async (url, init) => {
			capturedUrl = url.toString();
			capturedRequest = init;
			return new Response(
				JSON.stringify({ jsonrpc: "2.0", id: parsePostedJsonRpcRequest(init?.body).id, result: { ok: true } }),
			);
		};

		const response = await callMCP(
			"http://127.0.0.1:1/mcp",
			"tools/call",
			{ name: "web_search" },
			{ fetch: fetchMock, headers: { "User-Agent": "omp/test" }, signal },
		);

		expect(capturedUrl).toBe("http://127.0.0.1:1/mcp");
		expect(capturedRequest?.headers).toEqual({
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			"User-Agent": "omp/test",
		});
		expect(capturedRequest?.signal).toBe(signal);
		expect(response.result).toEqual({ ok: true });
	});

	it("lets callers classify HTTP errors using the response body", async () => {
		const fetchMock: FetchImpl = async () => new Response("rate limited", { status: 429 });

		await expect(
			callMCP(
				"http://127.0.0.1:1/mcp",
				"tools/call",
				{},
				{
					fetch: fetchMock,
					onHttpError: (response, body) => new Error(`classified ${response.status}: ${body}`),
				},
			),
		).rejects.toThrow("classified 429: rate limited");
	});

	it("lets callers classify malformed MCP responses", async () => {
		const fetchMock: FetchImpl = async () => new Response("not a JSON-RPC response");

		await expect(
			callMCP(
				"http://127.0.0.1:1/mcp",
				"tools/call",
				{},
				{
					fetch: fetchMock,
					onParseError: error =>
						new Error(`invalid MCP payload: ${error instanceof Error ? error.name : "unknown"}`),
				},
			),
		).rejects.toThrow("invalid MCP payload: SyntaxError");
	});

	it("lets fetchExaTools discover tools without descriptions after a notification", async () => {
		const tool = {
			name: "web_search_exa",
			inputSchema: { type: "object" },
		};
		mockMcpFetch(request =>
			sseResponse(
				[
					'data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}',
					`data: ${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { tools: [tool] } })}`,
					"",
				].join("\n\n"),
			),
		);

		await expect(fetchExaTools(null, ["web_search_exa"])).resolves.toEqual([tool]);
	});
});
