/**
 * Claude Code Marketplace Plugin Provider
 *
 * Loads configuration from ~/.claude/plugins/cache/ based on installed_plugins.json registry.
 * Priority: 70 (below claude.ts at 80, so user overrides in .claude/ take precedence)
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { isUserSourceEnabled, registerProvider } from "../capability";
import { readFile } from "../capability/fs";
import { type Hook, hookCapability } from "../capability/hook";
import { type MCPServer, mcpCapability } from "../capability/mcp";
import { type Rule, ruleCapability } from "../capability/rule";
import { type Skill, skillCapability } from "../capability/skill";
import { type SlashCommand, slashCommandCapability } from "../capability/slash-command";
import { type CustomTool, toolCapability } from "../capability/tool";
import type { LoadContext, LoadResult } from "../capability/types";
import { legacyProviderAllowed } from "./agent-plugin-format";
import { realpathIfExists } from "./contained-path";
import {
	discoverRuleFromMarkdown,
	type ClaudePluginRoot,
	createSourceMeta,
	expandEnvVarsDeep,
	listClaudePluginRoots,
	loadFilesFromDir,
	scanSkillsFromDir,
} from "./helpers";

import { resolvePluginStdioPaths, substitutePluginRoot } from "./substitute-plugin-root";

const PROVIDER_ID = "claude-plugins";
const DISPLAY_NAME = "Claude Code Marketplace";
const PRIORITY = 70; // Below claude.ts (80) so user .claude/ overrides win

/**
 * Plugin roots this legacy provider may process for a given surface. Roots
 * whose root `plugin.json` targets the Agent Plugins standard keep their
 * portable components (skills, MCP) exclusive to the `agent-plugins` provider;
 * fatally invalid Agent Plugins packages are skipped entirely.
 */
async function allowedRoots(
	ctx: LoadContext,
	surface: "skills" | "mcp" | "other",
): Promise<{ roots: ClaudePluginRoot[]; warnings: string[] }> {
	const { roots, warnings } = await listClaudePluginRoots(ctx.home, ctx.cwd);
	const userEnabled = isUserSourceEnabled("claude-plugins", ctx) || isUserSourceEnabled("claude", ctx);
	const scopedRoots = userEnabled ? roots : roots.filter(root => root.scope === "project" || root.origin !== "claude");
	const flags = await Promise.all(scopedRoots.map(root => legacyProviderAllowed(root.path, surface)));
	return { roots: scopedRoots.filter((_, i) => flags[i]), warnings };
}

interface ClaudePluginManifest {
	skills?: string | string[];
	"slash-commands"?: string | string[];
	commands?: string | string[];
}

interface ResolvedPluginDir {
	dirs: string[];
	warnings: string[];
	/**
	 * Dirs that came from a manifest declaration (rather than the
	 * conventional fallback). A declared entry may point directly at a
	 * single skill directory, so skill scans treat its own `SKILL.md` as a
	 * leaf boundary; the fallback collection root never is.
	 */
	declaredDirs: Set<string>;
}

interface ResolvePluginDirOptions {
	manifestKeys: ReadonlyArray<keyof ClaudePluginManifest>;
	fallback: string;
	includeFallback: boolean;
	marketplaceRootManifest?: ClaudePluginManifest | null;
}

interface ResolvedMCPConfig {
	/** On-disk config file to read, or null when servers are inline or nothing applies. */
	path: string | null;
	/** Server map declared inline in the plugin manifest, or null when the source is a file. */
	inlineServers: Record<string, unknown> | null;
	/** Path recorded as each discovered server's capability source. */
	sourcePath: string;
	/** Directory that relative stdio `command`/`cwd` values resolve against. */
	baseDir: string;
	/** True when a plugin manifest named this source, false for the conventional fallback. */
	declared: boolean;
	warnings: string[];
}

async function readPluginManifest(root: ClaudePluginRoot): Promise<ClaudePluginManifest | null> {
	const manifestPath = path.join(root.path, ".claude-plugin", "plugin.json");
	const raw = await readFile(manifestPath);
	if (raw === null) return null;

	try {
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		return parsed as ClaudePluginManifest;
	} catch {
		return null;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Env maps must hold only string values; anything else is malformed. */
function isStringRecord(value: unknown): value is Record<string, string> {
	return isRecord(value) && Object.values(value).every(v => typeof v === "string");
}

async function readMarketplaceRootManifest(root: ClaudePluginRoot): Promise<ClaudePluginManifest | null> {
	const catalogs = await Promise.all(
		[
			path.join(root.path, "marketplace.json"),
			path.join(root.path, ".omp-plugin", "marketplace.json"),
			path.join(root.path, ".claude-plugin", "marketplace.json"),
		].map(catalogPath => readFile(catalogPath)),
	);

	for (const raw of catalogs) {
		if (raw === null) continue;
		try {
			const parsed: unknown = JSON.parse(raw);
			if (!isRecord(parsed) || !Array.isArray(parsed.plugins)) continue;
			const entry = parsed.plugins.find(
				candidate => isRecord(candidate) && candidate.name === root.plugin && candidate.source === "./",
			);
			if (!isRecord(entry)) continue;

			if (typeof entry.skills === "string") return { skills: entry.skills };
			if (Array.isArray(entry.skills)) {
				return { skills: entry.skills.filter((value): value is string => typeof value === "string") };
			}
			return {};
		} catch {
			continue;
		}
	}
	return null;
}

function isWithinPluginRoot(rootPath: string, targetPath: string): boolean {
	const relative = path.relative(rootPath, targetPath);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Resolve manifest-declared component paths within a plugin root.
 *
 * Manifest path fields may be `string` or `string[]`
 * (https://code.claude.com/docs/en/plugins-reference#path-behavior-rules).
 * The first populated key wins within each manifest, preserving the
 * `commands` > `slash-commands` legacy fallback.
 *
 * Skills normally add to the default `skills/` directory. For a marketplace
 * entry whose source is the marketplace root, its listed skill paths and any
 * plugin-manifest paths are the complete selection, so the shared root
 * `skills/` directory is not scanned. If neither manifest declares a matching
 * path, the conventional fallback is still used.
 */
async function resolvePluginDir(root: ClaudePluginRoot, options: ResolvePluginDirOptions): Promise<ResolvedPluginDir> {
	const pluginManifest = await readPluginManifest(root);
	const manifests = options.marketplaceRootManifest
		? [pluginManifest, options.marketplaceRootManifest]
		: [pluginManifest];
	const fallbackDir = path.join(root.path, options.fallback);
	const configured: Array<{ entryPath: string; key: keyof ClaudePluginManifest }> = [];

	for (const manifest of manifests) {
		if (manifest === null) continue;
		for (const key of options.manifestKeys) {
			const val = manifest[key];
			const candidates: string[] = [];
			if (typeof val === "string") {
				const trimmed = val.trim();
				if (trimmed) candidates.push(trimmed);
			} else if (Array.isArray(val)) {
				for (const entry of val) {
					if (typeof entry !== "string") continue;
					const trimmed = entry.trim();
					if (trimmed) candidates.push(trimmed);
				}
			}
			if (candidates.length > 0) {
				configured.push(...candidates.map(entryPath => ({ entryPath, key })));
				break;
			}
		}
	}

	if (configured.length === 0) {
		return { dirs: [fallbackDir], warnings: [], declaredDirs: new Set() };
	}

	const seen = new Set<string>();
	const dirs: string[] = [];
	const warnings: string[] = [];
	const declaredDirs = new Set<string>();
	if (options.includeFallback && !options.marketplaceRootManifest) {
		seen.add(fallbackDir);
		dirs.push(fallbackDir);
	}
	for (const { entryPath, key } of configured) {
		const resolved = path.resolve(root.path, entryPath);
		if (!isWithinPluginRoot(root.path, resolved)) {
			warnings.push(
				`[claude-plugins] Ignoring ${String(key)} path outside plugin root for ${root.id}: ${entryPath}`,
			);
			continue;
		}
		if (seen.has(resolved)) continue;
		seen.add(resolved);
		dirs.push(resolved);
		declaredDirs.add(resolved);
	}

	return { dirs, warnings, declaredDirs };
}

// =============================================================================
// Skills
// =============================================================================

async function loadSkills(ctx: LoadContext): Promise<LoadResult<Skill>> {
	const items: Skill[] = [];
	const warnings: string[] = [];
	const { roots, warnings: rootWarnings } = await allowedRoots(ctx, "skills");
	warnings.push(...rootWarnings);
	const results = await Promise.all(
		roots.map(async root => {
			const marketplaceRootManifest = await readMarketplaceRootManifest(root);
			const {
				dirs: skillsDirs,
				warnings: resolveWarnings,
				declaredDirs,
			} = await resolvePluginDir(root, {
				manifestKeys: ["skills"],
				fallback: "skills",
				includeFallback: true,
				marketplaceRootManifest,
			});
			// §4.1 containment for candidates below the resolved dirs: a
			// symlinked child inside a declared directory must not pull in
			// skills from outside the plugin package.
			const realRoot = await realpathIfExists(root.path);
			const scanResults = await Promise.all(
				skillsDirs.map(dir =>
					scanSkillsFromDir(ctx, {
						dir,
						providerId: PROVIDER_ID,
						level: root.scope,
						includeSelf: true,
						origin: root.origin,
						// Only a manifest-DECLARED entry may be an individual skill
						// leaf; the conventional `skills/` collection keeps loading a
						// root SKILL.md alongside its children.
						selfIsBoundary: declaredDirs.has(dir),
						containWithin: realRoot ?? undefined,
					}),
				),
			);
			return { scanResults, resolveWarnings };
		}),
	);
	for (const { scanResults, resolveWarnings } of results) {
		warnings.push(...resolveWarnings);
		// Intentionally do NOT prefix skill names with `root.plugin`.
		// The `plugin:name` format breaks skill:// URL parsing (colons are
		// ambiguous with port separators) and is unintuitive for callers.
		// Dedup-by-key in the capability layer already handles name collisions
		// across providers using priority ordering.
		for (const result of scanResults) {
			items.push(...result.items);
			if (result.warnings) warnings.push(...result.warnings);
		}
	}
	return { items, warnings };
}

// =============================================================================
// Rules
// =============================================================================

async function loadRules(ctx: LoadContext): Promise<LoadResult<Rule>> {
	const { roots, warnings: rootWarnings } = await allowedRoots(ctx, "other");
	const warnings = [...rootWarnings];
	const results = await Promise.all(
		roots.map(root =>
			loadFilesFromDir<Rule>(ctx, path.join(root.path, "rules"), PROVIDER_ID, root.scope, {
				extensions: ["md", "mdc"],
				transform: (name, content, filePath, source) =>
					discoverRuleFromMarkdown(name, content, filePath, source, { stripNamePattern: /\.(md|mdc)$/ }),
			}),
		),
	);
	const items: Rule[] = [];
	for (const result of results) {
		items.push(...result.items);
		if (result.warnings) warnings.push(...result.warnings);
	}
	return { items, warnings };
}

// =============================================================================
// Slash Commands
// =============================================================================

async function loadSlashCommands(ctx: LoadContext): Promise<LoadResult<SlashCommand>> {
	const items: SlashCommand[] = [];
	const warnings: string[] = [];

	const { roots, warnings: rootWarnings } = await allowedRoots(ctx, "other");
	warnings.push(...rootWarnings);

	const results = await Promise.all(
		roots.map(async root => {
			const { dirs: commandsDirs, warnings: resolveWarnings } = await resolvePluginDir(root, {
				manifestKeys: ["commands", "slash-commands"],
				fallback: "commands",
				includeFallback: false,
			});
			const commandResults = await Promise.all(
				commandsDirs.map(async dir => {
					try {
						const stats = await fs.stat(dir);
						if (stats.isFile()) {
							if (path.extname(dir) !== ".md") return { items: [], warnings: [] };
							const content = await readFile(dir);
							if (content === null) return { items: [], warnings: [`Failed to read file: ${dir}`] };
							const cmdName = path.basename(dir).replace(/\.md$/, "");
							return {
								items: [
									{
										name: root.plugin ? `${root.plugin}:${cmdName}` : cmdName,
										path: dir,
										content,
										level: root.scope,
										_source: createSourceMeta(PROVIDER_ID, dir, root.scope),
									},
								],
								warnings: [],
							};
						}
					} catch {
						// Missing entries behave like missing directories: no items, no warning.
					}
					return loadFilesFromDir<SlashCommand>(ctx, dir, PROVIDER_ID, root.scope, {
						extensions: ["md"],
						transform: (name, content, filePath, source) => {
							const cmdName = name.replace(/\.md$/, "");
							return {
								name: root.plugin ? `${root.plugin}:${cmdName}` : cmdName,
								path: filePath,
								content,
								level: root.scope,
								_source: source,
							};
						},
					});
				}),
			);
			return { commandResults, resolveWarnings };
		}),
	);

	for (const { commandResults, resolveWarnings } of results) {
		warnings.push(...resolveWarnings);
		for (const commandResult of commandResults) {
			items.push(...commandResult.items);
			if (commandResult.warnings) warnings.push(...commandResult.warnings);
		}
	}

	return { items, warnings };
}

// =============================================================================
// Hooks
// =============================================================================

async function loadHooks(ctx: LoadContext): Promise<LoadResult<Hook>> {
	const items: Hook[] = [];
	const warnings: string[] = [];

	const { roots, warnings: rootWarnings } = await allowedRoots(ctx, "other");
	warnings.push(...rootWarnings);

	const hookTypes = ["pre", "post"] as const;

	const loadTasks: { root: ClaudePluginRoot; hookType: "pre" | "post" }[] = [];
	for (const root of roots) {
		for (const hookType of hookTypes) {
			loadTasks.push({ root, hookType });
		}
	}

	const results = await Promise.all(
		loadTasks.map(async ({ root, hookType }) => {
			const hooksDir = path.join(root.path, "hooks", hookType);
			return loadFilesFromDir<Hook>(ctx, hooksDir, PROVIDER_ID, root.scope, {
				transform: (name, _content, filePath, source) => {
					const toolName = name.replace(/\.(sh|bash|zsh|fish)$/, "");
					return {
						name,
						path: filePath,
						type: hookType,
						tool: toolName,
						level: root.scope,
						_source: source,
					};
				},
			});
		}),
	);

	for (const result of results) {
		items.push(...result.items);
		if (result.warnings) warnings.push(...result.warnings);
	}

	return { items, warnings };
}

// =============================================================================
// Custom Tools
// =============================================================================

async function loadTools(ctx: LoadContext): Promise<LoadResult<CustomTool>> {
	const items: CustomTool[] = [];
	const warnings: string[] = [];

	const { roots, warnings: rootWarnings } = await allowedRoots(ctx, "other");
	warnings.push(...rootWarnings);

	const results = await Promise.all(
		roots.map(async root => {
			const toolsDir = path.join(root.path, "tools");
			return loadFilesFromDir<CustomTool>(ctx, toolsDir, PROVIDER_ID, root.scope, {
				extensions: ["ts", "js"],
				transform: (name, _content, filePath, source) => {
					const toolName = name.replace(/\.(ts|js)$/, "");
					return {
						name: toolName,
						path: filePath,
						description: `${toolName} custom tool`,
						level: root.scope,
						_source: source,
					};
				},
			});
		}),
	);

	for (const result of results) {
		items.push(...result.items);
		if (result.warnings) warnings.push(...result.warnings);
	}

	return { items, warnings };
}

// =============================================================================
// MCP Servers
// =============================================================================

/**
 * Unwrap a parsed MCP config file to its server map. Supports the nested
 * `{ mcpServers: { … } }` project shape and the flat `{ name: cfg, … }`
 * marketplace-plugin shape. Returns null when a `mcpServers` field is present
 * but not an object map (malformed) so the caller skips the file.
 */
function extractServerMap(obj: Record<string, unknown>): Record<string, unknown> | null {
	if (isRecord(obj.mcpServers)) return obj.mcpServers;
	if (!("mcpServers" in obj)) return obj;
	return null;
}

/**
 * Resolve where a plugin's MCP servers come from, honoring the manifest's
 * `mcpServers` field before the conventional root `.mcp.json`.
 *
 * `.omp-plugin/plugin.json` takes precedence over `.claude-plugin/plugin.json`.
 * The field may be an inline object (the server map itself) or a string path to
 * a config file within the plugin root; a path escaping the root is rejected
 * with a warning. When no manifest declares the field, `<root>/.mcp.json` is the
 * fallback source.
 */
async function resolvePluginMCPConfig(root: ClaudePluginRoot): Promise<ResolvedMCPConfig> {
	const fallback = path.join(root.path, ".mcp.json");
	for (const manifestDir of [".omp-plugin", ".claude-plugin"]) {
		const manifestPath = path.join(root.path, manifestDir, "plugin.json");
		const raw = await readFile(manifestPath);
		if (raw === null) continue;

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			continue;
		}
		if (!isRecord(parsed)) continue;
		const pointer = parsed.mcpServers;

		// Inline object form: the manifest value is the server map itself, rooted
		// at the plugin directory (Claude's ${CLAUDE_PLUGIN_ROOT} base).
		if (isRecord(pointer)) {
			return {
				path: null,
				inlineServers: pointer,
				sourcePath: manifestPath,
				baseDir: root.path,
				declared: true,
				warnings: [],
			};
		}

		// File-pointer form: resolve the named config file within the plugin root.
		if (typeof pointer === "string") {
			const configured = pointer.trim();
			if (configured.length === 0) continue;
			const resolved = path.resolve(root.path, configured);
			if (!isWithinPluginRoot(root.path, resolved)) {
				return {
					path: null,
					inlineServers: null,
					sourcePath: manifestPath,
					baseDir: root.path,
					declared: true,
					warnings: [
						`[claude-plugins] Ignoring mcpServers path outside plugin root for ${root.id}: ${configured}`,
					],
				};
			}
			return {
				path: resolved,
				inlineServers: null,
				sourcePath: resolved,
				baseDir: path.dirname(resolved),
				declared: true,
				warnings: [],
			};
		}
	}

	return {
		path: fallback,
		inlineServers: null,
		sourcePath: fallback,
		baseDir: path.dirname(fallback),
		declared: false,
		warnings: [],
	};
}

/**
 * Split a marketplace stdio env map into final values and legacy values.
 *
 * `${VAR}`/`${VAR:-default}` placeholders (and `${CLAUDE_PLUGIN_ROOT}` /
 * `${OMP_PLUGIN_ROOT}`) are expanded here and recorded as literal keys: the
 * result is final package data and must never be reinterpreted later as a
 * bare env name or `!command` (a second resolution would execute expanded
 * values or substitute ambient variables). Values that contained no
 * placeholder keep the legacy indirection (bare env-name lookup and
 * `!command` execution) unresolved, so it only runs when the surviving
 * enabled server is actually connected.
 */
async function resolveMarketplaceEnv(
	env: Record<string, string>,
	rootPath: string,
): Promise<{ env: Record<string, string>; literalKeys: string[] }> {
	// Null prototype: a `__proto__` env key must become an own property, not
	// mutate the prototype chain (it would silently vanish before spawn).
	const resolved: Record<string, string> = Object.create(null);
	const literalKeys: string[] = [];
	for (const [key, rawValue] of Object.entries(env)) {
		// Feed the reserved plugin-root names through extraEnv: expansion then
		// cannot consume an ambient CLAUDE_PLUGIN_ROOT/OMP_PLUGIN_ROOT, and
		// the registered root inserted as the value is never re-scanned
		// for `${...}`.
		const final = expandEnvVarsDeep(rawValue, {
			CLAUDE_PLUGIN_ROOT: rootPath,
			OMP_PLUGIN_ROOT: rootPath,
		}) as string;
		if (final !== rawValue) literalKeys.push(key);
		resolved[key] = final;
	}
	return { env: resolved, literalKeys };
}

async function loadMCPServers(ctx: LoadContext): Promise<LoadResult<MCPServer>> {
	const items: MCPServer[] = [];
	const warnings: string[] = [];

	const { roots, warnings: rootWarnings } = await allowedRoots(ctx, "mcp");
	warnings.push(...rootWarnings);

	for (const root of roots) {
		const resolved = await resolvePluginMCPConfig(root);
		warnings.push(...resolved.warnings);

		let servers: Record<string, unknown> | null;
		if (resolved.inlineServers) {
			servers = resolved.inlineServers;
		} else if (resolved.path !== null) {
			const raw = await readFile(resolved.path);
			if (raw === null) {
				// The conventional fallback is optional, but a manifest that names a
				// missing file is an authoring error that would otherwise register
				// zero servers with no explanation.
				if (resolved.declared) {
					const warning = `[claude-plugins] Missing mcpServers file declared by ${root.id}: ${resolved.path}`;
					warnings.push(warning);
					logger.warn(warning);
				}
				continue;
			}

			let parsed: unknown;
			try {
				parsed = JSON.parse(raw);
			} catch {
				warnings.push(`[claude-plugins] Invalid JSON in ${resolved.path}`);
				logger.warn(`[claude-plugins] Invalid JSON in ${resolved.path}`);
				continue;
			}
			// Two file shapes are supported:
			//   nested: { "mcpServers": { name: cfg, ... } }   (OMP/Claude Code project shape)
			//   flat:   { name: cfg, ... }                      (Claude marketplace plugin shape)
			if (!isRecord(parsed)) continue;
			servers = extractServerMap(parsed);
		} else {
			continue;
		}
		if (servers === null) continue;

		const { sourcePath, baseDir } = resolved;
		for (const serverName in servers) {
			const serverCfg = servers[serverName];
			if (!serverCfg || typeof serverCfg !== "object" || Array.isArray(serverCfg)) continue;
			const raw = serverCfg as {
				enabled?: boolean;
				timeout?: number;
				command?: string;
				args?: string[];
				env?: Record<string, string>;
				cwd?: string;
				url?: string;
				headers?: Record<string, string>;
				auth?: MCPServer["auth"];
				oauth?: MCPServer["oauth"];
				type?: string;
			};
			// Require either command (stdio) or url (HTTP/SSE) — Claude marketplace plugins
			// occasionally ship .mcp.json entries with neither, which would register a useless
			// server and surface as a connection error at runtime.
			if (typeof raw.command !== "string" && typeof raw.url !== "string") {
				warnings.push(
					`[claude-plugins] Skipping MCP server "${serverName}" in ${sourcePath}: missing command or url`,
				);
				continue;
			}
			const namespacedName = root.plugin ? `${root.plugin}:${serverName}` : serverName;
			const substitutedCommand =
				raw.command !== undefined ? substitutePluginRoot(raw.command, root.path) : undefined;
			const substitutedCwd = raw.cwd !== undefined ? substitutePluginRoot(raw.cwd, root.path) : undefined;
			// Root relative command/cwd at the plugin's config directory, not the
			// session cwd (MCP stdio spawning resolves relative values there).
			const rooted = resolvePluginStdioPaths({ command: substitutedCommand, cwd: substitutedCwd }, baseDir);
			// Malformed env (e.g. `"env": null` in a hand-edited marketplace JSON)
			// must not throw inside resolveMarketplaceEnv: the capability loader
			// catches at provider scope and would discard every marketplace
			// server, not just this entry.
			if (raw.env !== undefined && !isStringRecord(raw.env)) {
				warnings.push(`[claude-plugins] Skipping MCP server "${serverName}" in ${sourcePath}: malformed env`);
				continue;
			}
			const resolvedEnv = raw.env !== undefined ? await resolveMarketplaceEnv(raw.env, root.path) : undefined;
			const server: MCPServer = {
				name: namespacedName,
				...(raw.enabled !== undefined && { enabled: raw.enabled }),
				...(raw.timeout !== undefined && { timeout: raw.timeout }),
				...(rooted.command !== undefined && { command: rooted.command }),
				...(raw.args !== undefined && { args: substitutePluginRoot(raw.args, root.path) }),
				...(resolvedEnv !== undefined && { env: resolvedEnv.env }),
				// Placeholder-expanded keys are final package data (literal);
				// raw values keep legacy indirection, resolved by
				// #resolveAuthConfig only when the server connects.
				...(resolvedEnv !== undefined &&
					resolvedEnv.literalKeys.length > 0 && {
						envLiteralKeys: resolvedEnv.literalKeys,
					}),
				...(rooted.cwd !== undefined && { cwd: rooted.cwd }),
				...(raw.url !== undefined && { url: expandEnvVarsDeep(raw.url) }),
				...(raw.headers !== undefined && { headers: expandEnvVarsDeep(raw.headers) }),
				...(raw.auth !== undefined && { auth: raw.auth }),
				...(raw.oauth !== undefined && { oauth: raw.oauth }),
				...(raw.type !== undefined && { transport: raw.type as MCPServer["transport"] }),
				_source: createSourceMeta(PROVIDER_ID, sourcePath, root.scope),
			};
			items.push(server);
		}
	}

	return { items, warnings };
}

// =============================================================================
// Provider Registration
// =============================================================================

registerProvider<Skill>(skillCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load skills from Claude Code marketplace plugins (~/.claude/plugins/cache/)",
	priority: PRIORITY,
	load: loadSkills,
});

registerProvider<Rule>(ruleCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load rules from marketplace plugin rules directories",
	priority: PRIORITY,
	load: loadRules,
});

registerProvider<SlashCommand>(slashCommandCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load slash commands from Claude Code marketplace plugins",
	priority: PRIORITY,
	load: loadSlashCommands,
});

registerProvider<Hook>(hookCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load hooks from Claude Code marketplace plugins",
	priority: PRIORITY,
	load: loadHooks,
});

registerProvider<CustomTool>(toolCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load custom tools from Claude Code marketplace plugins",
	priority: PRIORITY,
	load: loadTools,
});

registerProvider<MCPServer>(mcpCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load MCP servers from marketplace plugin .mcp.json files",
	priority: PRIORITY,
	load: loadMCPServers,
});
