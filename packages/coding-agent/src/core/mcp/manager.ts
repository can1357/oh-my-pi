/**
 * MCP Server Manager.
 *
 * Discovers, connects to, and manages MCP servers.
 * Handles tool loading and lifecycle.
 */

import type { TSchema } from "@sinclair/typebox";
import type { CustomTool } from "../custom-tools/types.js";
import { connectToServer, disconnectServer, listTools } from "./client.js";
import { loadAllMCPConfigs, validateServerConfig } from "./config.js";
import type { MCPToolDetails } from "./tool-bridge.js";
import { createMCPTools } from "./tool-bridge.js";
import type { MCPServerConfig, MCPServerConnection } from "./types.js";

/** Result of loading MCP tools */
export interface MCPLoadResult {
	/** Loaded tools as CustomTool instances */
	tools: CustomTool<TSchema, MCPToolDetails>[];
	/** Connection errors by server name */
	errors: Map<string, string>;
	/** Connected server names */
	connectedServers: string[];
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
	async discoverAndConnect(extraEnv?: Record<string, string>): Promise<MCPLoadResult> {
		const configs = loadAllMCPConfigs(this.cwd, extraEnv);
		return this.connectServers(configs);
	}

	/**
	 * Connect to specific MCP servers.
	 */
	async connectServers(configs: Record<string, MCPServerConfig>): Promise<MCPLoadResult> {
		const errors = new Map<string, string>();
		const connectedServers: string[] = [];
		const allTools: CustomTool<TSchema, MCPToolDetails>[] = [];

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

			try {
				const connection = await connectToServer(name, config);
				this.connections.set(name, connection);
				connectedServers.push(name);

				// Load tools from this server
				const serverTools = await listTools(connection);
				const customTools = createMCPTools(connection, serverTools);
				allTools.push(...customTools);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				errors.set(name, message);
			}
		}

		// Update cached tools
		this.tools = allTools;

		return {
			tools: allTools,
			errors,
			connectedServers,
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
	extraEnv?: Record<string, string>,
): Promise<{
	manager: MCPManager;
	result: MCPLoadResult;
}> {
	const manager = new MCPManager(cwd);
	const result = await manager.discoverAndConnect(extraEnv);
	return { manager, result };
}
