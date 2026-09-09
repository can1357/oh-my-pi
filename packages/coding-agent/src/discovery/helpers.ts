import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FileType, glob } from "@oh-my-pi/pi-natives";
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	getConfigDirName,
	getPluginsDir,
	getProjectDir,
	parseFrontmatter,
	tryParseJson,
} from "@oh-my-pi/pi-utils";
import { isUserSourceEnabled } from "../capability";
import type { ContextFile } from "../capability/context-file";
import type { ExtensionModule } from "../capability/extension-module";
import { invalidate as invalidateFsCache, readDirEntries, readFile } from "../capability/fs";
import {
	MAIN_AGENT_RULE_NAME,
	parseRuleAgents,
	parseRuleConditionAndScope,
	type Rule,
	type RuleFrontmatter,
	SUB_AGENT_RULE_NAME,
} from "../capability/rule";
import type { Skill, SkillFrontmatter } from "../capability/skill";
import type { LoadContext, LoadResult, SourceMeta } from "../capability/types";
import { resolveClaudePaths } from "../config/claude-paths";
import type { MCPRequestIdFormat } from "../mcp/types";
import { type ConfiguredThinkingLevel, parseConfiguredThinkingLevel } from "../thinking";
import { normalizeToolNames } from "../tools/builtin-names";

import { realpathIfExists, resolveContainedPath } from "./contained-path";
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
 * Resolve a user-level path for a source without the `~/` opt-in gate.
 * Only for callers that hold their own explicit opt-in (a per-capability
 * `skills.enable*User` / `commands.enable*User` toggle); everything else
 * goes through {@link getUserPath}.
 */
export function resolveUserPath(ctx: LoadContext, source: SourceId, subpath: string): string | null {
	// Native user config is profile-scoped via getAgentDir() (the active profile's
	// agent dir), matching builtin.ts and getMCPConfigPath("user").
	if (source === "native") return path.join(getAgentDir(), subpath);
	if (source === "claude") return path.join(resolveClaudePaths(ctx.home).configDir, subpath);
	const paths = SOURCE_PATHS[source];
	if (!paths.userAgent) return null;
	return path.join(ctx.home, paths.userAgent, subpath);
}

/**
 * Get user-level path for a source, or null when its `~/` config is not
 * opted in (see {@link isUserSourceEnabled}).
 */
export function getUserPath(ctx: LoadContext, source: SourceId, subpath: string): string | null {
	if (!isUserSourceEnabled(source, ctx)) return null;
	return resolveUserPath(ctx, source, subpath);
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
export function createSourceMeta(
	provider: string,
	filePath: string,
	level: "user" | "project",
	origin?: string,
): SourceMeta {
	return {
		provider,
		providerName: "", // Filled in by registry
		path: path.resolve(filePath),
		level,
		...(origin !== undefined && { origin }),
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
 * Parse an MCP `requestIdFormat` value. Unrecognized values are dropped so a typo
 * degrades to the default integer ids rather than reaching a transport.
 */
export function parseRequestIdFormat(value: unknown): MCPRequestIdFormat | undefined {
	if (value === "string" || value === "number") return value;
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

interface RuleMarkdownOptions {
	ruleName?: string;
	stripNamePattern?: RegExp;
}

function buildRule(
	name: string,
	body: string,
	frontmatter: RuleFrontmatter,
	filePath: string,
	source: SourceMeta,
	options?: RuleMarkdownOptions,
): Rule {
	const { condition, astCondition, scope } = parseRuleConditionAndScope(frontmatter);

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
		agents: parseRuleAgents(frontmatter.agents),
		interruptMode,
		_source: source,
	};
}

/** Build a canonical rule from Markdown, including explicitly loaded disabled files. */
export function buildRuleFromMarkdown(
	name: string,
	content: string,
	filePath: string,
	source: SourceMeta,
	options?: RuleMarkdownOptions,
): Rule {
	const { frontmatter, body } = parseFrontmatter(content, { source: filePath });
	return buildRule(name, body, frontmatter as RuleFrontmatter, filePath, source, options);
}

/** Build a discovered rule from Markdown, returning null when its frontmatter disables it. */
export function discoverRuleFromMarkdown(
	name: string,
	content: string,
	filePath: string,
	source: SourceMeta,
	options?: RuleMarkdownOptions,
): Rule | null {
	const { frontmatter, body } = parseFrontmatter(content, { source: filePath });
	if (frontmatter.enabled === false) return null;
	return buildRule(name, body, frontmatter as RuleFrontmatter, filePath, source, options);
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

/** Parsed agent fields from frontmatter (excludes source/filePath/systemPrompt) */
export interface ParsedAgentFields {
	name: string;
	description: string;
	tools?: string[];
	spawns?: string[] | "*";
	model?: string[];
	output?: unknown;
	thinkingLevel?: ConfiguredThinkingLevel;
	autoloadSkills?: string[];
	readSummarize?: boolean;
	blocking?: boolean;
	/** `true` = prewalk into the default target; string = prewalk into that model pattern. */
	prewalk?: boolean | string;
	/** `true` = advise with the default advisor-role model; string = advise with that model pattern. */
	advisor?: boolean | string;
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
	// "main" is the sentinel `agentName` for the top-level session (see
	// MAIN_AGENT_RULE_NAME); "sub" is the fallback `agentName` for a subagent
	// session with no explicit name (see SUB_AGENT_RULE_NAME / sdk.ts). A
	// custom agent definition sharing either name would resolve to the same
	// sentinel value, letting it load rules scoped `agents: [main]` or
	// `agents: [sub]` that are documented to target only that session kind.
	const normalizedName = name.trim().toLowerCase();
	if (normalizedName === MAIN_AGENT_RULE_NAME || normalizedName === SUB_AGENT_RULE_NAME) {
		return null;
	}

	let tools =
		Array.isArray(frontmatter.tools) && frontmatter.tools.length === 0 ? [] : parseArrayOrCSV(frontmatter.tools);
	if (tools) tools = normalizeToolNames(tools);

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

	// Backward compat: infer spawns: "*" when tools includes "task"
	if (spawns === undefined && tools?.includes("task")) {
		spawns = "*";
	}

	const output = frontmatter.output !== undefined ? frontmatter.output : undefined;
	const rawThinkingLevel =
		typeof frontmatter.thinkingLevel === "string"
			? frontmatter.thinkingLevel
			: typeof frontmatter.thinking === "string"
				? frontmatter.thinking
				: undefined;

	const thinkingLevel = parseConfiguredThinkingLevel(rawThinkingLevel);
	const model = parseModelList(frontmatter.model);
	const blocking = parseBoolean(frontmatter.blocking);
	const readSummarize = parseBoolean(frontmatter.readSummarize);
	// prewalk: true → hand off to the default prewalk target; "<pattern>" → custom target.
	let prewalk: boolean | string | undefined = parseBoolean(frontmatter.prewalk);
	if (prewalk === undefined && typeof frontmatter.prewalk === "string") {
		const trimmed = frontmatter.prewalk.trim();
		if (trimmed) prewalk = trimmed;
	}
	// advisor: true → advise with the default advisor-role model; "<pattern>" → custom advisor model.
	let advisor: boolean | string | undefined = parseBoolean(frontmatter.advisor);
	if (advisor === undefined && typeof frontmatter.advisor === "string") {
		const trimmed = frontmatter.advisor.trim();
		if (trimmed) advisor = trimmed;
	}
	const autoloadSkills = parseArrayOrCSV(frontmatter.autoloadSkills)
		?.map(s => s.trim())
		.filter(Boolean);
	return {
		name,
		description,
		tools,
		spawns,
		model,
		output,
		thinkingLevel,
		blocking,
		autoloadSkills,
		readSummarize,
		prewalk,
		advisor,
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
	/**
	 * When true, treat a `SKILL.md` sitting directly under `dir` as a single skill in addition to
	 * scanning `<dir>/<name>/SKILL.md` children. Matches the Claude plugin manifest convention
	 * that lets a skill path point at a directory containing `SKILL.md` directly (e.g.
	 * `"skills": ["./"]`), where the frontmatter `name` determines the invocation name and the
	 * directory basename is the fallback. Default `false` preserves the strict child-scan
	 * semantic every non-Claude provider relies on.
	 */
	includeSelf?: boolean;
	/**
	 * Registry/CLI origin of the plugin root supplying these skills, forwarded
	 * to {@link SourceMeta.origin} so user-scope gating can tell omp's own
	 * installs (`omp`, `plugin-dir`) from the foreign Claude tree (`claude`).
	 */
	origin?: string;
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
				_source: createSourceMeta(providerId, skillPath, level, options.origin),
			});
		} catch {
			warnings.push(`Failed to read skill file: ${skillPath}`);
		}
	};

	const work: Promise<void>[] = [];
	if (options.includeSelf) {
		const selfSkillPath = path.join(dir, "SKILL.md");
		if (fs.existsSync(selfSkillPath)) {
			work.push(loadSkill(selfSkillPath));
		}
	}
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
 * Resolve a placeholder name against `extraEnv`, then the ambient environment.
 *
 * Inherited members of either map (`__proto__`, `constructor`, `toString`, …)
 * are never substitutable: `extraEnv` is consulted by own property only, and
 * `Bun.env`'s getter falls through to `Object.prototype`, so `${constructor}`
 * would otherwise stringify into the value as `function Object() { [native
 * code] }`. Every real variable is a string, so a non-string ambient hit means
 * the name resolved to a prototype member and counts as unset.
 */
function lookupEnvValue(varName: string, extraEnv?: Record<string, string>): string | undefined {
	if (extraEnv !== undefined && Object.hasOwn(extraEnv, varName)) return extraEnv[varName];
	const ambient = Bun.env[varName];
	return typeof ambient === "string" ? ambient : undefined;
}

/**
 * Expand environment variables in a string.
 * Supports ${VAR} and ${VAR:-default} syntax.
 */
function expandEnvVars(value: string, extraEnv?: Record<string, string>): string {
	return value.replace(/\$\{([^}:]+)(?::-([^}]*))?\}/g, (_, varName: string, defaultValue?: string) => {
		const envValue = lookupEnvValue(varName, extraEnv);
		// `${VAR:-default}` follows POSIX `:-`: the default applies when the
		// variable is unset OR empty. Plain `${VAR}` keeps the value verbatim
		// (even an empty one) and stays literal when unset.
		if (envValue !== undefined && (defaultValue === undefined || envValue !== "")) return envValue;
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
			// Thread the caller's non-recursive intent explicitly: the native glob
			// defaults `recursive` to true and rewrites `*.{ts,js}` -> `**/*.{ts,js}`,
			// which would walk the entire subtree (e.g. a venv's site-packages under
			// ~/.codex/tools) and import arbitrary frontend assets as tools (#8552).
			recursive,
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
// =============================================================================
// Standalone context-file walker (AGENTS.md, CLAUDE.md, …)
// =============================================================================

/**
 * Compare paths while tolerating Windows drive casing.
 */
function samePath(left: string, right: string): boolean {
	const normalizedLeft = path.resolve(left);
	const normalizedRight = path.resolve(right);
	return process.platform === "win32"
		? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
		: normalizedLeft === normalizedRight;
}

/**
 * Return whether `child` is at or below `parent`.
 */
function isWithin(parent: string, child: string): boolean {
	const normalizedParent = path.resolve(parent);
	const normalizedChild = path.resolve(child);
	const relative = path.relative(
		process.platform === "win32" ? normalizedParent.toLowerCase() : normalizedParent,
		process.platform === "win32" ? normalizedChild.toLowerCase() : normalizedChild,
	);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/**
 * Load standalone context files (e.g. AGENTS.md, CLAUDE.md) by walking up from
 * cwd. Shared across providers whose files live in project root rather than
 * config directories (which their own providers handle).
 *
 * When a repository is nested below the user's home directory, continue past
 * the Git root to discover workspace-level files, but stop before loading the
 * home directory's own copy as project context. A repository rooted at the
 * home directory itself is not "nested below" it, so the home-level file
 * remains project context.
 */
export async function loadStandaloneContextFiles(
	ctx: LoadContext,
	providerId: string,
	fileName: string,
): Promise<LoadResult<ContextFile>> {
	const items: ContextFile[] = [];
	const warnings: string[] = [];
	const home = path.resolve(ctx.home);
	const cwd = path.resolve(ctx.cwd);
	const repoRoot = ctx.repoRoot ? path.resolve(ctx.repoRoot) : null;
	const filesystemRoot = path.parse(cwd).root;
	const cwdIsUnderHome = isWithin(home, cwd);
	const repoIsHome = repoRoot !== null && samePath(home, repoRoot);
	const repoIsUnderHome = repoRoot !== null && isWithin(home, repoRoot) && !repoIsHome;
	const scanToHome = repoRoot !== null && cwdIsUnderHome && repoIsUnderHome;
	const boundary = scanToHome ? home : (repoRoot ?? (cwdIsUnderHome ? home : filesystemRoot));
	const includeBoundary = repoRoot === null ? cwdIsUnderHome : !samePath(boundary, home) || repoIsHome;
	const excludeHome = scanToHome;

	let current = cwd;
	while (true) {
		const atBoundary = samePath(current, boundary);
		const atHome = excludeHome && samePath(current, home);
		if (!(atHome || (atBoundary && !includeBoundary))) {
			const candidate = path.join(current, fileName);
			const content = await readFile(candidate);

			// Empty files contribute nothing and must not claim the depth scope:
			// at a priority tie, an empty first-registered file would shadow a
			// non-empty sibling (e.g. an empty AGENTS.md shadowing CLAUDE.md).
			if (content !== null && content !== "") {
				const parent = path.dirname(candidate);
				const baseName = parent.split(path.sep).pop() ?? "";

				if (!baseName.startsWith(".")) {
					const fileDir = path.dirname(candidate);
					const calculatedDepth = calculateDepth(cwd, fileDir, path.sep);

					items.push({
						path: candidate,
						content,
						level: "project",
						depth: calculatedDepth,
						_source: createSourceMeta(providerId, candidate, "project"),
					});
				}
			}
		}
		if (atBoundary) break;

		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}

	return { items, warnings };
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
	/** Claude registry scope; project and local entries are restricted to their project path. */
	scope?: "user" | "project" | "local";
	installPath: string;
	version: string;
	installedAt: string;
	lastUpdated: string;
	gitCommitSha?: string;
	enabled?: boolean;
	/** Project root recorded by Claude for a project-bound installation. */
	projectPath?: string;
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
	/** Registry or explicit CLI source that supplied this root. */
	origin: "claude" | "omp" | "plugin-dir";
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
 * 1. Walk up from `cwd` looking for the nearest directory containing `.omp/`.
 *    The first match returns `<dir>/.omp/plugins/installed_plugins.json`.
 * 2. If no `.omp/` is found, rescan from `cwd` upward looking for `.git`.
 *    The git root is used as an anchor: `<gitRoot>/.omp/plugins/installed_plugins.json`.
 * 3. If neither is found, return `null` — no project context is active.
 *
 * This is the single source of truth for "active project root" used by install,
 * uninstall, list, upgrade, discovery, and doctor. Deterministic for a given `cwd`.
 */
export async function resolveActiveProjectRegistryPath(cwd: string): Promise<string | null> {
	// Pass 1: walk up looking for an existing .omp/ directory (nearest wins).
	// Stop before os.homedir() — ~/.omp/ is the user-level config dir, not a project root.
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
 * Like resolveActiveProjectRegistryPath, but falls back to `<cwd>/.omp/plugins/installed_plugins.json`
 * when no project anchor (.omp/ or .git/) is found.
 *
 * Use this when the caller accepts an explicit --scope project so that installing into a freshly
 * bootstrapped directory (no .omp/ or .git/ yet) works: writeInstalledPluginsRegistry auto-creates
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

async function canonicalClaudeProjectPath(projectPath: string): Promise<string | null> {
	try {
		return await fs.promises.realpath(path.resolve(projectPath));
	} catch {
		return null;
	}
}

/**
 * Claude Code `enabledPlugins` overrides, merged across the same settings
 * layers Claude Code itself consults: `<claude-config>/settings.json`, then
 * `<dir>/.claude/settings.json` and `<dir>/.claude/settings.local.json` for
 * each project directory (later layers win, `.local` wins within a layer).
 *
 * Returns `pluginId -> boolean` for the ids the user toggled explicitly, and
 * the list of settings files that contributed (for cache keying).
 */
async function readClaudeEnabledPlugins(
	claudeConfigDir: string,
	projectDirs: string[],
): Promise<{ enabled: Map<string, boolean>; sources: string[] }> {
	const enabled = new Map<string, boolean>();
	const sources: string[] = [];
	const candidates = [path.join(claudeConfigDir, "settings.json")];
	for (const dir of projectDirs) {
		candidates.push(path.join(dir, ".claude", "settings.json"), path.join(dir, ".claude", "settings.local.json"));
	}
	for (const file of candidates) {
		const content = await readFile(file);
		if (!content) continue;
		const data = tryParseJson<{ enabledPlugins?: unknown }>(content);
		if (!data || typeof data !== "object") continue;
		const map = data.enabledPlugins;
		if (!map || typeof map !== "object" || Array.isArray(map)) continue;
		sources.push(file);
		for (const [pluginId, value] of Object.entries(map as Record<string, unknown>)) {
			if (typeof value === "boolean") enabled.set(pluginId, value);
		}
	}
	return { enabled, sources };
}

const pluginRootsCache = new Map<string, { roots: ClaudePluginRoot[]; warnings: string[] }>();

const pluginCacheInvalidators = new Set<() => void>();

/** Register a process-global plugin cache invalidator called whenever plugin roots are cleared. */
export function registerPluginCacheInvalidator(invalidator: () => void): void {
	pluginCacheInvalidators.add(invalidator);
}

/**
 * List all installed Claude Code plugin roots from its active plugin cache and
 * ~/.omp/plugins/installed_plugins.json, plus the nearest project registry when present.
 *
 * Results are cached per Claude and OMP config directories, project registry, and canonical active project.
 */
export async function listClaudePluginRoots(
	home: string,
	cwd?: string,
): Promise<{ roots: ClaudePluginRoot[]; warnings: string[] }> {
	const claudeConfigDir = resolveClaudePaths(home).configDir;
	const ompRegistryPath = path.join(getPluginsDir(home), "installed_plugins.json");
	const resolvedProjectPath = cwd ? await resolveActiveProjectRegistryPath(cwd) : null;
	const projectRoot = resolvedProjectPath ? path.dirname(path.dirname(path.dirname(resolvedProjectPath))) : cwd;
	const activeClaudeProjectPath = projectRoot ? await canonicalClaudeProjectPath(projectRoot) : null;
	const canonicalCwd = cwd ? await canonicalClaudeProjectPath(cwd) : null;
	const settingsDirs = [...new Set([activeClaudeProjectPath, canonicalCwd].filter((d): d is string => !!d))];
	const enabledOverrides = await readClaudeEnabledPlugins(claudeConfigDir, settingsDirs);
	const cacheKey = `${claudeConfigDir}:${ompRegistryPath}:${resolvedProjectPath ?? ""}:${activeClaudeProjectPath ?? ""}:${canonicalCwd ?? ""}:${enabledOverrides.sources.join("|")}`;
	const cached = pluginRootsCache.get(cacheKey);
	if (cached) return cached;

	const roots: ClaudePluginRoot[] = [];
	const warnings: string[] = [];
	const projectRoots: ClaudePluginRoot[] = [];
	const canonicalClaudeProjectPaths = new Map<string, string | null>();

	// ── Claude Code registry ──────────────────────────────────────────────────
	const registryPath = path.join(claudeConfigDir, "plugins", "installed_plugins.json");
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
					// Claude Code's own on/off switch: `enabledPlugins` in settings.json /
					// settings.local.json. `false` hides the plugin here even though it is
					// installed; `true` opts a project-bound install into this project even
					// when its recorded projectPath is a different directory.
					const override = enabledOverrides.enabled.get(pluginId);
					if (override === false) continue;
					if ((entry.scope === "local" || entry.scope === "project") && override !== true) {
						if (!entry.projectPath || !activeClaudeProjectPath) continue;
						let entryProjectPath = canonicalClaudeProjectPaths.get(entry.projectPath);
						if (entryProjectPath === undefined) {
							entryProjectPath = await canonicalClaudeProjectPath(entry.projectPath);
							canonicalClaudeProjectPaths.set(entry.projectPath, entryProjectPath);
						}
						if (entryProjectPath !== activeClaudeProjectPath) continue;
					}

					roots.push({
						id: pluginId,
						marketplace,
						plugin: pluginName,
						version: entry.version || "unknown",
						path: entry.installPath,
						scope: entry.scope === "local" ? "project" : entry.scope || "user",
						origin: "claude",
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
	// Computed before the cache lookup because isolated SDK homes select distinct OMP registries.
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
						scope: entry.scope === "local" ? "project" : entry.scope || "user",
						origin: "omp",
					});
				}
			}
		} else {
			warnings.push(`Failed to parse OMP plugin registry: ${ompRegistryPath}`);
		}
	}

	// ── Project-scoped OMP registry ────────────────────────────────────────
	// Loaded from the nearest .omp/plugins/installed_plugins.json relative to cwd.
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
							origin: "omp",
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
	for (const invalidate of pluginCacheInvalidators) invalidate();
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
	invalidateFsCache(path.join(resolveClaudePaths().configDir, "plugins", "installed_plugins.json"));
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
		// Read plugin name from manifest: Claude marketplace layout first, then
		// the Agent Plugins standard root manifest (agent-plugins.org). Each
		// manifest is resolved and proven inside the plugin directory BEFORE the
		// read (Agent Plugins §4.1) — an escaping symlink falls back to the
		// directory basename without consuming outside content.
		let pluginName = path.basename(resolved);
		const realRoot = await realpathIfExists(resolved);
		if (realRoot !== null) {
			for (const manifestPath of [
				path.join(realRoot, ".claude-plugin", "plugin.json"),
				path.join(realRoot, "plugin.json"),
			]) {
				const contained = await resolveContainedPath(realRoot, manifestPath);
				if (contained.status !== "ok") continue;
				try {
					const manifest = await Bun.file(contained.realPath).json();
					if (typeof manifest?.name === "string" && manifest.name) {
						pluginName = manifest.name;
						break;
					}
				} catch {
					// Invalid manifest — try next, fall back to directory name
				}
			}
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
