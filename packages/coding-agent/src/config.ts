import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getConfigAgentDirName, getProjectDir } from "@oh-my-pi/pi-utils";
import { isUserSourceEnabled } from "./capability";
import { resolveClaudePaths } from "./config/claude-paths";
import { expandTilde } from "./tools/path-utils";

export * from "./config/config-file";

const priorityList = [
	{ dir: CONFIG_DIR_NAME, globalAgentDir: getConfigAgentDirName },
	{ dir: ".claude" },
	{ dir: ".codex" },
	{ dir: ".gemini" },
];

// =============================================================================
// Package Directory (for optional external docs/examples)
// =============================================================================

/**
 * Walk up from `startDir` looking for a `package.json`. Returns the directory
 * containing the marker, or `undefined` when the walk hits the filesystem root
 * without finding one.
 *
 * Exported for unit-testing the resolution contract from arbitrary start
 * directories (notably the `bun --compile` case where `import.meta.dir`
 * resolves to `/$bunfs/root` and no owning package is locatable — issue
 * #1423). Production callers should use {@link getPackageDir} instead.
 */
export function walkUpForPackageDir(startDir: string): string | undefined {
	let dir = startDir;
	while (dir !== path.dirname(dir)) {
		if (fs.existsSync(path.join(dir, "package.json"))) {
			return dir;
		}
		dir = path.dirname(dir);
	}
	return undefined;
}

/**
 * Get the base directory for resolving optional package assets (docs, examples, CHANGELOG.md).
 *
 * Honors the `PI_PACKAGE_DIR` override (useful for Nix/Guix store paths);
 * otherwise walks up from `import.meta.dir` looking for a `package.json`.
 * Returns `undefined` when no owning package is locatable — notably inside
 * `bun --compile` binaries where `import.meta.dir` resolves to `/$bunfs/root`
 * and the walk hits the filesystem root with nothing found.
 *
 * Callers MUST treat `undefined` as "no package assets available" and skip the
 * lookup. NEVER fall back to the user's `cwd` here: that conflates the host
 * project with omp's own assets and was the source of issue #1423 (the host
 * project's `CHANGELOG.md` rendered as omp's startup changelog).
 */
export function getPackageDir(): string | undefined {
	const envDir = process.env.PI_PACKAGE_DIR;
	if (envDir) {
		return expandTilde(envDir);
	}
	return walkUpForPackageDir(import.meta.dir);
}

/**
 * Path to omp's own `CHANGELOG.md`, or `undefined` when the package directory
 * cannot be resolved (e.g. inside `bun --compile` binaries that don't bundle
 * package assets). Callers MUST skip changelog parsing when this is undefined;
 * see issue #1423.
 */
export function getChangelogPath(): string | undefined {
	const packageDir = getPackageDir();
	return packageDir ? path.resolve(packageDir, "CHANGELOG.md") : undefined;
}

// =============================================================================
// Multi-Config Directory Helpers
// =============================================================================

/**
 * User-level: ~/.omp/agent, Claude's active config directory, ~/.codex, ~/.gemini
 * Project-level: .omp, .claude, .codex, .gemini
 */
const USER_CONFIG_BASES = priorityList.map(({ dir, globalAgentDir }) => ({
	base: () =>
		dir === ".claude" ? resolveClaudePaths().configDir : path.join(os.homedir(), globalAgentDir?.() ?? dir),
	name: dir,
}));

const PROJECT_CONFIG_BASES = priorityList.map(({ dir }) => ({
	base: dir,
	name: dir,
}));

export interface ConfigDirEntry {
	path: string;
	source: string; // e.g., ".omp", ".claude"
	level: "user" | "project";
}

export interface GetConfigDirsOptions {
	/** Include user-level directories (~/.omp/agent/...). Default: true */
	user?: boolean;
	/** Include project-level directories (.omp/...). Default: true */
	project?: boolean;
	/** Current working directory for project paths. Default: getProjectDir() */
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
	const { user = true, project = true, cwd = getProjectDir(), existingOnly = false } = options;
	const results: ConfigDirEntry[] = [];

	// User-level directories (highest priority)
	if (user) {
		for (const { base, name } of USER_CONFIG_BASES) {
			if (name !== CONFIG_DIR_NAME && !isUserSourceEnabled(name.replace(/^\./, ""))) {
				continue;
			}
			const resolvedPath = path.resolve(base(), subpath);
			if (!existingOnly || fs.existsSync(resolvedPath)) {
				results.push({ path: resolvedPath, source: name, level: "user" });
			}
		}
	}

	// Project-level directories
	if (project) {
		for (const { base, name } of PROJECT_CONFIG_BASES) {
			const resolvedPath = path.resolve(cwd, base, subpath);
			if (!existingOnly || fs.existsSync(resolvedPath)) {
				results.push({ path: resolvedPath, source: name, level: "project" });
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
	return getConfigDirs(subpath, options).map(e => e.path);
}

export interface ConfigFileResult<T> {
	path: string;
	source: string;
	level: "user" | "project";
	content: T;
}

/**
 * Find the first existing config file (for non-JSON files like SYSTEM.md).
 * Returns just the path, or undefined if not found.
 */
export function findConfigFile(subpath: string, options: GetConfigDirsOptions = {}): string | undefined {
	const dirs = getConfigDirs("", { ...options, existingOnly: false });

	for (const { path: base } of dirs) {
		const filePath = path.join(base, subpath);
		if (fs.existsSync(filePath)) {
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
		const filePath = path.join(base, subpath);
		if (fs.existsSync(filePath)) {
			return { path: filePath, source, level };
		}
	}

	return undefined;
}

// =============================================================================
// Walk-Up Config Discovery (for monorepo scenarios)
// =============================================================================

/**
 * Find all nearest config directories by walking up from cwd.
 * Returns one entry per config base (.omp, .claude) - the nearest one found.
 * Results are in priority order (highest first).
 */
export function findAllNearestProjectConfigDirs(subpath: string, cwd: string = getProjectDir()): ConfigDirEntry[] {
	const results: ConfigDirEntry[] = [];
	const foundBases = new Set<string>();

	let currentDir = cwd;

	while (foundBases.size < PROJECT_CONFIG_BASES.length) {
		for (const { base, name } of PROJECT_CONFIG_BASES) {
			if (foundBases.has(name)) continue;

			const candidate = path.join(currentDir, base, subpath);
			try {
				if (fs.statSync(candidate).isDirectory()) {
					results.push({ path: candidate, source: name, level: "project" });
					foundBases.add(name);
				}
			} catch {}
		}

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) break;
		currentDir = parentDir;
	}

	// Sort by priority order
	const order = PROJECT_CONFIG_BASES.map(b => b.name);
	results.sort((a, b) => order.indexOf(a.source) - order.indexOf(b.source));

	return results;
}
