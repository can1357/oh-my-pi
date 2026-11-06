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
import { type SlashCommand, slashCommandCapability } from "../capability/slash-command";
import { slashCommandFrontmatterDisplay } from "@oh-my-pi/pi-tui/overlays/extensions/inspector-model";
import type { LoadContext, LoadResult, SourceMeta } from "../capability/types";
import { settings } from "../config/settings";
import { asWrittenLiteral, asWrittenSubstitution } from "../mcp/as-written";

import {
	buildExtensionModuleItems,
	createSourceMeta,
	discoverExtensionModulePaths,
	getProjectPath,
	getUserPath,
	loadFilesFromDir,
	parseMcpBooleanField,
	resolveUserPath,
	scanSkillsFromDir,
	withMcpAsWritten,
} from "./helpers";

import { cfgCommandsEnableOpencodeProject, cfgCommandsEnableOpencodeUser } from "../extensibility/settings";

const PROVIDER_ID = "opencode";
const DISPLAY_NAME = "OpenCode";
const PRIORITY = 55;
const CONFIG_FILENAMES = ["opencode.json", "opencode.jsonc"] as const;

interface OpenCodeConfigSource {
	path: string;
	level: "user" | "project";
}

/** One `{env:...}`/`{file:...}` reference, as a span of the config file's text. */
interface ConfigReference {
	start: number;
	end: number;
	token: string;
}

/** A loaded OpenCode config: the effective value, and how the file wrote it. */
interface OpenCodeConfig {
	config: Record<string, unknown>;
	/** `null` when the file has no parsed shape of its own; see {@link loadOpenCodeConfig}. */
	asWritten: Record<string, unknown> | null;
}

// =============================================================================
// JSON Config Loading
// =============================================================================

/**
 * OpenCode's config references, as spans of the raw config text.
 *
 * OpenCode expands `{env:VAR}` (the env value, or an empty string when
 * unset) and `{file:path}` (file contents, trimmed) at load time, before the
 * JSON is parsed — see opencode `packages/opencode/src/config/variable.ts`.
 * OMP loads the same config files, so it MUST honor the same syntax; the
 * generic `${VAR}` expansion used elsewhere never matches, leaving a header
 * like `Bearer {env:MCP_KEY}` to reach the MCP server verbatim and 401
 * (#8778). Recognising a reference in the *parsed* value instead would
 * expand what OpenCode does not: `"\u007benv:VAR}"` and `"{env:VAR}"` parse
 * to one string, and only the second is a reference.
 *
 * A reference on a `//` comment line is not one, matching OpenCode. (The
 * line is dropped by the parse either way; the rule is kept so the text and
 * the tree agree about what was replaced.)
 */
function scanConfigReferences(text: string): ConfigReference[] {
	const references: ConfigReference[] = [];
	for (const match of text.matchAll(/\{(?:env|file):[^}]+\}/g)) {
		const start = match.index;
		const lineStart = text.lastIndexOf("\n", start - 1) + 1;
		if (text.slice(lineStart, start).trimStart().startsWith("//")) continue;
		references.push({ start, end: start + match[0].length, token: match[0] });
	}
	return references;
}

/** `text` with each reference replaced by `replacement`. */
function spliceReferences(
	text: string,
	references: readonly ConfigReference[],
	replacement: (index: number) => string,
): string {
	let out = "";
	let cursor = 0;
	for (const [index, reference] of references.entries()) {
		out += text.slice(cursor, reference.start) + replacement(index);
		cursor = reference.end;
	}
	return out + text.slice(cursor);
}

/**
 * What one reference expands to: the variable's value, or the referenced
 * file's trimmed contents. A missing file expands to an empty string
 * (OpenCode's `missing: "empty"` mode) rather than aborting discovery, and
 * `{file:path}` resolves relative to the config file's directory or from a
 * `~`/absolute path.
 */
async function expandReference(token: string, configDir: string, configPath: string): Promise<string> {
	if (token.startsWith("{env:")) return Bun.env[token.slice("{env:".length, -1)] ?? "";
	let filePath = token.slice("{file:".length, -1);
	if (filePath.startsWith("~/")) filePath = path.join(os.homedir(), filePath.slice(2));
	const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(configDir, filePath);
	const fileContent = await readFile(resolved);
	if (fileContent === null) {
		logger.warn("OpenCode config references a missing file", { configPath, path: resolved });
		return "";
	}
	return fileContent.trim();
}

/** `value` with every placeholder rendered by `replacements`, and every other span by `literal`. */
function renderConfig(
	value: unknown,
	nonce: string,
	replacements: readonly string[],
	literal: (text: string) => string,
): unknown {
	if (typeof value === "string") {
		const pieces = value.split(nonce);
		if (pieces.length === 1) return literal(value);
		let out = "";
		for (const [index, piece] of pieces.entries()) {
			out += (index % 2 === 1 ? replacements[Number(piece)] : undefined) ?? literal(piece);
		}
		return out;
	}
	if (Array.isArray(value)) return value.map(item => renderConfig(item, nonce, replacements, literal));
	if (isRecord(value)) {
		const out: Record<string, unknown> = {};
		for (const [key, nested] of Object.entries(value)) {
			out[renderConfig(key, nonce, replacements, literal) as string] = renderConfig(
				nested,
				nonce,
				replacements,
				literal,
			);
		}
		return out;
	}
	return value;
}

/**
 * One OpenCode config file: read once, parsed once, rendered twice.
 *
 * Each reference {@link scanConfigReferences} found is spliced into the text
 * as a placeholder carrying a nonce chosen after the file was read, so the
 * one parse yields a tree in which every span OpenCode's own grammar would
 * replace is marked and nothing in the file can forge one. Walking that tree
 * gives the effective config and the as-written record from the same
 * snapshot and the same structure, so the two cannot disagree about what was
 * substituted or pair different reads of the file. Only then does the record
 * get its encoding, on the parsed strings, like every other provider's
 * (`mcp/as-written.ts`).
 *
 * One OpenCode config cannot be read this way: a reference standing where
 * JSON *syntax* goes rather than inside a string (`"timeout": {env:MS}`),
 * which leaves the file unparseable until it is expanded. That one falls
 * back to expanding the text first, as OpenCode does, and records no written
 * form — the file has no parsed shape of its own to record one against — so
 * such a server is keyed on its effective config.
 */
async function loadOpenCodeConfig(
	configPath: string,
	onInvalid: (configPath: string) => void,
): Promise<OpenCodeConfig | null> {
	const content = await readFile(configPath);
	if (!content) return null;
	const references = scanConfigReferences(content);
	const configDir = path.dirname(configPath);
	const nonce = `omp${crypto.randomUUID().replaceAll("-", "")}`;

	let tree: unknown;
	try {
		tree = JSONC.parse(spliceReferences(content, references, index => `${nonce}${index}${nonce}`));
	} catch {
		return loadExpandedBeforeParse(content, references, configDir, configPath, onInvalid);
	}
	if (!isRecord(tree)) {
		onInvalid(configPath);
		return null;
	}

	const expanded = await Promise.all(references.map(({ token }) => expandReference(token, configDir, configPath)));
	return {
		config: renderConfig(tree, nonce, expanded, text => text) as Record<string, unknown>,
		asWritten: renderConfig(
			tree,
			nonce,
			references.map(({ token }) => asWrittenSubstitution(token)),
			asWrittenLiteral,
		) as Record<string, unknown>,
	};
}

/** The fallback {@link loadOpenCodeConfig} documents: expand the text, then parse it. */
async function loadExpandedBeforeParse(
	content: string,
	references: readonly ConfigReference[],
	configDir: string,
	configPath: string,
	onInvalid: (configPath: string) => void,
): Promise<OpenCodeConfig | null> {
	const expanded = await Promise.all(
		references.map(async ({ token }) => {
			const value = await expandReference(token, configDir, configPath);
			// JSON-escape file contents so multi-line/quoted text stays valid
			// inside the string literal it lands in, as OpenCode does.
			return token.startsWith("{file:") ? JSON.stringify(value).slice(1, -1) : value;
		}),
	);
	let parsed: unknown;
	try {
		parsed = JSONC.parse(spliceReferences(content, references, index => expanded[index]!));
	} catch {
		onInvalid(configPath);
		return null;
	}
	if (!isRecord(parsed)) {
		onInvalid(configPath);
		return null;
	}
	return { config: parsed, asWritten: null };
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
	lazy?: boolean | string;
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
	const asWrittenByName = new Map<string, Record<string, unknown>>();

	for (const source of getConfigSources(ctx)) {
		const loaded = await loadOpenCodeConfig(source.path, configPath => {
			logger.warn("Failed to parse OpenCode config", { path: configPath });
		});
		if (!loaded) continue;
		const { config, asWritten } = loaded;
		if (!isRecord(config.mcp)) continue;

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
		if (asWritten && isRecord(asWritten.mcp)) {
			for (const name in asWritten.mcp) {
				const entry = asWritten.mcp[name];
				if (!isRecord(entry)) continue;
				const previous = asWrittenByName.get(name);
				asWrittenByName.set(name, previous ? mergeConfigRecords(previous, entry) : entry);
			}
		}
	}

	const items: MCPServer[] = [];
	for (const [name, config] of mergedByName) {
		const serverConfig = config as OpenCodeMCPConfig;
		const source = sourceByName.get(name)!;
		items.push(buildMCPServer(name, serverConfig, source, asWrittenByName.get(name)));
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
function buildMCPServer(
	name: string,
	serverConfig: OpenCodeMCPConfig,
	source: OpenCodeConfigSource,
	asWritten?: Record<string, unknown>,
): MCPServer {
	const server = buildMCPServerFields(name, serverConfig, source);
	return asWritten
		? withMcpAsWritten(server, buildMCPServerFields(name, asWritten as OpenCodeMCPConfig, source))
		: server;
}

/** Map one OpenCode config shape after any required variable substitution. */
function buildMCPServerFields(name: string, serverConfig: OpenCodeMCPConfig, source: OpenCodeConfigSource): MCPServer {
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
		lazy: parseMcpBooleanField(serverConfig.lazy),
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
			enableUser: cfgCommandsEnableOpencodeUser.get(settings) === true,
			enableProject: cfgCommandsEnableOpencodeProject.get(settings),
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
				...(frontmatter.side === true ? { side: true } : {}),
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
		const loaded = await loadOpenCodeConfig(source.path, configPath => {
			warnings.push(`Invalid JSON in ${configPath}`);
		});
		const parsed = loaded?.config;
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
