import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { getInstalledPlugins, loadPluginsJson, readPluginPackageJson, savePluginsJson } from "@omp/manifest";
import { npmUninstall } from "@omp/npm";
import { NODE_MODULES_DIR, PLUGINS_DIR, PROJECT_NODE_MODULES, resolveScope } from "@omp/paths";
import { removePluginSymlinks } from "@omp/symlinks";
import chalk from "chalk";

export interface UninstallOptions {
	global?: boolean;
	local?: boolean;
	json?: boolean;
	force?: boolean;
	yes?: boolean;
}

/**
 * Uninstall a plugin
 */
export async function uninstallPlugin(name: string, options: UninstallOptions = {}): Promise<void> {
	const isGlobal = resolveScope(options);
	const prefix = isGlobal ? PLUGINS_DIR : ".pi";
	const nodeModules = isGlobal ? NODE_MODULES_DIR : PROJECT_NODE_MODULES;

	// Check if plugin is installed
	const pluginsJson = await loadPluginsJson(isGlobal);
	if (!pluginsJson.plugins[name]) {
		console.log(chalk.yellow(`Plugin "${name}" is not installed.`));
		process.exitCode = 1;
		return;
	}

	// Collect all items that will be deleted for confirmation
	const pkgJsonPreview = await readPluginPackageJson(name, isGlobal);
	const itemsToDelete: string[] = [];
	const pluginDir = join(nodeModules, name);

	if (existsSync(pluginDir)) {
		itemsToDelete.push(pluginDir);
	}

	// Collect symlinks that would be removed
	if (pkgJsonPreview?.omp?.install) {
		const { removePluginSymlinks: previewSymlinks } = await import("@omp/symlinks");
		// Get symlink paths without actually removing them
		for (const entry of pkgJsonPreview.omp.install) {
			const dest = typeof entry === "string" ? entry : entry.dest;
			if (dest) {
				const destPath = isGlobal
					? join(process.env.HOME || "", dest.replace(/^~\//, ""))
					: join(process.cwd(), dest);
				if (existsSync(destPath)) {
					itemsToDelete.push(destPath);
				}
			}
		}
	}

	// Show what will be deleted and require confirmation
	if (itemsToDelete.length > 0) {
		console.log(chalk.yellow(`\nThe following ${itemsToDelete.length} item(s) will be deleted:`));
		for (const item of itemsToDelete) {
			console.log(chalk.dim(`  - ${item}`));
		}
		console.log();

		// Check for interactive mode and --force/--yes flags
		const isInteractive = process.stdin.isTTY && process.stdout.isTTY;
		const skipConfirmation = options.force || options.yes;

		if (!skipConfirmation) {
			if (!isInteractive) {
				console.log(chalk.red("Error: Destructive operation requires confirmation."));
				console.log(chalk.dim("Use --force or --yes flag in non-interactive environments."));
				process.exitCode = 1;
				return;
			}

			const rl = createInterface({
				input: process.stdin,
				output: process.stdout,
			});
			const answer = await new Promise<string>((resolve) => {
				rl.question(chalk.yellow(`Proceed with uninstalling "${name}"? [y/N] `), (ans) => {
					rl.close();
					resolve(ans);
				});
			});

			if (answer.toLowerCase() !== "y" && answer.toLowerCase() !== "yes") {
				console.log(chalk.dim("Uninstall aborted."));
				return;
			}
		}
	}

	try {
		console.log(chalk.blue(`Uninstalling ${name}...`));

		// 1. Read package.json for omp.install entries before uninstalling
		const pkgJson = await readPluginPackageJson(name, isGlobal);

		// Check for shared dependencies
		if (pkgJson?.dependencies) {
			const allPlugins = await getInstalledPlugins(isGlobal);
			const sharedDeps: string[] = [];

			for (const depName of Object.keys(pkgJson.dependencies)) {
				for (const [otherName, otherPkgJson] of allPlugins) {
					if (otherName !== name && otherPkgJson.dependencies?.[depName]) {
						sharedDeps.push(`${depName} (also used by ${otherName})`);
						break;
					}
				}
			}

			if (sharedDeps.length > 0) {
				console.log(chalk.yellow("\n⚠ Warning: This plugin shares dependencies with other plugins:"));
				for (const dep of sharedDeps) {
					console.log(chalk.dim(`  - ${dep}`));
				}
				console.log(chalk.dim("  These dependencies will remain installed."));
			}
		}

		// 2. Remove symlinks
		if (pkgJson) {
			const result = await removePluginSymlinks(name, pkgJson, isGlobal);

			if (result.skippedNonSymlinks.length > 0) {
				console.log(chalk.yellow("\nThe following files are not symlinks and were not removed:"));
				for (const file of result.skippedNonSymlinks) {
					console.log(chalk.dim(`  - ${file}`));
				}

				const skipConfirmation = options.force || options.yes;

				if (skipConfirmation) {
					for (const file of result.skippedNonSymlinks) {
						await rm(file, { force: true, recursive: true });
						console.log(chalk.dim(`  Deleted: ${file}`));
					}
				} else if (process.stdin.isTTY && process.stdout.isTTY) {
					const rl = createInterface({
						input: process.stdin,
						output: process.stdout,
					});
					const answer = await new Promise<string>((resolve) => {
						rl.question(chalk.yellow("Delete these files anyway? [y/N] "), (ans) => {
							rl.close();
							resolve(ans);
						});
					});

					if (answer.toLowerCase() === "y" || answer.toLowerCase() === "yes") {
						for (const file of result.skippedNonSymlinks) {
							await rm(file, { force: true, recursive: true });
							console.log(chalk.dim(`  Deleted: ${file}`));
						}
					}
				} else {
					console.log(chalk.yellow("Non-interactive mode: skipping deletion of non-symlink files."));
					console.log(chalk.dim("Use --force or --yes flag to delete these files."));
				}
			}
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
		process.exitCode = 1;

		if (options.json) {
			console.log(JSON.stringify({ name, success: false, error: (err as Error).message }, null, 2));
		}
	}
}
