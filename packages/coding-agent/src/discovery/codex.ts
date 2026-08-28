/**
 * Codex Discovery Provider
 *
 * Loads configuration from OpenAI Codex format:
 * - System Instructions: AGENTS.md (user-level only at ~/.codex/AGENTS.md)
 *
 * User directory: ~/.codex
 */
import * as path from "node:path";
import { logger, parseFrontmatter } from "@oh-my-pi/pi-utils";
import { registerProvider } from "../capability";
import type { ContextFile } from "../capability/context-file";
import { contextFileCapability } from "../capability/context-file";
import { type ExtensionModule, extensionModuleCapability } from "../capability/extension-module";
import { readFile } from "../capability/fs";
import type { Hook } from "../capability/hook";
import { hookCapability } from "../capability/hook";
import type { MCPServer } from "../capability/mcp";
import { mcpCapability } from "../capability/mcp";
import type { Prompt } from "../capability/prompt";
import { promptCapability } from "../capability/prompt";
import type { Settings } from "../capability/settings";
import { settingsCapability } from "../capability/settings";
import type { Skill } from "../capability/skill";
import { skillCapability } from "../capability/skill";
import { type SlashCommand, slashCommandCapability, slashCommandFrontmatterDisplay } from "../capability/slash-command";
import type { CustomTool } from "../capability/tool";
import { toolCapability } from "../capability/tool";
import type { LoadContext, LoadResult, SourceMeta } from "../capability/types";

import {
	buildExtensionModuleItems,
	createSourceMeta,
	discoverExtensionModulePaths,
	loadFilesFromDir,
	SOURCE_PATHS,
	scanSkillsFromDir,
} from "./helpers";
import { resolvePluginStdioPaths } from "./substitute-plugin-root";

const PROVIDER_ID = "codex";
const DISPLAY_NAME = "OpenAI Codex";
const PRIORITY = 70;

function getProjectCodexDir(ctx: LoadContext): string {
	return path.join(ctx.cwd, ".codex");
}

// =============================================================================
// Context Files (AGENTS.md)
// =============================================================================

async function loadContextFiles(ctx: LoadContext): Promise<LoadResult<ContextFile>> {
	const items: ContextFile[] = [];
	const warnings: string[] = [];

	// User level only: ~/.codex/AGENTS.md
	const agentsMd = path.join(ctx.home, SOURCE_PATHS.codex.userBase, "AGENTS.md");
	const agentsContent = await readFile(agentsMd);
	if (agentsContent) {
		items.push({
			path: agentsMd,
			content: agentsContent,
			level: "user",
			_source: createSourceMeta(PROVIDER_ID, agentsMd, "user"),
		});
	}

	return { items, warnings };
}

// =============================================================================
// MCP Servers (config.toml)
// =============================================================================

async function loadMCPServers(ctx: LoadContext): Promise<LoadResult<MCPServer>> {
	const warnings: string[] = [];

	const userConfigPath = path.join(ctx.home, SOURCE_PATHS.codex.userBase, "config.toml");
	const codexDir = getProjectCodexDir(ctx);
	const projectConfigPath = path.join(codexDir, "config.toml");

	const [userConfig, projectConfig] = await Promise.all([
		loadTomlConfig(ctx, userConfigPath),
		loadTomlConfig(ctx, projectConfigPath),
	]);

	const items: MCPServer[] = [];
	// Capability dedupe is first-wins, including suppressed items claiming their
	// key. Load project entries first so a project `enabled = false` keeps a
	// same-named user server disabled.
	if (projectConfig) {
		const servers = extractMCPServersFromToml(projectConfig, path.dirname(projectConfigPath));
		for (const name in servers) {
			const config = servers[name];
			items.push({
				name,
				...config,
				_source: createSourceMeta(PROVIDER_ID, projectConfigPath, "project"),
			});
		}
	}
	if (userConfig) {
		const servers = extractMCPServersFromToml(userConfig, path.dirname(userConfigPath));
		for (const name in servers) {
			const config = servers[name];
			items.push({
				name,
				...config,
				_source: createSourceMeta(PROVIDER_ID, userConfigPath, "user"),
			});
		}
	}

	return { items, warnings };
}

async function loadTomlConfig(_ctx: LoadContext, path: string): Promise<Record<string, unknown> | null> {
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

async function loadSkills(ctx: LoadContext): Promise<LoadResult<Skill>> {
	const userSkillsDir = path.join(ctx.home, SOURCE_PATHS.codex.userBase, "skills");
	const codexDir = getProjectCodexDir(ctx);
	const projectSkillsDir = path.join(codexDir, "skills");

	const results = await Promise.all([
		scanSkillsFromDir(ctx, {
			dir: userSkillsDir,
			providerId: PROVIDER_ID,
			level: "user",
		}),
		scanSkillsFromDir(ctx, {
			dir: projectSkillsDir,
			providerId: PROVIDER_ID,
			level: "project",
		}),
	]);

	const items = results.flatMap(r => r.items);
	const warnings = results.flatMap(r => r.warnings || []);

	return { items, warnings };
}

// =============================================================================
// Extension Modules (extensions/)
// =============================================================================

async function loadExtensionModules(ctx: LoadContext): Promise<LoadResult<ExtensionModule>> {
	const warnings: string[] = [];

	const userExtensionsDir = path.join(ctx.home, SOURCE_PATHS.codex.userBase, "extensions");
	const codexDir = getProjectCodexDir(ctx);
	const projectExtensionsDir = path.join(codexDir, "extensions");

	const [userPaths, projectPaths] = await Promise.all([
		discoverExtensionModulePaths(ctx, userExtensionsDir),
		discoverExtensionModulePaths(ctx, projectExtensionsDir),
	]);

	const items = buildExtensionModuleItems(PROVIDER_ID, userPaths, projectPaths);

	return { items, warnings };
}

// =============================================================================
// Slash Commands (commands/)
// =============================================================================

async function loadSlashCommands(ctx: LoadContext): Promise<LoadResult<SlashCommand>> {
	const userCommandsDir = path.join(ctx.home, SOURCE_PATHS.codex.userBase, "commands");
	const codexDir = getProjectCodexDir(ctx);
	const projectCommandsDir = path.join(codexDir, "commands");

	const transformCommand =
		(level: "user" | "project") => (name: string, content: string, path: string, source: SourceMeta) => {
			const { frontmatter, body } = parseFrontmatter(content, { source: path });
			const commandName = frontmatter.name || name.replace(/\.md$/, "");
			return {
				name: String(commandName),
				path,
				content: body,
				...slashCommandFrontmatterDisplay(frontmatter),
				level,
				_source: source,
			};
		};

	const results = await Promise.all([
		loadFilesFromDir(ctx, userCommandsDir, PROVIDER_ID, "user", {
			extensions: ["md"],
			transform: transformCommand("user"),
		}),
		loadFilesFromDir(ctx, projectCommandsDir, PROVIDER_ID, "project", {
			extensions: ["md"],
			transform: transformCommand("project"),
		}),
	]);

	const items = results.flatMap(r => r.items);
	const warnings = results.flatMap(r => r.warnings || []);

	return { items, warnings };
}

// =============================================================================
// Prompts (prompts/*.md)
// =============================================================================

async function loadPrompts(ctx: LoadContext): Promise<LoadResult<Prompt>> {
	const userPromptsDir = path.join(ctx.home, SOURCE_PATHS.codex.userBase, "prompts");
	const codexDir = getProjectCodexDir(ctx);
	const projectPromptsDir = path.join(codexDir, "prompts");

	const transformPrompt = (name: string, content: string, path: string, source: SourceMeta) => {
		const { frontmatter, body } = parseFrontmatter(content, { source: path });
		const promptName = frontmatter.name || name.replace(/\.md$/, "");
		return {
			name: String(promptName),
			path,
			content: body,
			description: frontmatter.description ? String(frontmatter.description) : undefined,
			_source: source,
		};
	};

	const results = await Promise.all([
		loadFilesFromDir(ctx, userPromptsDir, PROVIDER_ID, "user", {
			extensions: ["md"],
			transform: transformPrompt,
		}),
		loadFilesFromDir(ctx, projectPromptsDir, PROVIDER_ID, "project", {
			extensions: ["md"],
			transform: transformPrompt,
		}),
	]);

	const items = results.flatMap(r => r.items);
	const warnings = results.flatMap(r => r.warnings || []);

	return { items, warnings };
}

// =============================================================================
// Hooks (hooks/)
// =============================================================================

async function loadHooks(ctx: LoadContext): Promise<LoadResult<Hook>> {
	const userHooksDir = path.join(ctx.home, SOURCE_PATHS.codex.userBase, "hooks");
	const codexDir = getProjectCodexDir(ctx);
	const projectHooksDir = path.join(codexDir, "hooks");

	// OMP hooks must be named `pre-<tool>.<ts|js>` or `post-<tool>.<ts|js>`.
	// Files without that prefix are not OMP hooks (e.g. the standalone Codex
	// hook scripts users keep alongside) — silently dropping the prefix and
	// defaulting to `pre:<basename>` caused those scripts to be imported as
	// extension factories and any top-level `process.exit()` killed startup
	// (#3680).
	const transformHook =
		(level: "user" | "project") =>
		(name: string, _content: string, path: string, source: SourceMeta): Hook | null => {
			const baseName = name.replace(/\.(ts|js)$/, "");
			const match = baseName.match(/^(pre|post)-(.+)$/);
			if (!match) return null;
			const hookType = match[1] as "pre" | "post";
			const toolName = match[2];
			return {
				name,
				path,
				type: hookType,
				tool: toolName,
				level,
				_source: source,
			};
		};

	const results = await Promise.all([
		loadFilesFromDir<Hook>(ctx, userHooksDir, PROVIDER_ID, "user", {
			extensions: ["ts", "js"],
			transform: transformHook("user"),
		}),
		loadFilesFromDir<Hook>(ctx, projectHooksDir, PROVIDER_ID, "project", {
			extensions: ["ts", "js"],
			transform: transformHook("project"),
		}),
	]);

	const items = results.flatMap(r => r.items);
	const warnings = results.flatMap(r => r.warnings || []);

	return { items, warnings };
}

// =============================================================================
// Tools (tools/)
// =============================================================================

async function loadTools(ctx: LoadContext): Promise<LoadResult<CustomTool>> {
	const userToolsDir = path.join(ctx.home, SOURCE_PATHS.codex.userBase, "tools");
	const codexDir = getProjectCodexDir(ctx);
	const projectToolsDir = path.join(codexDir, "tools");

	const transformTool =
		(level: "user" | "project") => (name: string, _content: string, path: string, source: SourceMeta) => {
			const toolName = name.replace(/\.(ts|js)$/, "");
			return {
				name: toolName,
				path,
				level,
				_source: source,
			} as CustomTool;
		};

	const results = await Promise.all([
		loadFilesFromDir(ctx, userToolsDir, PROVIDER_ID, "user", {
			extensions: ["ts", "js"],
			transform: transformTool("user"),
		}),
		loadFilesFromDir(ctx, projectToolsDir, PROVIDER_ID, "project", {
			extensions: ["ts", "js"],
			transform: transformTool("project"),
		}),
	]);

	const items = results.flatMap(r => r.items);
	const warnings = results.flatMap(r => r.warnings || []);

	return { items, warnings };
}

// =============================================================================
// Settings (config.toml)
// =============================================================================

async function loadSettings(ctx: LoadContext): Promise<LoadResult<Settings>> {
	const warnings: string[] = [];

	const userConfigPath = path.join(ctx.home, SOURCE_PATHS.codex.userBase, "config.toml");
	const codexDir = getProjectCodexDir(ctx);
	const projectConfigPath = path.join(codexDir, "config.toml");

	const [userConfig, projectConfig] = await Promise.all([
		loadTomlConfig(ctx, userConfigPath),
		loadTomlConfig(ctx, projectConfigPath),
	]);

	const items: Settings[] = [];
	if (userConfig) {
		items.push({
			...userConfig,
			_source: createSourceMeta(PROVIDER_ID, userConfigPath, "user"),
		} as Settings);
	}
	if (projectConfig) {
		items.push({
			...projectConfig,
			_source: createSourceMeta(PROVIDER_ID, projectConfigPath, "project"),
		} as Settings);
	}

	return { items, warnings };
}

// =============================================================================
// Provider Registration (executes on module import)
// =============================================================================

registerProvider<ContextFile>(contextFileCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load context files from ~/.codex/AGENTS.md (user-level only)",
	priority: PRIORITY,
	load: loadContextFiles,
});

registerProvider<MCPServer>(mcpCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load MCP servers from config.toml [mcp_servers.*] sections",
	priority: PRIORITY,
	load: loadMCPServers,
});

registerProvider<Skill>(skillCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load skills from ~/.codex/skills and .codex/skills/",
	priority: PRIORITY,
	load: loadSkills,
});

registerProvider<ExtensionModule>(extensionModuleCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load extension modules from ~/.codex/extensions and .codex/extensions/",
	priority: PRIORITY,
	load: loadExtensionModules,
});

registerProvider<SlashCommand>(slashCommandCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load slash commands from ~/.codex/commands and .codex/commands/",
	priority: PRIORITY,
	load: loadSlashCommands,
});

registerProvider<Prompt>(promptCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load prompts from ~/.codex/prompts and .codex/prompts/",
	priority: PRIORITY,
	load: loadPrompts,
});

registerProvider<Hook>(hookCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load hooks from ~/.codex/hooks and .codex/hooks/",
	priority: PRIORITY,
	load: loadHooks,
});

registerProvider<CustomTool>(toolCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load custom tools from ~/.codex/tools and .codex/tools/",
	priority: PRIORITY,
	load: loadTools,
});

registerProvider<Settings>(settingsCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load settings from config.toml",
	priority: PRIORITY,
	load: loadSettings,
});
