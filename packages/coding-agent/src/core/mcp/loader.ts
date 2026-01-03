/**
 * MCP tools loader.
 *
 * Integrates MCP tool discovery with the custom tools system.
 */

import type { LoadedCustomTool } from "../custom-tools/types";
import { type MCPLoadResult, MCPManager } from "./manager";
import { parseMCPToolName } from "./tool-bridge";

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
	/** Extracted Exa API keys from filtered MCP servers */
	exaApiKeys: string[];
}

/** Options for loading MCP tools */
export interface MCPToolsLoadOptions {
	/** Called when starting to connect to servers */
	onConnecting?: (serverNames: string[]) => void;
	/** Whether to load project-level config (default: true) */
	enableProjectConfig?: boolean;
	/** Whether to filter out Exa MCP servers (default: true) */
	filterExa?: boolean;
}

/**
 * Discover and load MCP tools from .mcp.json files.
 *
 * @param cwd Working directory (project root)
 * @param options Load options including progress callbacks
 * @returns MCP tools in LoadedCustomTool format for integration
 */
export async function discoverAndLoadMCPTools(cwd: string, options?: MCPToolsLoadOptions): Promise<MCPToolsLoadResult> {
	const manager = new MCPManager(cwd);

	let result: MCPLoadResult;
	try {
		result = await manager.discoverAndConnect({
			onConnecting: options?.onConnecting,
			enableProjectConfig: options?.enableProjectConfig,
			filterExa: options?.filterExa,
		});
	} catch (error) {
		// If discovery fails entirely, return empty result
		const message = error instanceof Error ? error.message : String(error);
		return {
			manager,
			tools: [],
			errors: [{ path: ".mcp.json", error: message }],
			connectedServers: [],
			exaApiKeys: [],
		};
	}

	// Convert MCP tools to LoadedCustomTool format
	const loadedTools: LoadedCustomTool[] = result.tools.map((tool) => {
		// Parse the MCP tool name to get server name
		const parsed = parseMCPToolName(tool.name);
		const serverName = parsed?.serverName;

		// Get provider info from manager's connection if available
		const connection = serverName ? manager.getConnection(serverName) : undefined;
		const provider = connection?._source?.provider;

		// Format path with provider info if available
		// Format: "mcp:serverName via providerName" (e.g., "mcp:agentx via Claude Code")
		const path =
			provider && serverName ? `mcp:${serverName} via ${connection._source!.providerName}` : `mcp:${tool.name}`;

		return {
			path,
			resolvedPath: `mcp:${tool.name}`,
			tool: tool as any, // MCPToolDetails is compatible with CustomTool<TSchema, any>
		};
	});

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
		exaApiKeys: result.exaApiKeys,
	};
}
