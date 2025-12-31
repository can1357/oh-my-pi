import chalk from "chalk";
import { loadPluginsJson, readPluginPackageJson } from "../manifest.js";
import { npmUpdate } from "../npm.js";
import { NODE_MODULES_DIR, PLUGINS_DIR, PROJECT_NODE_MODULES } from "../paths.js";
import { createPluginSymlinks, removePluginSymlinks } from "../symlinks.js";

export interface UpdateOptions {
	global?: boolean;
	json?: boolean;
}

/**
 * Update plugin(s) to latest within semver range
 */
export async function updatePlugin(name?: string, options: UpdateOptions = {}): Promise<void> {
	const isGlobal = options.global !== false;
	const prefix = isGlobal ? PLUGINS_DIR : ".pi";
	const _nodeModules = isGlobal ? NODE_MODULES_DIR : PROJECT_NODE_MODULES;

	const pluginsJson = await loadPluginsJson(isGlobal);
	const pluginNames = Object.keys(pluginsJson.plugins);

	if (pluginNames.length === 0) {
		console.log(chalk.yellow("No plugins installed."));
		return;
	}

	// If specific plugin name provided, verify it's installed
	if (name && !pluginsJson.plugins[name]) {
		console.log(chalk.yellow(`Plugin "${name}" is not installed.`));
		return;
	}

	const toUpdate = name ? [name] : pluginNames;

	// Filter out file: dependencies (local plugins)
	const npmPlugins = toUpdate.filter((n) => {
		const version = pluginsJson.plugins[n];
		return !version.startsWith("file:");
	});

	const localPlugins = toUpdate.filter((n) => {
		const version = pluginsJson.plugins[n];
		return version.startsWith("file:");
	});

	if (localPlugins.length > 0) {
		console.log(chalk.dim(`Skipping ${localPlugins.length} local plugin(s): ${localPlugins.join(", ")}`));
	}

	if (npmPlugins.length === 0) {
		console.log(chalk.yellow("No npm plugins to update."));
		return;
	}

	console.log(chalk.blue(`Updating ${npmPlugins.length} plugin(s)...`));

	const results: Array<{ name: string; from: string; to: string; success: boolean }> = [];

	try {
		// Get current versions before update
		const beforeVersions: Record<string, string> = {};
		for (const pluginName of npmPlugins) {
			const pkgJson = await readPluginPackageJson(pluginName, isGlobal);
			if (pkgJson) {
				beforeVersions[pluginName] = pkgJson.version;

				// Remove old symlinks before update
				await removePluginSymlinks(pluginName, pkgJson, false);
			}
		}

		// npm update
		await npmUpdate(npmPlugins, prefix);

		// Re-process symlinks for each updated plugin
		for (const pluginName of npmPlugins) {
			const pkgJson = await readPluginPackageJson(pluginName, isGlobal);
			if (pkgJson) {
				const beforeVersion = beforeVersions[pluginName] || "unknown";
				const afterVersion = pkgJson.version;

				// Create new symlinks
				await createPluginSymlinks(pluginName, pkgJson, isGlobal);

				const changed = beforeVersion !== afterVersion;
				if (changed) {
					console.log(chalk.green(`  ✓ ${pluginName}: ${beforeVersion} → ${afterVersion}`));
				} else {
					console.log(chalk.dim(`  · ${pluginName}: ${afterVersion} (already latest)`));
				}

				results.push({
					name: pluginName,
					from: beforeVersion,
					to: afterVersion,
					success: true,
				});
			}
		}

		const updated = results.filter((r) => r.from !== r.to);
		console.log();
		console.log(chalk.dim(`Updated: ${updated.length}, Already latest: ${results.length - updated.length}`));

		if (options.json) {
			console.log(JSON.stringify({ results }, null, 2));
		}
	} catch (err) {
		console.log(chalk.red(`Error updating plugins: ${(err as Error).message}`));
	}
}
