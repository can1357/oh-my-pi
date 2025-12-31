import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import {
	hasLegacyManifest,
	type LegacyPluginInfo,
	loadLegacyManifest,
	type PluginPackageJson,
	type PluginsJson,
	readPluginPackageJson,
	savePluginsJson,
} from "@omp/manifest";
import { LEGACY_MANIFEST_PATH, NODE_MODULES_DIR, PLUGINS_DIR } from "@omp/paths";
import { createPluginSymlinks } from "@omp/symlinks";
import chalk from "chalk";

/**
 * Prompt user for migration
 */
async function promptMigration(): Promise<boolean> {
	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	return new Promise((resolve) => {
		rl.question(chalk.yellow("Migrate to npm-native format? [y/N] "), (answer) => {
			rl.close();
			resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
		});
	});
}

/**
 * Check for and prompt migration if legacy manifest exists
 */
export async function checkMigration(auto = false): Promise<boolean> {
	if (!hasLegacyManifest()) {
		return false;
	}

	console.log(chalk.yellow("\n⚠ Legacy manifest.json detected"));
	console.log(chalk.dim("  oh-my-pi has been updated to use npm-native plugin management."));
	console.log();

	if (!auto) {
		const shouldMigrate = await promptMigration();
		if (!shouldMigrate) {
			console.log(chalk.dim("  Migration skipped. Use 'omp migrate' to migrate later."));
			return false;
		}
	}

	return await migrateToNpm();
}

/**
 * Migrate from legacy manifest.json to npm-native format
 */
export async function migrateToNpm(): Promise<boolean> {
	console.log(chalk.blue("\nMigrating to npm-native format..."));

	try {
		const legacyManifest = await loadLegacyManifest();
		const plugins = Object.entries(legacyManifest.plugins);

		if (plugins.length === 0) {
			console.log(chalk.dim("  No plugins to migrate"));
			await archiveLegacyManifest();
			return true;
		}

		// Create node_modules directory
		await mkdir(NODE_MODULES_DIR, { recursive: true });

		const newPluginsJson: PluginsJson = { plugins: {} };
		const migrated: string[] = [];
		const failed: string[] = [];

		for (const [name, info] of plugins) {
			try {
				console.log(chalk.dim(`  Migrating ${name}...`));
				await migratePlugin(name, info);

				// Determine version specifier for plugins.json
				if (info.type === "npm" && info.package) {
					newPluginsJson.plugins[info.package] = info.version ? `^${info.version}` : "latest";
				} else if (info.type === "local" && info.path) {
					newPluginsJson.plugins[name] = `file:${info.path}`;
				} else if (info.type === "github" && info.repo) {
					// GitHub plugins become local after clone
					newPluginsJson.plugins[name] = `file:${join(NODE_MODULES_DIR, name)}`;
				}

				migrated.push(name);
			} catch (err) {
				console.log(chalk.yellow(`    ⚠ Failed to migrate ${name}: ${(err as Error).message}`));
				failed.push(name);
			}
		}

		// Save new plugins.json
		await savePluginsJson(newPluginsJson, true);

		// Archive legacy manifest
		await archiveLegacyManifest();

		// Re-create symlinks for migrated plugins
		console.log(chalk.dim("  Creating symlinks..."));
		for (const [name] of Object.entries(newPluginsJson.plugins)) {
			const pkgJson = await readPluginPackageJson(name, true); // global mode
			if (pkgJson?.omp?.install?.length) {
				await createPluginSymlinks(name, pkgJson, true);
			}
		}

		console.log();
		console.log(chalk.green(`✓ Migrated ${migrated.length} plugin(s)`));
		if (failed.length > 0) {
			console.log(chalk.yellow(`⚠ Failed to migrate ${failed.length} plugin(s): ${failed.join(", ")}`));
		}

		return true;
	} catch (err) {
		console.log(chalk.red(`Error during migration: ${(err as Error).message}`));
		return false;
	}
}

/**
 * Migrate a single plugin to the new structure
 */
async function migratePlugin(name: string, info: LegacyPluginInfo): Promise<void> {
	const oldPluginDir = join(PLUGINS_DIR, name);
	const newPluginDir = join(NODE_MODULES_DIR, name);

	if (!existsSync(oldPluginDir)) {
		throw new Error(`Plugin directory not found: ${oldPluginDir}`);
	}

	// For linked plugins, create symlink in node_modules
	if (info.linked && info.path) {
		await mkdir(NODE_MODULES_DIR, { recursive: true });
		if (existsSync(newPluginDir)) {
			await rm(newPluginDir, { force: true, recursive: true });
		}
		await symlink(info.path, newPluginDir);
		// Remove old symlink
		await rm(oldPluginDir, { force: true });
		return;
	}

	// For regular plugins, move to node_modules
	if (existsSync(newPluginDir)) {
		await rm(newPluginDir, { force: true, recursive: true });
	}

	// Rename/move the directory
	await rename(oldPluginDir, newPluginDir);

	// Create package.json if it doesn't exist (convert from omp.json)
	const pkgJsonPath = join(newPluginDir, "package.json");
	const ompJsonPath = join(newPluginDir, "omp.json");

	if (!existsSync(pkgJsonPath) && existsSync(ompJsonPath)) {
		const ompJson = JSON.parse(await readFile(ompJsonPath, "utf-8"));
		const pkgJson: PluginPackageJson = {
			name: ompJson.name || name,
			version: ompJson.version || info.version || "0.0.0",
			description: ompJson.description,
			keywords: ["omp-plugin"],
			omp: {
				install: ompJson.install,
			},
		};
		await writeFile(pkgJsonPath, JSON.stringify(pkgJson, null, 2));
	}
}

/**
 * Archive the legacy manifest.json
 */
async function archiveLegacyManifest(): Promise<void> {
	if (!existsSync(LEGACY_MANIFEST_PATH)) {
		return;
	}

	const archivePath = join(PLUGINS_DIR, `manifest.json.bak.${Date.now()}`);
	await rename(LEGACY_MANIFEST_PATH, archivePath);
	console.log(chalk.dim(`  Archived old manifest to ${basename(archivePath)}`));
}
