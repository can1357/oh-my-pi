#!/usr/bin/env bun
/**
 * Test fixture: a minimal stdio MCP server that advertises MANY tools, used by
 * `sdk-mcp-auto-discovery.test.ts` to prove two deferred-discovery contracts:
 *
 * 1. `tools.discoveryMode: "auto"` is recomputed once the real MCP tool count
 *    is known — a toolset this large must flip discovery ON for a session whose
 *    pre-discovery registry was under the threshold, instead of force-activating
 *    every tool with no `search_tool_bm25` registered.
 * 2. A session disposed while the server is still connecting must disconnect
 *    the manager and never have MCP tools resurrected onto it. The optional
 *    `--delay <ms>` argv stalls the `initialize` response so the test can
 *    deterministically dispose mid-connect.
 *
 * Speaks newline-delimited JSON-RPC 2.0 (the wire format of `StdioTransport`),
 * same shape as `instructions-mcp.ts`. Exported constants are imported by the
 * test; the server only starts when run as the entry module (`import.meta.main`).
 */
import * as readline from "node:readline";

/** Enough tools to push any small session past TOOL_DISCOVERY_AUTO_THRESHOLD (40). */
export const MANY_TOOL_COUNT = 45;

/** Alphabetic names: MCP tool-name sanitization strips digits, so numeric
 *  suffixes like `tool_01` would all collapse into one colliding name. */
export function manyToolName(index: number): string {
	const hi = String.fromCharCode(97 + Math.floor(index / 26));
	const lo = String.fromCharCode(97 + (index % 26));
	return `tool_${hi}${lo}`;
}

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
				serverInfo: { name: "many-fixture", version: "1.0.0" },
				capabilities: { tools: {} },
			};
		case "tools/list":
			return {
				tools: Array.from({ length: MANY_TOOL_COUNT }, (_, i) => ({
					name: manyToolName(i),
					description: `Fixture tool #${i}; never actually called by the test.`,
					inputSchema: { type: "object", properties: {}, additionalProperties: false },
				})),
			};
		default:
			return {};
	}
}

function startServer(): void {
	const delayIndex = process.argv.indexOf("--delay");
	const initializeDelayMs = delayIndex >= 0 ? Number(process.argv[delayIndex + 1]) || 0 : 0;
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
			// Notifications (no `id`) get no response.
			if (msg.id === undefined || msg.id === null) return;
			if (msg.method === "initialize" && initializeDelayMs > 0) {
				await Bun.sleep(initializeDelayMs);
			}
			const response = { jsonrpc: "2.0" as const, id: msg.id, result: buildResult(msg.method) };
			process.stdout.write(`${JSON.stringify(response)}\n`);
		})();
	});
	rl.on("close", () => process.exit(0));
}

if (import.meta.main) {
	startServer();
}
