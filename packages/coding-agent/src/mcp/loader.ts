/**
 * MCP tools loader.
 *
 * Integrates MCP tool discovery with the custom tools system.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { LoadedCustomTool } from "../extensibility/custom-tools/types";
import { AgentStorage } from "../session/agent-storage";
import type { AuthStorage } from "../session/auth-storage";
import { type MCPLoadResult, MCPManager } from "./manager";
import type { McpConnectionStatusEvent } from "./startup-events";
import { MCPToolCache } from "./tool-cache";

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
	/** Called when MCP server connection state changes. */
	onStatus?: (event: McpConnectionStatusEvent) => void;
	/** Whether to load project-level config (default: true) */
	enableProjectConfig?: boolean;
	/** Whether to filter out Exa MCP servers (default: true) */
	filterExa?: boolean;
	/** Whether to filter out browser MCP servers when the built-in browser capability is enabled (default: false) */
	filterBrowser?: boolean;
	/** SQLite storage for MCP tool cache (null disables cache) */
	cacheStorage?: AgentStorage | null;
	/** Auth storage used to resolve OAuth credentials before initial MCP connect */
	authStorage?: AuthStorage;
}

async function resolveToolCache(storage: AgentStorage | null | undefined): Promise<MCPToolCache | null> {
	if (storage === null) return null;
	try {
		const resolved = storage ?? (await AgentStorage.open());
		return new MCPToolCache(resolved);
	} catch (error) {
		logger.warn("MCP tool cache unavailable", { error: String(error) });
		return null;
	}
}

/**
 * Discover and load MCP tools from .mcp.json files.
 *
 * @param cwd Working directory (project root)
 * @param options Load options including progress callbacks
 * @returns MCP tools in LoadedCustomTool format for integration
 */
export async function discoverAndLoadMCPTools(cwd: string, options?: MCPToolsLoadOptions): Promise<MCPToolsLoadResult> {
	const toolCache = await resolveToolCache(options?.cacheStorage);
	const manager = new MCPManager(cwd, toolCache);
	if (options?.authStorage) {
		manager.setAuthStorage(options.authStorage);
	}

	let result: MCPLoadResult;
	try {
		result = await manager.discoverAndConnect({
			onStatus: options?.onStatus,
			enableProjectConfig: options?.enableProjectConfig,
			filterExa: options?.filterExa,
			filterBrowser: options?.filterBrowser,
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
		// MCPTool and DeferredMCPTool have these properties
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
