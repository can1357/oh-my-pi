import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, getProjectDir } from "@oh-my-pi/pi-utils";
import { expandTilde } from "./tools/path-utils";

export * from "./config/config-file";

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
 * omp's config directories: user-level is the agent dir (`getAgentDir()`: profile,
 * `PI_CONFIG_DIR`, and `PI_CODING_AGENT_DIR` aware); project-level is `<cwd>/.omp`.
 */
export interface ConfigDirEntry {
	path: string;
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
 * // → [{ path: "~/.omp/agent/commands", level: "user" }, { path: "<cwd>/.omp/commands", level: "project" }]
 *
 * @example
 * // Get only existing project skill directories
 * getConfigDirs("skills", { user: false, existingOnly: true })
 */
export function getConfigDirs(subpath: string, options: GetConfigDirsOptions = {}): ConfigDirEntry[] {
	const { user = true, project = true, cwd = getProjectDir(), existingOnly = false } = options;
	const results: ConfigDirEntry[] = [];

	// User-level directory (highest priority)
	if (user) {
		const resolvedPath = path.resolve(getAgentDir(), subpath);
		if (!existingOnly || fs.existsSync(resolvedPath)) {
			results.push({ path: resolvedPath, level: "user" });
		}
	}

	// Project-level directory
	if (project) {
		const resolvedPath = path.resolve(cwd, CONFIG_DIR_NAME, subpath);
		if (!existingOnly || fs.existsSync(resolvedPath)) {
			results.push({ path: resolvedPath, level: "project" });
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

// =============================================================================
// Walk-Up Config Discovery (for monorepo scenarios)
// =============================================================================

/**
 * Find the nearest project config directory (`.omp/<subpath>`) by walking up from cwd.
 * Returns it as a single entry, or an empty array when no ancestor has one.
 */
export function findAllNearestProjectConfigDirs(subpath: string, cwd: string = getProjectDir()): ConfigDirEntry[] {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, CONFIG_DIR_NAME, subpath);
		try {
			if (fs.statSync(candidate).isDirectory()) return [{ path: candidate, level: "project" }];
		} catch {}
		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return [];
		currentDir = parentDir;
	}
}
