import { rm } from "node:fs/promises";
import { join } from "node:path";
import { loadPluginsJson, type OmpInstallEntry, type PluginPackageJson, readPluginPackageJson } from "@omp/manifest";
import { npmUpdate } from "@omp/npm";
import { log, outputJson, setJsonMode } from "@omp/output";
import {
	getProjectPiDir,
	NODE_MODULES_DIR,
	PI_CONFIG_DIR,
	PLUGINS_DIR,
	PROJECT_NODE_MODULES,
	resolveScope,
} from "@omp/paths";
import { createPluginSymlinks, removePluginSymlinks } from "@omp/symlinks";
import chalk from "chalk";

export interface UpdateOptions {
	global?: boolean;
	local?: boolean;
	json?: boolean;
}

/**
 * Update plugin(s) to latest within semver range
 */
export async function updatePlugin(name?: string, options: UpdateOptions = {}): Promise<void> {
	if (options.json) {
		setJsonMode(true);
	}

	const isGlobal = resolveScope(options);
	const prefix = isGlobal ? PLUGINS_DIR : ".pi";
	const _nodeModules = isGlobal ? NODE_MODULES_DIR : PROJECT_NODE_MODULES;

	const pluginsJson = await loadPluginsJson(isGlobal);
	const pluginNames = Object.keys(pluginsJson.plugins);

	if (pluginNames.length === 0) {
		log(chalk.yellow("No plugins installed."));
		process.exitCode = 1;
		return;
	}

	// If specific plugin name provided, verify it's installed
	if (name && !pluginsJson.plugins[name]) {
		log(chalk.yellow(`Plugin "${name}" is not installed.`));
		process.exitCode = 1;
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
		log(chalk.dim(`Skipping ${localPlugins.length} local plugin(s): ${localPlugins.join(", ")}`));
	}

	if (npmPlugins.length === 0) {
		log(chalk.yellow("No npm plugins to update."));
		process.exitCode = 1;
		return;
	}

	log(chalk.blue(`Updating ${npmPlugins.length} plugin(s)...`));

	const results: Array<{
		name: string;
		from: string;
		to: string;
		success: boolean;
	}> = [];

	// Save old package info before removing symlinks (for recovery on failure)
	const oldPkgJsons = new Map<string, PluginPackageJson>();
	const beforeVersions: Record<string, string> = {};
	const oldInstallEntries = new Map<string, OmpInstallEntry[]>();

	try {
		// Get current versions and install entries before update
		for (const pluginName of npmPlugins) {
			const pkgJson = await readPluginPackageJson(pluginName, isGlobal);
			if (pkgJson) {
				oldPkgJsons.set(pluginName, pkgJson);
				beforeVersions[pluginName] = pkgJson.version;

				// Save old install entries for later comparison
				if (pkgJson.omp?.install) {
					oldInstallEntries.set(pluginName, [...pkgJson.omp.install]);
				}

				// Remove old symlinks before update
				await removePluginSymlinks(pluginName, pkgJson, isGlobal);
			}
		}

		// npm update
		await npmUpdate(npmPlugins, prefix);

		// Base directory for symlink destinations
		const baseDir = isGlobal ? PI_CONFIG_DIR : getProjectPiDir();

		// Re-process symlinks for each updated plugin
		for (const pluginName of npmPlugins) {
			const pkgJson = await readPluginPackageJson(pluginName, isGlobal);
			if (pkgJson) {
				const beforeVersion = beforeVersions[pluginName] || "unknown";
				const afterVersion = pkgJson.version;

				// Handle changed omp.install entries: remove orphaned symlinks
				const oldEntries = oldInstallEntries.get(pluginName) || [];
				const newEntries = pkgJson.omp?.install || [];
				const newDests = new Set(newEntries.map((e) => e.dest));

				for (const oldEntry of oldEntries) {
					if (!newDests.has(oldEntry.dest)) {
						// This destination was in the old version but not in the new one
						const dest = join(baseDir, oldEntry.dest);
						try {
							await rm(dest, { force: true });
							log(chalk.dim(`  Removed orphaned: ${oldEntry.dest}`));
						} catch {
							// Ignore removal errors for orphaned symlinks
						}
					}
				}

				// Create new symlinks (handles overwrites for existing destinations)
				await createPluginSymlinks(pluginName, pkgJson, isGlobal);

				const changed = beforeVersion !== afterVersion;
				if (changed) {
					log(chalk.green(`  ✓ ${pluginName}: ${beforeVersion} → ${afterVersion}`));
				} else {
					log(chalk.dim(`  · ${pluginName}: ${afterVersion} (already latest)`));
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
		log();
		log(chalk.dim(`Updated: ${updated.length}, Already latest: ${results.length - updated.length}`));

		if (options.json) {
			outputJson({ results });
		}
	} catch (err) {
		// Restore old symlinks AND node_modules on failure
		if (oldPkgJsons.size > 0) {
			log(chalk.yellow("  Update failed, rolling back..."));

			// Reinstall old versions to restore node_modules
			const packagesToRestore = Array.from(oldPkgJsons.entries()).map(
				([pluginName, pkgJson]) => `${pluginName}@${pkgJson.version}`,
			);
			if (packagesToRestore.length > 0) {
				log(chalk.dim("  Restoring package versions..."));
				try {
					const { npmInstall } = await import("@omp/npm");
					await npmInstall(packagesToRestore, prefix, { save: false });
				} catch (restoreErr) {
					log(chalk.red(`  Failed to restore package versions: ${(restoreErr as Error).message}`));
				}
			}

			// Restore symlinks after node_modules are restored
			log(chalk.dim("  Restoring symlinks..."));
			for (const [pluginName, pkgJson] of oldPkgJsons) {
				try {
					await createPluginSymlinks(pluginName, pkgJson, isGlobal);
				} catch (restoreErr) {
					log(
						chalk.red(`  Failed to restore symlinks for ${pluginName}: ${(restoreErr as Error).message}`),
					);
				}
			}
		}
		log(chalk.red(`Error updating plugins: ${(err as Error).message}`));
		process.exitCode = 1;
	}
}
