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

import { registerProvider } from "../capability/index";
import { type MCPServer, mcpCapability } from "../capability/mcp";
import { type Rule, ruleCapability } from "../capability/rule";
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

const PROVIDER_ID = "windsurf";
const DISPLAY_NAME = "Windsurf";
const PRIORITY = 50;

// =============================================================================
// MCP Servers
// =============================================================================

function loadMCPServers(ctx: LoadContext): LoadResult<MCPServer> {
	const items: MCPServer[] = [];
	const warnings: string[] = [];

	// User-level: ~/.codeium/windsurf/mcp_config.json
	const userPath = getUserPath(ctx, "windsurf", "mcp_config.json");
	if (userPath && ctx.fs.isFile(userPath)) {
		const content = ctx.fs.readFile(userPath);
		if (content) {
			const config = parseJSON<{ mcpServers?: Record<string, unknown> }>(content);
			if (config?.mcpServers) {
				for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
					if (typeof serverConfig !== "object" || serverConfig === null) {
						warnings.push(`Invalid server config for "${name}" in ${userPath}`);
						continue;
					}

					const server = expandEnvVarsDeep(serverConfig as Record<string, unknown>);
					items.push({
						name,
						command: server.command as string | undefined,
						args: server.args as string[] | undefined,
						env: server.env as Record<string, string> | undefined,
						url: server.url as string | undefined,
						headers: server.headers as Record<string, string> | undefined,
						transport: server.type as "stdio" | "sse" | "http" | undefined,
						_source: createSourceMeta(PROVIDER_ID, userPath, "user"),
					});
				}
			}
		}
	}

	// Project-level: .windsurf/mcp_config.json
	const projectPath = getProjectPath(ctx, "windsurf", "mcp_config.json");
	if (projectPath && ctx.fs.isFile(projectPath)) {
		const content = ctx.fs.readFile(projectPath);
		if (content) {
			const config = parseJSON<{ mcpServers?: Record<string, unknown> }>(content);
			if (config?.mcpServers) {
				for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
					if (typeof serverConfig !== "object" || serverConfig === null) {
						warnings.push(`Invalid server config for "${name}" in ${projectPath}`);
						continue;
					}

					const server = expandEnvVarsDeep(serverConfig as Record<string, unknown>);
					items.push({
						name,
						command: server.command as string | undefined,
						args: server.args as string[] | undefined,
						env: server.env as Record<string, string> | undefined,
						url: server.url as string | undefined,
						headers: server.headers as Record<string, string> | undefined,
						transport: server.type as "stdio" | "sse" | "http" | undefined,
						_source: createSourceMeta(PROVIDER_ID, projectPath, "project"),
					});
				}
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

	// User-level: ~/.codeium/windsurf/memories/global_rules.md
	const userPath = getUserPath(ctx, "windsurf", "memories/global_rules.md");
	if (userPath && ctx.fs.isFile(userPath)) {
		const content = ctx.fs.readFile(userPath);
		if (content) {
			const { frontmatter, body } = parseFrontmatter(content);

			// Validate and normalize globs
			let globs: string[] | undefined;
			if (Array.isArray(frontmatter.globs)) {
				globs = frontmatter.globs.filter((g): g is string => typeof g === "string");
			} else if (typeof frontmatter.globs === "string") {
				globs = [frontmatter.globs];
			}

			items.push({
				name: "global_rules",
				path: userPath,
				content: body,
				globs,
				alwaysApply: frontmatter.alwaysApply as boolean | undefined,
				description: frontmatter.description as string | undefined,
				ttsrTrigger: typeof frontmatter.ttsr_trigger === "string" ? frontmatter.ttsr_trigger : undefined,
				_source: createSourceMeta(PROVIDER_ID, userPath, "user"),
			});
		}
	}

	// Project-level: .windsurf/rules/*.md
	const projectRulesDir = getProjectPath(ctx, "windsurf", "rules");
	if (projectRulesDir) {
		const result = loadFilesFromDir<Rule>(ctx, projectRulesDir, PROVIDER_ID, "project", {
			extensions: ["md"],
			transform: (name, content, path, source) => {
				const { frontmatter, body } = parseFrontmatter(content);
				const ruleName = name.replace(/\.md$/, "");

				// Validate and normalize globs
				let globs: string[] | undefined;
				if (Array.isArray(frontmatter.globs)) {
					globs = frontmatter.globs.filter((g): g is string => typeof g === "string");
				} else if (typeof frontmatter.globs === "string") {
					globs = [frontmatter.globs];
				}

				return {
					name: ruleName,
					path,
					content: body,
					globs,
					alwaysApply: frontmatter.alwaysApply as boolean | undefined,
					description: frontmatter.description as string | undefined,
					ttsrTrigger: typeof frontmatter.ttsr_trigger === "string" ? frontmatter.ttsr_trigger : undefined,
					_source: source,
				};
			},
		});
		items.push(...result.items);
		if (result.warnings) warnings.push(...result.warnings);
	}

	// Legacy: .windsurfrules in project root
	const legacyPath = ctx.fs.walkUp(".windsurfrules", { file: true });
	if (legacyPath) {
		const content = ctx.fs.readFile(legacyPath);
		if (content) {
			const { frontmatter, body } = parseFrontmatter(content);

			// Validate and normalize globs
			let globs: string[] | undefined;
			if (Array.isArray(frontmatter.globs)) {
				globs = frontmatter.globs.filter((g): g is string => typeof g === "string");
			} else if (typeof frontmatter.globs === "string") {
				globs = [frontmatter.globs];
			}

			items.push({
				name: "windsurfrules",
				path: legacyPath,
				content: body,
				globs,
				alwaysApply: frontmatter.alwaysApply as boolean | undefined,
				description: frontmatter.description as string | undefined,
				ttsrTrigger: typeof frontmatter.ttsr_trigger === "string" ? frontmatter.ttsr_trigger : undefined,
				_source: createSourceMeta(PROVIDER_ID, legacyPath, "project"),
			});
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
