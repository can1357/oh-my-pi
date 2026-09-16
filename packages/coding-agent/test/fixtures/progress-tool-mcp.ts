#!/usr/bin/env bun
/**
 * Test fixture: a stdio MCP server whose tool takes far longer than the
 * client's configured request timeout and reports `notifications/progress`
 * while it works — the MCP keepalive a host-blocking tool (a question waiting
 * on a person, a slow build) relies on.
 *
 * `tools/call` echoes the `_meta.progressToken` it received, so a test can
 * prove the client actually asked for progress. Pass `silent` as the first
 * argument to work for just as long without reporting anything.
 *
 * Speaks newline-delimited JSON-RPC 2.0 (the wire format of `StdioTransport`):
 * one JSON object per line on stdin, one JSON response per line on stdout.
 * Notifications (no `id`) are dropped.
 */
import * as readline from "node:readline";

export const TOOL_NAME = "slow_progress_tool";
export const TOOL_RESULT = "MCP_PROGRESS_OK_4f71";
/** Progress steps reported before the tool answers. */
export const PROGRESS_STEPS = 8;
/** Gap between progress notifications, and so the longest silence a client sees. */
export const PROGRESS_INTERVAL_MS = 50;
/** Total time the tool works — deliberately several timeout windows long. */
export const TOOL_DURATION_MS = PROGRESS_STEPS * PROGRESS_INTERVAL_MS;

type JsonRpcRequest = {
	jsonrpc: "2.0";
	id?: string | number;
	method: string;
	params?: Record<string, unknown>;
};

function progressToken(params: Record<string, unknown> | undefined): string | number | null {
	const meta = params?._meta;
	if (typeof meta !== "object" || meta === null) return null;
	const token = (meta as Record<string, unknown>).progressToken;
	return typeof token === "string" || typeof token === "number" ? token : null;
}

function write(message: unknown): void {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function callTool(id: string | number, params: Record<string, unknown> | undefined, silent: boolean) {
	const token = progressToken(params);
	for (let step = 1; step <= PROGRESS_STEPS; step += 1) {
		await Bun.sleep(PROGRESS_INTERVAL_MS);
		if (silent || token === null) continue;
		write({
			jsonrpc: "2.0",
			method: "notifications/progress",
			params: { progressToken: token, progress: step, total: PROGRESS_STEPS },
		});
	}
	write({
		jsonrpc: "2.0",
		id,
		result: { content: [{ type: "text", text: `${TOOL_RESULT}:${token ?? "none"}` }], isError: false },
	});
}

function startServer(): void {
	const silent = process.argv[2] === "silent";
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
			switch (msg.method) {
				case "initialize":
					write({
						jsonrpc: "2.0",
						id: msg.id,
						result: {
							protocolVersion: "2025-06-18",
							serverInfo: { name: "progress-tool-fixture", version: "1.0.0" },
							capabilities: { tools: {} },
						},
					});
					return;
				case "tools/list":
					write({
						jsonrpc: "2.0",
						id: msg.id,
						result: {
							tools: [
								{
									name: TOOL_NAME,
									description: "Fixture tool that reports progress while it works.",
									inputSchema: { type: "object", properties: {}, additionalProperties: false },
								},
							],
						},
					});
					return;
				case "tools/call":
					await callTool(msg.id, msg.params, silent);
					return;
				default:
					write({ jsonrpc: "2.0", id: msg.id, result: {} });
			}
		})();
	});
	rl.on("close", () => process.exit(0));
}

if (import.meta.main) {
	startServer();
}
