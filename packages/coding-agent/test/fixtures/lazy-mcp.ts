#!/usr/bin/env bun
/**
 * Test fixture: a well-behaved stdio MCP server used by the `lazy: true`
 * connection tests. Answers `initialize`, `tools/list`, and `tools/call`
 * immediately, and — when `LAZY_MCP_SPAWN_MARKER` is set — writes that file
 * on boot so a test can prove whether the process was ever spawned.
 *
 * Speaks newline-delimited JSON-RPC 2.0 (the wire format of `StdioTransport`):
 * one JSON object per line on stdin, one JSON response per line on stdout.
 * Only requests (objects with an `id`) get a response; notifications
 * (including `notifications/initialized`) are dropped.
 */
import * as readline from "node:readline";

export const TOOL_NAME = "lazy_ping";
export const TOOL_RESULT = "MCP_LAZY_CONNECT_OK_4f8a";

type JsonRpcRequest = {
	jsonrpc: "2.0";
	id?: string | number;
	method: string;
	params?: Record<string, unknown>;
};

function buildResult(method: string): Record<string, unknown> {
	switch (method) {
		case "initialize":
			return {
				protocolVersion: "2025-03-26",
				serverInfo: { name: "lazy-fixture", version: "1.0.0" },
				capabilities: { tools: {} },
			};
		case "tools/list":
			return {
				tools: [
					{
						name: TOOL_NAME,
						description: "Fixture tool served by the lazy-connect fixture.",
						inputSchema: { type: "object", properties: {}, additionalProperties: false },
					},
				],
			};
		case "tools/call":
			return { content: [{ type: "text", text: TOOL_RESULT }], isError: false };
		default:
			return {};
	}
}

function startServer(): void {
	const marker = process.env.LAZY_MCP_SPAWN_MARKER;
	if (marker) {
		void Bun.write(marker, `spawned pid=${process.pid}\n`);
	}
	const rl = readline.createInterface({ input: process.stdin });
	rl.on("line", line => {
		const trimmed = line.trim();
		if (trimmed.length === 0) return;
		let msg: JsonRpcRequest;
		try {
			msg = JSON.parse(trimmed) as JsonRpcRequest;
		} catch {
			return;
		}
		if (msg.id === undefined || msg.id === null) return;
		const response = { jsonrpc: "2.0" as const, id: msg.id, result: buildResult(msg.method) };
		process.stdout.write(`${JSON.stringify(response)}\n`);
	});
	rl.on("close", () => process.exit(0));
}

if (import.meta.main) {
	startServer();
}
