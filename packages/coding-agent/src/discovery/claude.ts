/**
 * Claude Code Provider
 *
 * Loads configuration from .claude directories.
 * Priority: 80 (tool-specific, below builtin but above shared standards)
 */

import { dirname, join, sep } from "node:path";
import { type ContextFile, contextFileCapability } from "../capability/context-file";
import { type Hook, hookCapability } from "../capability/hook";
import { registerProvider } from "../capability/index";
import { type MCPServer, mcpCapability } from "../capability/mcp";
import { type Settings, settingsCapability } from "../capability/settings";
import { type Skill, skillCapability } from "../capability/skill";
import { type SlashCommand, slashCommandCapability } from "../capability/slash-command";
import { type SystemPrompt, systemPromptCapability } from "../capability/system-prompt";
import { type CustomTool, toolCapability } from "../capability/tool";
import type { LoadContext, LoadResult } from "../capability/types";
import {
	calculateDepth,
	createSourceMeta,
	expandEnvVarsDeep,
	loadFilesFromDir,
	parseFrontmatter,
	parseJSON,
} from "./helpers";

const PROVIDER_ID = "claude";
const DISPLAY_NAME = "Claude Code";
const PRIORITY = 80;
const CONFIG_DIR = ".claude";

/**
 * Get user-level .claude path.
 */
function getUserClaude(ctx: LoadContext): string {
	return join(ctx.home, CONFIG_DIR);
}

/**
 * Get project-level .claude path (walks up from cwd).
 */
function getProjectClaude(ctx: LoadContext): string | null {
	return ctx.fs.walkUp(CONFIG_DIR, { dir: true });
}

// =============================================================================
// MCP Servers
// =============================================================================

function loadMCPServers(ctx: LoadContext): LoadResult<MCPServer> {
	const items: MCPServer[] = [];
	const warnings: string[] = [];

	// User-level: ~/.claude.json or ~/.claude/mcp.json
	const userBase = getUserClaude(ctx);
	const userClaudeJson = join(ctx.home, ".claude.json");
	const userMcpJson = join(userBase, "mcp.json");

	for (const [path, level] of [
		[userClaudeJson, "user"],
		[userMcpJson, "user"],
	] as const) {
		if (!ctx.fs.isFile(path)) continue;

		const content = ctx.fs.readFile(path);
		if (!content) {
			warnings.push(`Failed to read ${path}`);
			continue;
		}

		const json = parseJSON<{ mcpServers?: Record<string, unknown> }>(content);
		if (!json?.mcpServers) continue;

		const mcpServers = expandEnvVarsDeep(json.mcpServers);

		for (const [name, config] of Object.entries(mcpServers)) {
			const serverConfig = config as Record<string, unknown>;
			items.push({
				name,
				command: serverConfig.command as string | undefined,
				args: serverConfig.args as string[] | undefined,
				env: serverConfig.env as Record<string, string> | undefined,
				url: serverConfig.url as string | undefined,
				headers: serverConfig.headers as Record<string, string> | undefined,
				transport: serverConfig.type as "stdio" | "sse" | "http" | undefined,
				_source: createSourceMeta(PROVIDER_ID, path, level),
			});
		}
		break; // First existing file wins
	}

	// Project-level: <project>/.mcp.json or <project>/mcp.json
	const projectBase = getProjectClaude(ctx);
	if (projectBase) {
		const projectMcpJson = join(projectBase, ".mcp.json");
		const projectMcpJsonAlt = join(projectBase, "mcp.json");

		for (const path of [projectMcpJson, projectMcpJsonAlt]) {
			if (!ctx.fs.isFile(path)) continue;

			const content = ctx.fs.readFile(path);
			if (!content) {
				warnings.push(`Failed to read ${path}`);
				continue;
			}

			const json = parseJSON<{ mcpServers?: Record<string, unknown> }>(content);
			if (!json?.mcpServers) continue;

			const mcpServers = expandEnvVarsDeep(json.mcpServers);

			for (const [name, config] of Object.entries(mcpServers)) {
				const serverConfig = config as Record<string, unknown>;
				items.push({
					name,
					command: serverConfig.command as string | undefined,
					args: serverConfig.args as string[] | undefined,
					env: serverConfig.env as Record<string, string> | undefined,
					url: serverConfig.url as string | undefined,
					headers: serverConfig.headers as Record<string, string> | undefined,
					transport: serverConfig.type as "stdio" | "sse" | "http" | undefined,
					_source: createSourceMeta(PROVIDER_ID, path, "project"),
				});
			}
			break; // First existing file wins
		}
	}

	return { items, warnings };
}

// =============================================================================
// Context Files (CLAUDE.md)
// =============================================================================

function loadContextFiles(ctx: LoadContext): LoadResult<ContextFile> {
	const items: ContextFile[] = [];
	const warnings: string[] = [];

	// User-level: ~/.claude/CLAUDE.md
	const userBase = getUserClaude(ctx);
	const userClaudeMd = join(userBase, "CLAUDE.md");

	if (ctx.fs.isFile(userClaudeMd)) {
		const content = ctx.fs.readFile(userClaudeMd);
		if (content !== null) {
			items.push({
				path: userClaudeMd,
				content,
				level: "user",
				_source: createSourceMeta(PROVIDER_ID, userClaudeMd, "user"),
			});
		} else {
			warnings.push(`Failed to read ${userClaudeMd}`);
		}
	}

	// Project-level: walk up looking for .claude/CLAUDE.md
	const projectBase = getProjectClaude(ctx);
	if (projectBase) {
		const projectClaudeMd = join(projectBase, "CLAUDE.md");

		if (ctx.fs.isFile(projectClaudeMd)) {
			const content = ctx.fs.readFile(projectClaudeMd);
			if (content !== null) {
				// Calculate depth (distance from cwd)
				const depth = calculateDepth(ctx.cwd, projectBase, sep);

				items.push({
					path: projectClaudeMd,
					content,
					level: "project",
					depth,
					_source: createSourceMeta(PROVIDER_ID, projectClaudeMd, "project"),
				});
			} else {
				warnings.push(`Failed to read ${projectClaudeMd}`);
			}
		}
	}

	// Also check for CLAUDE.md in project root (without .claude directory)
	const rootClaudeMd = ctx.fs.walkUp("CLAUDE.md", { file: true });
	if (rootClaudeMd) {
		const content = ctx.fs.readFile(rootClaudeMd);
		if (content !== null) {
			// Only add if not already added from .claude/CLAUDE.md
			const alreadyAdded = items.some((item) => item.path === rootClaudeMd);
			if (!alreadyAdded) {
				const fileDir = dirname(rootClaudeMd);
				const depth = calculateDepth(ctx.cwd, fileDir, sep);

				items.push({
					path: rootClaudeMd,
					content,
					level: "project",
					depth,
					_source: createSourceMeta(PROVIDER_ID, rootClaudeMd, "project"),
				});
			}
		} else {
			warnings.push(`Failed to read ${rootClaudeMd}`);
		}
	}

	return { items, warnings };
}

// =============================================================================
// Skills
// =============================================================================

function loadSkills(ctx: LoadContext): LoadResult<Skill> {
	const items: Skill[] = [];
	const warnings: string[] = [];

	// User-level: ~/.claude/skills/*/SKILL.md
	const userBase = getUserClaude(ctx);
	const userSkillsDir = join(userBase, "skills");

	if (ctx.fs.isDir(userSkillsDir)) {
		const skillDirs = ctx.fs.readDir(userSkillsDir);

		for (const dirName of skillDirs) {
			if (dirName.startsWith(".")) continue;

			const skillDir = join(userSkillsDir, dirName);
			if (!ctx.fs.isDir(skillDir)) continue;

			const skillFile = join(skillDir, "SKILL.md");
			if (!ctx.fs.isFile(skillFile)) continue;

			const content = ctx.fs.readFile(skillFile);
			if (!content) {
				warnings.push(`Failed to read ${skillFile}`);
				continue;
			}

			const { frontmatter, body } = parseFrontmatter(content);
			const name = (frontmatter.name as string) || dirName;

			items.push({
				name,
				path: skillFile,
				content: body,
				frontmatter,
				level: "user",
				_source: createSourceMeta(PROVIDER_ID, skillFile, "user"),
			});
		}
	}

	// Project-level: <project>/.claude/skills/*/SKILL.md
	const projectBase = getProjectClaude(ctx);
	if (projectBase) {
		const projectSkillsDir = join(projectBase, "skills");

		if (ctx.fs.isDir(projectSkillsDir)) {
			const skillDirs = ctx.fs.readDir(projectSkillsDir);

			for (const dirName of skillDirs) {
				if (dirName.startsWith(".")) continue;

				const skillDir = join(projectSkillsDir, dirName);
				if (!ctx.fs.isDir(skillDir)) continue;

				const skillFile = join(skillDir, "SKILL.md");
				if (!ctx.fs.isFile(skillFile)) continue;

				const content = ctx.fs.readFile(skillFile);
				if (!content) {
					warnings.push(`Failed to read ${skillFile}`);
					continue;
				}

				const { frontmatter, body } = parseFrontmatter(content);
				const name = (frontmatter.name as string) || dirName;

				items.push({
					name,
					path: skillFile,
					content: body,
					frontmatter,
					level: "project",
					_source: createSourceMeta(PROVIDER_ID, skillFile, "project"),
				});
			}
		}
	}

	return { items, warnings };
}

// =============================================================================
// Slash Commands
// =============================================================================

function loadSlashCommands(ctx: LoadContext): LoadResult<SlashCommand> {
	const items: SlashCommand[] = [];
	const warnings: string[] = [];

	// User-level: ~/.claude/commands/*.md
	const userBase = getUserClaude(ctx);
	const userCommandsDir = join(userBase, "commands");

	const userResult = loadFilesFromDir<SlashCommand>(ctx, userCommandsDir, PROVIDER_ID, "user", {
		extensions: ["md"],
		transform: (name, content, path, source) => {
			const cmdName = name.replace(/\.md$/, "");
			return {
				name: cmdName,
				path,
				content,
				level: "user",
				_source: source,
			};
		},
	});

	items.push(...userResult.items);
	if (userResult.warnings) warnings.push(...userResult.warnings);

	// Project-level: <project>/.claude/commands/*.md
	const projectBase = getProjectClaude(ctx);
	if (projectBase) {
		const projectCommandsDir = join(projectBase, "commands");

		const projectResult = loadFilesFromDir<SlashCommand>(ctx, projectCommandsDir, PROVIDER_ID, "project", {
			extensions: ["md"],
			transform: (name, content, path, source) => {
				const cmdName = name.replace(/\.md$/, "");
				return {
					name: cmdName,
					path,
					content,
					level: "project",
					_source: source,
				};
			},
		});

		items.push(...projectResult.items);
		if (projectResult.warnings) warnings.push(...projectResult.warnings);
	}

	return { items, warnings };
}

// =============================================================================
// Hooks
// =============================================================================

function loadHooks(ctx: LoadContext): LoadResult<Hook> {
	const items: Hook[] = [];
	const warnings: string[] = [];

	// User-level: ~/.claude/hooks/pre/* and ~/.claude/hooks/post/*
	const userBase = getUserClaude(ctx);
	const userHooksDir = join(userBase, "hooks");

	for (const hookType of ["pre", "post"] as const) {
		const hooksTypeDir = join(userHooksDir, hookType);

		const result = loadFilesFromDir<Hook>(ctx, hooksTypeDir, PROVIDER_ID, "user", {
			transform: (name, _content, path, source) => {
				// Extract tool name from filename (e.g., "bash.sh" -> "bash", "*.sh" -> "*")
				const toolName = name.replace(/\.(sh|bash|zsh|fish)$/, "");

				return {
					name,
					path,
					type: hookType,
					tool: toolName,
					level: "user",
					_source: source,
				};
			},
		});

		items.push(...result.items);
		if (result.warnings) warnings.push(...result.warnings);
	}

	// Project-level: <project>/.claude/hooks/pre/* and <project>/.claude/hooks/post/*
	const projectBase = getProjectClaude(ctx);
	if (projectBase) {
		const projectHooksDir = join(projectBase, "hooks");

		for (const hookType of ["pre", "post"] as const) {
			const hooksTypeDir = join(projectHooksDir, hookType);

			const result = loadFilesFromDir<Hook>(ctx, hooksTypeDir, PROVIDER_ID, "project", {
				transform: (name, _content, path, source) => {
					const toolName = name.replace(/\.(sh|bash|zsh|fish)$/, "");

					return {
						name,
						path,
						type: hookType,
						tool: toolName,
						level: "project",
						_source: source,
					};
				},
			});

			items.push(...result.items);
			if (result.warnings) warnings.push(...result.warnings);
		}
	}

	return { items, warnings };
}

// =============================================================================
// Custom Tools
// =============================================================================

function loadTools(ctx: LoadContext): LoadResult<CustomTool> {
	const items: CustomTool[] = [];
	const warnings: string[] = [];

	// User-level: ~/.claude/tools/*
	const userBase = getUserClaude(ctx);
	const userToolsDir = join(userBase, "tools");

	const userResult = loadFilesFromDir<CustomTool>(ctx, userToolsDir, PROVIDER_ID, "user", {
		transform: (name, _content, path, source) => {
			const toolName = name.replace(/\.(ts|js|sh|bash|py)$/, "");

			return {
				name: toolName,
				path,
				level: "user",
				_source: source,
			};
		},
	});

	items.push(...userResult.items);
	if (userResult.warnings) warnings.push(...userResult.warnings);

	// Project-level: <project>/.claude/tools/*
	const projectBase = getProjectClaude(ctx);
	if (projectBase) {
		const projectToolsDir = join(projectBase, "tools");

		const projectResult = loadFilesFromDir<CustomTool>(ctx, projectToolsDir, PROVIDER_ID, "project", {
			transform: (name, _content, path, source) => {
				const toolName = name.replace(/\.(ts|js|sh|bash|py)$/, "");

				return {
					name: toolName,
					path,
					level: "project",
					_source: source,
				};
			},
		});

		items.push(...projectResult.items);
		if (projectResult.warnings) warnings.push(...projectResult.warnings);
	}

	return { items, warnings };
}

// =============================================================================
// System Prompts
// =============================================================================

function loadSystemPrompts(ctx: LoadContext): LoadResult<SystemPrompt> {
	const items: SystemPrompt[] = [];
	const warnings: string[] = [];

	// User-level: ~/.claude/SYSTEM.md
	const userBase = getUserClaude(ctx);
	const userSystemMd = join(userBase, "SYSTEM.md");

	if (ctx.fs.isFile(userSystemMd)) {
		const content = ctx.fs.readFile(userSystemMd);
		if (content !== null) {
			items.push({
				path: userSystemMd,
				content,
				level: "user",
				_source: createSourceMeta(PROVIDER_ID, userSystemMd, "user"),
			});
		} else {
			warnings.push(`Failed to read ${userSystemMd}`);
		}
	}

	return { items, warnings };
}

// =============================================================================
// Settings
// =============================================================================

function loadSettings(ctx: LoadContext): LoadResult<Settings> {
	const items: Settings[] = [];
	const warnings: string[] = [];

	// User-level: ~/.claude/settings.json
	const userBase = getUserClaude(ctx);
	const userSettingsJson = join(userBase, "settings.json");

	if (ctx.fs.isFile(userSettingsJson)) {
		const content = ctx.fs.readFile(userSettingsJson);
		if (content) {
			const data = parseJSON<Record<string, unknown>>(content);
			if (data) {
				items.push({
					path: userSettingsJson,
					data,
					level: "user",
					_source: createSourceMeta(PROVIDER_ID, userSettingsJson, "user"),
				});
			} else {
				warnings.push(`Failed to parse JSON in ${userSettingsJson}`);
			}
		} else {
			warnings.push(`Failed to read ${userSettingsJson}`);
		}
	}

	// Project-level: <project>/.claude/settings.json
	const projectBase = getProjectClaude(ctx);
	if (projectBase) {
		const projectSettingsJson = join(projectBase, "settings.json");

		if (ctx.fs.isFile(projectSettingsJson)) {
			const content = ctx.fs.readFile(projectSettingsJson);
			if (content) {
				const data = parseJSON<Record<string, unknown>>(content);
				if (data) {
					items.push({
						path: projectSettingsJson,
						data,
						level: "project",
						_source: createSourceMeta(PROVIDER_ID, projectSettingsJson, "project"),
					});
				} else {
					warnings.push(`Failed to parse JSON in ${projectSettingsJson}`);
				}
			} else {
				warnings.push(`Failed to read ${projectSettingsJson}`);
			}
		}
	}

	return { items, warnings };
}

// =============================================================================
// Provider Registration
// =============================================================================

registerProvider<MCPServer>(mcpCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load MCP servers from .claude.json and .claude/mcp.json",
	priority: PRIORITY,
	load: loadMCPServers,
});

registerProvider<ContextFile>(contextFileCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load CLAUDE.md files from .claude/ directories and project root",
	priority: PRIORITY,
	load: loadContextFiles,
});

registerProvider<Skill>(skillCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load skills from .claude/skills/*/SKILL.md",
	priority: PRIORITY,
	load: loadSkills,
});

registerProvider<SlashCommand>(slashCommandCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load slash commands from .claude/commands/*.md",
	priority: PRIORITY,
	load: loadSlashCommands,
});

registerProvider<Hook>(hookCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load hooks from .claude/hooks/pre/ and .claude/hooks/post/",
	priority: PRIORITY,
	load: loadHooks,
});

registerProvider<CustomTool>(toolCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load custom tools from .claude/tools/",
	priority: PRIORITY,
	load: loadTools,
});

registerProvider<Settings>(settingsCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load settings from .claude/settings.json",
	priority: PRIORITY,
	load: loadSettings,
});

registerProvider<SystemPrompt>(systemPromptCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load system prompt from .claude/SYSTEM.md",
	priority: PRIORITY,
	load: loadSystemPrompts,
});
