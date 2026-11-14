/**
 * Dependency-free OhMyPi MCP stdio entrypoint.
 *
 * Runs the MCP server over stdio using the standalone harness (Bun/Node builtins
 * only), so it works without `bun install`. External harness access is
 * deny-by-default and can only be enabled by process-level environment opt-in;
 * project/plugin/model configuration can never grant external control.
 *
 *   OMP_EXTERNAL_HARNESS_ENABLED=1        enable external harness mode
 *   OMP_EXTERNAL_HARNESS_ALLOW_WRITE=1    permit write/edit tools
 *   OMP_EXTERNAL_HARNESS_ALLOW_EXECUTION=1 permit bash
 *   OMP_WORKSPACE_ROOT=/path              workspace root (defaults to cwd)
 */
import { ExternalHarnessController } from "../harness/external-mode";
import { OhMyPiMcpServer } from "./server";
import { createStandaloneTools, discoverStandalonePlugins, StandaloneHarness } from "./standalone-harness";

// stdout is reserved for JSON-RPC framing; route all diagnostics to stderr.
console.log = (...args: unknown[]) => console.error(...args);
console.info = (...args: unknown[]) => console.error(...args);

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

server.startStdioServer();

export { harness, externalController, server };
