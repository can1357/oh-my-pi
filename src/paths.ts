import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

// Legacy manifest (for migration)
export const LEGACY_MANIFEST_PATH = join(PLUGINS_DIR, "manifest.json");

// Project-local config directory
export const PROJECT_PI_DIR = ".pi";

// Project-local plugins.json
export const PROJECT_PLUGINS_JSON = join(PROJECT_PI_DIR, "plugins.json");

// Project-local lock file
export const PROJECT_PLUGINS_LOCK = join(PROJECT_PI_DIR, "plugins-lock.json");

// Project-local node_modules
export const PROJECT_NODE_MODULES = join(PROJECT_PI_DIR, "node_modules");

/**
 * Get the agent directory (where symlinks are installed)
 */
export function getAgentDir(global = true): string {
	if (global) {
		return join(PI_CONFIG_DIR, "agent");
	}
	return join(PROJECT_PI_DIR, "agent");
}

/**
 * Get the plugins directory for the given scope
 */
export function getPluginsDir(global = true): string {
	if (global) {
		return PLUGINS_DIR;
	}
	return PROJECT_PI_DIR;
}

/**
 * Get the node_modules directory for the given scope
 */
export function getNodeModulesDir(global = true): string {
	if (global) {
		return NODE_MODULES_DIR;
	}
	return PROJECT_NODE_MODULES;
}

/**
 * Get the package.json path for the given scope
 */
export function getPackageJsonPath(global = true): string {
	if (global) {
		return GLOBAL_PACKAGE_JSON;
	}
	return PROJECT_PLUGINS_JSON;
}

/**
 * Check if a project-local .pi/plugins.json exists in the current working directory
 */
export function hasProjectPlugins(): boolean {
	return existsSync(PROJECT_PLUGINS_JSON);
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
