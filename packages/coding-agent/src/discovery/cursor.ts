/**
 * Cursor Provider
 *
 * Loads configuration from Cursor's config directories.
 * Priority: 50 (tool-specific provider)
 *
 * Sources:
 * - User: ~/.cursor
 * - Project: .cursor/ (walks up from cwd)
 *
 * Capabilities:
 * - mcps: From mcp.json with mcpServers key
 * - rules: From rules/*.mdc files with MDC frontmatter (description, globs, alwaysApply)
 * - settings: From settings.json if present
 * - Legacy: .cursorrules file in project root as a single rule
 */

import { registerProvider } from "../capability/index";
import { type MCPServer, mcpCapability } from "../capability/mcp";
import type { Rule } from "../capability/rule";
import { ruleCapability } from "../capability/rule";
import type { Settings } from "../capability/settings";
import { settingsCapability } from "../capability/settings";
import type { LoadContext, LoadResult } from "../capability/types";
import {
	createSourceMeta,
	expandEnvVarsDeep,
	getProjectPath,
	getUserPath,
	loadFilesFromDir,
	parseFrontmatter,
	parseJSON,
} from "./helpers";

const PROVIDER_ID = "cursor";
const DISPLAY_NAME = "Cursor";
const PRIORITY = 50;

// =============================================================================
// MCP Servers
// =============================================================================

function loadMCPServers(ctx: LoadContext): LoadResult<MCPServer> {
	const items: MCPServer[] = [];
	const warnings: string[] = [];

	// User-level: ~/.cursor/mcp.json
	const userPath = getUserPath(ctx, "cursor", "mcp.json");
	if (userPath && ctx.fs.isFile(userPath)) {
		const content = ctx.fs.readFile(userPath);
		if (content) {
			const parsed = parseJSON<{ mcpServers?: Record<string, unknown> }>(content);
			if (parsed?.mcpServers) {
				const servers = expandEnvVarsDeep(parsed.mcpServers);
				for (const [name, config] of Object.entries(servers)) {
					const serverConfig = config as Record<string, unknown>;
					items.push({
						name,
						command: serverConfig.command as string | undefined,
						args: serverConfig.args as string[] | undefined,
						env: serverConfig.env as Record<string, string> | undefined,
						url: serverConfig.url as string | undefined,
						headers: serverConfig.headers as Record<string, string> | undefined,
						transport: ["stdio", "sse", "http"].includes(serverConfig.type as string)
							? (serverConfig.type as "stdio" | "sse" | "http")
							: undefined,
						_source: createSourceMeta(PROVIDER_ID, userPath, "user"),
					});
				}
			} else {
				warnings.push(`${userPath}: missing or invalid 'mcpServers' key`);
			}
		}
	}

	// Project-level: .cursor/mcp.json
	const projectPath = getProjectPath(ctx, "cursor", "mcp.json");
	if (projectPath && ctx.fs.isFile(projectPath)) {
		const content = ctx.fs.readFile(projectPath);
		if (content) {
			const parsed = parseJSON<{ mcpServers?: Record<string, unknown> }>(content);
			if (parsed?.mcpServers) {
				const servers = expandEnvVarsDeep(parsed.mcpServers);
				for (const [name, config] of Object.entries(servers)) {
					const serverConfig = config as Record<string, unknown>;
					items.push({
						name,
						command: serverConfig.command as string | undefined,
						args: serverConfig.args as string[] | undefined,
						env: serverConfig.env as Record<string, string> | undefined,
						url: serverConfig.url as string | undefined,
						headers: serverConfig.headers as Record<string, string> | undefined,
						transport: ["stdio", "sse", "http"].includes(serverConfig.type as string)
							? (serverConfig.type as "stdio" | "sse" | "http")
							: undefined,
						_source: createSourceMeta(PROVIDER_ID, projectPath, "project"),
					});
				}
			} else {
				warnings.push(`${projectPath}: missing or invalid 'mcpServers' key`);
			}
		}
	}

	return { items, warnings };
}

// =============================================================================
// Rules
// =============================================================================

function loadRules(ctx: LoadContext): LoadResult<Rule> {
	const items: Rule[] = [];
	const warnings: string[] = [];

	// Legacy: .cursorrules file in project root
	const legacyPath = ctx.fs.walkUp(".cursorrules", { file: true });
	if (legacyPath) {
		const content = ctx.fs.readFile(legacyPath);
		if (content) {
			items.push({
				name: "cursorrules",
				path: legacyPath,
				content,
				_source: createSourceMeta(PROVIDER_ID, legacyPath, "project"),
			});
		}
	}

	// User-level: ~/.cursor/rules/*.mdc
	const userRulesPath = getUserPath(ctx, "cursor", "rules");
	if (userRulesPath && ctx.fs.isDir(userRulesPath)) {
		const result = loadFilesFromDir<Rule>(ctx, userRulesPath, PROVIDER_ID, "user", {
			extensions: ["mdc", "md"],
			transform: transformMDCRule,
		});
		items.push(...result.items);
		if (result.warnings) warnings.push(...result.warnings);
	}

	// Project-level: .cursor/rules/*.mdc
	const projectRulesPath = getProjectPath(ctx, "cursor", "rules");
	if (projectRulesPath && ctx.fs.isDir(projectRulesPath)) {
		const result = loadFilesFromDir<Rule>(ctx, projectRulesPath, PROVIDER_ID, "project", {
			extensions: ["mdc", "md"],
			transform: transformMDCRule,
		});
		items.push(...result.items);
		if (result.warnings) warnings.push(...result.warnings);
	}

	return { items, warnings };
}

function transformMDCRule(
	name: string,
	content: string,
	path: string,
	source: ReturnType<typeof createSourceMeta>,
): Rule {
	const { frontmatter, body } = parseFrontmatter(content);

	// Extract frontmatter fields
	const description = typeof frontmatter.description === "string" ? frontmatter.description : undefined;
	const alwaysApply = frontmatter.alwaysApply === true;
	const ttsrTrigger = typeof frontmatter.ttsr_trigger === "string" ? frontmatter.ttsr_trigger : undefined;

	// Parse globs (can be array or single string)
	let globs: string[] | undefined;
	if (Array.isArray(frontmatter.globs)) {
		globs = frontmatter.globs.filter((g): g is string => typeof g === "string");
	} else if (typeof frontmatter.globs === "string") {
		globs = [frontmatter.globs];
	}

	// Derive name from filename (strip extension)
	const ruleName = name.replace(/\.(mdc|md)$/, "");

	return {
		name: ruleName,
		path,
		content: body,
		description,
		alwaysApply,
		globs,
		ttsrTrigger,
		_source: source,
	};
}

// =============================================================================
// Settings
// =============================================================================

function loadSettings(ctx: LoadContext): LoadResult<Settings> {
	const items: Settings[] = [];
	const warnings: string[] = [];

	// User-level: ~/.cursor/settings.json
	const userPath = getUserPath(ctx, "cursor", "settings.json");
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
				warnings.push(`${userPath}: invalid JSON`);
			}
		}
	}

	// Project-level: .cursor/settings.json
	const projectPath = getProjectPath(ctx, "cursor", "settings.json");
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
				warnings.push(`${projectPath}: invalid JSON`);
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
	description: "Load MCP servers from ~/.cursor/mcp.json and .cursor/mcp.json",
	priority: PRIORITY,
	load: loadMCPServers,
});

registerProvider(ruleCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load rules from .cursor/rules/*.mdc and legacy .cursorrules",
	priority: PRIORITY,
	load: loadRules,
});

registerProvider(settingsCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load settings from ~/.cursor/settings.json and .cursor/settings.json",
	priority: PRIORITY,
	load: loadSettings,
});
