#!/usr/bin/env bun
/**
 * Test fixture: a stdio MCP server of the handshake era that enforces the
 * lifecycle strictly, as rmcp does — the first request it receives must be
 * `initialize`; anything else and it exits with an error on stderr.
 *
 * Used by `upstream-probe.test.ts` to prove the era probe opens the
 * `initialize` session before asking `server/discover` (#20292).
 *
 * Speaks newline-delimited JSON-RPC 2.0 (the wire format of `StdioTransport`).
 * Notifications are dropped; unknown requests get `Method not found`.
 */
import * as readline from "node:readline";

function reply(id: string | number, result: unknown): void {
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function fail(id: string | number, message: string): void {
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message } })}\n`);
}

if (import.meta.main) {
	let initialized = false;
	const line = readline.createInterface({ input: process.stdin });
	line.on("line", raw => {
		let message: { id?: string | number; method: string; params?: Record<string, unknown> };
		try {
			message = JSON.parse(raw);
		} catch {
			return;
		}
		if (message.id === undefined) return; // notification
		if (!initialized) {
			if (message.method !== "initialize") {
				process.stderr.write(`expect initialize request, but received: ${message.method}\n`);
				process.exit(1);
			}
			initialized = true;
			reply(message.id, {
				protocolVersion: "2025-06-18",
				capabilities: { tools: {} },
				serverInfo: { name: "strict-fixture", version: "1.0.0" },
			});
			return;
		}
		if (message.method === "tools/list") {
			reply(message.id, {
				tools: [{ name: "ping_strict", description: "t", inputSchema: { type: "object", properties: {} } }],
			});
			return;
		}
		fail(message.id, `Method not found: ${message.method}`);
	});
}
