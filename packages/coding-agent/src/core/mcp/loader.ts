/**
 * MCP tools loader.
 *
 * Integrates MCP tool discovery with the custom tools system.
 */

import type { LoadedCustomTool } from "../custom-tools/types.js";
import { type MCPLoadResult, MCPManager } from "./manager.js";

/** Result from loading MCP tools */
export interface MCPToolsLoadResult {
	/** MCP manager (for lifecycle management) */
	manager: MCPManager;
	/** Loaded tools as LoadedCustomTool format */
	tools: LoadedCustomTool[];
	/** Errors keyed by server name */
	errors: Array<{ path: string; error: string }>;
	/** Connected server names */
	connectedServers: string[];
}

/**
 * Discover and load MCP tools from .mcp.json files.
 *
 * @param cwd Working directory (project root)
 * @param extraEnv Additional environment variables for expansion
 * @returns MCP tools in LoadedCustomTool format for integration
 */
export async function discoverAndLoadMCPTools(
	cwd: string,
	extraEnv?: Record<string, string>,
): Promise<MCPToolsLoadResult> {
	const manager = new MCPManager(cwd);

	let result: MCPLoadResult;
	try {
		result = await manager.discoverAndConnect(extraEnv);
	} catch (error) {
		// If discovery fails entirely, return empty result
		const message = error instanceof Error ? error.message : String(error);
		return {
			manager,
			tools: [],
			errors: [{ path: ".mcp.json", error: message }],
			connectedServers: [],
		};
	}

	// Convert MCP tools to LoadedCustomTool format
	const loadedTools: LoadedCustomTool[] = result.tools.map((tool) => ({
		path: `mcp:${tool.name}`,
		resolvedPath: `mcp:${tool.name}`,
		tool: tool as any, // MCPToolDetails is compatible with CustomTool<TSchema, any>
	}));

	// Convert error map to array format
	const errors: Array<{ path: string; error: string }> = [];
	for (const [serverName, errorMsg] of result.errors) {
		errors.push({ path: `mcp:${serverName}`, error: errorMsg });
	}

	return {
		manager,
		tools: loadedTools,
		errors,
		connectedServers: result.connectedServers,
	};
}
