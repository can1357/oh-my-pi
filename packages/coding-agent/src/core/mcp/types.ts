/**
 * MCP (Model Context Protocol) type definitions.
 *
 * Based on MCP specification 2025-03-26:
 * https://modelcontextprotocol.io/specification/2025-03-26/
 */

// =============================================================================
// JSON-RPC 2.0 Types
// =============================================================================

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

/** Base server config with shared options */
interface MCPServerConfigBase {
	/** Connection timeout in milliseconds (default: 30000) */
	timeout?: number;
}

/** Stdio server configuration */
export interface MCPStdioServerConfig extends MCPServerConfigBase {
	type?: "stdio"; // Default if not specified
	command: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
}

/** HTTP server configuration (Streamable HTTP transport) */
export interface MCPHttpServerConfig extends MCPServerConfigBase {
	type: "http";
	url: string;
	headers?: Record<string, string>;
}

/** SSE server configuration (deprecated, use HTTP) */
export interface MCPSseServerConfig extends MCPServerConfigBase {
	type: "sse";
	url: string;
	headers?: Record<string, string>;
}

export type MCPServerConfig = MCPStdioServerConfig | MCPHttpServerConfig | MCPSseServerConfig;

/** Root .mcp.json file structure */
export interface MCPConfigFile {
	mcpServers?: Record<string, MCPServerConfig>;
}

// =============================================================================
// MCP Protocol Types
// =============================================================================

/** MCP implementation info */
export interface MCPImplementation {
	name: string;
	version: string;
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

/** MCP tool definition */
export interface MCPToolDefinition {
	name: string;
	description?: string;
	inputSchema: {
		type: "object";
		properties?: Record<string, unknown>;
		required?: string[];
		[key: string]: unknown;
	};
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

/** tools/call response */
export interface MCPToolCallResult {
	content: MCPContent[];
	isError?: boolean;
}

// =============================================================================
// Transport Types
// =============================================================================

/** Transport interface - abstracts stdio/http */
export interface MCPTransport {
	/** Send a request and wait for response */
	request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;

	/** Send a notification (no response expected) */
	notify(method: string, params?: Record<string, unknown>): Promise<void>;

	/** Close the transport */
	close(): Promise<void>;

	/** Whether the transport is connected */
	readonly connected: boolean;

	/** Event handlers */
	onClose?: () => void;
	onError?: (error: Error) => void;
	onNotification?: (method: string, params: unknown) => void;
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
	_source?: import("../../capability/types").SourceMeta;
}

/** MCP tool with server context */
export interface MCPToolWithServer {
	server: MCPServerConnection;
	tool: MCPToolDefinition;
}
