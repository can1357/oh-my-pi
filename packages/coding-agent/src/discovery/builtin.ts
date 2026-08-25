/**
 * Builtin Provider (.omp)
 *
 * Primary provider for OMP native configs. Supports all capabilities.
 */
import * as path from "node:path";
import { getAgentDir, logger, parseFrontmatter, tryParseJson } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { getManagedSkillsDir, MANAGED_SKILLS_PROVIDER_ID } from "../autolearn/managed-skills";
import { registerProvider } from "../capability";
import { type ContextFile, contextFileCapability } from "../capability/context-file";
import { type Extension, type ExtensionManifest, extensionCapability } from "../capability/extension";
import { type ExtensionModule, extensionModuleCapability } from "../capability/extension-module";
import { readDirEntries, readFile } from "../capability/fs";
import { type Hook, hookCapability } from "../capability/hook";
import { type Instruction, instructionCapability } from "../capability/instruction";
import { type MCPServer, mcpCapability } from "../capability/mcp";
import { type Prompt, promptCapability } from "../capability/prompt";
import { type Rule, ruleCapability } from "../capability/rule";
import { type Settings, settingsCapability } from "../capability/settings";
import { type Skill, skillCapability } from "../capability/skill";
import { type SlashCommand, slashCommandCapability } from "../capability/slash-command";
import { type SystemPrompt, systemPromptCapability } from "../capability/system-prompt";
import { type CustomTool, toolCapability } from "../capability/tool";
import type { LoadContext, LoadResult } from "../capability/types";
import { expandTilde } from "../tools/path-utils";
import {
	buildRuleFromMarkdown,
	createSourceMeta,
	discoverExtensionModulePaths,
	expandEnvVarsDeep,
	getExtensionNameFromPath,
	loadFilesFromDir,
	parseRequestIdFormat,
	SOURCE_PATHS,
	scanSkillsFromDir,
} from "./helpers";

const PROVIDER_ID = "native";
const DISPLAY_NAME = "OMP";
const DESCRIPTION = "Native OMP configuration from ~/.omp and .omp/";
const PRIORITY = 100;

const PATHS = SOURCE_PATHS.native;

async function ifNonEmptyDir(...seg: string[]): Promise<string | null> {
	let dir = path.join(...seg);
	const entries = await readDirEntries(dir);
	if (entries.length > 0) {
		if (!path.isAbsolute(dir)) {
			dir = path.resolve(dir);
		}
		return dir;
	}
	return null;
}

async function getConfigDirs(ctx: LoadContext): Promise<Array<{ dir: string; level: "user" | "project" }>> {
	const result: Array<{ dir: string; level: "user" | "project" }> = [];

	const projectDir = await ifNonEmptyDir(ctx.cwd, PATHS.projectDir);
	if (projectDir) {
		result.push({ dir: projectDir, level: "project" });
	}
	// Native user config is profile-scoped: getAgentDir() points at the active
	// profile's agent dir (~/.omp/profiles/<name>/agent), like sessions and MCP.
	const userDir = await ifNonEmptyDir(getAgentDir());
	if (userDir) {
		result.push({ dir: userDir, level: "user" });
	}

	return result;
}

function getAncestorDirs(cwd: string, stopAt?: string | null): Array<{ dir: string; depth: number }> {
	const ancestors: Array<{ dir: string; depth: number }> = [];
	let current = cwd;
	let depth = 0;
	while (true) {
		ancestors.push({ dir: current, depth });
		if (stopAt && current === stopAt) break;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
		depth++;
	}
	return ancestors;
}

async function findNearestProjectConfigDir(
	cwd: string,
	repoRoot?: string | null,
): Promise<{ dir: string; depth: number } | null> {
	for (const ancestor of getAncestorDirs(cwd, repoRoot)) {
		const configDir = await ifNonEmptyDir(ancestor.dir, PATHS.projectDir);
		if (configDir) return { dir: configDir, depth: ancestor.depth };
	}
	return null;
}

// MCP
async function loadMCPServers(ctx: LoadContext): Promise<LoadResult<MCPServer>> {
	const items: MCPServer[] = [];
	const warnings: string[] = [];

	const parseMcpServers = (content: string, path: string, level: "user" | "project"): MCPServer[] => {
		const result: MCPServer[] = [];
		const data = tryParseJson<{ mcpServers?: Record<string, unknown> }>(content);
		if (!data?.mcpServers) return result;

		const expanded = expandEnvVarsDeep(data.mcpServers);
		for (const [serverName, config] of Object.entries(expanded)) {
			const serverConfig = config as Record<string, unknown>;

			// Validate enabled: coerce string "true"/"false", warn on other types
			let enabled: boolean | undefined;
			if (serverConfig.enabled === undefined || serverConfig.enabled === null) {
				enabled = undefined;
			} else if (typeof serverConfig.enabled === "boolean") {
				enabled = serverConfig.enabled;
			} else if (typeof serverConfig.enabled === "string") {
				const lower = serverConfig.enabled.toLowerCase();
				if (lower === "false" || lower === "0") enabled = false;
				else if (lower === "true" || lower === "1") enabled = true;
				else {
					logger.warn(`MCP server "${serverName}": invalid enabled value "${serverConfig.enabled}", ignoring`);
					enabled = undefined;
				}
			} else {
				logger.warn(`MCP server "${serverName}": invalid enabled type ${typeof serverConfig.enabled}, ignoring`);
				enabled = undefined;
			}

			// Validate lazy: coerce string "true"/"false" like enabled, warn otherwise
			let lazy: boolean | undefined;
			if (serverConfig.lazy === undefined || serverConfig.lazy === null) {
				lazy = undefined;
			} else if (typeof serverConfig.lazy === "boolean") {
				lazy = serverConfig.lazy;
			} else if (typeof serverConfig.lazy === "string") {
				const lower = serverConfig.lazy.toLowerCase();
				if (lower === "false" || lower === "0") lazy = false;
				else if (lower === "true" || lower === "1") lazy = true;
				else {
					logger.warn(`MCP server "${serverName}": invalid lazy value "${serverConfig.lazy}", ignoring`);
					lazy = undefined;
				}
			} else {
				logger.warn(`MCP server "${serverName}": invalid lazy type ${typeof serverConfig.lazy}, ignoring`);
				lazy = undefined;
			}

			// Validate timeout: coerce numeric strings, warn on invalid
			let timeout: number | undefined;
			if (serverConfig.timeout === undefined || serverConfig.timeout === null) {
				timeout = undefined;
			} else if (typeof serverConfig.timeout === "number") {
				if (Number.isFinite(serverConfig.timeout) && serverConfig.timeout >= 0) {
					timeout = serverConfig.timeout;
				} else {
					logger.warn(`MCP server "${serverName}": invalid timeout ${serverConfig.timeout}, ignoring`);
					timeout = undefined;
				}
			} else if (typeof serverConfig.timeout === "string") {
				const parsed = Number(serverConfig.timeout);
				if (Number.isFinite(parsed) && parsed >= 0) {
					timeout = parsed;
				} else {
					logger.warn(`MCP server "${serverName}": invalid timeout "${serverConfig.timeout}", ignoring`);
					timeout = undefined;
				}
			} else {
				logger.warn(`MCP server "${serverName}": invalid timeout type ${typeof serverConfig.timeout}, ignoring`);
				timeout = undefined;
			}

			// Validate requestIdFormat: only the two documented encodings
			const requestIdFormat = parseRequestIdFormat(serverConfig.requestIdFormat);
			if (requestIdFormat === undefined && serverConfig.requestIdFormat != null) {
				logger.warn(
					`MCP server "${serverName}": invalid requestIdFormat ${JSON.stringify(serverConfig.requestIdFormat)}, ignoring`,
				);
			}

			result.push({
				name: serverName,
				enabled,
				lazy,
				timeout,
				requestIdFormat,
				command: serverConfig.command as string | undefined,
				args: serverConfig.args as string[] | undefined,
				env: serverConfig.env as Record<string, string> | undefined,
				cwd: serverConfig.cwd as string | undefined,
				url: serverConfig.url as string | undefined,
				headers: serverConfig.headers as Record<string, string> | undefined,
				auth: serverConfig.auth as
					| {
							type: "oauth" | "apikey";
							credentialId?: string;
							tokenUrl?: string;
							clientId?: string;
							clientSecret?: string;
					  }
					| undefined,
				oauth: serverConfig.oauth as
					| {
							clientId?: string;
							clientSecret?: string;
							redirectUri?: string;
							callbackPort?: number;
							callbackPath?: string;
							prompt?: string;
					  }
					| undefined,
				transport: serverConfig.type as "stdio" | "sse" | "http" | undefined,
				_source: createSourceMeta(PROVIDER_ID, path, level),
			});
		}
		return result;
	};

	// User scope tracks the active profile via getAgentDir() (not ctx.home), so it
	// stays in sync with getMCPConfigPath("user") and the /mcp config writer.
	const userAgentDir = getAgentDir();
	const paths = [
		{ path: path.join(ctx.cwd, PATHS.projectDir, "mcp.json"), level: "project" as const },
		{ path: path.join(ctx.cwd, PATHS.projectDir, ".mcp.json"), level: "project" as const },
		{ path: path.join(userAgentDir, "mcp.json"), level: "user" as const },
		{ path: path.join(userAgentDir, ".mcp.json"), level: "user" as const },
	];

	const contents = await Promise.allSettled(
		paths.map(async p => {
			const content = await readFile(p.path);
			if (content) {
				return { path: p.path, content, level: p.level };
			}
			return null;
		}),
	);

	for (const result of contents) {
		if (result.status === "fulfilled" && result.value) {
			const { path, content, level } = result.value;
			items.push(...parseMcpServers(content, path, level));
		}
	}

	return { items, warnings };
}

registerProvider<MCPServer>(mcpCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: DESCRIPTION,
	priority: PRIORITY,
	load: loadMCPServers,
});

// System Prompt (SYSTEM.md)
async function loadSystemPrompt(ctx: LoadContext): Promise<LoadResult<SystemPrompt>> {
	const items: SystemPrompt[] = [];

	const userPath = path.join(getAgentDir(), "SYSTEM.md");
	const userContent = await readFile(userPath);
	if (userContent) {
		items.push({
			path: userPath,
			content: userContent,
			level: "user",
			_source: createSourceMeta(PROVIDER_ID, userPath, "user"),
		});
	}

	const nearestProjectConfigDir = await findNearestProjectConfigDir(ctx.cwd, ctx.repoRoot);
	if (nearestProjectConfigDir) {
		const projectPath = path.join(nearestProjectConfigDir.dir, "SYSTEM.md");
		const projectContent = await readFile(projectPath);
		if (projectContent) {
			items.push({
				path: projectPath,
				content: projectContent,
				level: "project",
				_source: createSourceMeta(PROVIDER_ID, projectPath, "project"),
			});
		}
	}

	return { items, warnings: [] };
}

registerProvider<SystemPrompt>(systemPromptCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Custom system prompt from SYSTEM.md",
	priority: PRIORITY,
	load: loadSystemPrompt,
});

// Skills
async function loadSkills(ctx: LoadContext): Promise<LoadResult<Skill>> {
	// Walk up from cwd finding .omp/skills/ in ancestors (closest first)
	const ancestors = getAncestorDirs(ctx.cwd, ctx.repoRoot ?? ctx.home);
	const projectScans = ancestors.map(({ dir }) =>
		scanSkillsFromDir(ctx, {
			dir: path.join(dir, PATHS.projectDir, "skills"),
			providerId: PROVIDER_ID,
			level: "project",
			requireDescription: true,
		}),
	);

	// User-level scan from ~/.omp/agent/skills/
	const userScan = scanSkillsFromDir(ctx, {
		dir: path.join(getAgentDir(), "skills"),
		providerId: PROVIDER_ID,
		level: "user",
		requireDescription: true,
	});

	const results = await Promise.all([...projectScans, userScan]);
	return {
		items: results.flatMap(r => r.items),
		warnings: results.flatMap(r => r.warnings ?? []),
	};
}

// Managed skills (auto-learn) are a SEPARATE provider at the lowest skill
// priority, so an authored skill of the same name from ANY other provider wins
// the capability-level priority dedup. Discovery is unconditional (an empty
// managed dir is a no-op); only writing/nudging is gated by `autolearn.enabled`.
const MANAGED_SKILLS_PRIORITY = 5;
async function loadManagedSkills(ctx: LoadContext): Promise<LoadResult<Skill>> {
	return scanSkillsFromDir(ctx, {
		dir: getManagedSkillsDir(),
		providerId: MANAGED_SKILLS_PROVIDER_ID,
		level: "user",
		requireDescription: true,
	});
}

registerProvider<Skill>(skillCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: DESCRIPTION,
	priority: PRIORITY,
	load: loadSkills,
});

registerProvider<Skill>(skillCapability.id, {
	id: MANAGED_SKILLS_PROVIDER_ID,
	displayName: "Managed Skills (auto-learn)",
	description: "Auto-generated managed skills from ~/.omp/agent/managed-skills",
	priority: MANAGED_SKILLS_PRIORITY,
	load: loadManagedSkills,
});

// Slash Commands
async function loadSlashCommands(ctx: LoadContext): Promise<LoadResult<SlashCommand>> {
	const items: SlashCommand[] = [];
	const warnings: string[] = [];

	for (const { dir, level } of await getConfigDirs(ctx)) {
		const commandsDir = path.join(dir, "commands");
		const result = await loadFilesFromDir<SlashCommand>(ctx, commandsDir, PROVIDER_ID, level, {
			extensions: ["md"],
			transform: (name, content, path, source) => ({
				name: name.replace(/\.md$/, ""),
				path,
				content,
				level,
				_source: source,
			}),
		});
		items.push(...result.items);
		if (result.warnings) warnings.push(...result.warnings);
	}

	return { items, warnings };
}

registerProvider<SlashCommand>(slashCommandCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: DESCRIPTION,
	priority: PRIORITY,
	load: loadSlashCommands,
});

// Rules
async function loadRules(ctx: LoadContext): Promise<LoadResult<Rule>> {
	const items: Rule[] = [];
	const warnings: string[] = [];

	for (const { dir, level } of await getConfigDirs(ctx)) {
		const rulesDir = path.join(dir, "rules");
		const result = await loadFilesFromDir<Rule>(ctx, rulesDir, PROVIDER_ID, level, {
			extensions: ["md", "mdc"],
			transform: (name, content, path, source) =>
				buildRuleFromMarkdown(name, content, path, source, { stripNamePattern: /\.(md|mdc)$/ }),
		});
		items.push(...result.items);
		if (result.warnings) warnings.push(...result.warnings);
	}

	// Top-level RULES.md is a sticky always-apply rule. Documented in
	// https://omp.sh/docs/context-files as the file that gets "re-injected near
	// the current turn so they keep hold across long conversations".
	// User scope:    ~/.omp/agent/RULES.md
	// Project scope: nearest .omp/RULES.md walking up from cwd to repoRoot
	const userRulesFile = path.join(getAgentDir(), "RULES.md");
	const userRule = await loadStickyRulesFile(userRulesFile, "user");
	if (userRule) items.push(userRule);

	const nearestProjectConfigDir = await findNearestProjectConfigDir(ctx.cwd, ctx.repoRoot);
	if (nearestProjectConfigDir) {
		const projectRulesFile = path.join(nearestProjectConfigDir.dir, "RULES.md");
		const projectRule = await loadStickyRulesFile(projectRulesFile, "project");
		if (projectRule) items.push(projectRule);
	}

	return { items, warnings };
}

/**
 * Read a top-level `RULES.md` and synthesize an always-apply rule.
 * Returns null when the file is absent or empty so callers can short-circuit.
 */
async function loadStickyRulesFile(filePath: string, level: "user" | "project"): Promise<Rule | null> {
	const content = await readFile(filePath);
	if (!content) return null;
	const source = createSourceMeta(PROVIDER_ID, filePath, level);
	const ruleName = level === "project" ? "RULES@project" : "RULES";
	const rule = buildRuleFromMarkdown("RULES.md", content, filePath, source, { ruleName });
	// Force alwaysApply regardless of frontmatter — the whole point of RULES.md
	// is to be reattached every turn.
	return { ...rule, alwaysApply: true };
}

registerProvider<Rule>(ruleCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: DESCRIPTION,
	priority: PRIORITY,
	load: loadRules,
});

// Prompts
async function loadPrompts(ctx: LoadContext): Promise<LoadResult<Prompt>> {
	const items: Prompt[] = [];
	const warnings: string[] = [];

	for (const { dir, level } of await getConfigDirs(ctx)) {
		const promptsDir = path.join(dir, "prompts");
		const result = await loadFilesFromDir<Prompt>(ctx, promptsDir, PROVIDER_ID, level, {
			extensions: ["md"],
			transform: (name, content, path, source) => ({
				name: name.replace(/\.md$/, ""),
				path,
				content,
				_source: source,
			}),
		});
		items.push(...result.items);
		if (result.warnings) warnings.push(...result.warnings);
	}

	return { items, warnings };
}

registerProvider<Prompt>(promptCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: DESCRIPTION,
	priority: PRIORITY,
	load: loadPrompts,
});

// Extension Modules
async function loadExtensionModules(ctx: LoadContext): Promise<LoadResult<ExtensionModule>> {
	const items: ExtensionModule[] = [];
	const warnings: string[] = [];

	const resolveExtensionPath = (rawPath: string): string => {
		const expanded = expandTilde(rawPath, ctx.home);
		if (path.isAbsolute(expanded)) {
			return expanded;
		}
		return path.resolve(ctx.cwd, expanded);
	};

	const createExtensionModule = (extPath: string, level: "user" | "project"): ExtensionModule => ({
		name: getExtensionNameFromPath(extPath),
		path: extPath,
		level,
		_source: createSourceMeta(PROVIDER_ID, extPath, level),
	});

	const configDirs = await getConfigDirs(ctx);

	const [discoveredResults, settingsResults] = await Promise.all([
		Promise.all(configDirs.map(({ dir }) => discoverExtensionModulePaths(ctx, path.join(dir, "extensions")))),
		Promise.all(configDirs.map(({ dir }) => readFile(path.join(dir, "settings.json")))),
	]);

	for (let i = 0; i < configDirs.length; i++) {
		const { level } = configDirs[i];
		for (const extPath of discoveredResults[i]) {
			items.push(createExtensionModule(extPath, level));
		}
	}

	const settingsExtensions: Array<{
		resolvedPath: string;
		settingsPath: string;
		level: "user" | "project";
	}> = [];

	for (let i = 0; i < configDirs.length; i++) {
		const { dir, level } = configDirs[i];
		const settingsContent = settingsResults[i];
		if (!settingsContent) continue;

		const settingsPath = path.join(dir, "settings.json");
		const settingsData = tryParseJson<{ extensions?: unknown }>(settingsContent);
		const extensions = settingsData?.extensions;
		if (!Array.isArray(extensions)) continue;

		for (const entry of extensions) {
			if (typeof entry !== "string") {
				warnings.push(`Invalid extension path in ${settingsPath}: ${String(entry)}`);
				continue;
			}
			settingsExtensions.push({
				resolvedPath: resolveExtensionPath(entry),
				settingsPath,
				level,
			});
		}
	}

	const [entriesResults, fileContents] = await Promise.all([
		Promise.all(settingsExtensions.map(({ resolvedPath }) => readDirEntries(resolvedPath))),
		Promise.all(settingsExtensions.map(({ resolvedPath }) => readFile(resolvedPath))),
	]);

	const dirDiscoveryPromises: Array<{
		promise: Promise<string[]>;
		level: "user" | "project";
	}> = [];

	for (let i = 0; i < settingsExtensions.length; i++) {
		const { resolvedPath, level } = settingsExtensions[i];
		const entries = entriesResults[i];
		const content = fileContents[i];

		if (entries.length > 0) {
			dirDiscoveryPromises.push({
				promise: discoverExtensionModulePaths(ctx, resolvedPath),
				level,
			});
		} else if (content !== null) {
			items.push(createExtensionModule(resolvedPath, level));
		} else {
			warnings.push(`Extension path not found: ${resolvedPath}`);
		}
	}

	const dirDiscoveryResults = await Promise.all(dirDiscoveryPromises.map(d => d.promise));
	for (let i = 0; i < dirDiscoveryPromises.length; i++) {
		const { level } = dirDiscoveryPromises[i];
		for (const extPath of dirDiscoveryResults[i]) {
			items.push(createExtensionModule(extPath, level));
		}
	}

	return { items, warnings };
}

registerProvider<ExtensionModule>(extensionModuleCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: DESCRIPTION,
	priority: PRIORITY,
	load: loadExtensionModules,
});

// Extensions
async function loadExtensions(ctx: LoadContext): Promise<LoadResult<Extension>> {
	const items: Extension[] = [];
	const warnings: string[] = [];

	const configDirs = await getConfigDirs(ctx);
	const entriesResults = await Promise.all(configDirs.map(({ dir }) => readDirEntries(path.join(dir, "extensions"))));

	const manifestCandidates: Array<{
		extDir: string;
		manifestPath: string;
		entryName: string;
		level: "user" | "project";
	}> = [];

	for (let i = 0; i < configDirs.length; i++) {
		const { dir, level } = configDirs[i];
		const entries = entriesResults[i];
		const extensionsDir = path.join(dir, "extensions");

		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			if (!entry.isDirectory()) continue;

			const extDir = path.join(extensionsDir, entry.name);
			manifestCandidates.push({
				extDir,
				manifestPath: path.join(extDir, "gemini-extension.json"),
				entryName: entry.name,
				level,
			});
		}
	}

	const manifestContents = await Promise.all(manifestCandidates.map(({ manifestPath }) => readFile(manifestPath)));

	for (let i = 0; i < manifestCandidates.length; i++) {
		const content = manifestContents[i];
		if (!content) continue;

		const { extDir, manifestPath, entryName, level } = manifestCandidates[i];
		const manifest = tryParseJson<ExtensionManifest>(content);
		if (!manifest) {
			warnings.push(`Failed to parse ${manifestPath}`);
			continue;
		}

		items.push({
			name: manifest.name || entryName,
			path: extDir,
			manifest,
			level,
			_source: createSourceMeta(PROVIDER_ID, manifestPath, level),
		});
	}

	return { items, warnings };
}

registerProvider<Extension>(extensionCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: DESCRIPTION,
	priority: PRIORITY,
	load: loadExtensions,
});

// Instructions
async function loadInstructions(ctx: LoadContext): Promise<LoadResult<Instruction>> {
	const items: Instruction[] = [];
	const warnings: string[] = [];

	for (const { dir, level } of await getConfigDirs(ctx)) {
		const instructionsDir = path.join(dir, "instructions");
		const result = await loadFilesFromDir<Instruction>(ctx, instructionsDir, PROVIDER_ID, level, {
			extensions: ["md"],
			transform: (name, content, path, source) => {
				const { frontmatter, body } = parseFrontmatter(content, { source: path });
				return {
					name: name.replace(/\.instructions\.md$/, "").replace(/\.md$/, ""),
					path,
					content: body,
					applyTo: frontmatter.applyTo as string | undefined,
					_source: source,
				};
			},
		});
		items.push(...result.items);
		if (result.warnings) warnings.push(...result.warnings);
	}

	return { items, warnings };
}

registerProvider<Instruction>(instructionCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: DESCRIPTION,
	priority: PRIORITY,
	load: loadInstructions,
});

// Hooks
async function loadHooks(ctx: LoadContext): Promise<LoadResult<Hook>> {
	const items: Hook[] = [];

	const configDirs = await getConfigDirs(ctx);
	const hookTypes = ["pre", "post"] as const;

	const typeDirRequests: Array<{
		typeDir: string;
		hookType: (typeof hookTypes)[number];
		level: "user" | "project";
	}> = [];

	for (const { dir, level } of configDirs) {
		for (const hookType of hookTypes) {
			typeDirRequests.push({
				typeDir: path.join(dir, "hooks", hookType),
				hookType,
				level,
			});
		}
	}

	const typeEntriesResults = await Promise.all(typeDirRequests.map(({ typeDir }) => readDirEntries(typeDir)));

	for (let i = 0; i < typeDirRequests.length; i++) {
		const { typeDir, hookType, level } = typeDirRequests[i];
		const typeEntries = typeEntriesResults[i];

		for (const entry of typeEntries) {
			if (entry.name.startsWith(".")) continue;
			if (!entry.isFile()) continue;

			const hookPath = path.join(typeDir, entry.name);
			const baseName = entry.name.includes(".") ? entry.name.slice(0, entry.name.lastIndexOf(".")) : entry.name;
			const tool = baseName === "*" ? "*" : baseName;

			items.push({
				name: entry.name,
				path: hookPath,
				type: hookType,
				tool,
				level,
				_source: createSourceMeta(PROVIDER_ID, hookPath, level),
			});
		}
	}

	return { items, warnings: [] };
}

registerProvider<Hook>(hookCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: DESCRIPTION,
	priority: PRIORITY,
	load: loadHooks,
});

// Custom Tools
async function loadTools(ctx: LoadContext): Promise<LoadResult<CustomTool>> {
	const items: CustomTool[] = [];
	const warnings: string[] = [];

	const configDirs = await getConfigDirs(ctx);
	const entriesResults = await Promise.all(configDirs.map(({ dir }) => readDirEntries(path.join(dir, "tools"))));

	const fileLoadPromises: Array<Promise<{ items: CustomTool[]; warnings?: string[] }>> = [];
	const subDirCandidates: Array<{
		indexPath: string;
		entryName: string;
		level: "user" | "project";
	}> = [];

	for (let i = 0; i < configDirs.length; i++) {
		const { dir, level } = configDirs[i];
		const toolEntries = entriesResults[i];
		if (toolEntries.length === 0) continue;

		const toolsDir = path.join(dir, "tools");

		fileLoadPromises.push(
			loadFilesFromDir<CustomTool>(ctx, toolsDir, PROVIDER_ID, level, {
				extensions: ["json", "md", "ts", "js", "sh", "bash", "py"],
				transform: (name, content, path, source) => {
					if (name.endsWith(".json")) {
						const data = tryParseJson<{ name?: string; description?: string }>(content);
						const toolName = data?.name || name.replace(/\.json$/, "");
						const description =
							typeof data?.description === "string" && data.description.trim()
								? data.description
								: `${toolName} custom tool`;
						return {
							name: toolName,
							path,
							description,
							level,
							_source: source,
						};
					}
					if (name.endsWith(".md")) {
						const { frontmatter } = parseFrontmatter(content, { source: path });
						const toolName = (frontmatter.name as string) || name.replace(/\.md$/, "");
						const description =
							typeof frontmatter.description === "string" && frontmatter.description.trim()
								? String(frontmatter.description)
								: `${toolName} custom tool`;
						return {
							name: toolName,
							path,
							description,
							level,
							_source: source,
						};
					}
					// Executable tool files (.ts, .js, .sh, .bash, .py)
					const toolName = name.replace(/\.(ts|js|sh|bash|py)$/, "");
					return {
						name: toolName,
						path,
						description: `${toolName} custom tool`,
						level,
						_source: source,
					};
				},
			}),
		);

		for (const entry of toolEntries) {
			if (entry.name.startsWith(".")) continue;
			if (!entry.isDirectory()) continue;

			subDirCandidates.push({
				indexPath: path.join(toolsDir, entry.name, "index.ts"),
				entryName: entry.name,
				level,
			});
		}
	}

	const [fileResults, indexContents] = await Promise.all([
		Promise.all(fileLoadPromises),
		Promise.all(subDirCandidates.map(({ indexPath }) => readFile(indexPath))),
	]);

	for (const result of fileResults) {
		items.push(...result.items);
		if (result.warnings) warnings.push(...result.warnings);
	}

	for (let i = 0; i < subDirCandidates.length; i++) {
		const indexContent = indexContents[i];
		if (indexContent !== null) {
			const { indexPath, entryName, level } = subDirCandidates[i];
			items.push({
				name: entryName,
				path: indexPath,
				description: `${entryName} custom tool`,
				level,
				_source: createSourceMeta(PROVIDER_ID, indexPath, level),
			});
		}
	}

	return { items, warnings };
}

registerProvider<CustomTool>(toolCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: DESCRIPTION,
	priority: PRIORITY,
	load: loadTools,
});

// Settings
async function loadSettings(ctx: LoadContext): Promise<LoadResult<Settings>> {
	const items: Settings[] = [];
	const warnings: string[] = [];

	const parseYamlSettings = (content: string, filePath: string): Record<string, unknown> | null => {
		try {
			const data = YAML.parse(content);
			if (!data || typeof data !== "object" || Array.isArray(data)) return {};
			return data as Record<string, unknown>;
		} catch {
			warnings.push(`Failed to parse ${filePath}`);
			return null;
		}
	};

	for (const { dir, level } of await getConfigDirs(ctx)) {
		const settingsPath = path.join(dir, "settings.json");
		const settingsContent = await readFile(settingsPath);
		if (settingsContent) {
			const data = tryParseJson<Record<string, unknown>>(settingsContent);
			if (data) {
				items.push({
					path: settingsPath,
					data,
					level,
					_source: createSourceMeta(PROVIDER_ID, settingsPath, level),
				});
			} else {
				warnings.push(`Failed to parse ${settingsPath}`);
			}
		}

		const configPath = path.join(dir, "config.yml");
		const configContent = await readFile(configPath);
		if (!configContent) continue;

		const data = parseYamlSettings(configContent, configPath);
		if (!data) continue;

		items.push({
			path: configPath,
			data,
			level,
			_source: createSourceMeta(PROVIDER_ID, configPath, level),
		});
	}

	return { items, warnings };
}

registerProvider<Settings>(settingsCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: DESCRIPTION,
	priority: PRIORITY,
	load: loadSettings,
});

// Context Files (AGENTS.md)
async function loadContextFiles(ctx: LoadContext): Promise<LoadResult<ContextFile>> {
	const items: ContextFile[] = [];
	const warnings: string[] = [];

	const userPath = path.join(getAgentDir(), "AGENTS.md");
	const userContent = await readFile(userPath);
	if (userContent) {
		items.push({
			path: userPath,
			content: userContent,
			level: "user",
			_source: createSourceMeta(PROVIDER_ID, userPath, "user"),
		});
	}

	const nearestProjectConfigDir = await findNearestProjectConfigDir(ctx.cwd, ctx.repoRoot);
	if (nearestProjectConfigDir) {
		const projectPath = path.join(nearestProjectConfigDir.dir, "AGENTS.md");
		const projectContent = await readFile(projectPath);
		if (projectContent) {
			items.push({
				path: projectPath,
				content: projectContent,
				level: "project",
				depth: nearestProjectConfigDir.depth,
				_source: createSourceMeta(PROVIDER_ID, projectPath, "project"),
			});
			return { items, warnings };
		}
	}
	return { items, warnings };
}

registerProvider<ContextFile>(contextFileCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load AGENTS.md from .omp/ directories",
	priority: PRIORITY,
	load: loadContextFiles,
});
