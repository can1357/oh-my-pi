/**
 * Plugin loader - discovers and loads tools/hooks from installed plugins.
 *
 * Reads enabled plugins from the runtime config and loads their tools/hooks
 * based on manifest entries and enabled features.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	getAllProjectPluginOverridePaths,
	getPluginsLockfile,
	getPluginsNodeModules,
	getPluginsPackageJson,
} from "./paths";
import type { InstalledPlugin, PluginManifest, PluginRuntimeConfig, ProjectPluginOverrides } from "./types";

// =============================================================================
// Runtime Config Loading
// =============================================================================

/**
 * Load plugin runtime config from lock file.
 */
function loadRuntimeConfig(): PluginRuntimeConfig {
	const lockPath = getPluginsLockfile();
	if (!existsSync(lockPath)) {
		return { plugins: {}, settings: {} };
	}
	try {
		return JSON.parse(readFileSync(lockPath, "utf-8"));
	} catch {
		return { plugins: {}, settings: {} };
	}
}

/**
 * Load project-local plugin overrides (checks .omp and .pi directories).
 */
function loadProjectOverrides(cwd: string): ProjectPluginOverrides {
	for (const overridesPath of getAllProjectPluginOverridePaths(cwd)) {
		if (existsSync(overridesPath)) {
			try {
				return JSON.parse(readFileSync(overridesPath, "utf-8"));
			} catch {
				// Continue to next path
			}
		}
	}
	return {};
}

// =============================================================================
// Plugin Discovery
// =============================================================================

/**
 * Get list of enabled plugins with their resolved configurations.
 * Respects both global runtime config and project overrides.
 */
export function getEnabledPlugins(cwd: string): InstalledPlugin[] {
	const pkgJsonPath = getPluginsPackageJson();
	if (!existsSync(pkgJsonPath)) {
		return [];
	}

	const nodeModulesPath = getPluginsNodeModules();
	if (!existsSync(nodeModulesPath)) {
		return [];
	}

	const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
	const deps = pkg.dependencies || {};
	const runtimeConfig = loadRuntimeConfig();
	const projectOverrides = loadProjectOverrides(cwd);
	const plugins: InstalledPlugin[] = [];

	for (const [name] of Object.entries(deps)) {
		const pluginPkgPath = join(nodeModulesPath, name, "package.json");
		if (!existsSync(pluginPkgPath)) {
			continue;
		}

		const pluginPkg = JSON.parse(readFileSync(pluginPkgPath, "utf-8"));
		const manifest: PluginManifest | undefined = pluginPkg.omp || pluginPkg.pi;

		if (!manifest) {
			// Not an omp plugin, skip
			continue;
		}

		manifest.version = pluginPkg.version;

		const runtimeState = runtimeConfig.plugins[name];

		// Check if disabled globally
		if (runtimeState && !runtimeState.enabled) {
			continue;
		}

		// Check if disabled in project
		if (projectOverrides.disabled?.includes(name)) {
			continue;
		}

		// Resolve enabled features (project overrides take precedence)
		const enabledFeatures = projectOverrides.features?.[name] ?? runtimeState?.enabledFeatures ?? null;

		plugins.push({
			name,
			version: pluginPkg.version,
			path: join(nodeModulesPath, name),
			manifest,
			enabledFeatures,
			enabled: true,
		});
	}

	return plugins;
}

// =============================================================================
// Path Resolution
// =============================================================================

/**
 * Resolve tool entry points for a plugin based on manifest and enabled features.
 * Returns absolute paths to tool modules.
 */
export function resolvePluginToolPaths(plugin: InstalledPlugin): string[] {
	const paths: string[] = [];
	const manifest = plugin.manifest;

	// Base tools entry (always included if exists)
	if (manifest.tools) {
		const toolPath = join(plugin.path, manifest.tools);
		if (existsSync(toolPath)) {
			paths.push(toolPath);
		}
	}

	// Feature-specific tools
	if (manifest.features && plugin.enabledFeatures) {
		const enabledSet = new Set(plugin.enabledFeatures);

		for (const [featName, feat] of Object.entries(manifest.features)) {
			if (!enabledSet.has(featName)) continue;

			if (feat.tools) {
				for (const toolEntry of feat.tools) {
					const toolPath = join(plugin.path, toolEntry);
					if (existsSync(toolPath)) {
						paths.push(toolPath);
					}
				}
			}
		}
	} else if (manifest.features && plugin.enabledFeatures === null) {
		// null means use defaults - enable features with default: true
		for (const [_featName, feat] of Object.entries(manifest.features)) {
			if (!feat.default) continue;

			if (feat.tools) {
				for (const toolEntry of feat.tools) {
					const toolPath = join(plugin.path, toolEntry);
					if (existsSync(toolPath)) {
						paths.push(toolPath);
					}
				}
			}
		}
	}

	return paths;
}

/**
 * Resolve hook entry points for a plugin based on manifest and enabled features.
 * Returns absolute paths to hook modules.
 */
export function resolvePluginHookPaths(plugin: InstalledPlugin): string[] {
	const paths: string[] = [];
	const manifest = plugin.manifest;

	// Base hooks entry (always included if exists)
	if (manifest.hooks) {
		const hookPath = join(plugin.path, manifest.hooks);
		if (existsSync(hookPath)) {
			paths.push(hookPath);
		}
	}

	// Feature-specific hooks
	if (manifest.features && plugin.enabledFeatures) {
		const enabledSet = new Set(plugin.enabledFeatures);

		for (const [featName, feat] of Object.entries(manifest.features)) {
			if (!enabledSet.has(featName)) continue;

			if (feat.hooks) {
				for (const hookEntry of feat.hooks) {
					const hookPath = join(plugin.path, hookEntry);
					if (existsSync(hookPath)) {
						paths.push(hookPath);
					}
				}
			}
		}
	} else if (manifest.features && plugin.enabledFeatures === null) {
		// null means use defaults - enable features with default: true
		for (const [_featName, feat] of Object.entries(manifest.features)) {
			if (!feat.default) continue;

			if (feat.hooks) {
				for (const hookEntry of feat.hooks) {
					const hookPath = join(plugin.path, hookEntry);
					if (existsSync(hookPath)) {
						paths.push(hookPath);
					}
				}
			}
		}
	}

	return paths;
}

/**
 * Resolve command file paths for a plugin based on manifest and enabled features.
 * Returns absolute paths to command files (.md).
 */
export function resolvePluginCommandPaths(plugin: InstalledPlugin): string[] {
	const paths: string[] = [];
	const manifest = plugin.manifest;

	// Base commands (always included if exists)
	if (manifest.commands) {
		for (const cmdEntry of manifest.commands) {
			const cmdPath = join(plugin.path, cmdEntry);
			if (existsSync(cmdPath)) {
				paths.push(cmdPath);
			}
		}
	}

	// Feature-specific commands
	if (manifest.features && plugin.enabledFeatures) {
		const enabledSet = new Set(plugin.enabledFeatures);

		for (const [featName, feat] of Object.entries(manifest.features)) {
			if (!enabledSet.has(featName)) continue;

			if (feat.commands) {
				for (const cmdEntry of feat.commands) {
					const cmdPath = join(plugin.path, cmdEntry);
					if (existsSync(cmdPath)) {
						paths.push(cmdPath);
					}
				}
			}
		}
	} else if (manifest.features && plugin.enabledFeatures === null) {
		// null means use defaults - enable features with default: true
		for (const [_featName, feat] of Object.entries(manifest.features)) {
			if (!feat.default) continue;

			if (feat.commands) {
				for (const cmdEntry of feat.commands) {
					const cmdPath = join(plugin.path, cmdEntry);
					if (existsSync(cmdPath)) {
						paths.push(cmdPath);
					}
				}
			}
		}
	}

	return paths;
}

// =============================================================================
// Aggregated Discovery
// =============================================================================

/**
 * Get all tool paths from all enabled plugins.
 */
export function getAllPluginToolPaths(cwd: string): string[] {
	const plugins = getEnabledPlugins(cwd);
	const paths: string[] = [];

	for (const plugin of plugins) {
		paths.push(...resolvePluginToolPaths(plugin));
	}

	return paths;
}

/**
 * Get all hook paths from all enabled plugins.
 */
export function getAllPluginHookPaths(cwd: string): string[] {
	const plugins = getEnabledPlugins(cwd);
	const paths: string[] = [];

	for (const plugin of plugins) {
		paths.push(...resolvePluginHookPaths(plugin));
	}

	return paths;
}

/**
 * Get all command paths from all enabled plugins.
 */
export function getAllPluginCommandPaths(cwd: string): string[] {
	const plugins = getEnabledPlugins(cwd);
	const paths: string[] = [];

	for (const plugin of plugins) {
		paths.push(...resolvePluginCommandPaths(plugin));
	}

	return paths;
}

/**
 * Get plugin settings for use in tool/hook contexts.
 * Merges global settings with project overrides.
 */
export function getPluginSettings(pluginName: string, cwd: string): Record<string, unknown> {
	const runtimeConfig = loadRuntimeConfig();
	const projectOverrides = loadProjectOverrides(cwd);

	const global = runtimeConfig.settings[pluginName] || {};
	const project = projectOverrides.settings?.[pluginName] || {};

	return { ...global, ...project };
}
