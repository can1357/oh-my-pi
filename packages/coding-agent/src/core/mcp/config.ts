/**
 * MCP configuration loader.
 *
 * Loads .mcp.json files from project root with environment variable expansion.
 * Supports ${VAR} and ${VAR:-default} syntax.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDirPaths } from "../../config";
import type { MCPConfigFile, MCPServerConfig } from "./types";

/** Environment variable expansion pattern: ${VAR} or ${VAR:-default} */
const ENV_VAR_PATTERN = /\$\{([^}:]+)(?::-([^}]*))?\}/g;

/**
 * Expand environment variables in a string.
 * Supports ${VAR} and ${VAR:-default} syntax.
 */
export function expandEnvVars(value: string, extraEnv?: Record<string, string>): string {
	return value.replace(ENV_VAR_PATTERN, (_, varName: string, defaultValue?: string) => {
		const envValue = extraEnv?.[varName] ?? process.env[varName];
		if (envValue !== undefined) {
			return envValue;
		}
		if (defaultValue !== undefined) {
			return defaultValue;
		}
		// If no value and no default, leave the placeholder (will likely cause an error later)
		return `\${${varName}}`;
	});
}

/**
 * Recursively expand environment variables in an object.
 */
function expandEnvVarsInObject<T>(obj: T, extraEnv?: Record<string, string>): T {
	if (typeof obj === "string") {
		return expandEnvVars(obj, extraEnv) as T;
	}
	if (Array.isArray(obj)) {
		return obj.map((item) => expandEnvVarsInObject(item, extraEnv)) as T;
	}
	if (obj !== null && typeof obj === "object") {
		const result: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(obj)) {
			result[key] = expandEnvVarsInObject(value, extraEnv);
		}
		return result as T;
	}
	return obj;
}

/**
 * Load and parse an .mcp.json file.
 * Returns null if file doesn't exist or is invalid.
 */
export function loadMCPConfigFile(filePath: string, extraEnv?: Record<string, string>): MCPConfigFile | null {
	if (!existsSync(filePath)) {
		return null;
	}

	try {
		const content = readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(content) as MCPConfigFile;

		// Expand environment variables in server configs
		if (parsed.mcpServers) {
			parsed.mcpServers = expandEnvVarsInObject(parsed.mcpServers, extraEnv);
		}

		return parsed;
	} catch (error) {
		console.error(`Warning: Failed to parse ${filePath}: ${error}`);
		return null;
	}
}

/**
 * Configuration locations (in order of priority, later overrides earlier).
 */
export interface MCPConfigLocations {
	/** User-level config paths: ~/.omp/mcp.json, ~/.pi/mcp.json, ~/.claude/mcp.json */
	userPaths: string[];
	/** Project-level config: <cwd>/mcp.json or <cwd>/.mcp.json */
	project?: string;
}

/**
 * Get standard MCP config file paths.
 * User-level checks .omp, .pi, .claude directories for fallback support.
 */
export function getMCPConfigPaths(cwd: string): MCPConfigLocations {
	// User-level: check all config dirs (not under agent/)
	// mcp.json lives at ~/.omp/mcp.json, not ~/.omp/agent/mcp.json
	const userPaths = getConfigDirPaths("mcp.json", { project: false }).map((p) =>
		p.replace("/agent/mcp.json", "/mcp.json"),
	);

	// Project-level: check both mcp.json and .mcp.json (prefer mcp.json if both exist)
	const mcpJson = join(cwd, "mcp.json");
	const dotMcpJson = join(cwd, ".mcp.json");
	const projectPath = existsSync(mcpJson) ? mcpJson : dotMcpJson;

	return {
		userPaths,
		project: projectPath,
	};
}

/**
 * Merge MCP configs from multiple sources.
 * Later sources override earlier ones for servers with same name.
 */
export function mergeMCPConfigs(...configs: (MCPConfigFile | null)[]): Record<string, MCPServerConfig> {
	const result: Record<string, MCPServerConfig> = {};

	for (const config of configs) {
		if (config?.mcpServers) {
			Object.assign(result, config.mcpServers);
		}
	}

	return result;
}

/** Options for loading MCP configs */
export interface LoadMCPConfigsOptions {
	/** Additional environment variables for expansion */
	extraEnv?: Record<string, string>;
	/** Whether to load project-level config (default: true) */
	enableProjectConfig?: boolean;
	/** Whether to filter out Exa MCP servers (default: true) */
	filterExa?: boolean;
}

/** Result of loading MCP configs */
export interface LoadMCPConfigsResult {
	/** Loaded server configs */
	configs: Record<string, MCPServerConfig>;
	/** Extracted Exa API keys (if any were filtered) */
	exaApiKeys: string[];
}

/**
 * Load all MCP server configs from standard locations.
 * Returns merged config with project overriding user.
 *
 * @param cwd Working directory (project root)
 * @param options Load options or extraEnv for backwards compatibility
 */
export function loadAllMCPConfigs(
	cwd: string,
	options?: LoadMCPConfigsOptions | Record<string, string>,
): LoadMCPConfigsResult {
	// Support old signature: loadAllMCPConfigs(cwd, extraEnv)
	const opts: LoadMCPConfigsOptions =
		options && ("extraEnv" in options || "enableProjectConfig" in options || "filterExa" in options)
			? (options as LoadMCPConfigsOptions)
			: { extraEnv: options as Record<string, string> | undefined };

	const enableProjectConfig = opts.enableProjectConfig ?? true;
	const filterExa = opts.filterExa ?? true;

	const paths = getMCPConfigPaths(cwd);

	// Load first existing user config (fallback support)
	let userConfig: MCPConfigFile | null = null;
	for (const userPath of paths.userPaths) {
		userConfig = loadMCPConfigFile(userPath, opts.extraEnv);
		if (userConfig) break;
	}

	const projectConfig = enableProjectConfig && paths.project ? loadMCPConfigFile(paths.project, opts.extraEnv) : null;

	let configs = mergeMCPConfigs(userConfig, projectConfig);
	let exaApiKeys: string[] = [];

	if (filterExa) {
		const result = filterExaMCPServers(configs);
		configs = result.configs;
		exaApiKeys = result.exaApiKeys;
	}

	return { configs, exaApiKeys };
}

/** Pattern to match Exa MCP servers */
const EXA_MCP_URL_PATTERN = /mcp\.exa\.ai/i;
const EXA_API_KEY_PATTERN = /exaApiKey=([^&\s]+)/i;

/**
 * Check if a server config is an Exa MCP server.
 */
export function isExaMCPServer(name: string, config: MCPServerConfig): boolean {
	// Check by server name
	if (name.toLowerCase() === "exa") {
		return true;
	}

	// Check by URL for HTTP/SSE servers
	if (config.type === "http" || config.type === "sse") {
		const httpConfig = config as { url?: string };
		if (httpConfig.url && EXA_MCP_URL_PATTERN.test(httpConfig.url)) {
			return true;
		}
	}

	// Check by args for stdio servers (e.g., mcp-remote to exa)
	if (!config.type || config.type === "stdio") {
		const stdioConfig = config as { args?: string[] };
		if (stdioConfig.args?.some((arg) => EXA_MCP_URL_PATTERN.test(arg))) {
			return true;
		}
	}

	return false;
}

/**
 * Extract Exa API key from an MCP server config.
 */
export function extractExaApiKey(config: MCPServerConfig): string | undefined {
	// Check URL for HTTP/SSE servers
	if (config.type === "http" || config.type === "sse") {
		const httpConfig = config as { url?: string };
		if (httpConfig.url) {
			const match = EXA_API_KEY_PATTERN.exec(httpConfig.url);
			if (match) return match[1];
		}
	}

	// Check args for stdio servers
	if (!config.type || config.type === "stdio") {
		const stdioConfig = config as { args?: string[] };
		if (stdioConfig.args) {
			for (const arg of stdioConfig.args) {
				const match = EXA_API_KEY_PATTERN.exec(arg);
				if (match) return match[1];
			}
		}
	}

	// Check env vars
	if ("env" in config && config.env) {
		const envConfig = config as { env: Record<string, string> };
		if (envConfig.env.EXA_API_KEY) {
			return envConfig.env.EXA_API_KEY;
		}
	}

	return undefined;
}

/** Result of filtering Exa MCP servers */
export interface ExaFilterResult {
	/** Configs with Exa servers removed */
	configs: Record<string, MCPServerConfig>;
	/** Extracted Exa API keys (if any) */
	exaApiKeys: string[];
}

/**
 * Filter out Exa MCP servers and extract their API keys.
 * Since we have native Exa integration, we don't need the MCP server.
 */
export function filterExaMCPServers(configs: Record<string, MCPServerConfig>): ExaFilterResult {
	const filtered: Record<string, MCPServerConfig> = {};
	const exaApiKeys: string[] = [];

	for (const [name, config] of Object.entries(configs)) {
		if (isExaMCPServer(name, config)) {
			// Extract API key before filtering
			const apiKey = extractExaApiKey(config);
			if (apiKey) {
				exaApiKeys.push(apiKey);
			}
		} else {
			filtered[name] = config;
		}
	}

	return { configs: filtered, exaApiKeys };
}

/**
 * Validate server config has required fields.
 */
export function validateServerConfig(name: string, config: MCPServerConfig): string[] {
	const errors: string[] = [];

	const serverType = config.type ?? "stdio";

	if (serverType === "stdio") {
		const stdioConfig = config as { command?: string };
		if (!stdioConfig.command) {
			errors.push(`Server "${name}": stdio server requires "command" field`);
		}
	} else if (serverType === "http" || serverType === "sse") {
		const httpConfig = config as { url?: string };
		if (!httpConfig.url) {
			errors.push(`Server "${name}": ${serverType} server requires "url" field`);
		}
	} else {
		errors.push(`Server "${name}": unknown server type "${serverType}"`);
	}

	return errors;
}
