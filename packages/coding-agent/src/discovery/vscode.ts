/**
 * VS Code Provider
 *
 * Loads config from `.vscode` directory (project-only).
 * Supports MCP server discovery from `mcp.json` with nested `mcp.servers` structure.
 */

import { registerProvider } from "../capability/index";
import { type MCPServer, mcpCapability } from "../capability/mcp";
import type { LoadContext, LoadResult } from "../capability/types";
import { createSourceMeta, expandEnvVarsDeep, getProjectPath, parseJSON } from "./helpers";

const PROVIDER_ID = "vscode";
const DISPLAY_NAME = "VS Code";
const PRIORITY = 20;

// =============================================================================
// MCP Servers
// =============================================================================

registerProvider<MCPServer>(mcpCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load MCP servers from .vscode/mcp.json",
	priority: PRIORITY,
	load(ctx: LoadContext): LoadResult<MCPServer> {
		const items: MCPServer[] = [];
		const warnings: string[] = [];

		// Project-only (VS Code doesn't support user-level MCP config)
		const projectPath = getProjectPath(ctx, "vscode", "mcp.json");
		if (projectPath && ctx.fs.isFile(projectPath)) {
			const result = loadMCPConfig(ctx, projectPath, "project");
			items.push(...result.items);
			if (result.warnings) warnings.push(...result.warnings);
		}

		return { items, warnings };
	},
});

/**
 * Load MCP servers from a mcp.json file.
 * VS Code uses nested structure: { "mcp": { "servers": { ... } } }
 */
function loadMCPConfig(ctx: LoadContext, path: string, level: "user" | "project"): LoadResult<MCPServer> {
	const items: MCPServer[] = [];
	const warnings: string[] = [];

	const content = ctx.fs.readFile(path);
	if (!content) {
		warnings.push(`Failed to read ${path}`);
		return { items, warnings };
	}

	const parsed = parseJSON<{ mcp?: { servers?: Record<string, unknown> } }>(content);
	if (!parsed) {
		warnings.push(`Invalid JSON in ${path}`);
		return { items, warnings };
	}

	// VS Code uses nested structure: mcp.servers
	const servers = parsed.mcp?.servers;
	if (!servers || typeof servers !== "object") {
		return { items, warnings };
	}

	for (const [name, config] of Object.entries(servers)) {
		if (!config || typeof config !== "object") {
			warnings.push(`Invalid config for server "${name}" in ${path}`);
			continue;
		}

		const raw = config as Record<string, unknown>;

		// Expand environment variables
		const expanded = expandEnvVarsDeep(raw);

		const server: MCPServer = {
			name,
			command: typeof expanded.command === "string" ? expanded.command : undefined,
			args: Array.isArray(expanded.args) ? (expanded.args as string[]) : undefined,
			env: expanded.env && typeof expanded.env === "object" ? (expanded.env as Record<string, string>) : undefined,
			url: typeof expanded.url === "string" ? expanded.url : undefined,
			headers:
				expanded.headers && typeof expanded.headers === "object"
					? (expanded.headers as Record<string, string>)
					: undefined,
			transport: ["stdio", "sse", "http"].includes(expanded.transport as string)
				? (expanded.transport as "stdio" | "sse" | "http")
				: undefined,
			_source: createSourceMeta(PROVIDER_ID, path, level),
		};

		items.push(server);
	}

	return { items, warnings };
}
