/**
 * MCP (Model Context Protocol) Servers Capability
 *
 * Canonical shape for MCP server configurations, regardless of source format.
 * All providers translate their native format to this shape.
 */

import type { MCPRequestIdFormat } from "../mcp/types";
import { defineCapability } from ".";
import type { SourceMeta } from "./types";

/**
 * Canonical MCP server configuration.
 */
export interface MCPServer {
	/** Server name (unique key) */
	name: string;
	/** Whether this server is enabled (default: true) */
	enabled?: boolean;
	/** Connection timeout in milliseconds */
	timeout?: number;
	/** Encoding for outgoing JSON-RPC request ids (default: `"number"`) */
	requestIdFormat?: MCPRequestIdFormat;
	/** Command to run (for stdio transport) */
	command?: string;
	/** Command arguments */
	args?: string[];
	/** Environment variables */
	env?: Record<string, string>;
	/**
	 * `literal`: env values are opaque plugin package data (Agent Plugins
	 * §§4.1/9.2) — exempt from env-name lookup and `!command` resolution.
	 */
	envPolicy?: "literal";
	/** Working directory for stdio transport */
	cwd?: string;
	/** URL (for HTTP/SSE transport) */
	url?: string;
	/** HTTP headers (for HTTP transport) */
	headers?: Record<string, string>;
	/**
	 * `origin-locked`: configured headers are literal package data pinned to the
	 * configured URL's origin (Agent Plugins §7.2.1) — never expanded, never
	 * forwarded cross-origin, and client-generated headers win case-insensitively.
	 */
	headerPolicy?: "origin-locked";
	/** Authentication configuration */
	auth?: {
		type: "oauth" | "apikey";
		credentialId?: string;
		tokenUrl?: string;
		clientId?: string;
		clientSecret?: string;
		resource?: string;
	};
	/** OAuth configuration for servers requiring explicit client credentials */
	oauth?: {
		clientId?: string;
		clientSecret?: string;
		scope?: string;
		redirectUri?: string;
		callbackPort?: number;
		callbackPath?: string;
		prompt?: string;
	};
	/** Transport type */
	transport?: "stdio" | "sse" | "http";
	/** Source metadata (added by loader) */
	_source: SourceMeta;
}

/** Compare the transport inputs that determine which MCP endpoint gets connected. */
function isSameMCPConnection(left: MCPServer, right: MCPServer): boolean {
	if (!Bun.deepEquals(left.auth, right.auth) || !Bun.deepEquals(left.oauth, right.oauth)) return false;
	// Normalize against the allocator's own default so an explicit "number" is
	// equivalent to leaving the option unset, not a distinct connection.
	if ((left.requestIdFormat ?? "number") !== (right.requestIdFormat ?? "number")) return false;

	const leftTransport = left.transport ?? (left.command ? "stdio" : left.url ? "http" : "stdio");
	const rightTransport = right.transport ?? (right.command ? "stdio" : right.url ? "http" : "stdio");
	if (leftTransport !== rightTransport) return false;

	if (leftTransport === "stdio") {
		return (
			left.command === right.command &&
			Bun.deepEquals(left.args, right.args) &&
			Bun.deepEquals(left.env, right.env) &&
			left.cwd === right.cwd
		);
	}

	return left.url === right.url && Bun.deepEquals(left.headers, right.headers);
}

export const mcpCapability = defineCapability<MCPServer>({
	id: "mcps",
	displayName: "MCP Servers",
	description: "Model Context Protocol server configurations for external tool integrations",
	key: server => server.name,
	equivalent: isSameMCPConnection,
	toExtensionId: server => `mcp:${server.name}`,
	validate: server => {
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
