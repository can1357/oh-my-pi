import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "../../config";

// =============================================================================
// Plugin Directory Paths
// =============================================================================

/** Root plugin directory: ~/.pi/plugins (not under agent/) */
export function getPluginsDir(): string {
	return join(homedir(), CONFIG_DIR_NAME, "plugins");
}

/** Where npm installs packages: ~/.pi/plugins/node_modules */
export function getPluginsNodeModules(): string {
	return join(getPluginsDir(), "node_modules");
}

/** Plugin manifest: ~/.pi/plugins/package.json */
export function getPluginsPackageJson(): string {
	return join(getPluginsDir(), "package.json");
}

/** Plugin lock file: ~/.pi/plugins/pi-plugins.lock.json */
export function getPluginsLockfile(): string {
	return join(getPluginsDir(), "pi-plugins.lock.json");
}

/** Project-local plugin overrides: .pi/plugin-overrides.json */
export function getProjectPluginOverrides(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, "plugin-overrides.json");
}
