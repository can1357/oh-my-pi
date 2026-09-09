/**
 * Windsurf (Codeium) Provider
 *
 * Loads configuration from Windsurf's config locations:
 * - User: ~/.codeium/windsurf
 * - Project: .windsurf
 *
 * Supports:
 * - MCP servers from mcp_config.json
 * - Rules from .windsurf/rules/*.md and ~/.codeium/windsurf/memories/global_rules.md
 * - Legacy .windsurfrules file
 */

import { tryParseJson } from "@oh-my-pi/pi-utils";
import { registerProvider } from "../capability";
import { readFile } from "../capability/fs";
import { type MCPServer, mcpCapability } from "../capability/mcp";
import { type Rule, ruleCapability } from "../capability/rule";
import type { LoadContext, LoadResult } from "../capability/types";
import {
	discoverRuleFromMarkdown,
	createSourceMeta,
	expandEnvVarsDeep,
	getProjectPath,
	getUserPath,
	loadFilesFromDir,
} from "./helpers";

const PROVIDER_ID = "windsurf";
const DISPLAY_NAME = "Windsurf";
const PRIORITY = 50;

// =============================================================================
// MCP Servers
// =============================================================================

function parseServerConfig(
	name: string,
	serverConfig: unknown,
	path: string,
	scope: "user" | "project",
): { server?: MCPServer; warning?: string } {
	if (typeof serverConfig !== "object" || serverConfig === null) {
		return { warning: `Invalid server config for "${name}" in ${path}` };
	}

	const server = expandEnvVarsDeep(serverConfig as Record<string, unknown>);
	return {
		server: {
			name,
			enabled: typeof server.enabled === "boolean" ? server.enabled : undefined,
			command: server.command as string | undefined,
			args: server.args as string[] | undefined,
			env: server.env as Record<string, string> | undefined,
			url: server.url as string | undefined,
			headers: server.headers as Record<string, string> | undefined,
			transport: server.type as "stdio" | "sse" | "http" | undefined,
			timeout: typeof server.timeout === "number" ? server.timeout : undefined,
			_source: createSourceMeta(PROVIDER_ID, path, scope),
		},
	};
}

async function loadMCPServers(ctx: LoadContext): Promise<LoadResult<MCPServer>> {
	const items: MCPServer[] = [];
	const warnings: string[] = [];

	const userPath = getUserPath(ctx, "windsurf", "mcp_config.json");
	const [userContent, projectPath] = await Promise.all([
		userPath ? readFile(userPath) : Promise.resolve(null),
		getProjectPath(ctx, "windsurf", "mcp_config.json"),
	]);

	const projectContent = projectPath ? await readFile(projectPath) : null;
	// Load project entries before user entries so a project `enabled: false`
	// claims its dedupe key before a same-named user server can survive (#7654).
	const configs: Array<{ content: string | null; path: string | null; scope: "user" | "project" }> = [
		{ content: projectContent, path: projectPath, scope: "project" },
		{ content: userContent, path: userPath, scope: "user" },
	];

	for (const { content, path, scope } of configs) {
		if (!content || !path) continue;

		const config = tryParseJson<{ mcpServers?: Record<string, unknown> }>(content);
		if (!config?.mcpServers) continue;

		for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
			const result = parseServerConfig(name, serverConfig, path, scope);
			if (result.warning) warnings.push(result.warning);
			if (result.server) items.push(result.server);
		}
	}

	return { items, warnings };
}

// =============================================================================
// Rules
// =============================================================================

async function loadRules(ctx: LoadContext): Promise<LoadResult<Rule>> {
	const items: Rule[] = [];
	const warnings: string[] = [];

	// User-level: ~/.codeium/windsurf/memories/global_rules.md
	const userPath = getUserPath(ctx, "windsurf", "memories/global_rules.md");
	if (userPath) {
		const content = await readFile(userPath);
		if (content) {
			const source = createSourceMeta(PROVIDER_ID, userPath, "user");
			const rule = discoverRuleFromMarkdown("global_rules.md", content, userPath, source, {
				ruleName: "global_rules",
			});
			if (rule) items.push(rule);
		}
	}

	// Project-level: .windsurf/rules/*.md
	const projectRulesDir = getProjectPath(ctx, "windsurf", "rules");
	if (projectRulesDir) {
		const result = await loadFilesFromDir<Rule>(ctx, projectRulesDir, PROVIDER_ID, "project", {
			extensions: ["md"],
			transform: (name, content, path, source) =>
				discoverRuleFromMarkdown(name, content, path, source, { stripNamePattern: /\.md$/ }),
		});
		items.push(...result.items);
		if (result.warnings) warnings.push(...result.warnings);
	}

	return { items, warnings };
}

// =============================================================================
// Provider Registration
// =============================================================================

registerProvider<MCPServer>(mcpCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load MCP servers from Windsurf config (mcp_config.json)",
	priority: PRIORITY,
	load: loadMCPServers,
});

registerProvider<Rule>(ruleCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load rules from Windsurf (.windsurf/rules/*.md, memories/global_rules.md, .windsurfrules)",
	priority: PRIORITY,
	load: loadRules,
});
