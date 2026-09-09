/**
 * Gemini CLI Provider
 *
 * Loads configuration from Gemini CLI's config directories.
 * Priority: 60 (tool-specific provider)
 *
 * Sources:
 * - User: ~/.gemini
 * - Project: .gemini/ (cwd only)
 *
 * Capabilities:
 * - mcps: From settings.json with mcpServers key
 * - context-files: GEMINI.md files
 * - system-prompt: system.md files for custom system prompt
 * - extensions: From extensions/STAR/gemini-extension.json manifests (STAR = wildcard)
 * - settings: From settings.json
 */
import * as path from "node:path";
import { tryParseJson } from "@oh-my-pi/pi-utils";
import { registerProvider } from "../capability";
import { type ContextFile, contextFileCapability } from "../capability/context-file";
import { type Extension, type ExtensionManifest, extensionCapability } from "../capability/extension";
import { type ExtensionModule, extensionModuleCapability } from "../capability/extension-module";
import { readDirEntries, readFile } from "../capability/fs";
import { type MCPServer, mcpCapability } from "../capability/mcp";
import { type Settings, settingsCapability } from "../capability/settings";
import { type SystemPrompt, systemPromptCapability } from "../capability/system-prompt";
import type { LoadContext, LoadResult } from "../capability/types";
import {
	buildExtensionModuleItems,
	calculateDepth,
	createSourceMeta,
	discoverExtensionModulePaths,
	expandEnvVarsDeep,
	getProjectPath,
	getUserPath,
} from "./helpers";

const PROVIDER_ID = "gemini";
const DISPLAY_NAME = "Gemini CLI";
const PRIORITY = 60;

// =============================================================================
// MCP Servers
// =============================================================================

async function loadMCPServers(ctx: LoadContext): Promise<LoadResult<MCPServer>> {
	const items: MCPServer[] = [];
	const warnings: string[] = [];

	// Load project entries before user entries so a project `enabled: false`
	// claims its dedupe key before a same-named user server can survive (#7654).
	// Project-level: .gemini/settings.json → mcpServers
	const projectPath = getProjectPath(ctx, "gemini", "settings.json");
	if (projectPath) {
		const result = await loadMCPFromSettings(ctx, projectPath, "project");
		items.push(...result.items);
		if (result.warnings) warnings.push(...result.warnings);
	}

	// User-level: ~/.gemini/settings.json → mcpServers
	const userPath = getUserPath(ctx, "gemini", "settings.json");
	if (userPath) {
		const result = await loadMCPFromSettings(ctx, userPath, "user");
		items.push(...result.items);
		if (result.warnings) warnings.push(...result.warnings);
	}

	return { items, warnings };
}

async function loadMCPFromSettings(
	_ctx: LoadContext,
	path: string,
	level: "user" | "project",
): Promise<LoadResult<MCPServer>> {
	const items: MCPServer[] = [];
	const warnings: string[] = [];

	const content = await readFile(path);
	if (!content) {
		return { items, warnings };
	}

	const parsed = tryParseJson<{ mcpServers?: Record<string, unknown> }>(content);
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
			enabled: typeof raw.enabled === "boolean" ? raw.enabled : undefined,
			command: typeof raw.command === "string" ? raw.command : undefined,
			args: Array.isArray(raw.args) ? (raw.args as string[]) : undefined,
			env: raw.env && typeof raw.env === "object" ? (raw.env as Record<string, string>) : undefined,
			url: typeof raw.url === "string" ? raw.url : undefined,
			headers: raw.headers && typeof raw.headers === "object" ? (raw.headers as Record<string, string>) : undefined,
			transport: ["stdio", "sse", "http"].includes(raw.type as string)
				? (raw.type as "stdio" | "sse" | "http")
				: undefined,
			timeout: typeof raw.timeout === "number" ? raw.timeout : undefined,
			_source: createSourceMeta(PROVIDER_ID, path, level),
		} as MCPServer);
	}

	return { items, warnings };
}

// =============================================================================
// Context Files
// =============================================================================

async function loadContextFiles(ctx: LoadContext): Promise<LoadResult<ContextFile>> {
	const items: ContextFile[] = [];
	const warnings: string[] = [];

	// User-level: ~/.gemini/GEMINI.md
	const userGeminiMd = getUserPath(ctx, "gemini", "GEMINI.md");
	if (userGeminiMd) {
		const content = await readFile(userGeminiMd);
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
	if (projectGeminiMd) {
		const content = await readFile(projectGeminiMd);
		if (content) {
			const projectBase = getProjectPath(ctx, "gemini", "");
			const depth = projectBase ? calculateDepth(ctx.cwd, projectBase, path.sep) : 0;

			items.push({
				path: projectGeminiMd,
				content,
				level: "project",
				depth,
				_source: createSourceMeta(PROVIDER_ID, projectGeminiMd, "project"),
			});
		}
	}

	return { items, warnings };
}

// =============================================================================
// Extensions
// =============================================================================

async function loadExtensions(ctx: LoadContext): Promise<LoadResult<Extension>> {
	const items: Extension[] = [];
	const warnings: string[] = [];

	// User-level: ~/.gemini/extensions/*/gemini-extension.json
	const userExtPath = getUserPath(ctx, "gemini", "extensions");
	if (userExtPath) {
		const result = await loadExtensionsFromDir(userExtPath, "user");
		items.push(...result.items);
		if (result.warnings) warnings.push(...result.warnings);
	}

	// Project-level: .gemini/extensions/*/gemini-extension.json
	const projectExtPath = getProjectPath(ctx, "gemini", "extensions");
	if (projectExtPath) {
		const result = await loadExtensionsFromDir(projectExtPath, "project");
		items.push(...result.items);
		if (result.warnings) warnings.push(...result.warnings);
	}

	return { items, warnings };
}

async function loadExtensionsFromDir(extensionsDir: string, level: "user" | "project"): Promise<LoadResult<Extension>> {
	const entries = await readDirEntries(extensionsDir);
	const dirEntries = entries.filter(entry => entry.isDirectory());

	const results = await Promise.all(
		dirEntries.map(async entry => {
			const extPath = path.join(extensionsDir, entry.name);
			const manifestPath = path.join(extPath, "gemini-extension.json");
			const content = await readFile(manifestPath);
			return { entry, extPath, manifestPath, content };
		}),
	);

	const items: Extension[] = [];
	const warnings: string[] = [];

	for (const { entry, extPath, manifestPath, content } of results) {
		if (!content) continue;

		const manifest = tryParseJson<ExtensionManifest>(content);
		if (!manifest) {
			warnings.push(`Invalid JSON in ${manifestPath}`);
			continue;
		}

		items.push({
			name: manifest.name ?? entry.name,
			path: extPath,
			manifest,
			level,
			_source: createSourceMeta(PROVIDER_ID, manifestPath, level),
		});
	}

	return { items, warnings };
}

// =============================================================================
// Extension Modules
// =============================================================================

async function loadExtensionModules(ctx: LoadContext): Promise<LoadResult<ExtensionModule>> {
	const userExtensionsDir = getUserPath(ctx, "gemini", "extensions");
	const projectExtensionsDir = getProjectPath(ctx, "gemini", "extensions");

	const [userPaths, projectPaths] = await Promise.all([
		userExtensionsDir ? discoverExtensionModulePaths(ctx, userExtensionsDir) : Promise.resolve([]),
		projectExtensionsDir ? discoverExtensionModulePaths(ctx, projectExtensionsDir) : Promise.resolve([]),
	]);

	const items = buildExtensionModuleItems(PROVIDER_ID, userPaths, projectPaths);

	return { items, warnings: [] };
}

// =============================================================================
// Settings
// =============================================================================

async function loadSettings(ctx: LoadContext): Promise<LoadResult<Settings>> {
	const items: Settings[] = [];
	const warnings: string[] = [];

	// User-level: ~/.gemini/settings.json
	const userPath = getUserPath(ctx, "gemini", "settings.json");
	if (userPath) {
		const content = await readFile(userPath);
		if (content) {
			const parsed = tryParseJson<Record<string, unknown>>(content);
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
	if (projectPath) {
		const content = await readFile(projectPath);
		if (content) {
			const parsed = tryParseJson<Record<string, unknown>>(content);
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

async function loadSystemPrompt(ctx: LoadContext): Promise<LoadResult<SystemPrompt>> {
	const items: SystemPrompt[] = [];

	// User-level: ~/.gemini/system.md
	const userSystemMd = getUserPath(ctx, "gemini", "system.md");
	if (userSystemMd) {
		const content = await readFile(userSystemMd);
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
	if (projectSystemMd) {
		const content = await readFile(projectSystemMd);
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

registerProvider(extensionModuleCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load extension modules from ~/.gemini/extensions/ and .gemini/extensions/",
	priority: PRIORITY,
	load: loadExtensionModules,
});

registerProvider(settingsCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load settings from ~/.gemini/settings.json and .gemini/settings.json",
	priority: PRIORITY,
	load: loadSettings,
});
