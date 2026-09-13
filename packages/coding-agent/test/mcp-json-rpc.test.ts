import { describe, expect, it, spyOn } from "bun:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { text } from "node:stream/consumers";
import { callMCP, parseSSE } from "@oh-my-pi/pi-coding-agent/mcp/json-rpc";
import { logger } from "@oh-my-pi/pi-utils";

describe("parseSSE", () => {
	it("skips non-JSON data lines (keep-alives) and returns the first JSON payload", () => {
		const text = 'data: ping\n\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n';
		expect(parseSSE(text)).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
	});

	it("returns null when nothing parses", () => {
		expect(parseSSE("data: ping\nnot json either")).toBeNull();
	});
});

it("redacts loopback MCP failures before logging while sending original structured params", async () => {
	const params = { arguments: { client_secret: { nested: "diag-mcp-param-secret" }, safe: "keep" } };
	const requests: unknown[] = [];
	// Bun.serve normalizes status text; node:http lets the peer supply its own.
	const server = createServer(async (req, res) => {
		requests.push(JSON.parse(await text(req)));
		if (req.url?.startsWith("/status")) {
			res.statusCode = 400;
			res.statusMessage = "client_secret=diag-mcp-status-secret";
			res.end("failed");
		} else res.end('invalid reply {"client_secret":"diag-mcp-response-secret' + "x".repeat(700));
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;
	const logs = spyOn(logger, "error").mockImplementation(() => {});
	try {
		const messages: string[] = [];
		for (const route of ["status", "malformed"]) {
			try {
				await callMCP(`http://127.0.0.1:${port}/${route}?token=diag-mcp-url-secret`, "tools/call", params);
				throw new Error("expected MCP rejection");
			} catch (error) {
				messages.push(String(error));
			}
		}
		expect(requests).toHaveLength(2);
		for (const request of requests) expect(request).toMatchObject({ params });
		expect(messages[0]).toContain("client_secret=[redacted]");
		expect(logs.mock.calls).toHaveLength(2);
		const diagnostics = JSON.stringify({ messages, logs: logs.mock.calls });
		for (const secret of [
			"diag-mcp-param-secret",
			"diag-mcp-status-secret",
			"diag-mcp-response-secret",
			"diag-mcp-url-secret",
		])
			expect(diagnostics).not.toContain(secret);
		expect(diagnostics).toContain("keep");
	} finally {
		logs.mockRestore();
		const closed = new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
		server.closeAllConnections();
		await closed;
	}
});
