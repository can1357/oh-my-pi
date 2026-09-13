#!/usr/bin/env bun
/**
 * Test fixture: a valid stdio MCP server that advertises ONLY the resources
 * capability — no `tools` capability at all. A resource-only (or prompt-only)
 * server is legal per the MCP spec, and `listTools()` short-circuits to `[]`
 * for it without ever issuing a `tools/list` (see client.ts: the capability is
 * absent). The manager must therefore NOT mistake that permanent `[]` for a
 * gateway warming up and schedule the empty-toolset retry loop.
 *
 * It completes `initialize` instantly (capabilities `{ resources: {} }`) and
 * answers `resources/list` with a single resource so the connection is healthy.
 */
import * as readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });

function send(message: Record<string, unknown>): void {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

rl.on("line", line => {
	const trimmed = line.trim();
	if (trimmed.length === 0) return;
	let message: { id?: number | string; method?: string };
	try {
		message = JSON.parse(trimmed);
	} catch {
		return;
	}

	if (message.method === "initialize" && message.id !== undefined) {
		send({
			jsonrpc: "2.0",
			id: message.id,
			result: {
				protocolVersion: "2025-03-26",
				capabilities: { resources: {} },
				serverInfo: { name: "resource-only", version: "1.0.0" },
			},
		});
		return;
	}

	if (message.method === "resources/list" && message.id !== undefined) {
		send({
			jsonrpc: "2.0",
			id: message.id,
			result: {
				resources: [{ uri: "mem://doc", name: "doc", mimeType: "text/plain" }],
			},
		});
		return;
	}

	if (message.method === "resources/templates/list" && message.id !== undefined) {
		send({ jsonrpc: "2.0", id: message.id, result: { resourceTemplates: [] } });
		return;
	}
});

rl.on("close", () => process.exit(0));
