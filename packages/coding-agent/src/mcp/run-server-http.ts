/**
 * Dependency-free OhMyPi MCP HTTP entrypoint (Streamable HTTP, stateless).
 *
 * Exposes the same OhMyPiMcpServer over HTTP so remote/external MCP clients
 * (e.g. Copilot over network, curl, other harnesses) can connect without a
 * stdio subprocess. Same deny-by-default external-mode contract as the stdio
 * entrypoint: only process-level environment opt-in can enable external control.
 *
 *   OMP_MCP_HTTP_PORT=8931                  listen port (default 8931)
 *   OMP_MCP_HTTP_HOST=127.0.0.1             bind host (default 127.0.0.1)
 *   OMP_EXTERNAL_HARNESS_ENABLED=1          enable external harness mode
 *   OMP_EXTERNAL_HARNESS_ALLOW_WRITE=1      permit write/edit tools
 *   OMP_EXTERNAL_HARNESS_ALLOW_EXECUTION=1  permit bash
 *   OMP_WORKSPACE_ROOT=/path                workspace root (defaults to cwd)
 *
 * Endpoints:
 *   POST /mcp     JSON-RPC 2.0 request (single object) -> JSON-RPC response
 *   GET  /health  {"status":"ok","server":"OhMyPi"} liveness probe
 */
import { ExternalHarnessController } from "../harness/external-mode";
import { OhMyPiMcpServer } from "./server";
import { createStandaloneTools, discoverStandalonePlugins, StandaloneHarness } from "./standalone-harness";

const workspaceRoot = process.env.OMP_WORKSPACE_ROOT ?? process.cwd();

const harness = new StandaloneHarness(workspaceRoot, createStandaloneTools());

const pluginResult = await discoverStandalonePlugins(workspaceRoot);
for (const tool of pluginResult.tools) {
	harness.registerTool(tool);
}
for (const error of pluginResult.errors) {
	console.error(`[ohmypi-mcp] plugin load error: ${error}`);
}

const externalEnabled = process.env.OMP_EXTERNAL_HARNESS_ENABLED === "1";
const externalController = new ExternalHarnessController({
	enabled: externalEnabled,
	allowWrite: externalEnabled && process.env.OMP_EXTERNAL_HARNESS_ALLOW_WRITE === "1",
	allowExecution: externalEnabled && process.env.OMP_EXTERNAL_HARNESS_ALLOW_EXECUTION === "1",
	workspaceRoot,
	allowedTools: ["*"],
});

const server = new OhMyPiMcpServer(harness, {
	serverInfo: { name: "OhMyPi", version: "1.0.0" },
	externalController,
});

const port = Number(process.env.OMP_MCP_HTTP_PORT ?? 8931);
const hostname = process.env.OMP_MCP_HTTP_HOST ?? "127.0.0.1";

const jsonHeaders = {
	"Content-Type": "application/json",
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "POST, GET, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type, Mcp-Session-Id",
};

Bun.serve({
	port,
	hostname,
	async fetch(req) {
		const url = new URL(req.url);

		if (req.method === "OPTIONS") {
			return new Response(null, { status: 204, headers: jsonHeaders });
		}

		if (req.method === "GET" && url.pathname === "/health") {
			return Response.json(
				{ status: "ok", server: "OhMyPi", externalEnabled },
				{ headers: jsonHeaders },
			);
		}

		if (req.method === "POST" && (url.pathname === "/mcp" || url.pathname === "/")) {
			let body: unknown;
			try {
				body = await req.json();
			} catch {
				return Response.json(
					{ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
					{ status: 200, headers: jsonHeaders },
				);
			}
			const response = await server.handleMessage(body);
			// Notifications (no id) produce no response; acknowledge with 202.
			if (response === null || response === undefined) {
				return new Response(null, { status: 202, headers: jsonHeaders });
			}
			return Response.json(response, { headers: jsonHeaders });
		}

		return Response.json(
			{ jsonrpc: "2.0", id: null, error: { code: -32601, message: `Not found: ${url.pathname}` } },
			{ status: 404, headers: jsonHeaders },
		);
	},
});

console.error(`[ohmypi-mcp] HTTP listening on http://${hostname}:${port}/mcp (external=${externalEnabled})`);

export { harness, externalController, server };
