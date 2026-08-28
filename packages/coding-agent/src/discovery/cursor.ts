/**
 * Cursor Provider
 *
 * Loads configuration from Cursor's config directories.
 * Priority: 50 (tool-specific provider)
 *
 * Sources:
 * - User: ~/.cursor
 * - Project: .cursor/ (cwd only)
 *
 * Capabilities:
 * - mcps: From mcp.json with mcpServers key
 * - rules: From rules/*.mdc files with MDC frontmatter (description, globs, alwaysApply)
 * - settings: From settings.json if present
 */

import { tryParseJson } from "@oh-my-pi/pi-utils";
import { registerProvider } from "../capability";
import { readFile } from "../capability/fs";
import { type MCPServer, mcpCapability } from "../capability/mcp";
import type { Rule } from "../capability/rule";
import { ruleCapability } from "../capability/rule";
import type { Settings } from "../capability/settings";
import { settingsCapability } from "../capability/settings";
import type { LoadContext, LoadResult, SourceMeta } from "../capability/types";
import {
	buildRuleFromMarkdown,
	createSourceMeta,
	expandEnvVarsDeep,
	getProjectPath,
	getUserPath,
	loadFilesFromDir,
} from "./helpers";

const PROVIDER_ID = "cursor";
const DISPLAY_NAME = "Cursor";
const PRIORITY = 50;

// =============================================================================
// MCP Servers
// =============================================================================

function parseMCPServers(
	content: string,
	path: string,
	level: "user" | "project",
): { items: MCPServer[]; warning?: string } {
	const items: MCPServer[] = [];

	const parsed = tryParseJson<{ mcpServers?: Record<string, unknown> }>(content);
	if (!parsed?.mcpServers) {
		return { items, warning: `${path}: missing or invalid 'mcpServers' key` };
	}

	const servers = expandEnvVarsDeep(parsed.mcpServers);
	for (const [name, config] of Object.entries(servers)) {
		const serverConfig = config as Record<string, unknown>;
		items.push({
			name,
			enabled: typeof serverConfig.enabled === "boolean" ? serverConfig.enabled : undefined,
			command: serverConfig.command as string | undefined,
			args: serverConfig.args as string[] | undefined,
			env: serverConfig.env as Record<string, string> | undefined,
			url: serverConfig.url as string | undefined,
			headers: serverConfig.headers as Record<string, string> | undefined,
			transport: ["stdio", "sse", "http"].includes(serverConfig.type as string)
				? (serverConfig.type as "stdio" | "sse" | "http")
				: undefined,
			timeout: typeof serverConfig.timeout === "number" ? serverConfig.timeout : undefined,
			_source: createSourceMeta(PROVIDER_ID, path, level),
		});
	}

	return { items };
}

async function loadMCPServers(ctx: LoadContext): Promise<LoadResult<MCPServer>> {
	const items: MCPServer[] = [];
	const warnings: string[] = [];

	const userPath = getUserPath(ctx, "cursor", "mcp.json");

	const [userContent, projectPath] = await Promise.all([
		userPath ? readFile(userPath) : Promise.resolve(null),
		getProjectPath(ctx, "cursor", "mcp.json"),
	]);

	const projectContentPromise = projectPath ? readFile(projectPath) : Promise.resolve(null);

	// Load project entries before user entries so a project `enabled: false`
	// claims its dedupe key before a same-named user server can survive (#7654).
	const projectContent = await projectContentPromise;
	if (projectContent && projectPath) {
		const result = parseMCPServers(projectContent, projectPath, "project");
		items.push(...result.items);
		if (result.warning) warnings.push(result.warning);
	}

	if (userContent && userPath) {
		const result = parseMCPServers(userContent, userPath, "user");
		items.push(...result.items);
		if (result.warning) warnings.push(result.warning);
	}

	return { items, warnings };
}

// =============================================================================
// Rules
// =============================================================================

async function loadRules(ctx: LoadContext): Promise<LoadResult<Rule>> {
	const items: Rule[] = [];
	const warnings: string[] = [];

	const userRulesPath = getUserPath(ctx, "cursor", "rules");

	const projectRulesPath = getProjectPath(ctx, "cursor", "rules");

	const [userResult, projectResult] = await Promise.all([
		userRulesPath
			? loadFilesFromDir<Rule>(ctx, userRulesPath, PROVIDER_ID, "user", {
					extensions: ["mdc", "md"],
					transform: transformMDCRule,
				})
			: Promise.resolve({ items: [] as Rule[], warnings: undefined }),
		projectRulesPath
			? loadFilesFromDir<Rule>(ctx, projectRulesPath, PROVIDER_ID, "project", {
					extensions: ["mdc", "md"],
					transform: transformMDCRule,
				})
			: Promise.resolve({ items: [] as Rule[], warnings: undefined }),
	]);

	items.push(...userResult.items);
	if (userResult.warnings) warnings.push(...userResult.warnings);

	items.push(...projectResult.items);
	if (projectResult.warnings) warnings.push(...projectResult.warnings);

	return { items, warnings };
}

function transformMDCRule(name: string, content: string, path: string, source: SourceMeta): Rule {
	return buildRuleFromMarkdown(name, content, path, source, { stripNamePattern: /\.(mdc|md)$/ });
}

// =============================================================================
// Settings
// =============================================================================

async function loadSettings(ctx: LoadContext): Promise<LoadResult<Settings>> {
	const items: Settings[] = [];
	const warnings: string[] = [];

	const userPath = getUserPath(ctx, "cursor", "settings.json");

	const [userContent, projectPath] = await Promise.all([
		userPath ? readFile(userPath) : Promise.resolve(null),
		getProjectPath(ctx, "cursor", "settings.json"),
	]);

	const projectContentPromise = projectPath ? readFile(projectPath) : Promise.resolve(null);

	if (userContent && userPath) {
		const parsed = tryParseJson<Record<string, unknown>>(userContent);
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

	const projectContent = await projectContentPromise;
	if (projectContent && projectPath) {
		const parsed = tryParseJson<Record<string, unknown>>(projectContent);
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
