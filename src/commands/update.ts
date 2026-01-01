import { rm } from "node:fs/promises";
import { join } from "node:path";
import { writeLoader } from "@omp/loader";
import { loadPluginsJson, type OmpInstallEntry, type PluginPackageJson, readPluginPackageJson } from "@omp/manifest";
import { npmUpdate, requireNpm } from "@omp/npm";
import { log, outputJson, setJsonMode } from "@omp/output";
import { PI_CONFIG_DIR, PLUGINS_DIR } from "@omp/paths";
import { createPluginSymlinks, removePluginSymlinks } from "@omp/symlinks";
import chalk from "chalk";

export interface UpdateOptions {
	json?: boolean;
	dryRun?: boolean;
}

/**
 * Dry-run operation for update
 */
interface DryRunUpdateOp {
	type: "npm-update" | "symlink-remove" | "symlink-create" | "orphan-remove";
	description: string;
	path?: string;
}

/**
 * Update plugin(s) to latest within semver range
 */
export async function updatePlugin(name?: string, options: UpdateOptions = {}): Promise<void> {
	requireNpm();

	if (options.json) {
		setJsonMode(true);
	}

	if (options.dryRun) {
		log(chalk.cyan("🔍 DRY-RUN MODE: No changes will be made\n"));
	}

	const pluginsJson = await loadPluginsJson();
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

	// Dry-run mode: compute and display what would happen
	if (options.dryRun) {
		const dryRunOps: DryRunUpdateOp[] = [];

		// Collect current state
		for (const pluginName of npmPlugins) {
			const pkgJson = await readPluginPackageJson(pluginName);
			if (pkgJson) {
				beforeVersions[pluginName] = pkgJson.version;

				// Symlinks that would be removed
				if (pkgJson.omp?.install) {
					for (const entry of pkgJson.omp.install) {
						dryRunOps.push({
							type: "symlink-remove",
							description: `Remove symlink: ${entry.dest}`,
							path: join(PI_CONFIG_DIR, entry.dest),
						});
					}
				}
			}
		}

		// npm update operation
		dryRunOps.push({
			type: "npm-update",
			description: `npm update ${npmPlugins.join(" ")} --prefix ${PLUGINS_DIR}`,
		});

		// Symlinks that would be recreated (same as before unless plugin changes)
		for (const pluginName of npmPlugins) {
			const pkgJson = await readPluginPackageJson(pluginName);
			if (pkgJson?.omp?.install) {
				for (const entry of pkgJson.omp.install) {
					dryRunOps.push({
						type: "symlink-create",
						description: `Create symlink: ${entry.dest} → ${entry.src}`,
						path: join(PI_CONFIG_DIR, entry.dest),
					});
				}
			}
		}

		// Display dry-run operations
		log(chalk.blue(`\n📋 Dry-run: update ${npmPlugins.length} plugin(s)`));
		log(chalk.dim("  The following operations would be performed:\n"));

		const symlinkRemoves = dryRunOps.filter((o) => o.type === "symlink-remove");
		const npmOps = dryRunOps.filter((o) => o.type === "npm-update");
		const symlinkCreates = dryRunOps.filter((o) => o.type === "symlink-create");

		if (symlinkRemoves.length > 0) {
			log(chalk.yellow("  🗑️  Symlinks to remove (temporarily):"));
			for (const op of symlinkRemoves) {
				log(`     ${op.path}`);
			}
		}

		if (npmOps.length > 0) {
			log(chalk.yellow("  📦 npm operations:"));
			for (const op of npmOps) {
				log(`     ${op.description}`);
			}
		}

		if (symlinkCreates.length > 0) {
			log(chalk.yellow("  🔗 Symlinks to recreate:"));
			for (const op of symlinkCreates) {
				log(`     ${op.description}`);
			}
		}

		log();
		log(chalk.cyan(`✓ Dry-run complete: ${npmPlugins.length} plugin(s) would be updated`));

		if (options.json) {
			outputJson({
				dryRun: true,
				plugins: npmPlugins.map((n) => ({
					name: n,
					currentVersion: beforeVersions[n] || "unknown",
				})),
				operations: dryRunOps,
			});
		}
		return;
	}

	try {
		// Get current versions and install entries before update
		for (const pluginName of npmPlugins) {
			const pkgJson = await readPluginPackageJson(pluginName);
			if (pkgJson) {
				oldPkgJsons.set(pluginName, pkgJson);
				beforeVersions[pluginName] = pkgJson.version;

				// Save old install entries for later comparison
				if (pkgJson.omp?.install) {
					oldInstallEntries.set(pluginName, [...pkgJson.omp.install]);
				}

				// Remove old symlinks before update
				await removePluginSymlinks(pluginName, pkgJson);
			}
		}

		// npm update
		await npmUpdate(npmPlugins, PLUGINS_DIR);

		// Re-process symlinks for each updated plugin
		for (const pluginName of npmPlugins) {
			const pkgJson = await readPluginPackageJson(pluginName);
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
						const dest = join(PI_CONFIG_DIR, oldEntry.dest);
						try {
							await rm(dest, { force: true });
							log(chalk.dim(`  Removed orphaned: ${oldEntry.dest}`));
						} catch {
							// Ignore removal errors for orphaned symlinks
						}
					}
				}

				// Create new symlinks (handles overwrites for existing destinations)
				await createPluginSymlinks(pluginName, pkgJson);

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

		// Ensure the OMP loader is in place
		if (results.length > 0) {
			await writeLoader();
		}

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
			let npmRestoreSuccess = false;
			if (packagesToRestore.length > 0) {
				log(chalk.dim("  Restoring package versions..."));
				try {
					const { npmInstall } = await import("@omp/npm");
					await npmInstall(packagesToRestore, PLUGINS_DIR, { save: false });
					npmRestoreSuccess = true;
				} catch (restoreErr) {
					log(chalk.red(`  Failed to restore package versions: ${(restoreErr as Error).message}`));
				}
			}

			// Restore symlinks only if node_modules were successfully restored
			if (npmRestoreSuccess) {
				log(chalk.dim("  Restoring symlinks..."));
				for (const [pluginName, pkgJson] of oldPkgJsons) {
					try {
						await createPluginSymlinks(pluginName, pkgJson);
					} catch (restoreErr) {
						log(chalk.red(`  Failed to restore symlinks for ${pluginName}: ${(restoreErr as Error).message}`));
					}
				}
			}
		}
		log(chalk.red(`Error updating plugins: ${(err as Error).message}`));
		process.exitCode = 1;
	}
}
