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
 * dropped. By default no server-to-client request is sent — the client side
 * only needs `initialize` + `tools/list` answered to register the tool and
 * capture any optional instructions. `ROOTS_ECHO_MODE` makes `tools/call` ask
 * the client `roots/list` and answer with the first root's URI, so a test can
 * observe which workspace root the client reports.
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
const CONTEXT_MODE_TOOL_NAME = "ctx_execute";
/** One more tool than the 64-row prompt budget, forcing the static fallback. */
export const BOUNDED_GUIDANCE_TOOL_COUNT = 65;
/** Gives the default tool a schema whose rendered docs exceed the per-device prompt cap. */
export const OVERSIZED_SCHEMA_MODE = "--oversized-schema";
/** `tools/call` answers with the URI of the client's first `roots/list` root. */
export const ROOTS_ECHO_MODE = "--roots-echo";

function defaultInputSchema(): Record<string, unknown> {
	if (!process.argv.includes(OVERSIZED_SCHEMA_MODE)) {
		return { type: "object", properties: {}, additionalProperties: false };
	}
	const properties = Object.fromEntries(
		Array.from({ length: 400 }, (_, index) => [
			`field_${index}`,
			{ type: "string", description: `Oversized schema fixture field ${index}.` },
		]),
	);
	return { type: "object", properties, additionalProperties: false };
}

type JsonRpcRequest = {
	jsonrpc: "2.0";
	id?: string | number;
	method: string;
	params?: Record<string, unknown>;
};

function buildResult(method: string): Record<string, unknown> {
	const contextModeWithoutInstructions = process.argv.includes(CONTEXT_MODE_NO_INSTRUCTIONS_MODE);
	switch (method) {
		case "initialize":
			return {
				protocolVersion: "2025-03-26",
				serverInfo: { name: "instr-fixture", version: "1.0.0" },
				// Declare only the tools capability so the client never probes
				// resources/list or prompts/list — keeps the fixture minimal.
				capabilities: { tools: {} },
				...(contextModeWithoutInstructions ? {} : { instructions: SERVER_INSTRUCTIONS }),
			};
		case "tools/list": {
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
							inputSchema: defaultInputSchema(),
						},
					];
			return { tools };
		}
		case "tools/call":
			return { content: [{ type: "text", text: TOOL_RESULT }], isError: false };
		default:
			// `ping` and any other request: a benign empty result keeps the
			// transport happy without modelling methods the test never exercises.
			return {};
	}
}

/** The client's reply to a server-to-client request. */
type JsonRpcResponse = { jsonrpc: "2.0"; id: string | number; result?: { roots?: Array<{ uri: string }> } };

function startServer(): void {
	const rl = readline.createInterface({ input: process.stdin });
	const write = (message: object) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
	/** `tools/call` ids awaiting the client's `roots/list` reply, keyed by that request's id. */
	const pendingRootCalls = new Map<string, string | number>();
	let nextRootsRequest = 0;
	rl.on("line", line => {
		const trimmed = line.trim();
		if (trimmed.length === 0) return;
		let msg: JsonRpcRequest | JsonRpcResponse;
		try {
			msg = JSON.parse(trimmed) as JsonRpcRequest | JsonRpcResponse;
		} catch {
			return;
		}
		if (!("method" in msg)) {
			const callId = pendingRootCalls.get(String(msg.id));
			if (callId === undefined) return;
			pendingRootCalls.delete(String(msg.id));
			const uri = msg.result?.roots?.[0]?.uri ?? "";
			write({ id: callId, result: { content: [{ type: "text", text: uri }], isError: false } });
			return;
		}
		// Notifications (no `id`) get no response.
		if (msg.id === undefined || msg.id === null) return;
		if (msg.method === "tools/call" && process.argv.includes(ROOTS_ECHO_MODE)) {
			const rootsId = `roots-${nextRootsRequest++}`;
			pendingRootCalls.set(rootsId, msg.id);
			write({ id: rootsId, method: "roots/list" });
			return;
		}
		write({ id: msg.id, result: buildResult(msg.method) });
	});
	rl.on("close", () => process.exit(0));
}

if (import.meta.main) {
	startServer();
}
