import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { MCPProgress } from "../mcp-progress";
import type { OutputMeta } from "../output-meta-format";
import { visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { flattenLine, shortenEmbeddedPaths } from "../../utils/render-utils";
import { truncateToWidth } from "../../utils/text-width";

/** Content types in tool results */
export interface MCPTextContent {
	type: "text";
	text: string;
}

/** Base64-encoded image returned by an MCP tool. */
export interface MCPImageContent {
	type: "image";
	data: string; // base64
	mimeType: string;
}

/** Base64-encoded audio returned by an MCP tool or prompt. */
export interface MCPAudioContent {
	type: "audio";
	data: string; // base64
	mimeType: string;
}

/** Link to a server resource, read separately (`resources/read`). */
export interface MCPResourceLinkContent {
	type: "resource_link";
	uri: string;
	name?: string;
	title?: string;
	description?: string;
	mimeType?: string;
}

/** Embedded text or binary resource returned by an MCP tool. */
export interface MCPResourceContent {
	type: "resource";
	resource: {
		uri: string;
		mimeType?: string;
		text?: string;
		blob?: string;
	};
}

/** Supported MCP result content blocks retained in display metadata. */
export type MCPContent =
	| MCPTextContent
	| MCPImageContent
	| MCPAudioContent
	| MCPResourceContent
	| MCPResourceLinkContent;

/** One-line progress text (`message (3/10)`) within `maxWidth` cells. */
export function formatMCPProgress(progress: MCPProgress, maxWidth = 200): string {
	const message =
		progress.message === undefined ? "" : shortenEmbeddedPaths(flattenLine(sanitizeText(progress.message)));
	const amount = progress.total === undefined ? `${progress.progress}` : `${progress.progress}/${progress.total}`;
	if (!message) return truncateToWidth(amount, maxWidth);
	if (progress.total === undefined) return truncateToWidth(message, maxWidth);
	const suffix = ` (${amount})`;
	const messageWidth = maxWidth - visibleWidth(suffix);
	return messageWidth > 0 ? `${truncateToWidth(message, messageWidth)}${suffix}` : truncateToWidth(amount, maxWidth);
}

/** MCP result details shared by renderers and programmatic tool consumers. */
export interface MCPToolDetails {
	/** Server name */
	serverName: string;
	/** Original MCP tool name */
	mcpToolName: string;
	/** Whether the call resulted in an error */
	isError?: boolean;
	/** Raw content from MCP response */
	rawContent?: MCPContent[];
	/** Server-supplied structured data, independent of the model-facing text rendering. */
	structuredContent?: Record<string, unknown>;
	/** Structured metadata from the MCP response */
	mcpMeta?: Record<string, unknown>;
	/** Provider ID (e.g., "claude", "mcp-json") */
	provider?: string;
	/** Provider display name (e.g., "Claude Code", "MCP Config") */
	providerName?: string;
	/** Latest progress of a running call; present only on partial updates. */
	progress?: MCPProgress;
	/** Structured output metadata (set by the spill wrapper when output is truncated to an artifact). */
	meta?: OutputMeta;
}

/** Registry prefix every minted MCP tool name carries. */
export const MCP_TOOL_NAME_PREFIX = "mcp__";

/**
 * Parse an MCP tool name back to server and tool components.
 *
 * Note: This returns the normalized tool name (with server prefix stripped).
 * The original MCP tool name may have had the server name as a prefix.
 */
export function parseMCPToolName(name: string): { serverName: string; toolName: string } | null {
	if (!name.startsWith(MCP_TOOL_NAME_PREFIX)) return null;

	const rest = name.slice(MCP_TOOL_NAME_PREFIX.length);
	const underscoreIdx = rest.indexOf("_");
	if (underscoreIdx === -1) return null;

	return {
		serverName: rest.slice(0, underscoreIdx),
		toolName: rest.slice(underscoreIdx + 1),
	};
}
