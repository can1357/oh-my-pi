import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ThinkingLevel } from "@pk-nerdsaver-ai/pi-agent-core";
import { FileType, glob } from "@pk-nerdsaver-ai/pi-natives";
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	getConfigDirName,
	getPluginsDir,
	getProjectDir,
	parseFrontmatter,
	tryParseJson,
} from "@pk-nerdsaver-ai/pi-utils";
import type { ExtensionModule } from "../capability/extension-module";
import { invalidate as invalidateFsCache, readDirEntries, readFile } from "../capability/fs";
import { parseRuleConditionAndScope, type Rule, type RuleFrontmatter } from "../capability/rule";
import type { Skill, SkillFrontmatter } from "../capability/skill";
import type { LoadContext, LoadResult, SourceMeta } from "../capability/types";
import { parseThinkingLevel } from "../thinking";
import { normalizeToolNames } from "../tools/builtin-names";

import { buildPluginDirRoot } from "./plugin-dir-roots";

/**
 * Standard paths for each config source.
 */
export const SOURCE_PATHS = {
	native: {
		get userBase() {
			return getConfigDirName();
		},
		get userAgent() {
			return `${getConfigDirName()}/agent`;
		},
		projectDir: CONFIG_DIR_NAME,
	},
	claude: {
		userBase: ".claude",
		userAgent: ".claude",
		projectDir: ".claude",
	},
	codex: {
		userBase: ".codex",
		userAgent: ".codex",
		projectDir: ".codex",
	},
	gemini: {
		userBase: ".gemini",
		userAgent: ".gemini",
		projectDir: ".gemini",
	},
	opencode: {
		userBase: ".config/opencode",
		userAgent: ".config/opencode",
		projectDir: ".opencode",
	},
	cursor: {
		userBase: ".cursor",
		userAgent: ".cursor",
		projectDir: ".cursor",
	},
	windsurf: {
		userBase: ".codeium/windsurf",
		userAgent: ".codeium/windsurf",
		projectDir: ".windsurf",
	},
	cline: {
		userBase: ".cline",
		userAgent: ".cline",
		projectDir: null, // Cline uses root-level .clinerules
	},
	github: {
		userBase: null,
		userAgent: null,
		projectDir: ".github",
	},
	vscode: {
		userBase: ".vscode",
		userAgent: ".vscode",
		projectDir: ".vscode",
	},
} as const;

export type SourceId = keyof typeof SOURCE_PATHS;

/**
 * Get user-level path for a source.
 */
export function getUserPath(ctx: LoadContext, source: SourceId, subpath: string): string | null {
	// Native user config is profile-scoped via getAgentDir() (the active profile's
	// agent dir), matching builtin.ts and getMCPConfigPath("user"). External tools
	// (~/.claude, ~/.gemini, …) are intentionally not profile-scoped, so they keep
	// resolving against ctx.home below.
	if (source === "native") return path.join(getAgentDir(), subpath);
	const paths = SOURCE_PATHS[source];
	if (!paths.userAgent) return null;
	return path.join(ctx.home, paths.userAgent, subpath);
}

/**
 * Get project-level path for a source (cwd only).
 */
export function getProjectPath(ctx: LoadContext, source: SourceId, subpath: string): string | null {
	const paths = SOURCE_PATHS[source];
	if (!paths.projectDir) return null;

	return path.join(ctx.cwd, paths.projectDir, subpath);
}

/**
 * Resolve GitHub Copilot CLI's user-global config root. Copilot stores per-user
 * instructions/prompts/agents/MCP under `~/.copilot`, relocatable via the
 * `COPILOT_HOME` env var (mirrors Copilot CLI's `--config-dir`). Falls back to
 * `<home>/.copilot` when the override is unset.
 */
export function resolveCopilotHome(home: string): string {
	const override = process.env.COPILOT_HOME?.trim();
	return override ? override : path.join(home, ".copilot");
}

/**
 * Create source metadata for an item.
 */
export function createSourceMeta(provider: string, filePath: string, level: "user" | "project"): SourceMeta {
	return {
		provider,
		providerName: "", // Filled in by registry
		path: path.resolve(filePath),
		level,
	};
}

export function parseBoolean(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "true") return true;
		if (normalized === "false") return false;
	}
	return undefined;
}

/**
 * Parse a comma-separated string into an array of trimmed, non-empty strings.
 */
export function parseCSV(value: string): string[] {
	return value
		.split(",")
		.map(s => s.trim())
		.filter(Boolean);
}

/**
 * Parse a value that may be an array of strings or a comma-separated string.
 * Returns undefined if the result would be empty.
 */
export function parseArrayOrCSV(value: unknown): string[] | undefined {
	if (Array.isArray(value)) {
		const filtered = value.filter((item): item is string => typeof item === "string");
		return filtered.length > 0 ? filtered : undefined;
	}
	if (typeof value === "string") {
		const parsed = parseCSV(value);
		return parsed.length > 0 ? parsed : undefined;
	}
	return undefined;
}

/**
 * Build a canonical rule item from a markdown/markdown-frontmatter document.
 */
export function buildRuleFromMarkdown(
	name: string,
	content: string,
	filePath: string,
	source: SourceMeta,
	options?: {
		ruleName?: string;
		stripNamePattern?: RegExp;
	},
): Rule {
	const { frontmatter, body } = parseFrontmatter(content, { source: filePath });
	const { condition, astCondition, scope } = parseRuleConditionAndScope(frontmatter as RuleFrontmatter);

	let globs: string[] | undefined;
	if (Array.isArray(frontmatter.globs)) {
		globs = frontmatter.globs.filter((item): item is string => typeof item === "string");
	} else if (typeof frontmatter.globs === "string") {
		globs = [frontmatter.globs];
	}

	const resolvedName = options?.ruleName ?? name.replace(options?.stripNamePattern ?? /\.(md|mdc)$/, "");
	const rawMode = frontmatter.interruptMode;
	const interruptMode: Rule["interruptMode"] =
		rawMode === "never" || rawMode === "prose-only" || rawMode === "tool-only" || rawMode === "always"
			? rawMode
			: undefined;
	return {
		name: resolvedName,
		path: filePath,
		content: body,
		globs,
		alwaysApply: frontmatter.alwaysApply === true,
		description: typeof frontmatter.description === "string" ? frontmatter.description : undefined,
		condition,
		astCondition,
		scope,
		interruptMode,
		_source: source,
	};
}

/**
 * Parse model field into a prioritized list.
 */
export function parseModelList(value: unknown): string[] | undefined {
	const parsed = parseArrayOrCSV(value);
	if (!parsed) return undefined;
	const normalized = parsed.map(entry => entry.trim()).filter(Boolean);
	return normalized.length > 0 ? normalized : undefined;
}

export type AgentPrefetch = "repo-evidence";

/** Parsed agent fields from frontmatter (excludes source/filePath/systemPrompt) */
export interface ParsedAgentFields {
	name: string;
	description: string;
	/**
	 * `undefined` = tools key omitted (unrestricted seed).
	 * `[]` / non-empty = explicit list (deny-all when empty before control-tool injection).
	 */
	tools?: string[];
	/** True when frontmatter included an explicit `tools` key (including `[]`). */
	toolsSpecified?: boolean;
	spawns?: string[] | "*";
	model?: string[];
	output?: unknown;
	thinkingLevel?: ThinkingLevel;
	autoloadSkills?: string[];
	readSummarize?: boolean;
	prefetch?: AgentPrefetch;
	blocking?: boolean;
}

/**
 * Parse agent fields from frontmatter.
 * Returns null if required fields (name, description) are missing.
 */
export function parseAgentFields(frontmatter: Record<string, unknown>): ParsedAgentFields | null {
	const name = typeof frontmatter.name === "string" ? frontmatter.name : undefined;
	const description = typeof frontmatter.description === "string" ? frontmatter.description : undefined;

	if (!name || !description) {
		return null;
	}

	const toolsSpecified = Object.hasOwn(frontmatter, "tools");
	let tools: string[] | undefined;
	if (toolsSpecified) {
		// Preserve explicit empty arrays — do not collapse `tools: []` to omission.
		if (Array.isArray(frontmatter.tools)) {
			tools = normalizeToolNames(frontmatter.tools.filter((item): item is string => typeof item === "string"));
		} else if (typeof frontmatter.tools === "string") {
			tools = normalizeToolNames(parseCSV(frontmatter.tools));
		} else if (frontmatter.tools == null) {
			tools = [];
		} else {
			tools = normalizeToolNames(parseArrayOrCSV(frontmatter.tools) ?? []);
		}
	}

	// Subagents with explicit tool lists always need yield
	if (tools && !tools.includes("yield")) {
		tools = [...tools, "yield"];
	}

	// Parse spawns field (array, "*", or CSV)
	let spawns: string[] | "*" | undefined;
	if (frontmatter.spawns === "*") {
		spawns = "*";
	} else if (typeof frontmatter.spawns === "string") {
		const trimmed = frontmatter.spawns.trim();
		if (trimmed === "*") {
			spawns = "*";
		} else {
			spawns = parseArrayOrCSV(trimmed);
		}
	} else {
		spawns = parseArrayOrCSV(frontmatter.spawns);
	}

	const hasExplicitExecutionPolicy = [
		"tier",
		"autonomy",
		"collaboration",
		"workClass",
		"editMode",
		"maxRequests",
		"maxRuntimeMs",
		"modelPool",
		"agentPolicies",
		"executionProfile",
	].some(key => frontmatter[key] !== undefined);

	// LEGACY: infer unrestricted spawns only when task is present and no explicit
	// execution policy exists. Profiled agents must declare spawns explicitly.
	if (spawns === undefined && tools?.includes("task") && !hasExplicitExecutionPolicy) {
		spawns = "*";
	}

	const output = frontmatter.output !== undefined ? frontmatter.output : undefined;
	const rawThinkingLevel =
		typeof frontmatter.thinkingLevel === "string"
			? frontmatter.thinkingLevel
			: typeof frontmatter.thinking === "string"
				? frontmatter.thinking
				: undefined;

	const thinkingLevel = parseThinkingLevel(rawThinkingLevel);
	const model = parseModelList(frontmatter.model);
	const blocking = parseBoolean(frontmatter.blocking);
	const readSummarize = parseBoolean(frontmatter.readSummarize);
	const prefetch: AgentPrefetch | undefined = frontmatter.prefetch === "repo-evidence" ? "repo-evidence" : undefined;
	const autoloadSkills = parseArrayOrCSV(frontmatter.autoloadSkills)
		?.map(s => s.trim())
		.filter(Boolean);
	return {
		name,
		description,
		tools,
		toolsSpecified: toolsSpecified || undefined,
		spawns,
		model,
		output,
		thinkingLevel,
		blocking,
		autoloadSkills,
		readSummarize,
		prefetch,
	};
}

async function globIf(
	dir: string,
	pattern: string,
	fileType: FileType,
	recursive: boolean = true,
): Promise<Array<{ path: string }>> {
	try {
		const result = await glob({ pattern, path: dir, gitignore: true, hidden: false, fileType, recursive });
		return result.matches;
	} catch {
		return [];
	}
}

export interface ScanSkillsFromDirOptions {
	dir: string;
	providerId: string;
	level: "user" | "project";
	requireDescription?: boolean;
}

// Stable ordering used for skill lists in prompts: name (case-insensitive), then name, then path.
export function compareSkillOrder(aName: string, aPath: string, bName: string, bPath: string): number {
	const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
	const lowerCompare = cmp(aName.toLowerCase(), bName.toLowerCase());
	if (lowerCompare !== 0) return lowerCompare;
	const nameCompare = cmp(aName, bName);
	if (nameCompare !== 0) return nameCompare;
	return cmp(aPath, bPath);
}

export async function scanSkillsFromDir(
	_ctx: LoadContext,
	options: ScanSkillsFromDirOptions,
): Promise<LoadResult<Skill>> {
	const items: Skill[] = [];
	const warnings: string[] = [];
	const { dir, level, providerId, requireDescription = false } = options;

	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(dir, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			warnings.push(`Failed to read skills directory: ${dir} (${String(error)})`);
		}
		return { items, warnings };
	}
	const loadSkill = async (skillPath: string) => {
		try {
			const content = await readFile(skillPath);
			if (!content) return;
			const { frontmatter, body } = parseFrontmatter(content, { source: skillPath });
			if (frontmatter.enabled === false) {
				return;
			}
			if (requireDescription && !frontmatter.description) {
				return;
			}
			const skillDirName = path.basename(path.dirname(skillPath));
			const rawName = frontmatter.name;
			const name = typeof rawName === "string" ? rawName.trim() || skillDirName : skillDirName;
			items.push({
				name,
				path: skillPath,
				content: body,
				frontmatter: frontmatter as SkillFrontmatter,
				level,
				_source: createSourceMeta(providerId, skillPath, level),
			});
		} catch {
			warnings.push(`Failed to read skill file: ${skillPath}`);
		}
	};

	const work = [];
	for (const entry of entries) {
		if (entry.name.startsWith(".")) continue;
		if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
		const skillPath = path.join(dir, entry.name, "SKILL.md");
		if (fs.existsSync(skillPath)) {
			work.push(loadSkill(skillPath));
		}
	}
	await Promise.all(work);

	// Deterministic ordering: async file reads complete nondeterministically, so sort after loading.
	items.sort((a, b) => compareSkillOrder(a.name, a.path, b.name, b.path));

	return { items, warnings };
}

/**
 * Expand environment variables in a string.
 * Supports ${VAR} and ${VAR:-default} syntax.
 */
function expandEnvVars(value: string, extraEnv?: Record<string, string>): string {
	return value.replace(/\$\{([^}:]+)(?::-([^}]*))?\}/g, (_, varName: string, defaultValue?: string) => {
		const envValue = extraEnv?.[varName] ?? Bun.env[varName];
		if (envValue !== undefined) return envValue;
		if (defaultValue !== undefined) return defaultValue;
		return `\${${varName}}`;
	});
}

/**
 * Recursively expand environment variables in an object.
 */
export function expandEnvVarsDeep<T>(obj: T, extraEnv?: Record<string, string>): T {
	if (typeof obj === "string") {
		return expandEnvVars(obj, extraEnv) as T;
	}
	if (Array.isArray(obj)) {
		return obj.map(item => expandEnvVarsDeep(item, extraEnv)) as T;
	}
	if (obj !== null && typeof obj === "object") {
		const result: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(obj)) {
			result[key] = expandEnvVarsDeep(value, extraEnv);
		}
		return result as T;
	}
	return obj;
}

/**
 * Load files from a directory matching extensions.
 * Uses native glob for fast filesystem scanning with gitignore support.
 */
export async function loadFilesFromDir<T>(
	_ctx: LoadContext,
	dir: string,
	provider: string,
	level: "user" | "project",
	options: {
		/** File extensions to match (without dot) */
		extensions?: string[];
		/** Transform file to item (return null to skip) */
		transform: (name: string, content: string, path: string, source: SourceMeta) => T | null;
		/** Whether to recurse into subdirectories (default: false) */
		recursive?: boolean;
	},
): Promise<LoadResult<T>> {
	const items: T[] = [];
	const warnings: string[] = [];
	// Build glob pattern based on extensions and recursion
	const { extensions, recursive = false } = options;

	let pattern: string;
	if (extensions && extensions.length > 0) {
		const extPattern = extensions.length === 1 ? extensions[0] : `{${extensions.join(",")}}`;
		pattern = recursive ? `**/*.${extPattern}` : `*.${extPattern}`;
	} else {
		pattern = recursive ? "**/*" : "*";
	}

	// Use native glob for fast scanning with gitignore support
	let matches: Array<{ path: string }>;
	try {
		const result = await glob({
			pattern,
			path: dir,
			gitignore: true,
			hidden: false,
			fileType: FileType.File,
		});
		matches = result.matches;
	} catch {
		// Directory doesn't exist or isn't readable
		return { items, warnings };
	}

	// Read all matching files in parallel
	const fileResults = await Promise.all(
		matches.map(async match => {
			const filePath = path.join(dir, match.path);
			const content = await readFile(filePath);
			return { filePath, content };
		}),
	);

	for (const { filePath, content } of fileResults) {
		if (content === null) {
			warnings.push(`Failed to read file: ${filePath}`);
			continue;
		}

		const name = path.basename(filePath);
		const source = createSourceMeta(provider, filePath, level);

		try {
			const item = options.transform(name, content, filePath, source);
			if (item !== null) {
				items.push(item);
			}
		} catch (err) {
			warnings.push(`Failed to parse ${filePath}: ${err}`);
		}
	}
	return { items, warnings };
}

/**
 * Calculate depth of target directory relative to current working directory.
 * Depth is the number of directory levels from cwd to target.
 * - Positive depth: target is above cwd (parent/ancestor)
 * - Zero depth: target is cwd
 * - This uses path splitting to count directory levels
 */
export function calculateDepth(cwd: string, targetDir: string, separator: string): number {
	return cwd.split(separator).length - targetDir.split(separator).length;
}

interface ExtensionModuleManifest {
	extensions?: string[];
}

async function discoverLinkedExtensionModuleFiles(dir: string): Promise<{
	indexFiles: Array<{ path: string }>;
	packageJsonFiles: Array<{ path: string }>;
}> {
	const entries = await readDirEntries(dir);
	const indexFiles: Array<{ path: string }> = [];
	const packageJsonFiles: Array<{ path: string }> = [];

	await Promise.all(
		entries.map(async entry => {
			if (entry.name.startsWith(".") || entry.isDirectory()) return;

			const entryPath = path.join(dir, entry.name);
			const stat = await fs.promises.stat(entryPath).catch(() => null);
			if (!stat?.isDirectory()) return;

			const [packageJsonContent, indexTsContent, indexJsContent] = await Promise.all([
				readFile(path.join(entryPath, "package.json")),
				readFile(path.join(entryPath, "index.ts")),
				readFile(path.join(entryPath, "index.js")),
			]);

			if (packageJsonContent !== null) {
				packageJsonFiles.push({ path: `${entry.name}/package.json` });
			}
			if (indexTsContent !== null) {
				indexFiles.push({ path: `${entry.name}/index.ts` });
			} else if (indexJsContent !== null) {
				indexFiles.push({ path: `${entry.name}/index.js` });
			}
		}),
	);

	return { indexFiles, packageJsonFiles };
}

async function readExtensionModuleManifest(
	_ctx: LoadContext,
	packageJsonPath: string,
): Promise<ExtensionModuleManifest | null> {
	const content = await readFile(packageJsonPath);
	if (!content) return null;

	const pkg = tryParseJson<{ omp?: ExtensionModuleManifest; pi?: ExtensionModuleManifest }>(content);
	const manifest = pkg?.omp ?? pkg?.pi;
	if (manifest && typeof manifest === "object") {
		return manifest;
	}
	return null;
}

/**
 * Discover extension module entry points in a directory.
 *
 * Discovery rules:
 * 1. Direct files: `extensions/*.ts` or `*.js` → load
 * 2. Subdirectory with index: `extensions/<ext>/index.ts` or `index.js` → load
 * 3. Subdirectory with package.json: `extensions/<ext>/package.json` with "omp"/"pi" field → load declared paths
 *
 * No recursion beyond one level. Complex packages must use package.json manifest.
 * Uses native glob for fast filesystem scanning with gitignore support.
 */
export async function discoverExtensionModulePaths(_ctx: LoadContext, dir: string): Promise<string[]> {
	const discovered = new Set<string>();
	// Find all candidate files in parallel using glob
	const [directFiles, globIndexFiles, globPackageJsonFiles, linkedFiles] = await Promise.all([
		// 1. Direct *.ts or *.js files
		globIf(dir, "*.{ts,js}", FileType.File, false),
		// 2. Subdirectory index files
		globIf(dir, "*/index.{ts,js}", FileType.File, false),
		// 3. Subdirectory package.json files
		globIf(dir, "*/package.json", FileType.File, false),
		// Native glob does not follow linked extension directories.
		discoverLinkedExtensionModuleFiles(dir),
	]);
	const indexFiles = [...globIndexFiles, ...linkedFiles.indexFiles];
	const packageJsonFiles = [...globPackageJsonFiles, ...linkedFiles.packageJsonFiles];

	// The native glob walker runs with follow_links=false, so a symlinked extension
	// directory is yielded as a Symlink entry but never descended into: its inner
	// index.{ts,js}/package.json are invisible to the `*/...` patterns above.
	// Detect top-level symlinked directories and synthesize the equivalent subdir
	// matches so the resolution below treats them like real directories. Symlinked
	// *files* already match, because the native file-type filter resolves a
	// symlink's target type for File filters.
	const topLevelEntries = await readDirEntries(dir);
	for (const entry of topLevelEntries) {
		if (!entry.isSymbolicLink()) continue;
		// readDirEntries follows the symlink: a link to a file/dangling link yields [].
		const subEntries = await readDirEntries(path.join(dir, entry.name));
		const hasEntry = (name: string): boolean =>
			subEntries.some(e => e.name === name && (e.isFile() || e.isSymbolicLink()));
		if (hasEntry("package.json")) packageJsonFiles.push({ path: `${entry.name}/package.json` });
		if (hasEntry("index.ts")) indexFiles.push({ path: `${entry.name}/index.ts` });
		else if (hasEntry("index.js")) indexFiles.push({ path: `${entry.name}/index.js` });
	}

	// Process direct files
	for (const match of directFiles) {
		if (match.path.includes("/")) continue;
		discovered.add(path.join(dir, match.path));
	}
	// Track which subdirectories have package.json manifests with declared extensions
	const subdirsWithDeclaredExtensions = new Set<string>();
	for (const match of packageJsonFiles) {
		const subdir = path.dirname(match.path); // e.g., "my-extension"
		const packageJsonPath = path.join(dir, match.path);
		const manifest = await readExtensionModuleManifest(_ctx, packageJsonPath);
		const declaredExtensions =
			manifest?.extensions?.filter((extPath): extPath is string => typeof extPath === "string") ?? [];
		if (declaredExtensions.length === 0) continue;
		subdirsWithDeclaredExtensions.add(subdir);
		const subdirPath = path.join(dir, subdir);
		for (const extPath of declaredExtensions) {
			let resolvedExtPath = path.resolve(subdirPath, extPath);
			const entries = await readDirEntries(resolvedExtPath);
			if (entries.length !== 0) {
				const pluginFilePath = entries.find(
					e => e.isFile() && (e.name === "index.ts" || e.name === "index.js"),
				)?.name;
				resolvedExtPath = pluginFilePath ? path.join(resolvedExtPath, pluginFilePath) : resolvedExtPath;
			}
			const content = await readFile(resolvedExtPath);
			if (content !== null) {
				discovered.add(resolvedExtPath);
			}
		}
	}
	const preferredIndexBySubdir = new Map<string, string>();
	for (const match of indexFiles) {
		if (match.path.split("/").length !== 2) continue;
		const subdir = path.dirname(match.path);
		if (subdirsWithDeclaredExtensions.has(subdir)) continue;
		const existing = preferredIndexBySubdir.get(subdir);
		if (!existing || (existing.endsWith("index.js") && match.path.endsWith("index.ts"))) {
			preferredIndexBySubdir.set(subdir, match.path);
		}
	}
	for (const preferredPath of preferredIndexBySubdir.values()) {
		discovered.add(path.join(dir, preferredPath));
	}
	return [...discovered];
}

/**
 * Derive a stable extension name from a path.
 */
export function getExtensionNameFromPath(extensionPath: string): string {
	const base = extensionPath.replace(/\\/g, "/").split("/").pop() ?? extensionPath;

	if (base === "index.ts" || base === "index.js") {
		const parts = extensionPath.replace(/\\/g, "/").split("/");
		const parent = parts[parts.length - 2];
		return parent ?? base;
	}

	const dot = base.lastIndexOf(".");
	if (dot > 0) {
		return base.slice(0, dot);
	}

	return base;
}

/**
 * Build ExtensionModule items from discovered user/project paths.
 * Shared across providers that expose extension modules via user + project dirs.
 */
export function buildExtensionModuleItems(
	providerId: string,
	userPaths: string[],
	projectPaths: string[],
): ExtensionModule[] {
	return [
		...userPaths.map(extPath => ({
			name: getExtensionNameFromPath(extPath),
			path: extPath,
			level: "user" as const,
			_source: createSourceMeta(providerId, extPath, "user"),
		})),
		...projectPaths.map(extPath => ({
			name: getExtensionNameFromPath(extPath),
			path: extPath,
			level: "project" as const,
			_source: createSourceMeta(providerId, extPath, "project"),
		})),
	];
}

// =============================================================================
// Claude Code Plugin Cache Helpers
// =============================================================================

/**
 * Entry for an installed Claude Code plugin.
 */
export interface ClaudePluginEntry {
	scope: "user" | "project";
	installPath: string;
	version: string;
	installedAt: string;
	lastUpdated: string;
	gitCommitSha?: string;
	enabled?: boolean;
}

/**
 * Claude Code installed_plugins.json registry format.
 */
export interface ClaudePluginsRegistry {
	version: number;
	plugins: Record<string, ClaudePluginEntry[]>;
}

/**
 * Resolved plugin root for loading.
 */
export interface ClaudePluginRoot {
	/** Plugin ID (e.g., "simpleclaude-core@simpleclaude") */
	id: string;
	/** Marketplace name */
	marketplace: string;
	/** Plugin name */
	plugin: string;
	/** Version string */
	version: string;
	/** Absolute path to plugin root */
	path: string;
	/** Whether this is a user or project scope plugin */
	scope: "user" | "project";
}

/**
 * Parse Claude Code installed_plugins.json content.
 */
export function parseClaudePluginsRegistry(content: string): ClaudePluginsRegistry | null {
	const data = tryParseJson<ClaudePluginsRegistry>(content);
	if (!data || typeof data !== "object") return null;
	if (
		typeof data.version !== "number" ||
		!data.plugins ||
		typeof data.plugins !== "object" ||
		Array.isArray(data.plugins)
	)
		return null;
	return data;
}

/**
 * Resolve the active project registry path by walking up from `cwd`.
 *
 * Walk order:
 * 1. Walk up from `cwd` looking for the nearest directory containing `.ompk/`.
 *    The first match returns `<dir>/.ompk/plugins/installed_plugins.json`.
 * 2. If no `.ompk/` is found, rescan from `cwd` upward looking for `.git`.
 *    The git root is used as an anchor: `<gitRoot>/.ompk/plugins/installed_plugins.json`.
 * 3. If neither is found, return `null` — no project context is active.
 *
 * This is the single source of truth for "active project root" used by install,
 * uninstall, list, upgrade, discovery, and doctor. Deterministic for a given `cwd`.
 */
export async function resolveActiveProjectRegistryPath(cwd: string): Promise<string | null> {
	// Pass 1: walk up looking for an existing .ompk/ directory (nearest wins).
	// Stop before os.homedir() — ~/.ompk/ is the user-level config dir, not a project root.
	const homeDir = os.homedir();
	let dir = path.resolve(cwd);
	while (dir !== homeDir) {
		try {
			const stat = await fs.promises.stat(path.join(dir, getConfigDirName()));
			if (stat.isDirectory()) {
				return path.join(dir, getConfigDirName(), "plugins", "installed_plugins.json");
			}
		} catch {
			// not found at this level — continue up
		}
		const parent = path.dirname(dir);
		if (parent === dir) break; // filesystem root
		dir = parent;
	}

	// Pass 2: walk up looking for .git as a fallback anchor.
	dir = path.resolve(cwd);
	while (dir !== homeDir) {
		try {
			await fs.promises.stat(path.join(dir, ".git"));
			return path.join(dir, getConfigDirName(), "plugins", "installed_plugins.json");
		} catch {
			// not found at this level — continue up
		}
		const parent = path.dirname(dir);
		if (parent === dir) break; // filesystem root
		dir = parent;
	}

	return null; // not inside any project
}

/**
 * Like resolveActiveProjectRegistryPath, but falls back to `<cwd>/.ompk/plugins/installed_plugins.json`
 * when no project anchor (.ompk/ or .git/) is found.
 *
 * Use this when the caller accepts an explicit --scope project so that installing into a freshly
 * bootstrapped directory (no .ompk/ or .git/ yet) works: writeInstalledPluginsRegistry auto-creates
 * the directory tree on first write.
 *
 * Returns undefined when cwd is os.homedir() — that path is already the user registry and must
 * never alias as the project registry.
 */
export async function resolveOrDefaultProjectRegistryPath(cwd: string): Promise<string | undefined> {
	const resolved = await resolveActiveProjectRegistryPath(cwd);
	if (resolved) return resolved;
	// Home directory must not be treated as a project root: the fallback path would alias
	// getInstalledPluginsRegistryPath(), causing MarketplaceManager to load the same file
	// as both user and project registry and producing duplicates / disambiguation errors.
	if (path.resolve(cwd) === os.homedir()) return undefined;
	return path.join(cwd, getConfigDirName(), "plugins", "installed_plugins.json");
}

const pluginRootsCache = new Map<string, { roots: ClaudePluginRoot[]; warnings: string[] }>();

/**
 * List all installed Claude Code plugin roots from the plugin cache.
 * Reads ~/.claude/plugins/installed_plugins.json and ~/.ompk/plugins/installed_plugins.json,
 * and optionally the nearest project-scoped registry resolved from `cwd`.
 *
 * Results are cached per `home:resolvedProjectPath` key to avoid repeated parsing.
 */
export async function listClaudePluginRoots(
	home: string,
	cwd?: string,
): Promise<{ roots: ClaudePluginRoot[]; warnings: string[] }> {
	const resolvedProjectPath = cwd ? await resolveActiveProjectRegistryPath(cwd) : null;
	const cacheKey = `${home}:${resolvedProjectPath ?? ""}`;
	const cached = pluginRootsCache.get(cacheKey);
	if (cached) return cached;

	const roots: ClaudePluginRoot[] = [];
	const warnings: string[] = [];
	const projectRoots: ClaudePluginRoot[] = [];

	// ── Claude Code registry ──────────────────────────────────────────────────
	const registryPath = path.join(home, ".claude", "plugins", "installed_plugins.json");
	const content = await readFile(registryPath);

	if (content) {
		const registry = parseClaudePluginsRegistry(content);
		if (!registry) {
			warnings.push(`Failed to parse Claude Code plugin registry: ${registryPath}`);
		} else {
			for (const [pluginId, entries] of Object.entries(registry.plugins)) {
				if (!Array.isArray(entries) || entries.length === 0) continue;

				// Parse plugin ID format: "plugin-name@marketplace"
				const atIndex = pluginId.lastIndexOf("@");
				if (atIndex === -1) {
					warnings.push(`Invalid plugin ID format (missing @marketplace): ${pluginId}`);
					continue;
				}

				const pluginName = pluginId.slice(0, atIndex);
				const marketplace = pluginId.slice(atIndex + 1);

				// Process all valid entries, not just the first one.
				// This handles plugins with multiple installs (different scopes/versions).
				for (const entry of entries) {
					if (!entry.installPath || typeof entry.installPath !== "string") {
						warnings.push(`Plugin ${pluginId} entry has no installPath`);
						continue;
					}
					if (entry.enabled === false) continue;

					roots.push({
						id: pluginId,
						marketplace,
						plugin: pluginName,
						version: entry.version || "unknown",
						path: entry.installPath,
						scope: entry.scope || "user",
					});
				}
			}
		}
	}

	// ── OMP installed plugins registry ───────────────────────────────────────
	// OMP registry is authoritative: its entries replace Claude's entries for the same plugin ID.
	// In production `home` is `os.homedir()`, so `getPluginsDir(home)` resolves to the
	// same XDG-aware path the marketplace writer uses (reads and writes always agree).
	// Tests pass a temp dir, which short-circuits the resolver for deterministic isolation.
	const ompRegistryPath = path.join(getPluginsDir(home), "installed_plugins.json");
	const ompContent = await readFile(ompRegistryPath);
	if (ompContent) {
		const ompRegistry = parseClaudePluginsRegistry(ompContent);
		if (ompRegistry) {
			for (const [pluginId, entries] of Object.entries(ompRegistry.plugins)) {
				if (!Array.isArray(entries) || entries.length === 0) continue;

				const atIndex = pluginId.lastIndexOf("@");
				if (atIndex === -1) {
					warnings.push(`Invalid plugin ID format (missing @marketplace): ${pluginId}`);
					continue;
				}
				const pluginName = pluginId.slice(0, atIndex);
				const marketplace = pluginId.slice(atIndex + 1);

				// OMP is authoritative: drop all Claude-sourced entries for this plugin ID
				const filtered = roots.filter(r => r.id !== pluginId);
				roots.length = 0;
				roots.push(...filtered);

				for (const entry of entries) {
					if (!entry.installPath || typeof entry.installPath !== "string") {
						warnings.push(`Plugin ${pluginId} entry has no installPath`);
						continue;
					}
					if (entry.enabled === false) continue;
					// Deduplicate by installPath within same ID
					if (roots.some(r => r.id === pluginId && r.path === entry.installPath)) continue;

					roots.push({
						id: pluginId,
						marketplace,
						plugin: pluginName,
						version: entry.version || "unknown",
						path: entry.installPath,
						scope: entry.scope || "user",
					});
				}
			}
		} else {
			warnings.push(`Failed to parse OMP plugin registry: ${ompRegistryPath}`);
		}
	}

	// ── Project-scoped OMP registry ────────────────────────────────────────
	// Loaded from the nearest .ompk/plugins/installed_plugins.json relative to cwd.
	// Project entries take precedence over user entries for the same plugin ID.
	if (resolvedProjectPath) {
		const projectContent = await readFile(resolvedProjectPath);
		if (projectContent) {
			const projectRegistry = parseClaudePluginsRegistry(projectContent);
			if (projectRegistry) {
				for (const [pluginId, entries] of Object.entries(projectRegistry.plugins)) {
					if (!Array.isArray(entries) || entries.length === 0) continue;
					const atIndex = pluginId.lastIndexOf("@");
					if (atIndex === -1) {
						warnings.push(`Invalid plugin ID format (missing @marketplace): ${pluginId}`);
						continue;
					}
					const pluginName = pluginId.slice(0, atIndex);
					const marketplace = pluginId.slice(atIndex + 1);
					for (const entry of entries) {
						if (!entry.installPath || typeof entry.installPath !== "string") {
							warnings.push(`Plugin ${pluginId} entry has no installPath`);
							continue;
						}
						if (entry.enabled === false) continue;
						projectRoots.push({
							id: pluginId,
							marketplace,
							plugin: pluginName,
							version: entry.version || "unknown",
							path: entry.installPath,
							scope: "project",
						});
					}
				}
			} else {
				warnings.push(`Failed to parse project plugin registry: ${resolvedProjectPath}`);
			}
		}
	}

	// Project entries shadow user entries for the same plugin ID.
	if (projectRoots.length > 0) {
		const projectIds = new Set(projectRoots.map(r => r.id));
		const deduped = roots.filter(r => !projectIds.has(r.id));
		roots.length = 0;
		roots.push(...projectRoots, ...deduped);
	}

	// Merge --plugin-dir roots (highest precedence) on every fresh load
	if (injectedPluginDirRoots.length > 0) {
		const injectedIds = new Set(injectedPluginDirRoots.map(r => r.id));
		const filtered = roots.filter(r => !injectedIds.has(r.id));
		roots.length = 0;
		roots.push(...injectedPluginDirRoots, ...filtered);
	}

	const result = { roots, warnings };
	pluginRootsCache.set(cacheKey, result);
	return result;
}

/**
 * Clear the plugin roots cache (useful for testing or when plugins change).
 */
export function clearClaudePluginRootsCache(): void {
	pluginRootsCache.clear();
	preloadedPluginRoots = [...injectedPluginDirRoots];
	// Re-warm preloaded roots asynchronously so sync LSP config reads stay valid
	if (lastPreloadHome) {
		void preloadPluginRoots(lastPreloadHome, getProjectDir());
	}
}

/**
 * Invalidate fs caches for installed-plugin registry files and reset the
 * in-memory plugin roots cache. Used by MarketplaceManager clients after
 * installing/uninstalling/enabling/disabling plugins.
 */
export function clearPluginRootsAndCaches(extraPaths?: readonly string[]): void {
	invalidateFsCache(path.join(os.homedir(), ".claude", "plugins", "installed_plugins.json"));
	invalidateFsCache(path.join(getPluginsDir(), "installed_plugins.json"));
	for (const p of extraPaths ?? []) invalidateFsCache(p);
	clearClaudePluginRootsCache();
}

// ── Preloaded plugin roots (for sync consumers like LSP config) ─────────────
// Populated at startup by preloadPluginRoots(). Read synchronously by
// getPreloadedPluginRoots(). Safe degradation: empty array if not warmed.

let preloadedPluginRoots: ClaudePluginRoot[] = [];
let injectedPluginDirRoots: ClaudePluginRoot[] = [];
let lastPreloadHome: string | undefined;

/**
 * Populate the module-level plugin roots cache for sync consumers.
 * Call during session initialization, after dir resolution completes
 * but before any LSP config is read.
 */
export async function preloadPluginRoots(home: string, cwd?: string): Promise<void> {
	lastPreloadHome = home;
	const { roots } = await listClaudePluginRoots(home, cwd);
	preloadedPluginRoots = roots;
}

/**
 * Get pre-loaded plugin roots synchronously.
 * Returns empty array if preloadPluginRoots() hasn't been called.
 */
export function getPreloadedPluginRoots(): readonly ClaudePluginRoot[] {
	return preloadedPluginRoots;
}

// ── --plugin-dir injection ──────────────────────────────────────────────────

/**
 * Inject synthetic plugin roots from --plugin-dir paths.
 * These are prepended to the cache with highest precedence (before OMP/Claude entries).
 * Must be called before any listClaudePluginRoots() access.
 */
export async function injectPluginDirRoots(home: string, dirs: string[], cwd?: string): Promise<void> {
	const injected: ClaudePluginRoot[] = [];
	for (const dir of dirs) {
		const resolved = path.resolve(dir);
		// Read plugin name from manifest
		let pluginName = path.basename(resolved);
		try {
			const manifestPath = path.join(resolved, ".claude-plugin", "plugin.json");
			const content = await Bun.file(manifestPath).text();
			const manifest = JSON.parse(content);
			if (typeof manifest.name === "string" && manifest.name) {
				pluginName = manifest.name;
			}
		} catch {
			// No manifest or invalid — use directory name
		}

		injected.push(buildPluginDirRoot(resolved, pluginName));
	}

	// Set injected roots BEFORE populating cache so listClaudePluginRoots merges them.
	injectedPluginDirRoots = injected;
	lastPreloadHome = home; // ensure cache-clear re-warm fires even when injectPluginDirRoots was the startup path
	// Clear any stale cache entries (populated before injected roots were set).
	pluginRootsCache.clear();
	// Rebuild — cache miss triggers fresh load that includes both user+project registries
	// and prepends injectedPluginDirRoots at highest precedence.
	const { roots } = await listClaudePluginRoots(home, cwd);
	preloadedPluginRoots = roots;
}
