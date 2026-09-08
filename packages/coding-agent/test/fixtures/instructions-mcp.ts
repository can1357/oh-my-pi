#!/usr/bin/env bun
/**
 * Test fixture: a minimal, well-behaved stdio MCP server that exposes
 * deterministic tools. By default it reports server-provided `instructions`
 * on `initialize`; its Context Mode fixture mode omits that field entirely.
 *
 * Used by `sdk-mcp-instructions.test.ts` to prove that deferred interactive
 * (`hasUI`) discovery rebuilds global mounted-route guidance independently of
 * optional server instructions, while still folding instructions into the
 * prompt when a connected server provides them.
 *
 * Speaks newline-delimited JSON-RPC 2.0 (the wire format of `StdioTransport`):
 * one JSON object per line on stdin, one JSON response per line on stdout.
 * Only requests (objects with an `id`) get a response; notifications are
 * dropped. Server-to-client requests are never sent — the client side only
 * needs `initialize` + `tools/list` answered to register the tool and capture
 * any optional instructions.
 *
 * Exported `SERVER_INSTRUCTIONS` is imported by the test for the assertion;
 * the server only starts when run as the entry module (`import.meta.main`), so
 * importing the constant never spawns a server in the test process.
 */
import * as readline from "node:readline";

/** Sentinel the test greps for in the rebuilt system prompt. */
export const SERVER_INSTRUCTIONS =
	"INSTR_FIXTURE_SENTINEL_3f9a2c: when this server is connected, always greet in Latin.";

/** Default advertised tool; bounded and Context Mode fixture modes replace it. */
export const TOOL_NAME = "do`thing";
export const TOOL_RESULT = "MCP_DEFERRED_SMOKE_OK_5c92";
export const BOUNDED_GUIDANCE_MODE = "--bounded-guidance";
export const CONTEXT_MODE_NO_INSTRUCTIONS_MODE = "--context-mode-no-instructions";
export const RESOURCE_GUIDANCE_MODE = "--resource-guidance";
const CONTEXT_MODE_TOOL_NAME = "ctx_execute";
/** One more tool than the 64-row prompt budget, forcing the static fallback. */
export const BOUNDED_GUIDANCE_TOOL_COUNT = 65;
let balance = 0;

type JsonRpcRequest = {
	jsonrpc: "2.0";
	id?: string | number;
	method: string;
	params?: Record<string, unknown>;
};

function buildResult(method: string, params?: Record<string, unknown>): Record<string, unknown> {
	const contextModeWithoutInstructions = process.argv.includes(CONTEXT_MODE_NO_INSTRUCTIONS_MODE);
	switch (method) {
		case "initialize":
			return {
				protocolVersion: "2025-03-26",
				serverInfo: { name: "instr-fixture", version: "1.0.0" },
				// Resource capability coverage keeps instructions eager even when every
				// tool is mounted, because resource reads have no tool-schema lookup.
				capabilities: { tools: {}, ...(process.argv.includes(RESOURCE_GUIDANCE_MODE) ? { resources: {} } : {}) },
				...(contextModeWithoutInstructions ? {} : { instructions: SERVER_INSTRUCTIONS }),
			};
		case "tools/list": {
			const tools = process.argv.includes(BOUNDED_GUIDANCE_MODE)
				? Array.from({ length: BOUNDED_GUIDANCE_TOOL_COUNT }, (_, index) => {
						const suffix = String.fromCharCode(97 + Math.floor(index / 26), 97 + (index % 26));
						return {
							name: `row_${suffix}`,
							description: `Bounded guidance fixture tool ${suffix}.`,
							inputSchema: {
								type: "object",
								properties: { delta: { type: "number" } },
								required: ["delta"],
								additionalProperties: false,
							},
						};
					})
				: [
						{
							name: contextModeWithoutInstructions ? CONTEXT_MODE_TOOL_NAME : TOOL_NAME,
							description: contextModeWithoutInstructions
								? "Execute code through the Context Mode fixture."
								: "Fixture tool returning a deterministic sentinel.",
							inputSchema: { type: "object", properties: {}, additionalProperties: false },
						},
					];
			return { tools };
		}
		case "tools/call": {
			if (!process.argv.includes(BOUNDED_GUIDANCE_MODE)) {
				return { content: [{ type: "text", text: TOOL_RESULT }], isError: false };
			}
			const name = typeof params?.name === "string" ? params.name : "";
			const args = params?.arguments;
			const delta = args && typeof args === "object" && "delta" in args ? args.delta : undefined;
			const rank = (name.charCodeAt(4) - 97) * 26 + name.charCodeAt(5) - 96;
			if (
				!/^row_[a-z]{2}$/.test(name) ||
				rank < 1 ||
				rank > BOUNDED_GUIDANCE_TOOL_COUNT ||
				typeof delta !== "number"
			) {
				return { content: [{ type: "text", text: "Invalid archive adjustment" }], isError: true };
			}
			balance += rank * delta;
			return { content: [{ type: "text", text: `balance=${balance}` }], isError: false };
		}
		case "resources/list":
			return { resources: [] };
		case "resources/templates/list":
			return { resourceTemplates: [] };
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
		const response = { jsonrpc: "2.0" as const, id: msg.id, result: buildResult(msg.method, msg.params) };
		process.stdout.write(`${JSON.stringify(response)}\n`);
	});
	rl.on("close", () => process.exit(0));
}

if (import.meta.main) {
	startServer();
}
