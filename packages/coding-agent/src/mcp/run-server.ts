import { logger } from "@oh-my-pi/pi-utils";
import { Settings } from "../config/settings";
import { discoverAndLoadCustomTools } from "../extensibility/custom-tools/loader";
import { LocalHarnessAdapter } from "../harness/adapter";
import { ExternalHarnessController } from "../harness/external-mode";
import { createTools, type Tool, type ToolSession } from "../tools";
import { OhMyPiMcpServer } from "./server";

// Ensure stdio server runs without polluting stdout with non-JSON-RPC logs
logger.setTransports({ console: false, file: false });
console.log = (...args: unknown[]) => {
	console.error(...args);
};
console.info = (...args: unknown[]) => {
	console.error(...args);
};

const workspaceRoot = process.env.OMP_WORKSPACE_ROOT ?? "/home/coder/OhMyPi";

const session: ToolSession = {
	cwd: workspaceRoot,
	hasUI: false,
	skipPythonPreflight: true,
	settings: Settings.isolated(),
	getSessionId: () => "ohmypi-mcp-session",
	getSessionFile: () => null,
	getSessionSpawns: () => "*",
};

const tools = await createTools(session);
const toolRegistry = new Map<string, Tool>();
for (const tool of tools) {
	toolRegistry.set(tool.name, tool);
}

// Load custom/plugin tools headlessly. Loader executes plugin code on import; only
// trusted local sources are scanned. Errors go to stderr to keep stdout JSON-RPC clean.
try {
	const builtInToolNames = tools.map((tool) => tool.name);
	const loaded = await discoverAndLoadCustomTools([], workspaceRoot, builtInToolNames);
	for (const loadedTool of loaded.tools) {
		toolRegistry.set(loadedTool.tool.name, loadedTool.tool);
	}
	for (const error of loaded.errors) {
		console.error(`[ohmypi-mcp] custom tool load error: ${error.path}: ${error.error}`);
	}
} catch (error) {
	console.error(`[ohmypi-mcp] custom tool discovery failed: ${String(error)}`);
}

const harness = new LocalHarnessAdapter({
	session,
	toolRegistry,
	workspacePolicy: {
		cwd: workspaceRoot,
		readOnly: false,
		allowNetwork: true,
	},
});

for (const tool of toolRegistry.values()) {
	harness.registerTool(tool);
}

// External harness is deny-by-default. Only process-level env opt-in can enable it;
// project/plugin/model configuration can never grant external control.
const externalEnabled = process.env.OMP_EXTERNAL_HARNESS_ENABLED === "1";
const externalController = new ExternalHarnessController({
	enabled: externalEnabled,
	allowWrite: externalEnabled && process.env.OMP_EXTERNAL_HARNESS_ALLOW_WRITE === "1",
	allowExecution: externalEnabled && process.env.OMP_EXTERNAL_HARNESS_ALLOW_EXECUTION === "1",
	workspaceRoot,
	allowedTools: ["*"],
});

const server = new OhMyPiMcpServer(harness, {
	serverInfo: {
		name: "OhMyPi",
		version: "1.0.0",
	},
	externalController,
});

server.startStdioServer();

export { harness, externalController, server };
