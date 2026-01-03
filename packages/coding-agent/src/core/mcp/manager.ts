/**
 * MCP Server Manager.
 *
 * Discovers, connects to, and manages MCP servers.
 * Handles tool loading and lifecycle.
 */

import type { TSchema } from "@sinclair/typebox";
import type { CustomTool } from "../custom-tools/types";
import { connectToServer, disconnectServer, listTools } from "./client";
import { loadAllMCPConfigs, validateServerConfig } from "./config";
import type { MCPToolDetails } from "./tool-bridge";
import { createMCPTools } from "./tool-bridge";
import type { MCPServerConfig, MCPServerConnection } from "./types";

/** Result of loading MCP tools */
export interface MCPLoadResult {
	/** Loaded tools as CustomTool instances */
	tools: CustomTool<TSchema, MCPToolDetails>[];
	/** Connection errors by server name */
	errors: Map<string, string>;
	/** Connected server names */
	connectedServers: string[];
	/** Extracted Exa API keys from filtered MCP servers */
	exaApiKeys: string[];
}

/** Options for discovering and connecting to MCP servers */
export interface MCPDiscoverOptions {
	/** Whether to load project-level config (default: true) */
	enableProjectConfig?: boolean;
	/** Whether to filter out Exa MCP servers (default: true) */
	filterExa?: boolean;
	/** Called when starting to connect to servers */
	onConnecting?: (serverNames: string[]) => void;
}

/**
 * MCP Server Manager.
 *
 * Manages connections to MCP servers and provides tools to the agent.
 */
export class MCPManager {
	private connections = new Map<string, MCPServerConnection>();
	private tools: CustomTool<TSchema, MCPToolDetails>[] = [];

	constructor(private cwd: string) {}

	/**
	 * Discover and connect to all MCP servers from .mcp.json files.
	 * Returns tools and any connection errors.
	 */
	async discoverAndConnect(options?: MCPDiscoverOptions): Promise<MCPLoadResult> {
		const { configs, exaApiKeys, sources } = await loadAllMCPConfigs(this.cwd, {
			enableProjectConfig: options?.enableProjectConfig,
			filterExa: options?.filterExa,
		});
		const result = await this.connectServers(configs, sources, options?.onConnecting);
		result.exaApiKeys = exaApiKeys;
		return result;
	}

	/**
	 * Connect to specific MCP servers.
	 * Connections are made in parallel for faster startup.
	 */
	async connectServers(
		configs: Record<string, MCPServerConfig>,
		sources: Record<string, import("../../capability/types").SourceMeta>,
		onConnecting?: (serverNames: string[]) => void,
	): Promise<MCPLoadResult> {
		const errors = new Map<string, string>();
		const connectedServers: string[] = [];
		const allTools: CustomTool<TSchema, MCPToolDetails>[] = [];

		// Prepare connection tasks
		const connectionTasks: Array<{
			name: string;
			config: MCPServerConfig;
			validationErrors: string[];
		}> = [];

		for (const [name, config] of Object.entries(configs)) {
			// Skip if already connected
			if (this.connections.has(name)) {
				connectedServers.push(name);
				continue;
			}

			// Validate config
			const validationErrors = validateServerConfig(name, config);
			if (validationErrors.length > 0) {
				errors.set(name, validationErrors.join("; "));
				continue;
			}

			connectionTasks.push({ name, config, validationErrors });
		}

		// Notify about servers we're connecting to
		if (connectionTasks.length > 0 && onConnecting) {
			onConnecting(connectionTasks.map((t) => t.name));
		}

		// Connect to all servers in parallel
		const results = await Promise.allSettled(
			connectionTasks.map(async ({ name, config }) => {
				const connection = await connectToServer(name, config);
				// Attach source metadata to connection
				if (sources[name]) {
					connection._source = sources[name];
				}
				const serverTools = await listTools(connection);
				return { name, connection, serverTools };
			}),
		);

		// Process results
		for (let i = 0; i < results.length; i++) {
			const result = results[i];
			const { name } = connectionTasks[i];

			if (result.status === "fulfilled") {
				const { connection, serverTools } = result.value;
				this.connections.set(name, connection);
				connectedServers.push(name);

				const customTools = createMCPTools(connection, serverTools);
				allTools.push(...customTools);
			} else {
				const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
				errors.set(name, message);
			}
		}

		// Update cached tools
		this.tools = allTools;

		return {
			tools: allTools,
			errors,
			connectedServers,
			exaApiKeys: [], // Will be populated by discoverAndConnect
		};
	}

	/**
	 * Get all loaded tools.
	 */
	getTools(): CustomTool<TSchema, MCPToolDetails>[] {
		return this.tools;
	}

	/**
	 * Get a specific connection.
	 */
	getConnection(name: string): MCPServerConnection | undefined {
		return this.connections.get(name);
	}

	/**
	 * Get all connected server names.
	 */
	getConnectedServers(): string[] {
		return Array.from(this.connections.keys());
	}

	/**
	 * Disconnect from a specific server.
	 */
	async disconnectServer(name: string): Promise<void> {
		const connection = this.connections.get(name);
		if (!connection) return;

		await disconnectServer(connection);
		this.connections.delete(name);

		// Remove tools from this server
		this.tools = this.tools.filter((t) => !t.name.startsWith(`mcp_${name}_`));
	}

	/**
	 * Disconnect from all servers.
	 */
	async disconnectAll(): Promise<void> {
		const promises = Array.from(this.connections.values()).map((conn) => disconnectServer(conn));
		await Promise.allSettled(promises);

		this.connections.clear();
		this.tools = [];
	}

	/**
	 * Refresh tools from a specific server.
	 */
	async refreshServerTools(name: string): Promise<void> {
		const connection = this.connections.get(name);
		if (!connection) return;

		// Clear cached tools
		connection.tools = undefined;

		// Reload tools
		const serverTools = await listTools(connection);
		const customTools = createMCPTools(connection, serverTools);

		// Replace tools from this server
		this.tools = this.tools.filter((t) => !t.name.startsWith(`mcp_${name}_`));
		this.tools.push(...customTools);
	}

	/**
	 * Refresh tools from all servers.
	 */
	async refreshAllTools(): Promise<void> {
		const promises = Array.from(this.connections.keys()).map((name) => this.refreshServerTools(name));
		await Promise.allSettled(promises);
	}
}

/**
 * Create an MCP manager and discover servers.
 * Convenience function for quick setup.
 */
export async function createMCPManager(
	cwd: string,
	options?: MCPDiscoverOptions,
): Promise<{
	manager: MCPManager;
	result: MCPLoadResult;
}> {
	const manager = new MCPManager(cwd);
	const result = await manager.discoverAndConnect(options);
	return { manager, result };
}
