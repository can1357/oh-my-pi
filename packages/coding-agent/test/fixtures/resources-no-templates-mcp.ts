#!/usr/bin/env bun
/**
 * Test fixture: a stdio MCP server that advertises the `resources` capability
 * and serves `resources/list`, but does NOT implement the optional
 * `resources/templates/list` method — it answers that request with a JSON-RPC
 * -32601 ("Method not found") error, exactly like jcodemunch/jdocmunch.
 *
 * Used by `mcp-resource-templates-missing.test.ts` to prove that a missing
 * templates method no longer discards the server's concrete resources.
 *
 * Speaks newline-delimited JSON-RPC 2.0 (the wire format of `StdioTransport`),
 * same shape as `many-tools-mcp.ts`. Exported constants are imported by the
 * test; the server only starts when run as the entry module (`import.meta.main`).
 */
import * as readline from "node:readline";

/** Concrete resource URIs the fixture advertises via `resources/list`. */
export const RESOURCE_URIS = ["test://alpha", "test://beta"];

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
				serverInfo: { name: "resources-no-templates-fixture", version: "1.0.0" },
				capabilities: { resources: {} },
			};
		case "resources/list":
			return {
				resources: RESOURCE_URIS.map((uri, i) => ({ uri, name: `Resource ${i}` })),
			};
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
		// Notifications (no `id`) get no response.
		if (msg.id === undefined || msg.id === null) return;

		if (msg.method === "server/discover" || msg.method === "resources/templates/list") {
			// Optional method this server doesn't implement.
			const error = {
				jsonrpc: "2.0" as const,
				id: msg.id,
				error: { code: -32601, message: "Method not found" },
			};
			process.stdout.write(`${JSON.stringify(error)}\n`);
			return;
		}

		const response = { jsonrpc: "2.0" as const, id: msg.id, result: buildResult(msg.method) };
		process.stdout.write(`${JSON.stringify(response)}\n`);
	});
	rl.on("close", () => process.exit(0));
}

if (import.meta.main) {
	startServer();
}
