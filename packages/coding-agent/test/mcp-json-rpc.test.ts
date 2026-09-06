import { describe, expect, it } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { callMCP, parseSSE, redactUrlForLog } from "@oh-my-pi/pi-coding-agent/mcp/json-rpc";

describe("callMCP", () => {
	it("supports injected fetch, custom headers, and caller cancellation", async () => {
		const signal = AbortSignal.timeout(1_000);
		let capturedUrl: string | undefined;
		let capturedRequest: RequestInit | undefined;
		const fetchMock: FetchImpl = async (url, init) => {
			capturedUrl = url.toString();
			capturedRequest = init;
			return new Response(JSON.stringify({ jsonrpc: "2.0", id: "mcp-test", result: { ok: true } }));
		};

		const response = await callMCP<{ ok: boolean }>(
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
		expect(JSON.parse(capturedRequest?.body as string)).toMatchObject({
			jsonrpc: "2.0",
			method: "tools/call",
			params: { name: "web_search" },
		});
		expect(response.result).toEqual({ ok: true });
	});

	it("reassembles multiline SSE data with CRLF and optional spaces after colons", async () => {
		const fetchMock: FetchImpl = async (_url, init) => {
			const request = JSON.parse(init?.body as string);
			const message = JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { ok: true } }, null, 2);
			return new Response(
				`${message
					.split("\n")
					.map(line => `data:${line}`)
					.join("\r\n")}\r\n\r\n`,
				{
					headers: { "Content-Type": "text/event-stream" },
				},
			);
		};

		const response = await callMCP<{ ok: boolean }>("http://127.0.0.1:1/mcp", "tools/call", {}, { fetch: fetchMock });

		expect(response.result).toEqual({ ok: true });
	});

	it("skips SSE notifications and unrelated responses until the requested result arrives", async () => {
		const fetchMock: FetchImpl = async (_url, init) => {
			const request = JSON.parse(init?.body as string);
			const messages = [
				{ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "Searching" } },
				{ jsonrpc: "2.0", id: "another-request", result: { ok: false } },
				{ jsonrpc: "2.0", id: request.id, result: { ok: true } },
			];
			return new Response(messages.map(message => `data: ${JSON.stringify(message)}\n\n`).join(""), {
				headers: { "Content-Type": "text/event-stream" },
			});
		};

		const response = await callMCP<{ ok: boolean }>("http://127.0.0.1:1/mcp", "tools/call", {}, { fetch: fetchMock });

		expect(response.result).toEqual({ ok: true });
	});

	it("allows callers to classify HTTP errors using the response body", async () => {
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

	it("allows callers to classify malformed MCP responses", async () => {
		const fetchMock: FetchImpl = async () => new Response("not a JSON-RPC response");

		await expect(
			callMCP(
				"http://127.0.0.1:1/mcp",
				"tools/call",
				{},
				{
					fetch: fetchMock,
					onParseError: responseText => new Error(`invalid MCP payload: ${responseText}`),
				},
			),
		).rejects.toThrow("invalid MCP payload: not a JSON-RPC response");
	});
});

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
