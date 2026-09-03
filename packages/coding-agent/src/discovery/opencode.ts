/**
 * OpenCode Discovery Provider
 *
 * Loads configuration from OpenCode's config directories:
 * - User: ~/.config/opencode/
 * - Project: .opencode/ (cwd) and opencode.json/opencode.jsonc (project root)
 *
 * Capabilities:
 * - context-files: AGENTS.md (user-level only at ~/.config/opencode/AGENTS.md)
 * - mcps: From opencode.json and opencode.jsonc "mcp" keys
 * - settings: From opencode.json and opencode.jsonc
 * - skills: From skills/ subdirectories
 * - slash-commands: From commands/ subdirectories
 * - extension-modules: From plugins/ subdirectories
 *
 * Priority: 55 (tool-specific provider)
 */
import * as os from "node:os";
import * as path from "node:path";
import { isRecord, logger, parseFrontmatter } from "@oh-my-pi/pi-utils";
import { JSONC } from "bun";
import { registerProvider } from "../capability";
import { type ContextFile, contextFileCapability } from "../capability/context-file";
import { type ExtensionModule, extensionModuleCapability } from "../capability/extension-module";
import { readFile } from "../capability/fs";
import { type MCPServer, mcpCapability } from "../capability/mcp";
import { type Settings, settingsCapability } from "../capability/settings";
import { type Skill, skillCapability } from "../capability/skill";
import { type SlashCommand, slashCommandCapability, slashCommandFrontmatterDisplay } from "../capability/slash-command";
import type { LoadContext, LoadResult, SourceMeta } from "../capability/types";
import { settings } from "../config/settings";

import {
	buildExtensionModuleItems,
	createSourceMeta,
	discoverExtensionModulePaths,
	getProjectPath,
	getUserPath,
	loadFilesFromDir,
	resolveUserPath,
	scanSkillsFromDir,
} from "./helpers";

const PROVIDER_ID = "opencode";
const DISPLAY_NAME = "OpenCode";
const PRIORITY = 55;
const CONFIG_FILENAMES = ["opencode.json", "opencode.jsonc"] as const;

interface OpenCodeConfigSource {
	path: string;
	level: "user" | "project";
}

// =============================================================================
// JSON Config Loading
// =============================================================================

async function loadJsonConfig(
	configPath: string,
	onInvalid: (configPath: string) => void,
): Promise<Record<string, unknown> | null> {
	const content = await readFile(configPath);
	if (!content) return null;

	let parsed: unknown;
	try {
		parsed = JSONC.parse(await substituteConfigVars(content, configPath));
	} catch {
		onInvalid(configPath);
		return null;
	}
	if (!isRecord(parsed)) {
		onInvalid(configPath);
		return null;
	}
	return parsed;
}

/**
 * Apply OpenCode's config variable substitution to raw config text.
 *
 * OpenCode expands `{env:VAR}` (the env value, or an empty string when unset)
 * and `{file:path}` (file contents, trimmed and JSON-escaped) at load time,
 * before the JSON is parsed — see opencode `packages/opencode/src/config/variable.ts`.
 * OMP loads the same config files, so it MUST honor the same syntax; the generic
 * `${VAR}` expansion used elsewhere never matches, leaving a header like
 * `Bearer {env:MCP_KEY}` to reach the MCP server verbatim and 401 (#8778).
 *
 * `{file:path}` resolves relative to the config file's directory, or from a `~`/
 * absolute path. A token on a `//` comment line is left untouched, matching
 * OpenCode. A missing file expands to an empty string (OpenCode's `missing:
 * "empty"` mode) rather than aborting discovery.
 */
async function substituteConfigVars(text: string, configPath: string): Promise<string> {
	const envExpanded = text.replace(/\{env:([^}]+)\}/g, (_, name: string) => Bun.env[name] ?? "");

	const fileMatches = [...envExpanded.matchAll(/\{file:[^}]+\}/g)];
	if (fileMatches.length === 0) return envExpanded;

	const configDir = path.dirname(configPath);
	let out = "";
	let cursor = 0;
	for (const match of fileMatches) {
		const token = match[0];
		const index = match.index ?? 0;
		out += envExpanded.slice(cursor, index);
		cursor = index + token.length;

		// A `{file:...}` sitting on a JSONC comment line is not a real reference.
		const lineStart = envExpanded.lastIndexOf("\n", index - 1) + 1;
		if (envExpanded.slice(lineStart, index).trimStart().startsWith("//")) {
			out += token;
			continue;
		}

		let filePath = token.slice("{file:".length, -1);
		if (filePath.startsWith("~/")) filePath = path.join(os.homedir(), filePath.slice(2));
		const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(configDir, filePath);

		const fileContent = await readFile(resolved);
		if (fileContent === null) {
			logger.warn("OpenCode config references a missing file", { configPath, path: resolved });
			continue;
		}
		// JSON-escape so multi-line/quoted contents stay valid inside the string literal.
		out += JSON.stringify(fileContent.trim()).slice(1, -1);
	}
	out += envExpanded.slice(cursor);
	return out;
}

/**
 * OpenCode config sources in ascending effective precedence (lowest first):
 * user `opencode.json` → user `opencode.jsonc` → project-root
 * `opencode.json` → project-root `opencode.jsonc` → project `.opencode/opencode.json`
 * → project `.opencode/opencode.jsonc`. This matches how OpenCode merges configs:
 * project overrides user, `.opencode` overrides project-root config, and within
 * a directory `opencode.jsonc` overrides `opencode.json`.
 *
 * Both consumers apply this order low-to-high: settings deep-merge in item
 * order (last wins) and `loadMCPServers` deep-merges each server across layers
 * (later overrides earlier), so higher-precedence sources win in both.
 */
function getConfigSources(ctx: LoadContext): OpenCodeConfigSource[] {
	const sources: OpenCodeConfigSource[] = [];
	for (const filename of CONFIG_FILENAMES) {
		const configPath = getUserPath(ctx, "opencode", filename);
		if (configPath) sources.push({ path: configPath, level: "user" });
	}
	for (const filename of CONFIG_FILENAMES) {
		sources.push({ path: path.join(ctx.cwd, filename), level: "project" });
	}
	for (const filename of CONFIG_FILENAMES) {
		const configPath = getProjectPath(ctx, "opencode", filename);
		if (configPath) sources.push({ path: configPath, level: "project" });
	}
	return sources;
}

// =============================================================================
// Context Files (AGENTS.md)
// =============================================================================

async function loadContextFiles(ctx: LoadContext): Promise<LoadResult<ContextFile>> {
	const items: ContextFile[] = [];
	const warnings: string[] = [];

	// User-level only: ~/.config/opencode/AGENTS.md
	const userAgentsMd = getUserPath(ctx, "opencode", "AGENTS.md");
	if (userAgentsMd) {
		const content = await readFile(userAgentsMd);
		if (content) {
			items.push({
				path: userAgentsMd,
				content,
				level: "user",
				_source: createSourceMeta(PROVIDER_ID, userAgentsMd, "user"),
			});
		}
	}

	return { items, warnings };
}

// =============================================================================
// MCP Servers (opencode.json/opencode.jsonc → mcp)
// =============================================================================

/** OpenCode MCP server config (from the "mcp" key) */
interface OpenCodeMCPConfig {
	type?: "local" | "remote";
	command?: string | string[];
	args?: string[];
	env?: Record<string, string>;
	environment?: Record<string, string>;
	url?: string;
	headers?: Record<string, string>;
	enabled?: boolean;
	timeout?: number;
	oauth?: {
		clientId?: string;
		clientSecret?: string;
		scope?: string;
		callbackPort?: number;
		redirectUri?: string;
	};
}

function stringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	for (const item of value) {
		if (typeof item !== "string") return undefined;
	}
	return value;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;

	const record: Record<string, string> = {};
	for (const [key, item] of Object.entries(value)) {
		if (typeof item !== "string") return undefined;
		record[key] = item;
	}
	return record;
}

function normalizeOAuth(value: unknown): MCPServer["oauth"] | undefined {
	if (!isRecord(value)) return undefined;

	const oauth = {
		clientId: typeof value.clientId === "string" ? value.clientId : undefined,
		clientSecret: typeof value.clientSecret === "string" ? value.clientSecret : undefined,
		scope: typeof value.scope === "string" ? value.scope : undefined,
		callbackPort: typeof value.callbackPort === "number" ? value.callbackPort : undefined,
		redirectUri: typeof value.redirectUri === "string" ? value.redirectUri : undefined,
	};
	return Object.values(oauth).some(item => item !== undefined) ? oauth : undefined;
}

function normalizeCommand(
	commandValue: string | string[] | undefined,
	argsValue: unknown,
): { command: string | undefined; args: string[] | undefined } {
	const configuredArgs = stringArray(argsValue);
	if (Array.isArray(commandValue)) {
		const [command, ...commandArgs] = commandValue;
		const args = configuredArgs ? [...commandArgs, ...configuredArgs] : commandArgs;
		return {
			command: typeof command === "string" ? command : undefined,
			args: args.length > 0 ? args : undefined,
		};
	}

	return {
		command: typeof commandValue === "string" ? commandValue : undefined,
		args: configuredArgs && configuredArgs.length > 0 ? configuredArgs : undefined,
	};
}

async function loadMCPServers(ctx: LoadContext): Promise<LoadResult<MCPServer>> {
	const warnings: string[] = [];

	// Deep-merge each server across config layers in ascending precedence, the
	// way OpenCode itself merges configs, so a partial higher-precedence override
	// (e.g. project opencode.jsonc setting only mcp.<name>.timeout) inherits the
	// command/url from lower-precedence layers instead of shadowing the complete
	// definition and being rejected by mcpCapability.validate.
	const mergedByName = new Map<string, Record<string, unknown>>();
	const sourceByName = new Map<string, OpenCodeConfigSource>();

	for (const source of getConfigSources(ctx)) {
		const config = await loadJsonConfig(source.path, configPath => {
			logger.warn("Failed to parse OpenCode config", { path: configPath });
		});
		if (!config || !isRecord(config.mcp)) continue;

		for (const name in config.mcp) {
			const raw = config.mcp[name];
			if (!isRecord(raw)) {
				warnings.push(`Invalid MCP config for "${name}" in ${source.path}`);
				continue;
			}
			const previous = mergedByName.get(name);
			mergedByName.set(name, previous ? mergeConfigRecords(previous, raw) : raw);
			sourceByName.set(name, source);
		}
	}

	const items: MCPServer[] = [];
	for (const [name, config] of mergedByName) {
		const serverConfig = config as OpenCodeMCPConfig;
		const source = sourceByName.get(name)!;
		items.push(buildMCPServer(name, serverConfig, source));
	}

	return { items, warnings };
}

/** Deep-merge two OpenCode config records; `override` wins, nested records recurse. */
function mergeConfigRecords(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = { ...base };
	for (const key in override) {
		const value = override[key];
		const existing = result[key];
		result[key] = isRecord(existing) && isRecord(value) ? mergeConfigRecords(existing, value) : value;
	}
	return result;
}

/** Translate one merged OpenCode MCP entry into the canonical MCPServer shape. */
function buildMCPServer(name: string, serverConfig: OpenCodeMCPConfig, source: OpenCodeConfigSource): MCPServer {
	// Determine transport from OpenCode's "type" field
	let transport: "stdio" | "sse" | "http" | undefined;
	if (serverConfig.type === "local") {
		transport = "stdio";
	} else if (serverConfig.type === "remote") {
		transport = "http";
	} else if (serverConfig.url) {
		transport = "http";
	} else if (serverConfig.command) {
		transport = "stdio";
	}

	const command = normalizeCommand(serverConfig.command, serverConfig.args);
	const env = stringRecord(serverConfig.environment) ?? stringRecord(serverConfig.env);

	return {
		name,
		command: command.command,
		args: command.args,
		env,
		url: typeof serverConfig.url === "string" ? serverConfig.url : undefined,
		headers: serverConfig.headers && typeof serverConfig.headers === "object" ? serverConfig.headers : undefined,
		enabled: serverConfig.enabled,
		timeout: typeof serverConfig.timeout === "number" ? serverConfig.timeout : undefined,
		oauth: normalizeOAuth(serverConfig.oauth),
		transport,
		_source: createSourceMeta(PROVIDER_ID, source.path, source.level),
	};
}

// =============================================================================
// Skills (skills/)
// =============================================================================

async function loadSkills(ctx: LoadContext): Promise<LoadResult<Skill>> {
	const userSkillsDir = getUserPath(ctx, "opencode", "skills");
	const projectSkillsDir = getProjectPath(ctx, "opencode", "skills");

	const promises: Promise<LoadResult<Skill>>[] = [];

	if (userSkillsDir) {
		promises.push(
			scanSkillsFromDir(ctx, {
				dir: userSkillsDir,
				providerId: PROVIDER_ID,
				level: "user",
			}),
		);
	}

	if (projectSkillsDir) {
		promises.push(
			scanSkillsFromDir(ctx, {
				dir: projectSkillsDir,
				providerId: PROVIDER_ID,
				level: "project",
			}),
		);
	}

	const results = await Promise.all(promises);
	const items = results.flatMap(r => r.items);
	const warnings = results.flatMap(r => r.warnings || []);

	return { items, warnings };
}

// =============================================================================
// Extension Modules (plugins/)
// =============================================================================

async function loadExtensionModules(ctx: LoadContext): Promise<LoadResult<ExtensionModule>> {
	const userPluginsDir = getUserPath(ctx, "opencode", "plugins");
	const projectPluginsDir = getProjectPath(ctx, "opencode", "plugins");

	const [userPaths, projectPaths] = await Promise.all([
		userPluginsDir ? discoverExtensionModulePaths(ctx, userPluginsDir) : Promise.resolve([]),
		projectPluginsDir ? discoverExtensionModulePaths(ctx, projectPluginsDir) : Promise.resolve([]),
	]);

	const items = buildExtensionModuleItems(PROVIDER_ID, userPaths, projectPaths);

	return { items, warnings: [] };
}

// =============================================================================
// Slash Commands (commands/)
// =============================================================================

/**
 * Read the OpenCode command-loading toggles from settings.
 * Falls back to true (current behavior) when settings are not initialized,
 * e.g. inside discovery unit tests that run without Settings.init().
 */
function readOpencodeCommandToggles(): { enableUser: boolean; enableProject: boolean } {
	try {
		return {
			enableUser: settings.get("commands.enableOpencodeUser") === true,
			enableProject: settings.get("commands.enableOpencodeProject") ?? true,
		};
	} catch {
		return { enableUser: false, enableProject: true };
	}
}

async function loadSlashCommands(ctx: LoadContext): Promise<LoadResult<SlashCommand>> {
	const { enableUser, enableProject } = readOpencodeCommandToggles();
	// The legacy commands toggle is a commands-only opt-in for ~/.config/opencode.
	const userCommandsDir = enableUser
		? resolveUserPath(ctx, "opencode", "commands")
		: getUserPath(ctx, "opencode", "commands");
	const projectCommandsDir = enableProject ? getProjectPath(ctx, "opencode", "commands") : null;

	const transformCommand =
		(level: "user" | "project") => (name: string, content: string, filePath: string, source: SourceMeta) => {
			const { frontmatter, body } = parseFrontmatter(content, { source: filePath });
			const commandName = frontmatter.name || name.replace(/\.md$/, "");
			return {
				name: String(commandName),
				path: filePath,
				content: body,
				...slashCommandFrontmatterDisplay(frontmatter),
				level,
				_source: source,
			};
		};

	const promises: Promise<LoadResult<SlashCommand>>[] = [];

	if (userCommandsDir) {
		promises.push(
			loadFilesFromDir(ctx, userCommandsDir, PROVIDER_ID, "user", {
				extensions: ["md"],
				transform: transformCommand("user"),
			}),
		);
	}

	if (projectCommandsDir) {
		promises.push(
			loadFilesFromDir(ctx, projectCommandsDir, PROVIDER_ID, "project", {
				extensions: ["md"],
				transform: transformCommand("project"),
			}),
		);
	}

	const results = await Promise.all(promises);
	const items = results.flatMap(r => r.items);
	const warnings = results.flatMap(r => r.warnings || []);

	return { items, warnings };
}

// =============================================================================
// Settings (opencode.json/opencode.jsonc)
// =============================================================================

async function loadSettings(ctx: LoadContext): Promise<LoadResult<Settings>> {
	const items: Settings[] = [];
	const warnings: string[] = [];

	for (const source of getConfigSources(ctx)) {
		const parsed = await loadJsonConfig(source.path, configPath => {
			warnings.push(`Invalid JSON in ${configPath}`);
		});
		if (!parsed) continue;

		items.push({
			path: source.path,
			data: parsed,
			level: source.level,
			_source: createSourceMeta(PROVIDER_ID, source.path, source.level),
		});
	}

	return { items, warnings };
}

// =============================================================================
// Provider Registration
// =============================================================================

registerProvider(contextFileCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load AGENTS.md from ~/.config/opencode/",
	priority: PRIORITY,
	load: loadContextFiles,
});

registerProvider(mcpCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load MCP servers from OpenCode config files",
	priority: PRIORITY,
	load: loadMCPServers,
});

registerProvider(skillCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load skills from ~/.config/opencode/skills/ and .opencode/skills/",
	priority: PRIORITY,
	load: loadSkills,
});

registerProvider(extensionModuleCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load extension modules from ~/.config/opencode/plugins/ and .opencode/plugins/",
	priority: PRIORITY,
	load: loadExtensionModules,
});

registerProvider(slashCommandCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load slash commands from ~/.config/opencode/commands/ and .opencode/commands/",
	priority: PRIORITY,
	load: loadSlashCommands,
});

registerProvider(settingsCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load settings from OpenCode config files",
	priority: PRIORITY,
	load: loadSettings,
});
