/**
 * Exa MCP Types
 *
 * Types for the Exa MCP client and tool implementations.
 */

import type { TSchema } from "@sinclair/typebox";

/** MCP endpoint URLs */
export const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
export const WEBSETS_MCP_URL = "https://websetsmcp.exa.ai/mcp";

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

/** Researcher task status */
export interface ResearcherStatus {
	id: string;
	status: "pending" | "running" | "completed" | "failed";
	result?: string;
	error?: string;
}

/** Webset definition */
export interface Webset {
	id: string;
	name: string;
	description?: string;
	createdAt?: string;
	updatedAt?: string;
}

/** Webset item */
export interface WebsetItem {
	id: string;
	websetId: string;
	url: string;
	title?: string;
	content?: string;
	metadata?: Record<string, unknown>;
}

/** Webset search */
export interface WebsetSearch {
	id: string;
	websetId: string;
	query: string;
	status: "pending" | "running" | "completed" | "cancelled";
	resultCount?: number;
}

/** Webset enrichment */
export interface WebsetEnrichment {
	id: string;
	websetId: string;
	name: string;
	prompt: string;
	status: "pending" | "running" | "completed" | "cancelled";
}

/** Tool name mappings: MCP name -> our tool name */
export const EXA_TOOL_MAPPINGS = {
	// Search tools
	web_search_exa: "exa_search",
	get_code_context_exa: "exa_search_code",
	crawling: "exa_crawl",
	// LinkedIn
	linkedin_search: "exa_linkedin",
	// Company
	company_research: "exa_company",
	// Researcher
	deep_researcher_start: "exa_researcher_start",
	deep_researcher_check: "exa_researcher_poll",
} as const;

export const WEBSETS_TOOL_MAPPINGS = {
	create_webset: "webset_create",
	list_websets: "webset_list",
	get_webset: "webset_get",
	update_webset: "webset_update",
	delete_webset: "webset_delete",
	list_webset_items: "webset_items_list",
	get_item: "webset_item_get",
	create_search: "webset_search_create",
	get_search: "webset_search_get",
	cancel_search: "webset_search_cancel",
	create_enrichment: "webset_enrichment_create",
	get_enrichment: "webset_enrichment_get",
	update_enrichment: "webset_enrichment_update",
	delete_enrichment: "webset_enrichment_delete",
	cancel_enrichment: "webset_enrichment_cancel",
	create_monitor: "webset_monitor_create",
} as const;

export type ExaMcpToolName = keyof typeof EXA_TOOL_MAPPINGS;
export type WebsetsMcpToolName = keyof typeof WEBSETS_TOOL_MAPPINGS;
export type ExaToolName = (typeof EXA_TOOL_MAPPINGS)[ExaMcpToolName];
export type WebsetsToolName = (typeof WEBSETS_TOOL_MAPPINGS)[WebsetsMcpToolName];

/** Render details for TUI */
export interface ExaRenderDetails {
	response?: ExaSearchResponse;
	error?: string;
	toolName?: string;
	/** Raw result for non-search responses */
	raw?: unknown;
}
