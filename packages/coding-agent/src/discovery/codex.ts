/**
 * Codex Discovery Provider
 *
 * Loads configuration from OpenAI Codex format:
 * - System Instructions: AGENTS.md (user-level only at ~/.codex/AGENTS.md)
 *
 * User directory: ~/.codex
 */

import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { ContextFile } from "../capability/context-file";
import { contextFileCapability } from "../capability/context-file";
import type { Hook } from "../capability/hook";
import { hookCapability } from "../capability/hook";
import { registerProvider } from "../capability/index";
import type { MCPServer } from "../capability/mcp";
import { mcpCapability } from "../capability/mcp";
import type { Prompt } from "../capability/prompt";
import { promptCapability } from "../capability/prompt";
import type { Settings } from "../capability/settings";
import { settingsCapability } from "../capability/settings";
import type { Skill } from "../capability/skill";
import { skillCapability } from "../capability/skill";
import type { SlashCommand } from "../capability/slash-command";
import { slashCommandCapability } from "../capability/slash-command";
import type { CustomTool } from "../capability/tool";
import { toolCapability } from "../capability/tool";
import type { LoadContext, LoadResult } from "../capability/types";
import { createSourceMeta, loadFilesFromDir, parseFrontmatter, SOURCE_PATHS } from "./helpers";

const PROVIDER_ID = "codex";
const DISPLAY_NAME = "OpenAI Codex";
const PRIORITY = 70;

// =============================================================================
// Context Files (AGENTS.md)
// =============================================================================

function loadContextFiles(ctx: LoadContext): LoadResult<ContextFile> {
	const items: ContextFile[] = [];
	const warnings: string[] = [];

	// User level only: ~/.codex/AGENTS.md
	const userBase = join(ctx.home, SOURCE_PATHS.codex.userBase);
	if (ctx.fs.isDir(userBase)) {
		const agentsMd = join(userBase, "AGENTS.md");
		const agentsContent = ctx.fs.readFile(agentsMd);
		if (agentsContent) {
			items.push({
				path: agentsMd,
				content: agentsContent,
				level: "user",
				_source: createSourceMeta(PROVIDER_ID, agentsMd, "user"),
			});
		}
	}

	return { items, warnings };
}

// =============================================================================
// MCP Servers (config.toml)
// =============================================================================

function loadMCPServers(ctx: LoadContext): LoadResult<MCPServer> {
	const items: MCPServer[] = [];
	const warnings: string[] = [];

	// User level: ~/.codex/config.toml
	const userConfigPath = join(ctx.home, SOURCE_PATHS.codex.userBase, "config.toml");
	const userConfig = loadTomlConfig(ctx, userConfigPath);
	if (userConfig) {
		const servers = extractMCPServersFromToml(userConfig);
		for (const [name, config] of Object.entries(servers)) {
			items.push({
				name,
				...config,
				_source: createSourceMeta(PROVIDER_ID, userConfigPath, "user"),
			});
		}
	}

	// Project level: .codex/config.toml
	const codexDir = ctx.fs.walkUp(".codex", { dir: true });
	if (codexDir) {
		const projectConfigPath = join(codexDir, "config.toml");
		const projectConfig = loadTomlConfig(ctx, projectConfigPath);
		if (projectConfig) {
			const servers = extractMCPServersFromToml(projectConfig);
			for (const [name, config] of Object.entries(servers)) {
				items.push({
					name,
					...config,
					_source: createSourceMeta(PROVIDER_ID, projectConfigPath, "project"),
				});
			}
		}
	}

	return { items, warnings };
}

function loadTomlConfig(ctx: LoadContext, path: string): Record<string, unknown> | null {
	const content = ctx.fs.readFile(path);
	if (!content) return null;

	try {
		return parseToml(content) as Record<string, unknown>;
	} catch (_err) {
		return null;
	}
}

/** Codex MCP server config format (from config.toml) */
interface CodexMCPConfig {
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

function extractMCPServersFromToml(toml: Record<string, unknown>): Record<string, Partial<MCPServer>> {
	// Check for [mcp_servers.*] sections (Codex format)
	if (!toml.mcp_servers || typeof toml.mcp_servers !== "object") {
		return {};
	}

	const codexServers = toml.mcp_servers as Record<string, CodexMCPConfig>;
	const result: Record<string, Partial<MCPServer>> = {};

	for (const [name, config] of Object.entries(codexServers)) {
		const server: Partial<MCPServer> = {
			command: config.command,
			args: config.args,
			url: config.url,
		};

		// Build env by merging explicit env and forwarded env_vars
		const env: Record<string, string> = { ...config.env };
		if (config.env_vars) {
			for (const varName of config.env_vars) {
				const value = process.env[varName];
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
				const value = process.env[envVarName];
				if (value !== undefined) {
					headers[headerName] = value;
				}
			}
		}
		if (config.bearer_token_env_var) {
			const token = process.env[config.bearer_token_env_var];
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

		result[name] = server;
	}

	return result;
}

// =============================================================================
// Skills (skills/)
// =============================================================================

function loadSkills(ctx: LoadContext): LoadResult<Skill> {
	const items: Skill[] = [];
	const warnings: string[] = [];

	// User level: ~/.codex/skills/
	const userSkillsDir = join(ctx.home, SOURCE_PATHS.codex.userBase, "skills");
	const userResult = loadFilesFromDir(ctx, userSkillsDir, PROVIDER_ID, "user", {
		extensions: ["md"],
		recursive: true,
		transform: (name, content, path, source) => {
			const { frontmatter, body } = parseFrontmatter(content);
			const skillName = frontmatter.name || name.replace(/\.md$/, "");

			return {
				name: String(skillName),
				path,
				content: body,
				frontmatter,
				level: "user" as const,
				_source: source,
			};
		},
	});
	items.push(...userResult.items);
	warnings.push(...(userResult.warnings || []));

	// Project level: .codex/skills/
	const codexDir = ctx.fs.walkUp(".codex", { dir: true });
	if (codexDir) {
		const projectSkillsDir = join(codexDir, "skills");
		const projectResult = loadFilesFromDir(ctx, projectSkillsDir, PROVIDER_ID, "project", {
			extensions: ["md"],
			recursive: true,
			transform: (name, content, path, source) => {
				const { frontmatter, body } = parseFrontmatter(content);
				const skillName = frontmatter.name || name.replace(/\.md$/, "");

				return {
					name: String(skillName),
					path,
					content: body,
					frontmatter,
					level: "project" as const,
					_source: source,
				};
			},
		});
		items.push(...projectResult.items);
		warnings.push(...(projectResult.warnings || []));
	}

	return { items, warnings };
}

// =============================================================================
// Slash Commands (commands/)
// =============================================================================

function loadSlashCommands(ctx: LoadContext): LoadResult<SlashCommand> {
	const items: SlashCommand[] = [];
	const warnings: string[] = [];

	// User level: ~/.codex/commands/
	const userCommandsDir = join(ctx.home, SOURCE_PATHS.codex.userBase, "commands");
	const userResult = loadFilesFromDir(ctx, userCommandsDir, PROVIDER_ID, "user", {
		extensions: ["md"],
		transform: (name, content, path, source) => {
			const { frontmatter, body } = parseFrontmatter(content);
			const commandName = frontmatter.name || name.replace(/\.md$/, "");

			return {
				name: String(commandName),
				path,
				content: body,
				level: "user" as const,
				_source: source,
			};
		},
	});
	items.push(...userResult.items);
	warnings.push(...(userResult.warnings || []));

	// Project level: .codex/commands/
	const codexDir = ctx.fs.walkUp(".codex", { dir: true });
	if (codexDir) {
		const projectCommandsDir = join(codexDir, "commands");
		const projectResult = loadFilesFromDir(ctx, projectCommandsDir, PROVIDER_ID, "project", {
			extensions: ["md"],
			transform: (name, content, path, source) => {
				const { frontmatter, body } = parseFrontmatter(content);
				const commandName = frontmatter.name || name.replace(/\.md$/, "");

				return {
					name: String(commandName),
					path,
					content: body,
					level: "project" as const,
					_source: source,
				};
			},
		});
		items.push(...projectResult.items);
		warnings.push(...(projectResult.warnings || []));
	}

	return { items, warnings };
}

// =============================================================================
// Prompts (prompts/*.md)
// =============================================================================

function loadPrompts(ctx: LoadContext): LoadResult<Prompt> {
	const items: Prompt[] = [];
	const warnings: string[] = [];

	// User level: ~/.codex/prompts/
	const userPromptsDir = join(ctx.home, SOURCE_PATHS.codex.userBase, "prompts");
	const userResult = loadFilesFromDir(ctx, userPromptsDir, PROVIDER_ID, "user", {
		extensions: ["md"],
		transform: (name, content, path, source) => {
			const { frontmatter, body } = parseFrontmatter(content);
			const promptName = frontmatter.name || name.replace(/\.md$/, "");

			return {
				name: String(promptName),
				path,
				content: body,
				description: frontmatter.description ? String(frontmatter.description) : undefined,
				_source: source,
			};
		},
	});
	items.push(...userResult.items);
	warnings.push(...(userResult.warnings || []));

	// Project level: .codex/prompts/
	const codexDir = ctx.fs.walkUp(".codex", { dir: true });
	if (codexDir) {
		const projectPromptsDir = join(codexDir, "prompts");
		const projectResult = loadFilesFromDir(ctx, projectPromptsDir, PROVIDER_ID, "project", {
			extensions: ["md"],
			transform: (name, content, path, source) => {
				const { frontmatter, body } = parseFrontmatter(content);
				const promptName = frontmatter.name || name.replace(/\.md$/, "");

				return {
					name: String(promptName),
					path,
					content: body,
					description: frontmatter.description ? String(frontmatter.description) : undefined,
					_source: source,
				};
			},
		});
		items.push(...projectResult.items);
		warnings.push(...(projectResult.warnings || []));
	}

	return { items, warnings };
}

// =============================================================================
// Hooks (hooks/)
// =============================================================================

function loadHooks(ctx: LoadContext): LoadResult<Hook> {
	const items: Hook[] = [];
	const warnings: string[] = [];

	// User level: ~/.codex/hooks/
	const userHooksDir = join(ctx.home, SOURCE_PATHS.codex.userBase, "hooks");
	const userResult = loadFilesFromDir(ctx, userHooksDir, PROVIDER_ID, "user", {
		extensions: ["ts", "js"],
		transform: (name, _content, path, source) => {
			// Extract hook type and tool from filename (e.g., pre-bash.ts -> type: pre, tool: bash)
			const baseName = name.replace(/\.(ts|js)$/, "");
			const match = baseName.match(/^(pre|post)-(.+)$/);
			const hookType = (match?.[1] as "pre" | "post") || "pre";
			const toolName = match?.[2] || baseName;

			return {
				name,
				path,
				type: hookType,
				tool: toolName,
				level: "user" as const,
				_source: source,
			};
		},
	});
	items.push(...userResult.items);
	warnings.push(...(userResult.warnings || []));

	// Project level: .codex/hooks/
	const codexDir = ctx.fs.walkUp(".codex", { dir: true });
	if (codexDir) {
		const projectHooksDir = join(codexDir, "hooks");
		const projectResult = loadFilesFromDir(ctx, projectHooksDir, PROVIDER_ID, "project", {
			extensions: ["ts", "js"],
			transform: (name, _content, path, source) => {
				const baseName = name.replace(/\.(ts|js)$/, "");
				const match = baseName.match(/^(pre|post)-(.+)$/);
				const hookType = (match?.[1] as "pre" | "post") || "pre";
				const toolName = match?.[2] || baseName;

				return {
					name,
					path,
					type: hookType,
					tool: toolName,
					level: "project" as const,
					_source: source,
				};
			},
		});
		items.push(...projectResult.items);
		warnings.push(...(projectResult.warnings || []));
	}

	return { items, warnings };
}

// =============================================================================
// Tools (tools/)
// =============================================================================

function loadTools(ctx: LoadContext): LoadResult<CustomTool> {
	const items: CustomTool[] = [];
	const warnings: string[] = [];

	// User level: ~/.codex/tools/
	const userToolsDir = join(ctx.home, SOURCE_PATHS.codex.userBase, "tools");
	const userResult = loadFilesFromDir(ctx, userToolsDir, PROVIDER_ID, "user", {
		extensions: ["ts", "js"],
		transform: (name, _content, path, source) => {
			const toolName = name.replace(/\.(ts|js)$/, "");
			return {
				name: toolName,
				path,
				level: "user" as const,
				_source: source,
			} as CustomTool;
		},
	});
	items.push(...userResult.items);
	warnings.push(...(userResult.warnings || []));

	// Project level: .codex/tools/
	const codexDir = ctx.fs.walkUp(".codex", { dir: true });
	if (codexDir) {
		const projectToolsDir = join(codexDir, "tools");
		const projectResult = loadFilesFromDir(ctx, projectToolsDir, PROVIDER_ID, "project", {
			extensions: ["ts", "js"],
			transform: (name, _content, path, source) => {
				const toolName = name.replace(/\.(ts|js)$/, "");
				return {
					name: toolName,
					path,
					level: "project" as const,
					_source: source,
				} as CustomTool;
			},
		});
		items.push(...projectResult.items);
		warnings.push(...(projectResult.warnings || []));
	}

	return { items, warnings };
}

// =============================================================================
// Settings (config.toml)
// =============================================================================

function loadSettings(ctx: LoadContext): LoadResult<Settings> {
	const items: Settings[] = [];
	const warnings: string[] = [];

	// User level: ~/.codex/config.toml
	const userConfigPath = join(ctx.home, SOURCE_PATHS.codex.userBase, "config.toml");
	const userConfig = loadTomlConfig(ctx, userConfigPath);
	if (userConfig) {
		items.push({
			...userConfig,
			_source: createSourceMeta(PROVIDER_ID, userConfigPath, "user"),
		} as Settings);
	}

	// Project level: .codex/config.toml
	const codexDir = ctx.fs.walkUp(".codex", { dir: true });
	if (codexDir) {
		const projectConfigPath = join(codexDir, "config.toml");
		const projectConfig = loadTomlConfig(ctx, projectConfigPath);
		if (projectConfig) {
			items.push({
				...projectConfig,
				_source: createSourceMeta(PROVIDER_ID, projectConfigPath, "project"),
			} as Settings);
		}
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
