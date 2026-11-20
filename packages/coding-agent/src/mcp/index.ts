/**
 * MCP (Model Context Protocol) support.
 *
 * Provides per-project .mcp.json configuration for connecting to
 * MCP servers, each reached through the MCP host.
 */

// Client
export * from "./client";
// Config
export * from "./config";
export * from "./config-writer";
// JSON-RPC (lightweight HTTP-based MCP calls)
export * from "./json-rpc";
// Loader (for SDK integration)
export * from "./loader";
// Manager
export * from "./manager";
// OAuth Discovery
export * from "./oauth-discovery";
// Reconnect
export * from "./reload";
// Tool bridge
export * from "./tool-bridge";
// Built-in transforms
export * from "./transforms";
// Protocol (MCP 2026-07-28) and the session ↔ host contract
export * from "./host/contract";
export * from "./protocol";
// Types
export * from "./types";

export type {
	MCPToolDetails,
	MCPTextContent,
	MCPImageContent,
	MCPAudioContent,
	MCPResourceContent,
	MCPResourceLinkContent,
	MCPContent,
} from "@oh-my-pi/pi-tui/tools/mcp";
