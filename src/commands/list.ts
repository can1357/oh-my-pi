import { loadPluginsJson, readPluginPackageJson } from "@omp/manifest";
import { resolveScope } from "@omp/paths";
import chalk from "chalk";

export interface ListOptions {
	global?: boolean;
	local?: boolean;
	json?: boolean;
}

/**
 * List all installed plugins
 */
export async function listPlugins(options: ListOptions = {}): Promise<void> {
	const isGlobal = resolveScope(options);
	const pluginsJson = await loadPluginsJson(isGlobal);
	const pluginNames = Object.keys(pluginsJson.plugins);

	if (pluginNames.length === 0) {
		console.log(chalk.yellow("No plugins installed."));
		console.log(chalk.dim("Install one with: omp install <package>"));
		process.exitCode = 1;
		return;
	}

	if (options.json) {
		const plugins: Record<string, unknown> = {};
		for (const name of pluginNames) {
			const pkgJson = await readPluginPackageJson(name, isGlobal);
			const disabled = pluginsJson.disabled?.includes(name) || false;
			plugins[name] = {
				version: pkgJson?.version || pluginsJson.plugins[name],
				description: pkgJson?.description,
				disabled,
				files: pkgJson?.omp?.install?.map((e) => e.dest) || [],
			};
		}
		console.log(JSON.stringify({ plugins }, null, 2));
		return;
	}

	const location = isGlobal ? "~/.pi/plugins" : ".pi";
	console.log(chalk.bold(`Installed plugins (${pluginNames.length}) [${location}]:\n`));

	for (const name of pluginNames.sort()) {
		const pkgJson = await readPluginPackageJson(name, isGlobal);
		const specifier = pluginsJson.plugins[name];
		const isLocal = specifier.startsWith("file:");
		const disabled = pluginsJson.disabled?.includes(name);

		const version = pkgJson?.version ? chalk.dim(` v${pkgJson.version}`) : "";
		const localBadge = isLocal ? chalk.cyan(" (local)") : "";
		const disabledBadge = disabled ? chalk.yellow(" (disabled)") : "";
		const icon = disabled ? chalk.gray("○") : chalk.green("◆");

		console.log(`${icon} ${chalk.bold(name)}${version}${localBadge}${disabledBadge}`);

		if (pkgJson?.description) {
			console.log(chalk.dim(`    ${pkgJson.description}`));
		}

		if (isLocal) {
			const localPath = specifier.replace("file:", "");
			console.log(chalk.dim(`    path: ${localPath}`));
		}

		if (pkgJson?.omp?.install?.length) {
			const files = pkgJson.omp.install.map((e) => e.dest);
			console.log(chalk.dim(`    files: ${files.join(", ")}`));
		}

		console.log();
	}
}
