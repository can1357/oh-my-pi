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
	/**
	 * Connect on first use instead of at startup. Startup serves the tool
	 * definitions cached from the last successful connect; the first tool
	 * invocation (or `/mcp reconnect`) establishes the real connection.
	 */
	lazy?: boolean;
	/** Connection timeout in milliseconds */
	timeout?: number;
	/** Encoding for outgoing JSON-RPC request ids (default: `"number"`) */
	requestIdFormat?: MCPRequestIdFormat;
	/** Include server-provided instructions in the system prompt (default: true) */
	instructions?: boolean;
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
	/** Env keys whose values are final package data (expanded by the provider). */
	envLiteralKeys?: string[];
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
	/**
	 * The connection fields as the config file wrote them, where they differ
	 * from the fields above: before the provider expanded `${VAR}` placeholders
	 * or read an env-forwarded value, a `{file:...}` reference or a plugin root.
	 * The tool cache keys the server's catalog on them (`attachConfigAsWritten`
	 * in `mcp/tool-cache.ts`), so a rotated credential keeps the catalog.
	 */
	asWritten?: MCPServerAsWritten;
	/** Source metadata (added by loader) */
	_source: SourceMeta;
}

/** The {@link MCPServer} connection fields a provider can fill from values it reads at load time. */
export type MCPServerAsWritten = Partial<
	Pick<MCPServer, "command" | "args" | "env" | "cwd" | "url" | "headers" | "auth" | "oauth">
>;

/**
 * Compare the transport inputs that determine which MCP endpoint gets
 * connected. This is discovery's dedup: `mcpCapability.equivalent`, which
 * decides whether two providers' entries for one server name are the same
 * definition or a conflict.
 *
 * It is **not** the same partition as `sameMcpServerIdentity` in
 * `mcp/tool-cache.ts`, which the tool cache and the crash-burst breaker
 * share, and the two must not be assumed to agree. Measured, in both
 * directions:
 *
 * - `envPolicy: "literal"` over `{A, B}` against `envLiteralKeys: ["B","A"]`
 *   over the same env: same here (the effective literal sets match), a
 *   different server there (`envPolicy` is a field of its own).
 * - `oauth: { prompt: "login" }` against no `oauth`: a different connection
 *   here (`oauth` is compared whole), the same server there (the browser
 *   login is policy).
 *
 * Both divergences are conservative today — an extra dedup entry, an extra
 * crash budget, an extra cache miss, never a shared catalogue — which is why
 * they stand. Unifying the two predicates would change discovery's dedup,
 * the breaker and the cache at once; whoever tries it owns all three.
 */
export function isSameMCPConnection(left: MCPServer, right: MCPServer): boolean {
	if (!Bun.deepEquals(left.auth, right.auth) || !Bun.deepEquals(left.oauth, right.oauth)) return false;
	// Normalize against the allocator's own default so an explicit "number" is
	// equivalent to leaving the option unset, not a distinct connection.
	if ((left.requestIdFormat ?? "number") !== (right.requestIdFormat ?? "number")) return false;

	const leftTransport = left.transport ?? (left.command ? "stdio" : left.url ? "http" : "stdio");
	const rightTransport = right.transport ?? (right.command ? "stdio" : right.url ? "http" : "stdio");
	if (leftTransport !== rightTransport) return false;

	if (leftTransport === "stdio") {
		// Effective literal keys: `envPolicy: "literal"` makes every env value
		// literal (equivalent to an envLiteralKeys set covering all keys), and an
		// inert policy on an env-less server must not distinguish otherwise
		// identical connections. Insertion order is irrelevant; compare as sets.
		const literalKeysOf = (server: MCPServer): string[] =>
			server.envPolicy === "literal"
				? Object.keys(server.env ?? {}).sort()
				: [...(server.envLiteralKeys ?? [])].sort();
		return (
			left.command === right.command &&
			Bun.deepEquals(left.args, right.args) &&
			Bun.deepEquals(left.env, right.env) &&
			Bun.deepEquals(literalKeysOf(left), literalKeysOf(right)) &&
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
