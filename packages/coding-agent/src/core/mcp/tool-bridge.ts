/**
 * MCP to CustomTool bridge.
 *
 * Converts MCP tool definitions to CustomTool format for the agent.
 */

import type { TSchema } from "@sinclair/typebox";
import type { CustomTool, CustomToolResult } from "../custom-tools/types.js";
import { callTool } from "./client.js";
import type { MCPContent, MCPServerConnection, MCPToolDefinition } from "./types.js";

/** Details included in MCP tool results for rendering */
export interface MCPToolDetails {
	/** Server name */
	serverName: string;
	/** Original MCP tool name */
	mcpToolName: string;
	/** Whether the call resulted in an error */
	isError?: boolean;
	/** Raw content from MCP response */
	rawContent?: MCPContent[];
}

/**
 * Convert JSON Schema from MCP to TypeBox-compatible schema.
 * MCP uses standard JSON Schema, TypeBox uses a compatible subset.
 */
function convertSchema(mcpSchema: MCPToolDefinition["inputSchema"]): TSchema {
	// MCP schemas are JSON Schema objects, TypeBox can use them directly
	// as long as we ensure the structure is correct
	return mcpSchema as unknown as TSchema;
}

/**
 * Format MCP content for LLM consumption.
 */
function formatMCPContent(content: MCPContent[]): string {
	const parts: string[] = [];

	for (const item of content) {
		switch (item.type) {
			case "text":
				parts.push(item.text);
				break;
			case "image":
				parts.push(`[Image: ${item.mimeType}]`);
				break;
			case "resource":
				if (item.resource.text) {
					parts.push(`[Resource: ${item.resource.uri}]\n${item.resource.text}`);
				} else {
					parts.push(`[Resource: ${item.resource.uri}]`);
				}
				break;
		}
	}

	return parts.join("\n\n");
}

/**
 * Create a unique tool name for an MCP tool.
 * Prefixes with server name to avoid conflicts.
 */
export function createMCPToolName(serverName: string, toolName: string): string {
	// Use underscore separator since tool names can't have special chars
	return `mcp_${serverName}_${toolName}`;
}

/**
 * Parse an MCP tool name back to server and tool components.
 */
export function parseMCPToolName(name: string): { serverName: string; toolName: string } | null {
	if (!name.startsWith("mcp_")) return null;

	const rest = name.slice(4);
	const underscoreIdx = rest.indexOf("_");
	if (underscoreIdx === -1) return null;

	return {
		serverName: rest.slice(0, underscoreIdx),
		toolName: rest.slice(underscoreIdx + 1),
	};
}

/**
 * Convert an MCP tool definition to a CustomTool.
 */
export function createMCPTool(
	connection: MCPServerConnection,
	tool: MCPToolDefinition,
): CustomTool<TSchema, MCPToolDetails> {
	const name = createMCPToolName(connection.name, tool.name);
	const schema = convertSchema(tool.inputSchema);

	return {
		name,
		label: `${connection.name}/${tool.name}`,
		description: tool.description ?? `MCP tool from ${connection.name}`,
		parameters: schema,

		async execute(_toolCallId, params, _onUpdate, _ctx, _signal): Promise<CustomToolResult<MCPToolDetails>> {
			try {
				const result = await callTool(connection, tool.name, params as Record<string, unknown>);

				const text = formatMCPContent(result.content);
				const details: MCPToolDetails = {
					serverName: connection.name,
					mcpToolName: tool.name,
					isError: result.isError,
					rawContent: result.content,
				};

				if (result.isError) {
					return {
						content: [{ type: "text", text: `Error: ${text}` }],
						details,
					};
				}

				return {
					content: [{ type: "text", text }],
					details,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `MCP error: ${message}` }],
					details: {
						serverName: connection.name,
						mcpToolName: tool.name,
						isError: true,
					},
				};
			}
		},
	};
}

/**
 * Convert all tools from an MCP server to CustomTools.
 */
export function createMCPTools(
	connection: MCPServerConnection,
	tools: MCPToolDefinition[],
): CustomTool<TSchema, MCPToolDetails>[] {
	return tools.map((tool) => createMCPTool(connection, tool));
}
