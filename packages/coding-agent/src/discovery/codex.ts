/**
 * Codex Discovery Provider
 *
 * Loads project-level OpenAI Codex configuration from `<cwd>/.codex`:
 * - MCP servers: `config.toml` `[mcp_servers.*]` sections
 * - Skills: `skills/`
 *
 * Codex's user-level config (`~/.codex`) is not read.
 */
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { registerProvider } from "../capability";
import { readFile } from "../capability/fs";
import { type MCPServer, mcpCapability } from "../capability/mcp";
import { type Skill, skillCapability } from "../capability/skill";
import type { LoadContext, LoadResult } from "../capability/types";
import { createSourceMeta, getProjectPath, scanSkillsFromDir } from "./helpers";
import { resolvePluginStdioPaths } from "./substitute-plugin-root";

const PROVIDER_ID = "codex";
const DISPLAY_NAME = "OpenAI Codex";
const PRIORITY = 70;

// =============================================================================
// MCP Servers (config.toml)
// =============================================================================

async function loadMCPServers(ctx: LoadContext): Promise<LoadResult<MCPServer>> {
	const configPath = getProjectPath(ctx, "codex", "config.toml");
	const config = await loadTomlConfig(configPath);

	const items: MCPServer[] = [];
	if (config) {
		const servers = extractMCPServersFromToml(config, path.dirname(configPath));
		for (const name in servers) {
			items.push({
				name,
				...servers[name],
				_source: createSourceMeta(PROVIDER_ID, configPath, "project"),
			});
		}
	}

	return { items, warnings: [] };
}

async function loadTomlConfig(path: string): Promise<Record<string, unknown> | null> {
	const content = await readFile(path);
	if (!content) return null;

	try {
		return Bun.TOML.parse(content) as Record<string, unknown>;
	} catch (error) {
		logger.warn("Failed to parse TOML config", { path, error: String(error) });
		return null;
	}
}

/** Codex MCP server config format (from config.toml) */
interface CodexMCPConfig {
	enabled?: boolean;
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	env_vars?: string[]; // Environment variable names to forward from parent
	url?: string;
	http_headers?: Record<string, string>;
	env_http_headers?: Record<string, string>; // Header name -> env var name
	bearer_token_env_var?: string;
	cwd?: string;
	startup_timeout_sec?: number;
	tool_timeout_sec?: number;
	enabled_tools?: string[];
	disabled_tools?: string[];
}

function extractMCPServersFromToml(
	toml: Record<string, unknown>,
	configDir: string,
): Record<string, Partial<MCPServer>> {
	// Check for [mcp_servers.*] sections (Codex format)
	if (!toml.mcp_servers || typeof toml.mcp_servers !== "object") {
		return {};
	}

	const codexServers = toml.mcp_servers as Record<string, CodexMCPConfig>;
	const result: Record<string, Partial<MCPServer>> = {};

	for (const name in codexServers) {
		const config = codexServers[name];
		// Root relative cwd/command against the Codex config directory. Codex
		// spawns the process with the resolved cwd, so a relative command is
		// resolved by the OS from there — pass "cwd" so e.g. cwd="server",
		// command="./bin/mcp" resolves to <configDir>/server/bin/mcp.
		const rooted = resolvePluginStdioPaths({ command: config.command, cwd: config.cwd }, configDir, "cwd");
		const server: Partial<MCPServer> = {
			// Carry `enabled: false` through rather than dropping the entry: the
			// central MCP loader (`loadAllMCPConfigs`) suppresses disabled servers
			// so they still claim their dedupe key (keeping a same-named,
			// lower-priority source disabled) and remain overridable via the user
			// force-enable allowlist. Dropping here would defeat both.
			...(config.enabled === false && { enabled: false }),
			...(rooted.command !== undefined && { command: rooted.command }),
			args: config.args,
			url: config.url,
			...(rooted.cwd !== undefined && { cwd: rooted.cwd }),
		};

		// Build env by merging explicit env and forwarded env_vars
		const env: Record<string, string> = { ...config.env };
		if (config.env_vars) {
			for (const varName of config.env_vars) {
				const value = Bun.env[varName];
				if (value !== undefined) {
					env[varName] = value;
				}
			}
		}
		if (Object.keys(env).length > 0) {
			server.env = env;
		}

		// Build headers from http_headers, env_http_headers, and bearer_token_env_var
		const headers: Record<string, string> = { ...config.http_headers };
		if (config.env_http_headers) {
			for (const [headerName, envVarName] of Object.entries(config.env_http_headers)) {
				const value = Bun.env[envVarName];
				if (value !== undefined) {
					headers[headerName] = value;
				}
			}
		}
		if (config.bearer_token_env_var) {
			const token = Bun.env[config.bearer_token_env_var];
			if (token) {
				headers.Authorization = `Bearer ${token}`;
			}
		}
		if (Object.keys(headers).length > 0) {
			server.headers = headers;
		}

		// Determine transport type (infer from config if not explicit)
		if (config.url) {
			server.transport = "http";
		} else if (config.command) {
			server.transport = "stdio";
		}
		// Note: validation of transport vs endpoint is handled by mcpCapability.validate()

		// Map Codex tool_timeout_sec (seconds) to MCPServer timeout (milliseconds)
		if (typeof config.tool_timeout_sec === "number" && config.tool_timeout_sec > 0) {
			server.timeout = config.tool_timeout_sec * 1000;
		}
		result[name] = server;
	}

	return result;
}

// =============================================================================
// Skills (skills/)
// =============================================================================

function loadSkills(ctx: LoadContext): Promise<LoadResult<Skill>> {
	return scanSkillsFromDir(ctx, {
		dir: getProjectPath(ctx, "codex", "skills"),
		providerId: PROVIDER_ID,
		level: "project",
	});
}

// =============================================================================
// Provider Registration (executes on module import)
// =============================================================================

registerProvider<MCPServer>(mcpCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load MCP servers from .codex/config.toml [mcp_servers.*] sections",
	priority: PRIORITY,
	load: loadMCPServers,
});

registerProvider<Skill>(skillCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load skills from .codex/skills/",
	priority: PRIORITY,
	load: loadSkills,
});
