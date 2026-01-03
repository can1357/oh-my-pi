import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getConfigDirPaths } from "../../config";

// =============================================================================
// Plugin Directory Paths
// =============================================================================

/** Root plugin directory: ~/.omp/plugins (not under agent/) */
export function getPluginsDir(): string {
	return join(homedir(), CONFIG_DIR_NAME, "plugins");
}

/** Where npm installs packages: ~/.omp/plugins/node_modules */
export function getPluginsNodeModules(): string {
	return join(getPluginsDir(), "node_modules");
}

/** Plugin manifest: ~/.omp/plugins/package.json */
export function getPluginsPackageJson(): string {
	return join(getPluginsDir(), "package.json");
}

/** Plugin lock file: ~/.omp/plugins/omp-plugins.lock.json */
export function getPluginsLockfile(): string {
	return join(getPluginsDir(), "omp-plugins.lock.json");
}

/** Project-local plugin overrides: .omp/plugin-overrides.json (primary) */
export function getProjectPluginOverrides(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, "plugin-overrides.json");
}

/** All possible project plugin override paths (primary + legacy) */
export function getAllProjectPluginOverridePaths(cwd: string): string[] {
	return getConfigDirPaths("plugin-overrides.json", { user: false, cwd });
}
