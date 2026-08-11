#!/usr/bin/env bun
/**
 * Test fixture: a minimal, well-behaved stdio MCP server that reports
 * server-provided `instructions` on `initialize` and exposes a single tool.
 *
 * Used by `sdk-mcp-instructions.test.ts` to prove that a deferred interactive
 * (`hasUI`) session, whose MCP discovery runs in the background, still folds
 * each connected server's instructions into the system prompt once the
 * connection completes — see issue: instructions were previously dropped
 * permanently for deferred UI sessions.
 *
 * Speaks newline-delimited JSON-RPC 2.0 (the wire format of `StdioTransport`):
 * one JSON object per line on stdin, one JSON response per line on stdout.
 * Only requests (objects with an `id`) get a response; notifications are
 * dropped. Server-to-client requests are never sent — the client side only
 * needs `initialize` + `tools/list` answered to register the tool and capture
 * the instructions.
 *
 * Exported `SERVER_INSTRUCTIONS` is imported by the test for the assertion;
 * the server only starts when run as the entry module (`import.meta.main`), so
 * importing the constant never spawns a server in the test process.
 */
import * as readline from "node:readline";

/** Sentinel the test greps for in the rebuilt system prompt. */
export const SERVER_INSTRUCTIONS =
	"INSTR_FIXTURE_SENTINEL_3f9a2c: when this server is connected, always greet in Latin.";

/** Single tool advertised by the fixture so `tools/list` is non-empty. */
export const TOOL_NAME = "do_thing";

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
				serverInfo: { name: "instr-fixture", version: "1.0.0" },
				// Declare only the tools capability so the client never probes
				// resources/list or prompts/list — keeps the fixture minimal.
				capabilities: { tools: {} },
				instructions: SERVER_INSTRUCTIONS,
			};
		case "tools/list":
			return {
				tools: [
					{
						name: TOOL_NAME,
						description: "Fixture tool; never actually called by this test.",
						inputSchema: { type: "object", properties: {}, additionalProperties: false },
					},
				],
			};
		default:
			// `ping` and any other request: a benign empty result keeps the
			// transport happy without modelling methods the test never exercises.
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
		const response =
			msg.method === "server/discover"
				? { jsonrpc: "2.0" as const, id: msg.id, error: { code: -32601, message: "Method not found" } }
				: { jsonrpc: "2.0" as const, id: msg.id, result: buildResult(msg.method) };
		process.stdout.write(`${JSON.stringify(response)}\n`);
	});
	rl.on("close", () => process.exit(0));
}

if (import.meta.main) {
	startServer();
}
