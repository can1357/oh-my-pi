/**
 * MCP tools loader.
 *
 * Integrates MCP tool discovery with the custom tools system.
 */
import type { LoadedCustomTool } from "../extensibility/custom-tools/types";
import type { AuthStorage } from "../session/auth-storage";
import { type MCPDiscoverOptions, type MCPLoadResult, MCPManager } from "./manager";

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

/** Options for loading MCP tools: discovery options plus manager setup. */
export interface MCPToolsLoadOptions extends MCPDiscoverOptions {
	/** Linger of an unused shared server in milliseconds (`mcp.idleStopMinutes`); the manager default when absent. */
	idleStopMs?: number;
	/** Auth storage used to resolve OAuth credentials before initial MCP connect */
	authStorage?: AuthStorage;
}

/**
 * Discover and load MCP tools from .mcp.json files.
 *
 * @param cwd Working directory (project root)
 * @param options Load options including progress callbacks
 * @returns MCP tools in LoadedCustomTool format for integration
 */
export async function discoverAndLoadMCPTools(cwd: string, options?: MCPToolsLoadOptions): Promise<MCPToolsLoadResult> {
	const manager = new MCPManager(cwd, undefined, options?.idleStopMs);
	if (options?.authStorage) {
		manager.setAuthStorage(options.authStorage);
	}

	let result: MCPLoadResult;
	try {
		result = await manager.discoverAndConnect({
			onStatus: options?.onStatus,
			startupTimeoutMs: options?.startupTimeoutMs,
			enableProjectConfig: options?.enableProjectConfig,
			filterExa: options?.filterExa,
			filterBrowser: options?.filterBrowser,
			extensionRoots: options?.extensionRoots,
			builtinTransforms: options?.builtinTransforms,
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
	const loadedTools: LoadedCustomTool[] = result.tools.map(tool => {
		// MCPTool has these properties
		const mcpTool = tool as { mcpServerName?: string };
		const serverName = mcpTool.mcpServerName;

		// Get provider info from manager's connection if available
		const connection = serverName ? manager.getConnection(serverName) : undefined;
		const source = serverName ? manager.getSource(serverName) : undefined;
		const providerName =
			connection?._source?.providerName ?? source?.providerName ?? connection?._source?.provider ?? source?.provider;

		// Format path with provider info if available
		// Format: "mcp:serverName via providerName" (e.g., "mcp:agentx via Claude Code")
		const path = serverName && providerName ? `mcp:${serverName} via ${providerName}` : `mcp:${tool.name}`;

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
