import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

// Embed package.json at build time for config
import packageJson from "../package.json" with { type: "json" };

// =============================================================================
// App Config (from embedded package.json)
// =============================================================================

export const APP_NAME: string = (packageJson as { ompConfig?: { name?: string } }).ompConfig?.name || "omp";
export const CONFIG_DIR_NAME: string =
	(packageJson as { ompConfig?: { configDir?: string } }).ompConfig?.configDir || ".omp";
export const VERSION: string = (packageJson as { version: string }).version;

const priorityList = [
	{ dir: ".omp", globalAgentDir: ".omp/agent" },
	{ dir: ".pi", globalAgentDir: ".pi/agent" },
	{ dir: ".claude" },
	{ dir: ".codex" },
	{ dir: ".gemini" },
];

// e.g., OMP_CODING_AGENT_DIR
export const ENV_AGENT_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`;

// =============================================================================
// Package Directory (for optional external docs/examples)
// =============================================================================

/**
 * Get the base directory for resolving optional package assets (docs, examples).
 * Walk up from import.meta.dir until we find package.json, or fall back to cwd.
 */
export function getPackageDir(): string {
	let dir = import.meta.dir;
	while (dir !== dirname(dir)) {
		if (existsSync(join(dir, "package.json"))) {
			return dir;
		}
		dir = dirname(dir);
	}
	// Fallback to cwd (docs/examples won't be found, but that's fine)
	return process.cwd();
}

/** Get path to README.md (optional, may not exist in binary) */
export function getReadmePath(): string {
	return resolve(join(getPackageDir(), "README.md"));
}

/** Get path to docs directory (optional, may not exist in binary) */
export function getDocsPath(): string {
	return resolve(join(getPackageDir(), "docs"));
}

/** Get path to examples directory (optional, may not exist in binary) */
export function getExamplesPath(): string {
	return resolve(join(getPackageDir(), "examples"));
}

/** Get path to CHANGELOG.md (optional, may not exist in binary) */
export function getChangelogPath(): string {
	return resolve(join(getPackageDir(), "CHANGELOG.md"));
}

// =============================================================================
// User Config Paths (~/.omp/agent/*)
// =============================================================================

/** Get the agent config directory (e.g., ~/.omp/agent/) */
export function getAgentDir(): string {
	return process.env[ENV_AGENT_DIR] || join(homedir(), CONFIG_DIR_NAME, "agent");
}

/** Get path to user's custom themes directory */
export function getCustomThemesDir(): string {
	return join(getAgentDir(), "themes");
}

/** Get path to models.json */
export function getModelsPath(): string {
	return join(getAgentDir(), "models.json");
}

/** Get path to auth.json */
export function getAuthPath(): string {
	return join(getAgentDir(), "auth.json");
}

/** Get path to settings.json */
export function getSettingsPath(): string {
	return join(getAgentDir(), "settings.json");
}

/** Get path to tools directory */
export function getToolsDir(): string {
	return join(getAgentDir(), "tools");
}

/** Get path to slash commands directory */
export function getCommandsDir(): string {
	return join(getAgentDir(), "commands");
}

/** Get path to sessions directory */
export function getSessionsDir(): string {
	return join(getAgentDir(), "sessions");
}

/** Get path to debug log file */
export function getDebugLogPath(): string {
	return join(getAgentDir(), `${APP_NAME}-debug.log`);
}

// =============================================================================
// Multi-Config Directory Helpers
// =============================================================================

/**
 * Config directory bases in priority order (highest first).
 * User-level: ~/.omp/agent, ~/.pi/agent, ~/.claude, ~/.codex, ~/.gemini
 * Project-level: .omp, .pi, .claude, .codex, .gemini
 */
const USER_CONFIG_BASES = priorityList.map(({ dir, globalAgentDir }) => ({
	base: () => join(homedir(), globalAgentDir ?? dir),
	name: dir,
}));

const PROJECT_CONFIG_BASES = priorityList.map(({ dir }) => ({
	base: dir,
	name: dir,
}));

export interface ConfigDirEntry {
	path: string;
	source: string; // e.g., ".omp", ".pi", ".claude"
	level: "user" | "project";
}

export interface GetConfigDirsOptions {
	/** Include user-level directories (~/.omp/agent/...). Default: true */
	user?: boolean;
	/** Include project-level directories (.omp/...). Default: true */
	project?: boolean;
	/** Current working directory for project paths. Default: process.cwd() */
	cwd?: string;
	/** Only return directories that exist. Default: false */
	existingOnly?: boolean;
}

/**
 * Get all config directories for a subpath, ordered by priority (highest first).
 *
 * @param subpath - Subpath within config dirs (e.g., "commands", "hooks", "agents")
 * @param options - Options for filtering
 * @returns Array of directory entries, highest priority first
 *
 * @example
 * // Get all command directories
 * getConfigDirs("commands")
 * // → [{ path: "~/.omp/agent/commands", source: ".omp", level: "user" }, ...]
 *
 * @example
 * // Get only existing project skill directories
 * getConfigDirs("skills", { user: false, existingOnly: true })
 */
export function getConfigDirs(subpath: string, options: GetConfigDirsOptions = {}): ConfigDirEntry[] {
	const { user = true, project = true, cwd = process.cwd(), existingOnly = false } = options;
	const results: ConfigDirEntry[] = [];

	// User-level directories (highest priority)
	if (user) {
		for (const { base, name } of USER_CONFIG_BASES) {
			const path = join(base(), subpath);
			if (!existingOnly || existsSync(path)) {
				results.push({ path, source: name, level: "user" });
			}
		}
	}

	// Project-level directories
	if (project) {
		for (const { base, name } of PROJECT_CONFIG_BASES) {
			const path = resolve(cwd, base, subpath);
			if (!existingOnly || existsSync(path)) {
				results.push({ path, source: name, level: "project" });
			}
		}
	}

	return results;
}

/**
 * Get all config directory paths for a subpath (convenience wrapper).
 * Returns just the paths, highest priority first.
 */
export function getConfigDirPaths(subpath: string, options: GetConfigDirsOptions = {}): string[] {
	return getConfigDirs(subpath, options).map((e) => e.path);
}

export interface ConfigFileResult<T> {
	path: string;
	source: string;
	level: "user" | "project";
	content: T;
}

/**
 * Read the first existing config file from priority-ordered locations.
 *
 * @param subpath - Subpath within config dirs (e.g., "settings.json", "models.json")
 * @param options - Options for filtering (same as getConfigDirs)
 * @returns The parsed content and metadata, or undefined if not found
 *
 * @example
 * const result = readConfigFile<Settings>("settings.json", { project: false });
 * if (result) {
 *   console.log(`Loaded from ${result.path}`);
 *   console.log(result.content);
 * }
 */
export function readConfigFile<T = unknown>(
	subpath: string,
	options: GetConfigDirsOptions = {},
): ConfigFileResult<T> | undefined {
	const dirs = getConfigDirs("", { ...options, existingOnly: false });

	for (const { path: base, source, level } of dirs) {
		const filePath = join(base, subpath);
		if (existsSync(filePath)) {
			try {
				const content = readFileSync(filePath, "utf-8");
				return {
					path: filePath,
					source,
					level,
					content: JSON.parse(content) as T,
				};
			} catch {
				// Continue to next file on parse error
			}
		}
	}

	return undefined;
}

/**
 * Get all existing config files for a subpath (for merging scenarios).
 * Returns in priority order (highest first).
 */
export function readAllConfigFiles<T = unknown>(
	subpath: string,
	options: GetConfigDirsOptions = {},
): ConfigFileResult<T>[] {
	const dirs = getConfigDirs("", { ...options, existingOnly: false });
	const results: ConfigFileResult<T>[] = [];

	for (const { path: base, source, level } of dirs) {
		const filePath = join(base, subpath);
		if (existsSync(filePath)) {
			try {
				const content = readFileSync(filePath, "utf-8");
				results.push({
					path: filePath,
					source,
					level,
					content: JSON.parse(content) as T,
				});
			} catch {
				// Skip files that fail to parse
			}
		}
	}

	return results;
}

/**
 * Find the first existing config file (for non-JSON files like SYSTEM.md).
 * Returns just the path, or undefined if not found.
 */
export function findConfigFile(subpath: string, options: GetConfigDirsOptions = {}): string | undefined {
	const dirs = getConfigDirs("", { ...options, existingOnly: false });

	for (const { path: base } of dirs) {
		const filePath = join(base, subpath);
		if (existsSync(filePath)) {
			return filePath;
		}
	}

	return undefined;
}

/**
 * Find the first existing config file with metadata.
 */
export function findConfigFileWithMeta(
	subpath: string,
	options: GetConfigDirsOptions = {},
): Omit<ConfigFileResult<never>, "content"> | undefined {
	const dirs = getConfigDirs("", { ...options, existingOnly: false });

	for (const { path: base, source, level } of dirs) {
		const filePath = join(base, subpath);
		if (existsSync(filePath)) {
			return { path: filePath, source, level };
		}
	}

	return undefined;
}

// =============================================================================
// Walk-Up Config Discovery (for monorepo scenarios)
// =============================================================================

function isDirectory(p: string): boolean {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Find nearest config directory by walking up from cwd.
 * Checks all config bases (.omp, .pi, .claude) at each level.
 *
 * @param subpath - Subpath within config dirs (e.g., "commands", "agents")
 * @param cwd - Starting directory
 * @returns First existing directory found, or undefined
 */
export function findNearestProjectConfigDir(subpath: string, cwd: string = process.cwd()): ConfigDirEntry | undefined {
	let currentDir = cwd;

	while (true) {
		// Check all config bases at this level, in priority order
		for (const { base, name } of PROJECT_CONFIG_BASES) {
			const candidate = join(currentDir, base, subpath);
			if (isDirectory(candidate)) {
				return { path: candidate, source: name, level: "project" };
			}
		}

		// Move up one directory
		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) break; // Reached root
		currentDir = parentDir;
	}

	return undefined;
}

/**
 * Find all nearest config directories by walking up from cwd.
 * Returns one entry per config base (.omp, .pi, .claude) - the nearest one found.
 * Results are in priority order (highest first).
 */
export function findAllNearestProjectConfigDirs(subpath: string, cwd: string = process.cwd()): ConfigDirEntry[] {
	const results: ConfigDirEntry[] = [];
	const foundBases = new Set<string>();

	let currentDir = cwd;

	while (foundBases.size < PROJECT_CONFIG_BASES.length) {
		for (const { base, name } of PROJECT_CONFIG_BASES) {
			if (foundBases.has(name)) continue;

			const candidate = join(currentDir, base, subpath);
			if (isDirectory(candidate)) {
				results.push({ path: candidate, source: name, level: "project" });
				foundBases.add(name);
			}
		}

		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) break;
		currentDir = parentDir;
	}

	// Sort by priority order
	const order = PROJECT_CONFIG_BASES.map((b) => b.name);
	results.sort((a, b) => order.indexOf(a.source) - order.indexOf(b.source));

	return results;
}
