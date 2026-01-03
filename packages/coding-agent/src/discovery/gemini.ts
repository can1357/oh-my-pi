/**
 * Gemini CLI Provider
 *
 * Loads configuration from Gemini CLI's config directories.
 * Priority: 60 (tool-specific provider)
 *
 * Sources:
 * - User: ~/.gemini
 * - Project: .gemini/ (walks up from cwd) or GEMINI.md in ancestors
 *
 * Capabilities:
 * - mcps: From settings.json with mcpServers key
 * - context-files: GEMINI.md files
 * - system-prompt: system.md files for custom system prompt
 * - extensions: From extensions/STAR/gemini-extension.json manifests (STAR = wildcard)
 * - settings: From settings.json
 */

import { dirname, join, sep } from "node:path";
import { type ContextFile, contextFileCapability } from "../capability/context-file";
import { type Extension, type ExtensionManifest, extensionCapability } from "../capability/extension";
import { registerProvider } from "../capability/index";
import { type MCPServer, mcpCapability } from "../capability/mcp";
import { type Settings, settingsCapability } from "../capability/settings";
import { type SystemPrompt, systemPromptCapability } from "../capability/system-prompt";
import type { LoadContext, LoadResult } from "../capability/types";
import { calculateDepth, createSourceMeta, expandEnvVarsDeep, getProjectPath, getUserPath, parseJSON } from "./helpers";

const PROVIDER_ID = "gemini";
const DISPLAY_NAME = "Gemini CLI";
const PRIORITY = 60;

// =============================================================================
// MCP Servers
// =============================================================================

function loadMCPServers(ctx: LoadContext): LoadResult<MCPServer> {
	const items: MCPServer[] = [];
	const warnings: string[] = [];

	// User-level: ~/.gemini/settings.json → mcpServers
	const userPath = getUserPath(ctx, "gemini", "settings.json");
	if (userPath && ctx.fs.isFile(userPath)) {
		const result = loadMCPFromSettings(ctx, userPath, "user");
		items.push(...result.items);
		if (result.warnings) warnings.push(...result.warnings);
	}

	// Project-level: .gemini/settings.json → mcpServers
	const projectPath = getProjectPath(ctx, "gemini", "settings.json");
	if (projectPath && ctx.fs.isFile(projectPath)) {
		const result = loadMCPFromSettings(ctx, projectPath, "project");
		items.push(...result.items);
		if (result.warnings) warnings.push(...result.warnings);
	}

	return { items, warnings };
}

function loadMCPFromSettings(ctx: LoadContext, path: string, level: "user" | "project"): LoadResult<MCPServer> {
	const items: MCPServer[] = [];
	const warnings: string[] = [];

	const content = ctx.fs.readFile(path);
	if (!content) {
		warnings.push(`Failed to read ${path}`);
		return { items, warnings };
	}

	const parsed = parseJSON<{ mcpServers?: Record<string, unknown> }>(content);
	if (!parsed) {
		warnings.push(`Invalid JSON in ${path}`);
		return { items, warnings };
	}

	if (!parsed.mcpServers || typeof parsed.mcpServers !== "object") {
		return { items, warnings };
	}

	const servers = expandEnvVarsDeep(parsed.mcpServers);

	for (const [name, config] of Object.entries(servers)) {
		if (!config || typeof config !== "object") {
			warnings.push(`Invalid config for server "${name}" in ${path}`);
			continue;
		}

		const raw = config as Record<string, unknown>;

		items.push({
			name,
			command: typeof raw.command === "string" ? raw.command : undefined,
			args: Array.isArray(raw.args) ? (raw.args as string[]) : undefined,
			env: raw.env && typeof raw.env === "object" ? (raw.env as Record<string, string>) : undefined,
			url: typeof raw.url === "string" ? raw.url : undefined,
			headers: raw.headers && typeof raw.headers === "object" ? (raw.headers as Record<string, string>) : undefined,
			transport: ["stdio", "sse", "http"].includes(raw.type as string)
				? (raw.type as "stdio" | "sse" | "http")
				: undefined,
			_source: createSourceMeta(PROVIDER_ID, path, level),
		} as MCPServer);
	}

	return { items, warnings };
}

// =============================================================================
// Context Files
// =============================================================================

function loadContextFiles(ctx: LoadContext): LoadResult<ContextFile> {
	const items: ContextFile[] = [];
	const warnings: string[] = [];

	// User-level: ~/.gemini/GEMINI.md
	const userGeminiMd = getUserPath(ctx, "gemini", "GEMINI.md");
	if (userGeminiMd && ctx.fs.isFile(userGeminiMd)) {
		const content = ctx.fs.readFile(userGeminiMd);
		if (content) {
			items.push({
				path: userGeminiMd,
				content,
				level: "user",
				_source: createSourceMeta(PROVIDER_ID, userGeminiMd, "user"),
			});
		}
	}

	// Project-level: .gemini/GEMINI.md
	const projectGeminiMd = getProjectPath(ctx, "gemini", "GEMINI.md");
	if (projectGeminiMd && ctx.fs.isFile(projectGeminiMd)) {
		const content = ctx.fs.readFile(projectGeminiMd);
		if (content) {
			const projectBase = getProjectPath(ctx, "gemini", "");
			const depth = projectBase ? calculateDepth(ctx.cwd, projectBase, sep) : 0;

			items.push({
				path: projectGeminiMd,
				content,
				level: "project",
				depth,
				_source: createSourceMeta(PROVIDER_ID, projectGeminiMd, "project"),
			});
		}
	}

	// Also check for GEMINI.md in project root (without .gemini directory)
	const rootGeminiMd = ctx.fs.walkUp("GEMINI.md", { file: true });
	if (rootGeminiMd) {
		const content = ctx.fs.readFile(rootGeminiMd);
		if (content) {
			// Only add if not already added from .gemini/GEMINI.md
			const alreadyAdded = items.some((item) => item.path === rootGeminiMd);
			if (!alreadyAdded) {
				const fileDir = dirname(rootGeminiMd);
				const depth = calculateDepth(ctx.cwd, fileDir, sep);

				items.push({
					path: rootGeminiMd,
					content,
					level: "project",
					depth,
					_source: createSourceMeta(PROVIDER_ID, rootGeminiMd, "project"),
				});
			}
		}
	}

	return { items, warnings };
}

// =============================================================================
// Extensions
// =============================================================================

function loadExtensions(ctx: LoadContext): LoadResult<Extension> {
	const items: Extension[] = [];
	const warnings: string[] = [];

	// User-level: ~/.gemini/extensions/*/gemini-extension.json
	const userExtPath = getUserPath(ctx, "gemini", "extensions");
	if (userExtPath && ctx.fs.isDir(userExtPath)) {
		const result = loadExtensionsFromDir(ctx, userExtPath, "user");
		items.push(...result.items);
		if (result.warnings) warnings.push(...result.warnings);
	}

	// Project-level: .gemini/extensions/*/gemini-extension.json
	const projectExtPath = getProjectPath(ctx, "gemini", "extensions");
	if (projectExtPath && ctx.fs.isDir(projectExtPath)) {
		const result = loadExtensionsFromDir(ctx, projectExtPath, "project");
		items.push(...result.items);
		if (result.warnings) warnings.push(...result.warnings);
	}

	return { items, warnings };
}

function loadExtensionsFromDir(
	ctx: LoadContext,
	extensionsDir: string,
	level: "user" | "project",
): LoadResult<Extension> {
	const items: Extension[] = [];
	const warnings: string[] = [];

	const dirs = ctx.fs.readDir(extensionsDir);
	for (const dirName of dirs) {
		const extPath = join(extensionsDir, dirName);
		if (!ctx.fs.isDir(extPath)) continue;

		const manifestPath = join(extPath, "gemini-extension.json");
		if (!ctx.fs.isFile(manifestPath)) continue;

		const content = ctx.fs.readFile(manifestPath);
		if (!content) {
			warnings.push(`Failed to read ${manifestPath}`);
			continue;
		}

		const manifest = parseJSON<ExtensionManifest>(content);
		if (!manifest) {
			warnings.push(`Invalid JSON in ${manifestPath}`);
			continue;
		}

		items.push({
			name: manifest.name ?? dirName,
			path: extPath,
			manifest,
			level,
			_source: createSourceMeta(PROVIDER_ID, manifestPath, level),
		});
	}

	return { items, warnings };
}

// =============================================================================
// Settings
// =============================================================================

function loadSettings(ctx: LoadContext): LoadResult<Settings> {
	const items: Settings[] = [];
	const warnings: string[] = [];

	// User-level: ~/.gemini/settings.json
	const userPath = getUserPath(ctx, "gemini", "settings.json");
	if (userPath && ctx.fs.isFile(userPath)) {
		const content = ctx.fs.readFile(userPath);
		if (content) {
			const parsed = parseJSON<Record<string, unknown>>(content);
			if (parsed) {
				items.push({
					path: userPath,
					data: parsed,
					level: "user",
					_source: createSourceMeta(PROVIDER_ID, userPath, "user"),
				});
			} else {
				warnings.push(`Invalid JSON in ${userPath}`);
			}
		}
	}

	// Project-level: .gemini/settings.json
	const projectPath = getProjectPath(ctx, "gemini", "settings.json");
	if (projectPath && ctx.fs.isFile(projectPath)) {
		const content = ctx.fs.readFile(projectPath);
		if (content) {
			const parsed = parseJSON<Record<string, unknown>>(content);
			if (parsed) {
				items.push({
					path: projectPath,
					data: parsed,
					level: "project",
					_source: createSourceMeta(PROVIDER_ID, projectPath, "project"),
				});
			} else {
				warnings.push(`Invalid JSON in ${projectPath}`);
			}
		}
	}

	return { items, warnings };
}

// =============================================================================
// Provider Registration
// =============================================================================

registerProvider(mcpCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load MCP servers from ~/.gemini/settings.json and .gemini/settings.json",
	priority: PRIORITY,
	load: loadMCPServers,
});

registerProvider(contextFileCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load GEMINI.md context files",
	priority: PRIORITY,
	load: loadContextFiles,
});

// =============================================================================
// System Prompt
// =============================================================================

function loadSystemPrompt(ctx: LoadContext): LoadResult<SystemPrompt> {
	const items: SystemPrompt[] = [];

	// User-level: ~/.gemini/system.md
	const userSystemMd = getUserPath(ctx, "gemini", "system.md");
	if (userSystemMd && ctx.fs.isFile(userSystemMd)) {
		const content = ctx.fs.readFile(userSystemMd);
		if (content) {
			items.push({
				path: userSystemMd,
				content,
				level: "user",
				_source: createSourceMeta(PROVIDER_ID, userSystemMd, "user"),
			});
		}
	}

	// Project-level: .gemini/system.md
	const projectSystemMd = getProjectPath(ctx, "gemini", "system.md");
	if (projectSystemMd && ctx.fs.isFile(projectSystemMd)) {
		const content = ctx.fs.readFile(projectSystemMd);
		if (content) {
			items.push({
				path: projectSystemMd,
				content,
				level: "project",
				_source: createSourceMeta(PROVIDER_ID, projectSystemMd, "project"),
			});
		}
	}

	return { items, warnings: [] };
}

registerProvider<SystemPrompt>(systemPromptCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load system.md custom system prompt files",
	priority: PRIORITY,
	load: loadSystemPrompt,
});

registerProvider(extensionCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load extensions from ~/.gemini/extensions/ and .gemini/extensions/",
	priority: PRIORITY,
	load: loadExtensions,
});

registerProvider(settingsCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load settings from ~/.gemini/settings.json and .gemini/settings.json",
	priority: PRIORITY,
	load: loadSettings,
});
