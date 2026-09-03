/**
 * MCP JSON Provider
 *
 * Discovers standalone mcp.json / .mcp.json files in the project root.
 * This is a fallback for projects that have a standalone mcp.json without any config directory.
 *
 * Priority: 5 (low, as this is a fallback after tool-specific providers)
 */
import * as path from "node:path";
import { logger, tryParseJson } from "@oh-my-pi/pi-utils";
import { registerProvider } from "../capability";
import { readFile } from "../capability/fs";
import { type MCPServer, mcpCapability } from "../capability/mcp";
import type { LoadContext, LoadResult, SourceMeta } from "../capability/types";
import { createSourceMeta, expandEnvVarsDeep, parseRequestIdFormat } from "./helpers";

const PROVIDER_ID = "mcp-json";
const DISPLAY_NAME = "MCP Config";

/**
 * Raw MCP JSON format (matches Claude Desktop's format).
 */
interface MCPConfigFile {
	mcpServers?: Record<
		string,
		{
			enabled?: boolean;
			timeout?: number;
			requestIdFormat?: "string" | "number";
			command?: string;
			args?: string[];
			env?: Record<string, string>;
			cwd?: string;
			url?: string;
			headers?: Record<string, string>;
			auth?: {
				type: "oauth" | "apikey";
				credentialId?: string;
				tokenUrl?: string;
				clientId?: string;
				clientSecret?: string;
			};
			type?: "stdio" | "sse" | "http";
			oauth?: {
				clientId?: string;
				clientSecret?: string;
				redirectUri?: string;
				callbackPort?: number;
				callbackPath?: string;
				prompt?: string;
			};
		}
	>;
}

/**
 * Transform raw MCP config to canonical MCPServer format.
 */
function transformMCPConfig(config: MCPConfigFile, source: SourceMeta): MCPServer[] {
	const servers: MCPServer[] = [];

	if (config.mcpServers) {
		for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
			// Runtime type validation for user-controlled JSON values
			let enabled: boolean | undefined;
			if (serverConfig.enabled !== undefined) {
				if (typeof serverConfig.enabled === "boolean") {
					enabled = serverConfig.enabled;
				} else {
					logger.warn("MCP server has invalid 'enabled' value, ignoring", { name, value: serverConfig.enabled });
				}
			}

			let timeout: number | undefined;
			if (serverConfig.timeout !== undefined) {
				if (
					typeof serverConfig.timeout === "number" &&
					Number.isFinite(serverConfig.timeout) &&
					serverConfig.timeout >= 0
				) {
					timeout = serverConfig.timeout;
				} else {
					logger.warn("MCP server has invalid 'timeout' value, ignoring", { name, value: serverConfig.timeout });
				}
			}

			const requestIdFormat = parseRequestIdFormat(serverConfig.requestIdFormat);
			if (requestIdFormat === undefined && serverConfig.requestIdFormat !== undefined) {
				logger.warn("MCP server has invalid 'requestIdFormat' value, ignoring", {
					name,
					value: serverConfig.requestIdFormat,
				});
			}

			const server: MCPServer = {
				name,
				enabled,
				timeout,
				requestIdFormat,
				command: serverConfig.command,
				args: serverConfig.args,
				env: serverConfig.env,
				cwd: serverConfig.cwd,
				url: serverConfig.url,
				headers: serverConfig.headers,
				auth: serverConfig.auth,
				oauth: serverConfig.oauth,
				transport: serverConfig.type,
				_source: source,
			};

			// Expand environment variables
			if (server.command) server.command = expandEnvVarsDeep(server.command);
			if (server.args) server.args = expandEnvVarsDeep(server.args);
			if (server.env) server.env = expandEnvVarsDeep(server.env);
			if (server.cwd) server.cwd = expandEnvVarsDeep(server.cwd);
			if (server.url) server.url = expandEnvVarsDeep(server.url);
			if (server.headers) server.headers = expandEnvVarsDeep(server.headers);
			if (server.auth) server.auth = expandEnvVarsDeep(server.auth);
			if (server.oauth) server.oauth = expandEnvVarsDeep(server.oauth);
			servers.push(server);
		}
	}

	return servers;
}

/**
 * Load MCP servers from a JSON file.
 */
async function loadMCPJsonFile(
	_ctx: LoadContext,
	path: string,
	level: "user" | "project",
): Promise<LoadResult<MCPServer>> {
	const warnings: string[] = [];
	const items: MCPServer[] = [];

	const content = await readFile(path);
	if (content === null) {
		return { items, warnings };
	}

	const config = tryParseJson<MCPConfigFile>(content);
	if (!config) {
		warnings.push(`Failed to parse JSON in ${path}`);
		return { items, warnings };
	}

	const source = createSourceMeta(PROVIDER_ID, path, level);
	const servers = transformMCPConfig(config, source);
	items.push(...servers);

	return { items, warnings };
}

/**
 * MCP JSON Provider loader.
 */
async function load(ctx: LoadContext): Promise<LoadResult<MCPServer>> {
	const filenames = ["mcp.json", ".mcp.json"];
	const results = await Promise.all(
		filenames.map(filename => loadMCPJsonFile(ctx, path.join(ctx.cwd, filename), "project")),
	);

	const allItems = results.flatMap(r => r.items);
	const allWarnings = results.flatMap(r => r.warnings ?? []);

	return {
		items: allItems,
		warnings: allWarnings.length > 0 ? allWarnings : undefined,
	};
}

// Register provider
registerProvider(mcpCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load MCP servers from standalone mcp.json or .mcp.json in project root",
	priority: 5,
	load,
});
