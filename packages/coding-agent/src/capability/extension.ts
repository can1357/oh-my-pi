/**
 * Extensions Capability
 *
 * Gemini-style extensions that provide MCP servers, tools, and context.
 */

import { defineCapability } from "./index";
import type { MCPServer } from "./mcp";
import type { SourceMeta } from "./types";

/**
 * Extension manifest structure.
 */
export interface ExtensionManifest {
	name?: string;
	description?: string;
	mcpServers?: Record<string, Omit<MCPServer, "name" | "_source">>;
	tools?: unknown[];
	context?: unknown;
}

/**
 * A loaded extension.
 */
export interface Extension {
	/** Extension name (from manifest.name or directory name) */
	name: string;
	/** Absolute path to extension directory */
	path: string;
	/** Parsed manifest data */
	manifest: ExtensionManifest;
	/** Source level */
	level: "user" | "project";
	/** Source metadata */
	_source: SourceMeta;
}

export const extensionCapability = defineCapability<Extension>({
	id: "extensions",
	displayName: "Extensions",
	description: "Gemini-style extensions providing MCP servers, tools, and context",
	key: (ext) => ext.name,
	validate: (ext) => {
		if (!ext.name) return "Missing extension name";
		if (!ext.path) return "Missing extension path";
		return undefined;
	},
});
