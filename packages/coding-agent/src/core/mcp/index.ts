/**
 * MCP (Model Context Protocol) support.
 *
 * Provides per-project .mcp.json configuration for connecting to
 * MCP servers via stdio or HTTP transports.
 */

// Client
export { callTool, connectToServer, disconnectServer, listTools, serverSupportsTools } from "./client.js";

// Config
export {
	expandEnvVars,
	getMCPConfigPaths,
	loadAllMCPConfigs,
	loadMCPConfigFile,
	mergeMCPConfigs,
	validateServerConfig,
} from "./config.js";
// Loader (for SDK integration)
export type { MCPToolsLoadResult } from "./loader.js";
export { discoverAndLoadMCPTools } from "./loader.js";
// Manager
export type { MCPLoadResult } from "./manager.js";
export { createMCPManager, MCPManager } from "./manager.js";
// Tool bridge
export type { MCPToolDetails } from "./tool-bridge.js";
export { createMCPTool, createMCPToolName, createMCPTools, parseMCPToolName } from "./tool-bridge.js";
// Transports
export { createHttpTransport, HttpTransport } from "./transports/http.js";
export { createStdioTransport, StdioTransport } from "./transports/stdio.js";
// Types
export type {
	MCPConfigFile,
	MCPContent,
	MCPHttpServerConfig,
	MCPServerCapabilities,
	MCPServerConfig,
	MCPServerConnection,
	MCPSseServerConfig,
	MCPStdioServerConfig,
	MCPToolDefinition,
	MCPToolWithServer,
	MCPTransport,
} from "./types.js";
