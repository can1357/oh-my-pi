/**
 * Claude Code Provider
 *
 * Loads project-level Claude Code configuration from `.claude` directories:
 * MCP servers (`.claude/.mcp.json`, `.claude/mcp.json`), `.claude/CLAUDE.md`,
 * skills (`.claude/skills`, walking up to the repo root), and slash commands
 * (`.claude/commands`). Claude Code's user-level config (`~/.claude`) is not read.
 * Priority: 80 (tool-specific, below builtin but above shared standards)
 */
import * as path from "node:path";
import { hasFsCode, tryParseJson } from "@oh-my-pi/pi-utils";
import { registerProvider } from "../capability";
import { type ContextFile, contextFileCapability } from "../capability/context-file";
import { readFile } from "../capability/fs";
import { type MCPServer, mcpCapability } from "../capability/mcp";
import { type Skill, skillCapability } from "../capability/skill";
import { type SlashCommand, slashCommandCapability } from "../capability/slash-command";
import type { LoadContext, LoadResult } from "../capability/types";
import { settings } from "../config/settings";
import { cfgCommandsEnableClaudeProject } from "../extensibility/settings";
import { calculateDepth, createSourceMeta, expandEnvVarsDeep, loadFilesFromDir, scanSkillsFromDir } from "./helpers";

const PROVIDER_ID = "claude";
const DISPLAY_NAME = "Claude Code";
const PRIORITY = 80;
const CONFIG_DIR = ".claude";

function isMissingDirectoryError(error: unknown): boolean {
	return hasFsCode(error, "ENOENT") || hasFsCode(error, "ENOTDIR");
}

// =============================================================================
// MCP Servers
// =============================================================================

async function loadMCPServers(ctx: LoadContext): Promise<LoadResult<MCPServer>> {
	const projectBase = path.join(ctx.cwd, CONFIG_DIR);
	const candidates = [path.join(projectBase, ".mcp.json"), path.join(projectBase, "mcp.json")];
	const contents = await Promise.all(candidates.map(candidate => readFile(candidate)));

	// The first file that declares servers wins.
	for (let i = 0; i < candidates.length; i++) {
		const content = contents[i];
		if (!content) continue;
		const json = tryParseJson<{ mcpServers?: Record<string, unknown> }>(content);
		if (!json?.mcpServers) continue;

		const mcpServers = expandEnvVarsDeep(json.mcpServers);
		const items = Object.entries(mcpServers).map(([name, config]): MCPServer => {
			const serverConfig = config as Record<string, unknown>;
			return {
				name,
				enabled: typeof serverConfig.enabled === "boolean" ? serverConfig.enabled : undefined,
				timeout: typeof serverConfig.timeout === "number" ? serverConfig.timeout : undefined,
				command: serverConfig.command as string | undefined,
				args: serverConfig.args as string[] | undefined,
				env: serverConfig.env as Record<string, string> | undefined,
				url: serverConfig.url as string | undefined,
				headers: serverConfig.headers as Record<string, string> | undefined,
				transport: serverConfig.type as "stdio" | "sse" | "http" | undefined,
				_source: createSourceMeta(PROVIDER_ID, candidates[i], "project"),
			};
		});
		if (items.length > 0) return { items, warnings: [] };
	}

	return { items: [], warnings: [] };
}

// =============================================================================
// Context Files (CLAUDE.md)
// =============================================================================

async function loadContextFiles(ctx: LoadContext): Promise<LoadResult<ContextFile>> {
	const items: ContextFile[] = [];

	const projectBase = path.join(ctx.cwd, CONFIG_DIR);
	const projectClaudeMd = path.join(projectBase, "CLAUDE.md");
	const projectContent = await readFile(projectClaudeMd);
	if (projectContent !== null) {
		items.push({
			path: projectClaudeMd,
			content: projectContent,
			level: "project",
			depth: calculateDepth(ctx.cwd, path.dirname(projectBase), path.sep),
			_source: createSourceMeta(PROVIDER_ID, projectClaudeMd, "project"),
		});
	}

	return { items, warnings: [] };
}

// =============================================================================
// Skills
// =============================================================================

async function loadSkills(ctx: LoadContext): Promise<LoadResult<Skill>> {
	// Walk up from cwd finding .claude/skills/ in ancestors. Skip $HOME:
	// `~/.claude` is Claude Code's user config, not a project directory.
	const projectScans: Promise<LoadResult<Skill>>[] = [];
	let current = ctx.cwd;
	while (true) {
		if (current !== ctx.home) {
			projectScans.push(
				scanSkillsFromDir(ctx, {
					dir: path.join(current, CONFIG_DIR, "skills"),
					providerId: PROVIDER_ID,
					level: "project",
				}),
			);
		}
		if (current === (ctx.repoRoot ?? ctx.home)) break;
		const parent = path.dirname(current);
		if (parent === current) break; // filesystem root
		current = parent;
	}

	const items: Skill[] = [];
	const warnings: string[] = [];
	for (const projectResult of await Promise.allSettled(projectScans)) {
		if (projectResult.status === "fulfilled") {
			items.push(...projectResult.value.items);
			warnings.push(...(projectResult.value.warnings ?? []));
		} else if (!isMissingDirectoryError(projectResult.reason)) {
			warnings.push(`Failed to scan Claude project skills: ${String(projectResult.reason)}`);
		}
	}

	return { items, warnings };
}

// =============================================================================
// Slash Commands
// =============================================================================

/**
 * Read the project command-loading toggle. Falls back to true when settings
 * are not initialized, e.g. inside discovery unit tests without Settings.init().
 */
function readClaudeProjectCommandsToggle(): boolean {
	try {
		return cfgCommandsEnableClaudeProject.get(settings);
	} catch {
		return true;
	}
}

function getClaudeRelativeCommandName(commandsDir: string, filePath: string): string {
	return path.relative(commandsDir, filePath).replace(/\.md$/, "");
}

function addClaudeCommandNamespaceAliases(commands: SlashCommand[], commandsDir: string): SlashCommand[] {
	const rootCommands: SlashCommand[] = [];
	const nestedCommands: SlashCommand[] = [];
	const aliases: SlashCommand[] = [];

	for (const command of commands) {
		const relativeName = getClaudeRelativeCommandName(commandsDir, command.path);
		if (!/[\\/]/.test(relativeName)) {
			rootCommands.push(command);
			continue;
		}

		nestedCommands.push(command);
		aliases.push({ ...command, name: relativeName.replace(/[\\/]+/g, ":") });
	}

	return nestedCommands.length === 0 ? commands : [...rootCommands, ...nestedCommands, ...aliases];
}

async function loadSlashCommands(ctx: LoadContext): Promise<LoadResult<SlashCommand>> {
	if (!readClaudeProjectCommandsToggle()) return { items: [], warnings: [] };

	const projectCommandsDir = path.join(ctx.cwd, CONFIG_DIR, "commands");
	const projectResult = await loadFilesFromDir<SlashCommand>(ctx, projectCommandsDir, PROVIDER_ID, "project", {
		extensions: ["md"],
		recursive: true,
		transform: (name, content, filePath, source) => ({
			name: name.replace(/\.md$/, ""),
			path: filePath,
			content,
			level: "project",
			_source: source,
		}),
	});

	return {
		items: addClaudeCommandNamespaceAliases(projectResult.items, projectCommandsDir),
		warnings: projectResult.warnings ?? [],
	};
}

// =============================================================================
// Provider Registration
// =============================================================================

registerProvider<MCPServer>(mcpCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load MCP servers from .claude/.mcp.json and .claude/mcp.json",
	priority: PRIORITY,
	load: loadMCPServers,
});

registerProvider<ContextFile>(contextFileCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load CLAUDE.md from .claude/",
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
