#!/usr/bin/env bun
/**
 * Test fixture: a minimal stdio MCP server that reports the arguments it was
 * spawned with. `initialize` returns `JSON.stringify(process.argv.slice(2))`
 * as its `instructions`, so a test can read the exact argv the child received
 * from `MCPServerConnection.instructions` (e.g. that a `${VAR}` placeholder was
 * substituted before spawn rather than passed literally).
 *
 * Speaks newline-delimited JSON-RPC 2.0 (the wire format of `StdioTransport`),
 * same shape as `many-tools-mcp.ts`. Only requests (objects with an `id`) get a
 * response; notifications are dropped.
 */
import * as readline from "node:readline";

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
				serverInfo: { name: "argv-echo-fixture", version: "1.0.0" },
				capabilities: { tools: {} },
				instructions: JSON.stringify(process.argv.slice(2)),
			};
		case "tools/list":
			return { tools: [] };
		default:
			return {};
	}
}

function startServer(): void {
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
