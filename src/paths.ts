import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

// Global pi configuration directory
export const PI_CONFIG_DIR = join(homedir(), ".pi");

// Global plugins directory
export const PLUGINS_DIR = join(PI_CONFIG_DIR, "plugins");

// npm node_modules within plugins directory
export const NODE_MODULES_DIR = join(PLUGINS_DIR, "node_modules");

// Global package.json for plugin management
export const GLOBAL_PACKAGE_JSON = join(PLUGINS_DIR, "package.json");

// Global package-lock.json
export const GLOBAL_LOCK_FILE = join(PLUGINS_DIR, "package-lock.json");

// Project-local config directory
export const PROJECT_PI_DIR = ".pi";

// Project-local plugins.json
export const PROJECT_PLUGINS_JSON = join(PROJECT_PI_DIR, "plugins.json");

// Project-local package.json (for npm operations)
export const PROJECT_PACKAGE_JSON = join(PROJECT_PI_DIR, "package.json");

// Project-local lock file
export const PROJECT_PLUGINS_LOCK = join(PROJECT_PI_DIR, "plugins-lock.json");

// Project-local node_modules
export const PROJECT_NODE_MODULES = join(PROJECT_PI_DIR, "node_modules");

/**
 * Find the project root by walking up parent directories looking for .pi/plugins.json.
 * Similar to how git finds .git directories.
 *
 * @returns The absolute path to the project root, or null if not found
 */
export function findProjectRoot(): string | null {
	let dir = process.cwd();
	const root = resolve("/");

	while (dir !== root) {
		if (existsSync(join(dir, ".pi", "plugins.json"))) {
			return dir;
		}
		const parent = dirname(dir);
		if (parent === dir) break; // Reached filesystem root
		dir = parent;
	}

	return null;
}

/**
 * Check if a project-local .pi/plugins.json exists in the current directory or any parent
 */
export function hasProjectPlugins(): boolean {
	return findProjectRoot() !== null;
}

/**
 * Get the project .pi directory path.
 * Uses findProjectRoot() to locate the project, or falls back to cwd.
 */
export function getProjectPiDir(): string {
	const projectRoot = findProjectRoot();
	if (projectRoot) {
		return join(projectRoot, ".pi");
	}
	// Fallback to cwd (e.g., for init command)
	return resolve(PROJECT_PI_DIR);
}

/**
 * Get the plugins directory for the given scope
 */
export function getPluginsDir(global = true): string {
	if (global) {
		return PLUGINS_DIR;
	}
	return getProjectPiDir();
}

/**
 * Get the node_modules directory for the given scope
 */
export function getNodeModulesDir(global = true): string {
	if (global) {
		return NODE_MODULES_DIR;
	}
	return join(getProjectPiDir(), "node_modules");
}

/**
 * Get the package.json path for the given scope
 */
export function getPackageJsonPath(global = true): string {
	if (global) {
		return GLOBAL_PACKAGE_JSON;
	}
	return join(getProjectPiDir(), "plugins.json");
}

/**
 * Get the agent directory (where symlinks are installed)
 */
export function getAgentDir(global = true): string {
	if (global) {
		return join(PI_CONFIG_DIR, "agent");
	}
	return join(getProjectPiDir(), "agent");
}

/**
 * Resolve whether to use global or local scope based on CLI flags and auto-detection.
 *
 * Logic:
 * - If --global is passed: use global mode
 * - If --local is passed: use local mode
 * - If neither: check if .pi/plugins.json exists in cwd, if so use local, otherwise use global
 *
 * @param options - CLI options containing global and local flags
 * @returns true if global scope should be used, false for local
 */
export function resolveScope(options: { global?: boolean; local?: boolean }): boolean {
	if (options.global) {
		return true;
	}
	if (options.local) {
		return false;
	}
	// Auto-detect: if project-local plugins.json exists, use local mode
	return !hasProjectPlugins();
}
