import { loadPluginsJson, readPluginPackageJson, savePluginsJson } from "@omp/manifest";
import { resolveScope } from "@omp/paths";
import {
	createPluginSymlinks,
	getAllFeatureNames,
	getDefaultFeatures,
	getEnabledInstallEntries,
	removePluginSymlinks,
} from "@omp/symlinks";
import chalk from "chalk";

export interface FeaturesOptions {
	global?: boolean;
	local?: boolean;
	json?: boolean;
	enable?: string[];
	disable?: string[];
	set?: string;
}

/**
 * Resolve which features are currently enabled based on stored config
 */
function resolveCurrentFeatures(
	allFeatureNames: string[],
	storedFeatures: string[] | null | undefined,
	pluginFeatures: Record<string, { default?: boolean }>,
): string[] {
	// null = first install, got all
	if (storedFeatures === null) {
		return allFeatureNames;
	}

	// ["*"] = explicitly all
	if (Array.isArray(storedFeatures) && storedFeatures.includes("*")) {
		return allFeatureNames;
	}

	// Specific list
	if (Array.isArray(storedFeatures)) {
		return storedFeatures;
	}

	// undefined = use defaults
	return getDefaultFeatures(pluginFeatures);
}

/**
 * List available features for a plugin
 * omp features @oh-my-pi/exa
 */
export async function listFeatures(name: string, options: FeaturesOptions = {}): Promise<void> {
	const isGlobal = resolveScope(options);
	const pluginsJson = await loadPluginsJson(isGlobal);

	// Check if plugin exists
	if (!pluginsJson.plugins[name]) {
		console.log(chalk.yellow(`Plugin "${name}" is not installed.`));
		process.exitCode = 1;
		return;
	}

	const pkgJson = await readPluginPackageJson(name, isGlobal);
	if (!pkgJson) {
		console.log(chalk.red(`Could not read package.json for ${name}`));
		process.exitCode = 1;
		return;
	}

	const features = pkgJson.omp?.features;
	if (!features || Object.keys(features).length === 0) {
		console.log(chalk.yellow(`Plugin "${name}" has no configurable features.`));
		return;
	}

	const allFeatureNames = Object.keys(features);
	const config = pluginsJson.config?.[name];
	const enabledFeatures = resolveCurrentFeatures(allFeatureNames, config?.features, features);

	if (options.json) {
		console.log(
			JSON.stringify(
				{
					plugin: name,
					features: Object.entries(features).map(([fname, fdef]) => ({
						name: fname,
						enabled: enabledFeatures.includes(fname),
						default: fdef.default !== false,
						description: fdef.description,
						installCount: fdef.install?.length || 0,
						variables: fdef.variables ? Object.keys(fdef.variables) : [],
					})),
				},
				null,
				2,
			),
		);
		return;
	}

	console.log(chalk.bold(`\nFeatures for ${name}:\n`));

	for (const [fname, fdef] of Object.entries(features)) {
		const isEnabled = enabledFeatures.includes(fname);
		const icon = isEnabled ? chalk.green("✓") : chalk.gray("○");
		const defaultStr = fdef.default === false ? chalk.dim(" (opt-in)") : "";

		console.log(`${icon} ${chalk.bold(fname)}${defaultStr}`);
		if (fdef.description) {
			console.log(chalk.dim(`    ${fdef.description}`));
		}
		if (fdef.install?.length) {
			console.log(chalk.dim(`    Files: ${fdef.install.length}`));
		}
		if (fdef.variables && Object.keys(fdef.variables).length > 0) {
			console.log(chalk.dim(`    Variables: ${Object.keys(fdef.variables).join(", ")}`));
		}
	}

	console.log();
	console.log(chalk.dim(`Configure with: omp features ${name} --enable <feature> --disable <feature>`));
	console.log(chalk.dim(`Or set exactly: omp features ${name} --set feature1,feature2`));
}

/**
 * Configure features for an installed plugin
 * omp features @oh-my-pi/exa --enable websets --disable search
 * omp features @oh-my-pi/exa --set search,websets
 */
export async function configureFeatures(name: string, options: FeaturesOptions = {}): Promise<void> {
	const isGlobal = resolveScope(options);
	const pluginsJson = await loadPluginsJson(isGlobal);

	// Check if plugin exists
	if (!pluginsJson.plugins[name]) {
		console.log(chalk.yellow(`Plugin "${name}" is not installed.`));
		process.exitCode = 1;
		return;
	}

	const pkgJson = await readPluginPackageJson(name, isGlobal);
	if (!pkgJson) {
		console.log(chalk.red(`Could not read package.json for ${name}`));
		process.exitCode = 1;
		return;
	}

	const features = pkgJson.omp?.features;
	if (!features || Object.keys(features).length === 0) {
		console.log(chalk.yellow(`Plugin "${name}" has no configurable features.`));
		process.exitCode = 1;
		return;
	}

	const allFeatureNames = Object.keys(features);
	const config = pluginsJson.config?.[name];
	const currentlyEnabled = resolveCurrentFeatures(allFeatureNames, config?.features, features);

	let newEnabled: string[];

	// Handle --set (explicit list)
	if (options.set !== undefined) {
		if (options.set === "*") {
			newEnabled = allFeatureNames;
		} else if (options.set === "") {
			newEnabled = [];
		} else {
			newEnabled = options.set.split(",").map((f) => f.trim()).filter(Boolean);
			// Validate
			for (const f of newEnabled) {
				if (!features[f]) {
					console.log(chalk.red(`Unknown feature "${f}". Available: ${allFeatureNames.join(", ")}`));
					process.exitCode = 1;
					return;
				}
			}
		}
	} else {
		// Handle --enable and --disable
		newEnabled = [...currentlyEnabled];

		if (options.enable) {
			for (const f of options.enable) {
				if (!features[f]) {
					console.log(chalk.red(`Unknown feature "${f}". Available: ${allFeatureNames.join(", ")}`));
					process.exitCode = 1;
					return;
				}
				if (!newEnabled.includes(f)) {
					newEnabled.push(f);
				}
			}
		}

		if (options.disable) {
			for (const f of options.disable) {
				if (!features[f]) {
					console.log(chalk.red(`Unknown feature "${f}". Available: ${allFeatureNames.join(", ")}`));
					process.exitCode = 1;
					return;
				}
				newEnabled = newEnabled.filter((e) => e !== f);
			}
		}
	}

	// Compute what changed
	const toDisable = currentlyEnabled.filter((f) => !newEnabled.includes(f));
	const toEnable = newEnabled.filter((f) => !currentlyEnabled.includes(f));

	if (toDisable.length === 0 && toEnable.length === 0) {
		console.log(chalk.yellow("No changes to feature configuration."));
		return;
	}

	console.log(chalk.blue(`\nReconfiguring features for ${name}...`));

	// Remove symlinks for disabled features
	if (toDisable.length > 0) {
		console.log(chalk.dim(`  Disabling: ${toDisable.join(", ")}`));
		// Create a fake pkgJson with only the features to disable
		const disableEntries = toDisable.flatMap((f) => features[f].install || []);
		if (disableEntries.length > 0) {
			await removePluginSymlinks(name, { ...pkgJson, omp: { install: disableEntries } }, isGlobal, false);
		}
	}

	// Create symlinks for newly enabled features
	if (toEnable.length > 0) {
		console.log(chalk.dim(`  Enabling: ${toEnable.join(", ")}`));
		const enableEntries = toEnable.flatMap((f) => features[f].install || []);
		if (enableEntries.length > 0) {
			await createPluginSymlinks(
				name,
				{ ...pkgJson, omp: { install: enableEntries } },
				isGlobal,
				false,
				undefined,
				undefined,
			);
		}
	}

	// Update config in plugins.json
	if (!pluginsJson.config) {
		pluginsJson.config = {};
	}
	if (!pluginsJson.config[name]) {
		pluginsJson.config[name] = {};
	}

	// Store the new feature list
	if (newEnabled.length === allFeatureNames.length) {
		// All enabled - store ["*"] for explicitness
		pluginsJson.config[name].features = ["*"];
	} else {
		pluginsJson.config[name].features = newEnabled;
	}

	await savePluginsJson(pluginsJson, isGlobal);

	console.log(chalk.green(`\n✓ Features updated`));
	if (newEnabled.length > 0) {
		console.log(chalk.dim(`  Enabled: ${newEnabled.join(", ")}`));
	} else {
		console.log(chalk.dim(`  Enabled: none (core only)`));
	}

	if (options.json) {
		console.log(JSON.stringify({ plugin: name, enabled: newEnabled, disabled: toDisable, added: toEnable }, null, 2));
	}
}

/**
 * Main features command handler
 * Routes to list or configure based on options
 */
export async function featuresCommand(name: string, options: FeaturesOptions = {}): Promise<void> {
	// If any modification options are passed, configure
	if (options.enable || options.disable || options.set !== undefined) {
		await configureFeatures(name, options);
	} else {
		// Otherwise, just list
		await listFeatures(name, options);
	}
}
