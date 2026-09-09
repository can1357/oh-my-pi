/**
 * Exa MCP Types
 *
 * Types for the Exa MCP client and tool implementations.
 */
import type { TSchema } from "@oh-my-pi/pi-ai";

/** MCP tool definition from server */
export interface MCPTool {
	name: string;
	description: string;
	inputSchema: TSchema;
}

/** Tool wrapper config for dynamic MCP tool creation */
export interface MCPToolWrapperConfig {
	/** Our tool name (e.g., "exa_search") */
	name: string;
	/** Display label for UI */
	label: string;
	/** MCP tool name to call (e.g., "web_search_exa") */
	mcpToolName: string;
	/** Whether this is a websets tool (uses different MCP endpoint) */
	isWebsetsTool?: boolean;
}

/** MCP tools/list response */
export interface MCPToolsResponse {
	result?: {
		tools: MCPTool[];
	};
	error?: {
		code: number;
		message: string;
	};
}

/** MCP tools/call response */
export interface MCPCallResponse {
	result?: {
		content?: Array<{ type: string; text?: string }>;
	};
	error?: {
		code: number;
		message: string;
	};
}

/** Search result from Exa */
export interface ExaSearchResult {
	id?: string;
	title?: string;
	url?: string;
	author?: string;
	publishedDate?: string;
	text?: string;
	highlights?: string[];
	image?: string;
	favicon?: string;
}

/** Search response from Exa */
export interface ExaSearchResponse {
	results?: ExaSearchResult[];
	statuses?: Array<{ id: string; status: string; source?: string }>;
	costDollars?: { total: number };
	searchTime?: number;
	requestId?: string;
}
