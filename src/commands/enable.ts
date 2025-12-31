import { loadPluginsJson, readPluginPackageJson, savePluginsJson } from "@omp/manifest";
import { resolveScope } from "@omp/paths";
import { checkPluginSymlinks, createPluginSymlinks, removePluginSymlinks } from "@omp/symlinks";
import chalk from "chalk";

export interface EnableDisableOptions {
	global?: boolean;
	local?: boolean;
	json?: boolean;
}

/**
 * Enable a disabled plugin (re-create symlinks)
 */
export async function enablePlugin(name: string, options: EnableDisableOptions = {}): Promise<void> {
	const isGlobal = resolveScope(options);

	const pluginsJson = await loadPluginsJson(isGlobal);

	// Check if plugin exists
	if (!pluginsJson.plugins[name]) {
		console.log(chalk.yellow(`Plugin "${name}" is not installed.`));
		process.exitCode = 1;
		return;
	}

	// Check if already enabled
	if (!pluginsJson.disabled?.includes(name)) {
		console.log(chalk.yellow(`Plugin "${name}" is already enabled.`));
		process.exitCode = 1;
		return;
	}

	try {
		// Read package.json
		const pkgJson = await readPluginPackageJson(name, isGlobal);
		if (!pkgJson) {
			console.log(chalk.red(`Could not read package.json for ${name}`));
			process.exitCode = 1;
			return;
		}

		// Check if symlinks are already in place
		const symlinkStatus = await checkPluginSymlinks(name, pkgJson, isGlobal);

		if (symlinkStatus.valid.length > 0 && symlinkStatus.broken.length === 0 && symlinkStatus.missing.length === 0) {
			console.log(chalk.yellow(`Plugin "${name}" symlinks are already in place.`));
		} else {
			// Re-create symlinks
			console.log(chalk.blue(`Enabling ${name}...`));
			await createPluginSymlinks(name, pkgJson, isGlobal);
		}

		// Remove from disabled list
		pluginsJson.disabled = pluginsJson.disabled.filter((n) => n !== name);
		await savePluginsJson(pluginsJson, isGlobal);

		console.log(chalk.green(`✓ Enabled "${name}"`));

		if (options.json) {
			console.log(JSON.stringify({ name, enabled: true }, null, 2));
		}
	} catch (err) {
		console.log(chalk.red(`Error enabling plugin: ${(err as Error).message}`));
		process.exitCode = 1;
	}
}

/**
 * Disable a plugin (remove symlinks but keep installed)
 */
export async function disablePlugin(name: string, options: EnableDisableOptions = {}): Promise<void> {
	const isGlobal = resolveScope(options);

	const pluginsJson = await loadPluginsJson(isGlobal);

	// Check if plugin exists
	if (!pluginsJson.plugins[name]) {
		console.log(chalk.yellow(`Plugin "${name}" is not installed.`));
		process.exitCode = 1;
		return;
	}

	// Check if already disabled
	if (pluginsJson.disabled?.includes(name)) {
		console.log(chalk.yellow(`Plugin "${name}" is already disabled.`));
		process.exitCode = 1;
		return;
	}

	try {
		// Read package.json
		const pkgJson = await readPluginPackageJson(name, isGlobal);
		if (!pkgJson) {
			console.log(chalk.red(`Could not read package.json for ${name}`));
			process.exitCode = 1;
			return;
		}

		// Remove symlinks
		console.log(chalk.blue(`Disabling ${name}...`));
		await removePluginSymlinks(name, pkgJson, isGlobal);

		// Add to disabled list
		if (!pluginsJson.disabled) {
			pluginsJson.disabled = [];
		}
		pluginsJson.disabled.push(name);
		await savePluginsJson(pluginsJson, isGlobal);

		console.log(chalk.green(`✓ Disabled "${name}"`));
		console.log(chalk.dim("  Plugin is still installed, symlinks removed"));
		console.log(chalk.dim(`  Re-enable with: omp enable ${name}`));

		if (options.json) {
			console.log(JSON.stringify({ name, enabled: false }, null, 2));
		}
	} catch (err) {
		console.log(chalk.red(`Error disabling plugin: ${(err as Error).message}`));
		process.exitCode = 1;
	}
}
