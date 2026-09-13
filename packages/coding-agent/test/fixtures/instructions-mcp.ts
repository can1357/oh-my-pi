#!/usr/bin/env bun
/**
 * Test fixture: a minimal, well-behaved stdio MCP server that exposes
 * deterministic tools. By default it reports server-provided `instructions`
 * on `initialize`; its Context Mode fixture mode omits that field entirely,
 * and its resource-only mode advertises the resources capability instead of
 * tools while still reporting instructions.
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
/** Sentinel reported by the resource-only fixture mode, so tests can tell which server's text survived. */
export const RESOURCE_ONLY_INSTRUCTIONS =
	"RESOURCE_ONLY_FIXTURE_SENTINEL_7b1e4: this server only serves resources; keep its guidance.";

/** Default advertised tool; bounded and Context Mode fixture modes replace it. */
export const TOOL_NAME = "do`thing";
export const TOOL_RESULT = "MCP_DEFERRED_SMOKE_OK_5c92";
export const BOUNDED_GUIDANCE_MODE = "--bounded-guidance";
export const CONTEXT_MODE_NO_INSTRUCTIONS_MODE = "--context-mode-no-instructions";
/** Advertise only the resources capability (no tools) while still reporting instructions. */
export const RESOURCE_ONLY_MODE = "--resource-only";
const CONTEXT_MODE_TOOL_NAME = "ctx_execute";
/** One more tool than the 64-row prompt budget, forcing the static fallback. */
export const BOUNDED_GUIDANCE_TOOL_COUNT = 65;

type JsonRpcRequest = {
	jsonrpc: "2.0";
	id?: string | number;
	method: string;
	params?: Record<string, unknown>;
};

function buildResult(method: string): Record<string, unknown> {
	const contextModeWithoutInstructions = process.argv.includes(CONTEXT_MODE_NO_INSTRUCTIONS_MODE);
	const resourceOnly = process.argv.includes(RESOURCE_ONLY_MODE);
	switch (method) {
		case "initialize":
			return {
				protocolVersion: "2025-03-26",
				serverInfo: { name: "instr-fixture", version: "1.0.0" },
				// Declare only the tools capability so the client never probes
				// resources/list or prompts/list — keeps the fixture minimal.
				// Resource-only mode advertises resources instead of tools.
				capabilities: resourceOnly ? { resources: {} } : { tools: {} },
				...(contextModeWithoutInstructions
					? {}
					: { instructions: resourceOnly ? RESOURCE_ONLY_INSTRUCTIONS : SERVER_INSTRUCTIONS }),
			};
		case "tools/list": {
			// Resource-only mode advertises no tools; the client skips the call
			// when the capability is absent, but answer benignly if probed.
			if (resourceOnly) return { tools: [] };
			const tools = process.argv.includes(BOUNDED_GUIDANCE_MODE)
				? Array.from({ length: BOUNDED_GUIDANCE_TOOL_COUNT }, (_, index) => {
						const suffix = String.fromCharCode(97 + Math.floor(index / 26), 97 + (index % 26));
						return {
							name: `row_${suffix}`,
							description: `Bounded guidance fixture tool ${suffix}.`,
							inputSchema: { type: "object", properties: {}, additionalProperties: false },
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
		case "tools/call":
			return { content: [{ type: "text", text: TOOL_RESULT }], isError: false };
		case "resources/list":
			return { resources: [{ uri: "fixture://readme", name: "Fixture README" }] };
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
		const response = { jsonrpc: "2.0" as const, id: msg.id, result: buildResult(msg.method) };
		process.stdout.write(`${JSON.stringify(response)}\n`);
	});
	rl.on("close", () => process.exit(0));
}

if (import.meta.main) {
	startServer();
}
