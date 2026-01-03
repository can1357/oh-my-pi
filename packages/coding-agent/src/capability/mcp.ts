/**
 * MCP (Model Context Protocol) Servers Capability
 *
 * Canonical shape for MCP server configurations, regardless of source format.
 * All providers translate their native format to this shape.
 */

import { defineCapability } from "./index";
import type { SourceMeta } from "./types";

/**
 * Canonical MCP server configuration.
 */
export interface MCPServer {
	/** Server name (unique key) */
	name: string;
	/** Command to run (for stdio transport) */
	command?: string;
	/** Command arguments */
	args?: string[];
	/** Environment variables */
	env?: Record<string, string>;
	/** URL (for HTTP/SSE transport) */
	url?: string;
	/** HTTP headers (for HTTP transport) */
	headers?: Record<string, string>;
	/** Transport type */
	transport?: "stdio" | "sse" | "http";
	/** Source metadata (added by loader) */
	_source: SourceMeta;
}

export const mcpCapability = defineCapability<MCPServer>({
	id: "mcps",
	displayName: "MCP Servers",
	description: "Model Context Protocol server configurations for external tool integrations",
	key: (server) => server.name,
	validate: (server) => {
		if (!server.name) return "Missing server name";
		if (!server.command && !server.url) return "Must have command or url";

		// Validate transport-endpoint pairing
		if (server.transport === "stdio" && !server.command) {
			return "stdio transport requires command field";
		}
		if ((server.transport === "http" || server.transport === "sse") && !server.url) {
			return "http/sse transport requires url field";
		}

		return undefined;
	},
});
