/**
 * MCP configuration loader.
 *
 * Loads .mcp.json files from project root with environment variable expansion.
 * Supports ${VAR} and ${VAR:-default} syntax.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MCPConfigFile, MCPServerConfig } from "./types.js";

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
	/** User-level config: ~/.pi/mcp.json or ~/.claude.json */
	user?: string;
	/** Project-level config: <cwd>/.mcp.json */
	project?: string;
}

/**
 * Get standard MCP config file paths.
 */
export function getMCPConfigPaths(cwd: string): MCPConfigLocations {
	const home = homedir();
	return {
		// User-level: ~/.pi/mcp.json (our standard)
		user: join(home, ".pi", "mcp.json"),
		// Project-level: .mcp.json at project root
		project: join(cwd, ".mcp.json"),
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

/**
 * Load all MCP server configs from standard locations.
 * Returns merged config with project overriding user.
 */
export function loadAllMCPConfigs(cwd: string, extraEnv?: Record<string, string>): Record<string, MCPServerConfig> {
	const paths = getMCPConfigPaths(cwd);

	const userConfig = paths.user ? loadMCPConfigFile(paths.user, extraEnv) : null;
	const projectConfig = paths.project ? loadMCPConfigFile(paths.project, extraEnv) : null;

	return mergeMCPConfigs(userConfig, projectConfig);
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
