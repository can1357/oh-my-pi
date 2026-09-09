/**
 * MCP (Model Context Protocol) type definitions.
 *
 * Based on MCP specification 2025-11-25:
 * https://modelcontextprotocol.io/specification/2025-11-25/
 */

// =============================================================================
// JSON-RPC 2.0 Types
// =============================================================================

import type { SourceMeta } from "../capability/types";

export interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: string | number;
	method: string;
	params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: string | number;
	result?: unknown;
	error?: JsonRpcError;
}

export interface JsonRpcError {
	code: number;
	message: string;
	data?: unknown;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

// =============================================================================
// MCP Server Configuration (.mcp.json format)
// =============================================================================

/** Authentication configuration for MCP servers */
export interface MCPAuthConfig {
	/** Authentication type */
	type: "oauth" | "apikey";
	/** Credential ID for OAuth (references agent.db) */
	credentialId?: string;
	/** Token endpoint URL — persisted for proactive token refresh */
	tokenUrl?: string;
	/** Client ID — persisted for token refresh */
	clientId?: string;
	/** Client secret — persisted for token refresh */
	clientSecret?: string;
	/** MCP resource URI — persisted for OAuth resource indicators during refresh */
	resource?: string;
}

/** Encoding used for outgoing JSON-RPC request ids. */
export type MCPRequestIdFormat = "string" | "number";

/** Base server config with shared options */
interface MCPServerConfigBase {
	/** Whether this server is enabled (default: true) */
	enabled?: boolean;
	/** MCP request timeout in milliseconds (default: 30000, 0 to disable) */
	timeout?: number;
	/**
	 * Encoding for outgoing JSON-RPC request ids (default: `"number"`).
	 *
	 * Set `"string"` for servers that need collision-resistant snowflake string
	 * ids instead of per-transport integers. See `RequestIdAllocator` in
	 * `./request-id`.
	 *
	 * OMP-specific, so only the OMP-owned discovery providers parse it (native,
	 * standalone `mcp.json`, OMP plugins). Providers that translate another
	 * tool's config do not, since the key is not part of those formats.
	 */
	requestIdFormat?: MCPRequestIdFormat;
	/** Authentication configuration (optional) */
	auth?: MCPAuthConfig;
	/** OAuth configuration for servers requiring explicit client credentials */
	oauth?: {
		clientId?: string;
		clientSecret?: string;
		scope?: string;
		redirectUri?: string;
		callbackPort?: number;
		callbackPath?: string;
		/** `prompt` param for the authorization request (default "consent"; "" to omit) */
		prompt?: string;
	};
}

/** Stdio server configuration */
export interface MCPStdioServerConfig extends MCPServerConfigBase {
	type?: "stdio"; // Default if not specified
	command: string;
	args?: string[];
	env?: Record<string, string>;
	/**
	 * `literal`: env values are opaque plugin package data (Agent Plugins
	 * §§4.1/9.2) — no env-name lookup, no `!command` execution, no dropping of
	 * empty values. The provider already applied the only permitted expansion
	 * (`${PLUGIN_ROOT}`/`${PLUGIN_DATA}`).
	 */
	envPolicy?: "literal";
	/** Env keys whose values are final package data; auth resolution keeps them verbatim. */
	envLiteralKeys?: string[];
	cwd?: string;
}

/** HTTP server configuration (Streamable HTTP transport) */
export interface MCPHttpServerConfig extends MCPServerConfigBase {
	type: "http";
	url: string;
	headers?: Record<string, string>;
	/**
	 * `origin-locked`: configured headers are literal package data pinned to the
	 * configured URL's origin (Agent Plugins §7.2.1) — never expanded, never
	 * forwarded cross-origin, and client-generated headers win case-insensitively.
	 */
	headerPolicy?: "origin-locked";
}

/** SSE server configuration (deprecated, use HTTP) */
export interface MCPSseServerConfig extends MCPServerConfigBase {
	type: "sse";
	url: string;
	headers?: Record<string, string>;
	/** See {@link MCPHttpServerConfig.headerPolicy}. */
	headerPolicy?: "origin-locked";
}

export type MCPServerConfig = MCPStdioServerConfig | MCPHttpServerConfig | MCPSseServerConfig;

export const MCP_CONFIG_SCHEMA_URL =
	"https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json";

/** Root mcp.json/.mcp.json file structure */
export interface MCPConfigFile {
	$schema?: string;
	mcpServers?: Record<string, MCPServerConfig>;
	/** Names to hide regardless of any source `enabled` flag. Highest precedence. */
	disabledServers?: string[];
	/** Names to force-enable when a non-writable source reports `enabled: false`. */
	enabledServers?: string[];
}

// =============================================================================
// MCP Protocol Types
// =============================================================================

/**
 * Latest MCP protocol revision this client negotiates.
 *
 * Sent as `protocolVersion` in the `initialize` request and, for Streamable
 * HTTP, echoed back to the server in the `MCP-Protocol-Version` header on every
 * subsequent request (per the MCP HTTP transport spec). Must track the current
 * stable revision: AWS Bedrock AgentCore Gateway refuses tool calls on an
 * outbound per-user OAuth (`AUTHORIZATION_CODE`) target below `2025-11-25`, and
 * it checks the version *before* consulting its token vault, so an older client
 * is refused even for a caller whose consent is already stored.
 */
export const MCP_PROTOCOL_VERSION = "2025-11-25";

/** Optionally-sized icon for MCP UI metadata (implementation, tools, resources). */
export interface MCPIcon {
	src: string;
	mimeType?: string;
	sizes?: string[];
	theme?: "light" | "dark";
}

/** MCP implementation info (`InitializeRequest.params.clientInfo` / `InitializeResult.serverInfo`). */
export interface MCPImplementation {
	name: string;
	title?: string;
	version: string;
	description?: string;
	websiteUrl?: string;
	icons?: MCPIcon[];
}

/** MCP client capabilities */
export interface MCPClientCapabilities {
	roots?: { listChanged?: boolean };
	sampling?: Record<string, never>;
	experimental?: Record<string, unknown>;
}

/** MCP server capabilities */
export interface MCPServerCapabilities {
	tools?: { listChanged?: boolean };
	resources?: { subscribe?: boolean; listChanged?: boolean };
	prompts?: { listChanged?: boolean };
	logging?: Record<string, never>;
	experimental?: Record<string, unknown>;
}

/** Initialize request params */
export interface MCPInitializeParams {
	protocolVersion: string;
	capabilities: MCPClientCapabilities;
	clientInfo: MCPImplementation;
}

/** Initialize response result */
export interface MCPInitializeResult {
	protocolVersion: string;
	capabilities: MCPServerCapabilities;
	serverInfo: MCPImplementation;
	instructions?: string;
}

/** Tool annotations from the 2025-11-25 tools spec. */
export interface MCPToolAnnotations {
	title?: string;
	readOnlyHint?: boolean;
	destructiveHint?: boolean;
	idempotentHint?: boolean;
	openWorldHint?: boolean;
}

/** Execution metadata from the 2025-11-25 tools spec. */
export interface MCPToolExecution {
	taskSupport?: "forbidden" | "optional" | "required";
}

/** MCP tool definition */
export interface MCPToolDefinition {
	name: string;
	title?: string;
	description?: string;
	icons?: MCPIcon[];
	inputSchema: {
		type: "object";
		properties?: Record<string, unknown>;
		required?: string[];
		[key: string]: unknown;
	};
	outputSchema?: Record<string, unknown>;
	execution?: MCPToolExecution;
	annotations?: MCPToolAnnotations;
	_meta?: Record<string, unknown>;
}

/** tools/list response */
export interface MCPToolsListResult {
	tools: MCPToolDefinition[];
	nextCursor?: string;
}

/** tools/call params */
export interface MCPToolCallParams {
	name: string;
	arguments?: Record<string, unknown>;
}

/** Content types in tool results */
export interface MCPTextContent {
	type: "text";
	text: string;
}

export interface MCPImageContent {
	type: "image";
	data: string; // base64
	mimeType: string;
}

export interface MCPResourceContent {
	type: "resource";
	resource: {
		uri: string;
		mimeType?: string;
		text?: string;
		blob?: string;
	};
}

export type MCPContent = MCPTextContent | MCPImageContent | MCPResourceContent;

/** Structured authentication challenge returned in a tool result. */
export interface MCPAuthChallenge {
	/** Values from `_meta["mcp/www_authenticate"]`. */
	readonly wwwAuthenticate: readonly string[];
}

/** tools/call response */
export interface MCPToolCallResult {
	content: MCPContent[];
	isError?: boolean;
	/**
	 * Machine-readable payload channel (MCP spec 2025-06-18, Tools → Structured
	 * Content). Servers may return their data here while keeping `content`
	 * minimal; the bridge surfaces it so it reaches the model.
	 */
	structuredContent?: Record<string, unknown>;
	_meta?: Record<string, unknown>;
}

// =============================================================================
// Transport Types
// =============================================================================

export interface MCPRequestOptions {
	/** Abort signal (e.g. Escape-to-interrupt) */
	signal?: AbortSignal;
}

/** Transport interface - abstracts stdio/http */
export interface MCPTransport {
	/** Send a request and wait for response */
	request<T = unknown>(method: string, params?: Record<string, unknown>, options?: MCPRequestOptions): Promise<T>;

	/** Send a notification (no response expected) */
	notify(method: string, params?: Record<string, unknown>): Promise<void>;

	/** Close the transport */
	close(): Promise<void>;

	/**
	 * Record the protocol version negotiated in the `initialize` response.
	 * Streamable HTTP transports echo it in the `MCP-Protocol-Version` header on
	 * every subsequent request; transports that need no per-request version
	 * (stdio) omit this.
	 */
	setProtocolVersion?(version: string): void;

	/** Whether the transport is connected */
	readonly connected: boolean;

	/** Event handlers */
	onClose?: () => void;
	onError?: (error: Error) => void;
	onNotification?: (method: string, params: unknown) => void;
	/** Handler for server-to-client requests (e.g. roots/list). Returns result or throws a JsonRpcError. */
	onRequest?: (method: string, params: unknown) => Promise<unknown>;
}

/** Transport factory function */
export type TransportFactory = (config: MCPServerConfig) => Promise<MCPTransport>;

// =============================================================================
// MCP Client Types
// =============================================================================

/** Connected MCP server state */
export interface MCPServerConnection {
	/** Server name from config */
	name: string;
	/** Original config */
	config: MCPServerConfig;
	/** Transport instance */
	transport: MCPTransport;
	/** Server info from initialize */
	serverInfo: MCPImplementation;
	/** Server capabilities */
	capabilities: MCPServerCapabilities;
	/** Cached tools (populated on demand) */
	tools?: MCPToolDefinition[];
	/** Source metadata (for display) */
	_source?: SourceMeta;
	/** Cached resources (populated on demand) */
	resources?: MCPResource[];
	/** Cached resource templates (populated on demand) */
	resourceTemplates?: MCPResourceTemplate[];
	/** Server instructions from initialize */
	instructions?: string;
	/** Cached prompts (populated on demand) */
	prompts?: MCPPrompt[];
}

/** MCP tool with server context */
export interface MCPToolWithServer {
	server: MCPServerConnection;
	tool: MCPToolDefinition;
}

// =============================================================================
// MCP Resource Types
// =============================================================================

/** Annotations for resources, templates, and content blocks */
export interface MCPAnnotations {
	audience?: ("user" | "assistant")[];
	priority?: number;
	lastModified?: string;
}

/** A concrete resource exposed by an MCP server */
export interface MCPResource {
	uri: string;
	name: string;
	title?: string;
	description?: string;
	mimeType?: string;
	size?: number;
	annotations?: MCPAnnotations;
}

/** A parameterized resource template (RFC 6570 URI template) */
export interface MCPResourceTemplate {
	uriTemplate: string;
	name: string;
	title?: string;
	description?: string;
	mimeType?: string;
	annotations?: MCPAnnotations;
}

/** Result of resources/list */
export interface MCPResourcesListResult {
	resources: MCPResource[];
	nextCursor?: string;
}

/** Result of resources/templates/list */
export interface MCPResourceTemplatesListResult {
	resourceTemplates: MCPResourceTemplate[];
	nextCursor?: string;
}

/** A single content item from resources/read */
export interface MCPResourceContentItem {
	uri: string;
	mimeType?: string;
	text?: string;
	blob?: string;
}

/** Result of resources/read */
export interface MCPResourceReadResult {
	contents: MCPResourceContentItem[];
}

/** Params for resources/read */
export interface MCPResourceReadParams {
	uri: string;
}

/** Params for resources/subscribe and resources/unsubscribe */
export interface MCPResourceSubscribeParams {
	uri: string;
}

// =============================================================================
// MCP Prompt Types
// =============================================================================

/** An argument definition for an MCP prompt */
export interface MCPPromptArgument {
	name: string;
	description?: string;
	required?: boolean;
}

/** A prompt definition exposed by an MCP server */
export interface MCPPrompt {
	name: string;
	title?: string;
	description?: string;
	arguments?: MCPPromptArgument[];
}

/** Result of prompts/list */
export interface MCPPromptsListResult {
	prompts: MCPPrompt[];
	nextCursor?: string;
}

/** Audio content in prompt messages */
export interface MCPAudioContent {
	type: "audio";
	data: string;
	mimeType: string;
}

/** Content type union for prompt messages */
export type MCPPromptContent = MCPTextContent | MCPImageContent | MCPAudioContent | MCPResourceContent;

/** A single message in a prompt result */
export interface MCPPromptMessage {
	role: "user" | "assistant";
	content: MCPPromptContent | MCPPromptContent[];
}

/** Params for prompts/get */
export interface MCPGetPromptParams {
	name: string;
	arguments?: Record<string, string>;
}

/** Result of prompts/get */
export interface MCPGetPromptResult {
	description?: string;
	messages: MCPPromptMessage[];
}

// =============================================================================
// MCP Notification Method Names
// =============================================================================

/** MCP server notification method names */
export const MCPNotificationMethods = {
	TOOLS_LIST_CHANGED: "notifications/tools/list_changed",
	RESOURCES_LIST_CHANGED: "notifications/resources/list_changed",
	RESOURCES_UPDATED: "notifications/resources/updated",
	PROMPTS_LIST_CHANGED: "notifications/prompts/list_changed",
} as const;

/** Extract a JsonRpcError from a thrown value. Preserves `.code` and `.message` from Error instances or plain objects. */
export function toJsonRpcError(error: unknown): JsonRpcError {
	if (error instanceof Error) {
		const code = "code" in error && typeof error.code === "number" ? error.code : -32603;
		return { code, message: error.message };
	}
	if (typeof error === "object" && error !== null) {
		const obj = error as Record<string, unknown>;
		if (typeof obj.code === "number" && typeof obj.message === "string") {
			return { code: obj.code, message: obj.message };
		}
	}
	return { code: -32603, message: "Internal error" };
}
