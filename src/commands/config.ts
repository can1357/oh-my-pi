import type { OmpVariable } from "@omp/manifest";
import { loadPluginsJson, readPluginPackageJson, savePluginsJson } from "@omp/manifest";
import { log, outputJson, setJsonMode } from "@omp/output";
import { resolveScope } from "@omp/paths";
import chalk from "chalk";

export interface ConfigOptions {
	global?: boolean;
	local?: boolean;
	json?: boolean;
	delete?: boolean;
}

/**
 * Collect all variables from a plugin (top-level + enabled features)
 */
function collectVariables(
	pkgJson: {
		omp?: {
			variables?: Record<string, OmpVariable>;
			features?: Record<string, { variables?: Record<string, OmpVariable> }>;
		};
	},
	enabledFeatures: string[],
): Record<string, OmpVariable> {
	const vars: Record<string, OmpVariable> = {};

	// Top-level variables
	if (pkgJson.omp?.variables) {
		Object.assign(vars, pkgJson.omp.variables);
	}

	// Variables from enabled features
	if (pkgJson.omp?.features) {
		for (const fname of enabledFeatures) {
			const feature = pkgJson.omp.features[fname];
			if (feature?.variables) {
				Object.assign(vars, feature.variables);
			}
		}
	}

	return vars;
}

/**
 * Parse a string value to the appropriate type based on variable definition
 */
function parseValue(value: string, varDef: OmpVariable): string | number | boolean | string[] {
	switch (varDef.type) {
		case "number": {
			const num = Number(value);
			if (Number.isNaN(num)) {
				throw new Error(`Invalid number: ${value}`);
			}
			return num;
		}
		case "boolean":
			if (value === "true" || value === "1" || value === "yes") return true;
			if (value === "false" || value === "0" || value === "no") return false;
			throw new Error(`Invalid boolean: ${value}. Use true/false, 1/0, or yes/no`);
		case "string[]":
			return value
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
		default:
			return value;
	}
}

/**
 * Format a value for display
 */
function formatValue(value: unknown, varDef: OmpVariable): string {
	if (value === undefined) {
		return chalk.dim("(not set)");
	}
	if (varDef.type === "string[]" && Array.isArray(value)) {
		return value.join(", ");
	}
	if (typeof value === "string" && varDef.env) {
		// Mask sensitive values (likely API keys)
		if (value.length > 8) {
			return `${value.slice(0, 4)}...${value.slice(-4)}`;
		}
	}
	return String(value);
}

/**
 * Resolve which features are currently enabled
 *
 * - null/undefined: use plugin defaults (features with default !== false)
 * - ["*"]: explicitly all features
 * - []: no optional features
 * - ["f1", "f2"]: specific features
 */
function resolveEnabledFeatures(
	allFeatureNames: string[],
	storedFeatures: string[] | null | undefined,
	pluginFeatures: Record<string, { default?: boolean }>,
): string[] {
	// Explicit "all features" request
	if (Array.isArray(storedFeatures) && storedFeatures.includes("*")) return allFeatureNames;
	// Explicit feature list (including empty array = no features)
	if (Array.isArray(storedFeatures)) return storedFeatures;
	// null/undefined = use defaults
	return Object.entries(pluginFeatures)
		.filter(([_, f]) => f.default !== false)
		.map(([name]) => name);
}

/**
 * List all configurable variables for a plugin
 * omp config @oh-my-pi/exa
 */
export async function listConfig(name: string, options: ConfigOptions = {}): Promise<void> {
	if (options.json) {
		setJsonMode(true);
	}

	const isGlobal = resolveScope(options);
	const pluginsJson = await loadPluginsJson(isGlobal);

	if (!pluginsJson.plugins[name]) {
		log(chalk.yellow(`Plugin "${name}" is not installed.`));
		process.exitCode = 1;
		return;
	}

	const pkgJson = await readPluginPackageJson(name, isGlobal);
	if (!pkgJson) {
		log(chalk.red(`Could not read package.json for ${name}`));
		process.exitCode = 1;
		return;
	}

	const allFeatureNames = Object.keys(pkgJson.omp?.features || {});
	const config = pluginsJson.config?.[name];
	const enabledFeatures = resolveEnabledFeatures(allFeatureNames, config?.features, pkgJson.omp?.features || {});
	const variables = collectVariables(pkgJson, enabledFeatures);

	if (Object.keys(variables).length === 0) {
		log(chalk.yellow(`Plugin "${name}" has no configurable variables.`));
		return;
	}

	const userVars = config?.variables || {};

	if (options.json) {
		outputJson({
			plugin: name,
			variables: Object.entries(variables).map(([vname, vdef]) => ({
				name: vname,
				type: vdef.type,
				value: userVars[vname],
				default: vdef.default,
				required: vdef.required,
				env: vdef.env,
				description: vdef.description,
			})),
		});
		return;
	}

	log(chalk.bold(`\nVariables for ${name}:\n`));

	for (const [vname, vdef] of Object.entries(variables)) {
		const currentValue = userVars[vname];
		const hasValue = currentValue !== undefined;
		const hasDefault = vdef.default !== undefined;

		const icon = hasValue
			? chalk.green("✓")
			: hasDefault
				? chalk.blue("○")
				: vdef.required
					? chalk.red("!")
					: chalk.gray("○");
		const requiredStr = vdef.required && !hasValue ? chalk.red(" (required)") : "";
		const envStr = vdef.env ? chalk.dim(` [${vdef.env}]`) : "";

		log(`${icon} ${chalk.bold(vname)}${requiredStr}${envStr}`);

		if (vdef.description) {
			log(chalk.dim(`    ${vdef.description}`));
		}

		log(chalk.dim(`    Type: ${vdef.type}`));

		if (hasValue) {
			log(`    Value: ${formatValue(currentValue, vdef)}`);
		} else if (hasDefault) {
			log(`    Default: ${formatValue(vdef.default, vdef)}`);
		}
	}

	log();
	log(chalk.dim(`Set a value: omp config ${name} <variable> <value>`));
	log(chalk.dim(`Delete a value: omp config ${name} <variable> --delete`));
}

/**
 * Get a specific variable value
 * omp config @oh-my-pi/exa apiKey
 */
export async function getConfig(name: string, key: string, options: ConfigOptions = {}): Promise<void> {
	if (options.json) {
		setJsonMode(true);
	}

	const isGlobal = resolveScope(options);
	const pluginsJson = await loadPluginsJson(isGlobal);

	if (!pluginsJson.plugins[name]) {
		log(chalk.yellow(`Plugin "${name}" is not installed.`));
		process.exitCode = 1;
		return;
	}

	const pkgJson = await readPluginPackageJson(name, isGlobal);
	if (!pkgJson) {
		log(chalk.red(`Could not read package.json for ${name}`));
		process.exitCode = 1;
		return;
	}

	const allFeatureNames = Object.keys(pkgJson.omp?.features || {});
	const config = pluginsJson.config?.[name];
	const enabledFeatures = resolveEnabledFeatures(allFeatureNames, config?.features, pkgJson.omp?.features || {});
	const variables = collectVariables(pkgJson, enabledFeatures);

	const varDef = variables[key];
	if (!varDef) {
		log(chalk.red(`Unknown variable "${key}".`));
		log(chalk.dim(`Available: ${Object.keys(variables).join(", ") || "(none)"}`));
		process.exitCode = 1;
		return;
	}

	const userValue = config?.variables?.[key];
	const value = userValue ?? varDef.default;

	if (options.json) {
		outputJson({ plugin: name, variable: key, value, default: varDef.default });
		return;
	}

	if (value !== undefined) {
		log(formatValue(value, varDef));
	} else {
		log(chalk.dim("(not set)"));
	}
}

/**
 * Set a variable value
 * omp config @oh-my-pi/exa apiKey sk-xxx
 */
export async function setConfig(name: string, key: string, value: string, options: ConfigOptions = {}): Promise<void> {
	if (options.json) {
		setJsonMode(true);
	}

	const isGlobal = resolveScope(options);
	const pluginsJson = await loadPluginsJson(isGlobal);

	if (!pluginsJson.plugins[name]) {
		log(chalk.yellow(`Plugin "${name}" is not installed.`));
		process.exitCode = 1;
		return;
	}

	const pkgJson = await readPluginPackageJson(name, isGlobal);
	if (!pkgJson) {
		log(chalk.red(`Could not read package.json for ${name}`));
		process.exitCode = 1;
		return;
	}

	const allFeatureNames = Object.keys(pkgJson.omp?.features || {});
	const config = pluginsJson.config?.[name];
	const enabledFeatures = resolveEnabledFeatures(allFeatureNames, config?.features, pkgJson.omp?.features || {});
	const variables = collectVariables(pkgJson, enabledFeatures);

	const varDef = variables[key];
	if (!varDef) {
		log(chalk.red(`Unknown variable "${key}".`));
		log(chalk.dim(`Available: ${Object.keys(variables).join(", ") || "(none)"}`));
		process.exitCode = 1;
		return;
	}

	// Parse and validate value
	let parsed: string | number | boolean | string[];
	try {
		parsed = parseValue(value, varDef);
	} catch (err) {
		log(chalk.red((err as Error).message));
		process.exitCode = 1;
		return;
	}

	// Update config
	if (!pluginsJson.config) pluginsJson.config = {};
	if (!pluginsJson.config[name]) pluginsJson.config[name] = {};
	if (!pluginsJson.config[name].variables) pluginsJson.config[name].variables = {};

	pluginsJson.config[name].variables[key] = parsed;
	await savePluginsJson(pluginsJson, isGlobal);

	log(chalk.green(`✓ Set ${name}.${key} = ${JSON.stringify(parsed)}`));

	if (varDef.env) {
		log(chalk.dim(`  Environment variable: ${varDef.env}`));
		log(chalk.dim(`  Export with: omp env`));
	}

	if (options.json) {
		outputJson({ plugin: name, variable: key, value: parsed });
	}
}

/**
 * Delete a variable override (revert to default)
 * omp config @oh-my-pi/exa apiKey --delete
 */
export async function deleteConfig(name: string, key: string, options: ConfigOptions = {}): Promise<void> {
	if (options.json) {
		setJsonMode(true);
	}

	const isGlobal = resolveScope(options);
	const pluginsJson = await loadPluginsJson(isGlobal);

	if (!pluginsJson.plugins[name]) {
		log(chalk.yellow(`Plugin "${name}" is not installed.`));
		process.exitCode = 1;
		return;
	}

	const config = pluginsJson.config?.[name];
	// Check key presence with hasOwnProperty, not truthiness (allows deleting falsy values like false, 0, "", [])
	if (!config?.variables || !Object.hasOwn(config.variables, key)) {
		log(chalk.yellow(`Variable "${key}" is not set for ${name}.`));
		return;
	}

	delete pluginsJson.config![name].variables![key];

	// Clean up empty objects
	if (Object.keys(pluginsJson.config![name].variables!).length === 0) {
		delete pluginsJson.config![name].variables;
	}
	if (Object.keys(pluginsJson.config![name]).length === 0) {
		delete pluginsJson.config![name];
	}
	if (Object.keys(pluginsJson.config!).length === 0) {
		delete pluginsJson.config;
	}

	await savePluginsJson(pluginsJson, isGlobal);

	log(chalk.green(`✓ Deleted ${name}.${key} (reverted to default)`));

	if (options.json) {
		outputJson({ plugin: name, variable: key, deleted: true });
	}
}

/**
 * Main config command handler
 * Routes to list, get, set, or delete based on arguments
 */
export async function configCommand(
	name: string,
	keyOrOptions?: string | ConfigOptions,
	valueOrOptions?: string | ConfigOptions,
	options: ConfigOptions = {},
): Promise<void> {
	// Handle different argument patterns
	let key: string | undefined;
	let value: string | undefined;
	let opts: ConfigOptions;

	if (typeof keyOrOptions === "object") {
		// omp config <name> [options]
		opts = keyOrOptions;
	} else if (typeof valueOrOptions === "object") {
		// omp config <name> <key> [options]
		key = keyOrOptions;
		opts = valueOrOptions;
	} else {
		// omp config <name> <key> <value> [options]
		key = keyOrOptions;
		value = valueOrOptions;
		opts = options;
	}

	if (!key) {
		await listConfig(name, opts);
	} else if (opts.delete) {
		await deleteConfig(name, key, opts);
	} else if (value !== undefined) {
		await setConfig(name, key, value, opts);
	} else {
		await getConfig(name, key, opts);
	}
}
