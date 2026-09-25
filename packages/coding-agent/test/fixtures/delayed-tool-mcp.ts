#!/usr/bin/env bun
/**
 * Test fixture: a well-behaved stdio MCP server that answers `initialize`
 * only after a deliberate delay exceeding `MCPManager`'s
 * `STARTUP_TIMEOUT_MS` (250 ms), then responds normally to `tools/list`.
 *
 * Without arguments every launch delays, exercising late background binding.
 * With a marker-file argument only the first launch delays; it writes the
 * marker before waiting so a reconnect responds immediately. This models a
 * transient startup timeout followed by recovery.
 *
 * Speaks newline-delimited JSON-RPC 2.0 (the wire format of `StdioTransport`):
 * one JSON object per line on stdin, one JSON response per line on stdout.
 * Only requests (objects with an `id`) get a response; notifications
 * (including `notifications/initialized`) are dropped.
 */
import * as readline from "node:readline";

export const TOOL_NAME = "late_tool";
export const TOOL_RESULT = "MCP_LATE_CONNECT_OK_9d21";
export const INITIALIZE_DELAY_MS = 450;

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
				serverInfo: { name: "delayed-tool-fixture", version: "1.0.0" },
				capabilities: { tools: {} },
			};
		case "tools/list":
			return {
				tools: [
					{
						name: TOOL_NAME,
						description: "Fixture tool that only arrives after the startup race window.",
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

async function startServer(): Promise<void> {
	const markerPath = process.argv[2];
	const delayInitialize = !markerPath || !(await Bun.file(markerPath).exists());
	if (markerPath && delayInitialize) await Bun.write(markerPath, "");

	const rl = readline.createInterface({ input: process.stdin });
	rl.on("line", line => {
		void (async () => {
			const trimmed = line.trim();
			if (trimmed.length === 0) return;
			let msg: JsonRpcRequest;
			try {
				msg = JSON.parse(trimmed) as JsonRpcRequest;
			} catch {
				return;
			}
			if (msg.id === undefined || msg.id === null) return;
			if (msg.method === "initialize" && delayInitialize) {
				await Bun.sleep(INITIALIZE_DELAY_MS);
			}
			const response = { jsonrpc: "2.0" as const, id: msg.id, result: buildResult(msg.method) };
			process.stdout.write(`${JSON.stringify(response)}\n`);
		})();
	});
	rl.on("close", () => process.exit(0));
}

if (import.meta.main) {
	void startServer();
}
