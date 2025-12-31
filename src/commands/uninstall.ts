import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import chalk from "chalk";
import { loadPluginsJson, readPluginPackageJson, savePluginsJson } from "../manifest.js";
import { npmUninstall } from "../npm.js";
import { NODE_MODULES_DIR, PLUGINS_DIR, PROJECT_NODE_MODULES } from "../paths.js";
import { removePluginSymlinks } from "../symlinks.js";

export interface UninstallOptions {
	global?: boolean;
	json?: boolean;
}

/**
 * Uninstall a plugin
 */
export async function uninstallPlugin(name: string, options: UninstallOptions = {}): Promise<void> {
	const isGlobal = options.global !== false; // Default to global
	const prefix = isGlobal ? PLUGINS_DIR : ".pi";
	const nodeModules = isGlobal ? NODE_MODULES_DIR : PROJECT_NODE_MODULES;

	// Check if plugin is installed
	const pluginsJson = await loadPluginsJson(isGlobal);
	if (!pluginsJson.plugins[name]) {
		console.log(chalk.yellow(`Plugin "${name}" is not installed.`));
		return;
	}

	try {
		console.log(chalk.blue(`Uninstalling ${name}...`));

		// 1. Read package.json for omp.install entries before uninstalling
		const pkgJson = await readPluginPackageJson(name, isGlobal);

		// 2. Remove symlinks
		if (pkgJson) {
			await removePluginSymlinks(name, pkgJson);
		}

		// 3. npm uninstall
		try {
			await npmUninstall([name], prefix);
		} catch (_err) {
			// Package might have been installed via file: protocol
			// Try to remove manually from node_modules
			const pluginDir = join(nodeModules, name);
			if (existsSync(pluginDir)) {
				await rm(pluginDir, { recursive: true, force: true });
			}
		}

		// 4. Update plugins.json/package.json
		delete pluginsJson.plugins[name];
		// Also remove from disabled list if present
		if (pluginsJson.disabled) {
			pluginsJson.disabled = pluginsJson.disabled.filter((n) => n !== name);
		}
		await savePluginsJson(pluginsJson, isGlobal);

		console.log(chalk.green(`✓ Uninstalled "${name}"`));

		if (options.json) {
			console.log(JSON.stringify({ name, success: true }, null, 2));
		}
	} catch (err) {
		console.log(chalk.red(`Error uninstalling plugin: ${(err as Error).message}`));

		if (options.json) {
			console.log(JSON.stringify({ name, success: false, error: (err as Error).message }, null, 2));
		}
	}
}
