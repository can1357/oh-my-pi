/**
 * MCP Client.
 *
 * Handles connection initialization, tool listing, and tool calling.
 */

import { createHttpTransport } from "./transports/http.js";
import { createStdioTransport } from "./transports/stdio.js";
import type {
	MCPHttpServerConfig,
	MCPInitializeParams,
	MCPInitializeResult,
	MCPServerCapabilities,
	MCPServerConfig,
	MCPServerConnection,
	MCPSseServerConfig,
	MCPStdioServerConfig,
	MCPToolCallParams,
	MCPToolCallResult,
	MCPToolDefinition,
	MCPToolsListResult,
	MCPTransport,
} from "./types.js";

/** MCP protocol version we support */
const PROTOCOL_VERSION = "2025-03-26";

/** Client info sent during initialization */
const CLIENT_INFO = {
	name: "pi-coding-agent",
	version: "1.0.0",
};

/**
 * Create a transport for the given server config.
 */
async function createTransport(config: MCPServerConfig): Promise<MCPTransport> {
	const serverType = config.type ?? "stdio";

	switch (serverType) {
		case "stdio":
			return createStdioTransport(config as MCPStdioServerConfig);
		case "http":
		case "sse":
			return createHttpTransport(config as MCPHttpServerConfig | MCPSseServerConfig);
		default:
			throw new Error(`Unknown server type: ${serverType}`);
	}
}

/**
 * Initialize connection with MCP server.
 */
async function initializeConnection(transport: MCPTransport): Promise<MCPInitializeResult> {
	const params: MCPInitializeParams = {
		protocolVersion: PROTOCOL_VERSION,
		capabilities: {
			roots: { listChanged: false },
		},
		clientInfo: CLIENT_INFO,
	};

	const result = await transport.request<MCPInitializeResult>(
		"initialize",
		params as unknown as Record<string, unknown>,
	);

	// Send initialized notification
	await transport.notify("notifications/initialized");

	return result;
}

/**
 * Connect to an MCP server.
 */
export async function connectToServer(name: string, config: MCPServerConfig): Promise<MCPServerConnection> {
	const transport = await createTransport(config);

	try {
		const initResult = await initializeConnection(transport);

		return {
			name,
			config,
			transport,
			serverInfo: initResult.serverInfo,
			capabilities: initResult.capabilities,
		};
	} catch (error) {
		await transport.close();
		throw error;
	}
}

/**
 * List tools from a connected server.
 */
export async function listTools(connection: MCPServerConnection): Promise<MCPToolDefinition[]> {
	// Check if server supports tools
	if (!connection.capabilities.tools) {
		return [];
	}

	// Return cached tools if available
	if (connection.tools) {
		return connection.tools;
	}

	const allTools: MCPToolDefinition[] = [];
	let cursor: string | undefined;

	do {
		const params: Record<string, unknown> = {};
		if (cursor) {
			params.cursor = cursor;
		}

		const result = await connection.transport.request<MCPToolsListResult>("tools/list", params);
		allTools.push(...result.tools);
		cursor = result.nextCursor;
	} while (cursor);

	// Cache tools
	connection.tools = allTools;

	return allTools;
}

/**
 * Call a tool on a connected server.
 */
export async function callTool(
	connection: MCPServerConnection,
	toolName: string,
	args: Record<string, unknown> = {},
): Promise<MCPToolCallResult> {
	const params: MCPToolCallParams = {
		name: toolName,
		arguments: args,
	};

	return connection.transport.request<MCPToolCallResult>("tools/call", params as unknown as Record<string, unknown>);
}

/**
 * Disconnect from a server.
 */
export async function disconnectServer(connection: MCPServerConnection): Promise<void> {
	await connection.transport.close();
}

/**
 * Check if a server supports tools.
 */
export function serverSupportsTools(capabilities: MCPServerCapabilities): boolean {
	return capabilities.tools !== undefined;
}
