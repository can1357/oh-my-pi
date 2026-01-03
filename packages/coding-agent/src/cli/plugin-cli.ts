/**
 * Plugin CLI command handlers.
 *
 * Handles `omp plugin <command>` subcommands for plugin lifecycle management.
 */

import chalk from "chalk";
import { APP_NAME } from "../config";
import { PluginManager, parseSettingValue, validateSetting } from "../core/plugins/index";

// =============================================================================
// Types
// =============================================================================

export type PluginAction =
	| "install"
	| "uninstall"
	| "list"
	| "link"
	| "doctor"
	| "features"
	| "config"
	| "enable"
	| "disable";

export interface PluginCommandArgs {
	action: PluginAction;
	args: string[];
	flags: {
		json?: boolean;
		fix?: boolean;
		force?: boolean;
		dryRun?: boolean;
		local?: boolean;
		enable?: string;
		disable?: string;
		set?: string;
	};
}

// =============================================================================
// Argument Parser
// =============================================================================

const VALID_ACTIONS: PluginAction[] = [
	"install",
	"uninstall",
	"list",
	"link",
	"doctor",
	"features",
	"config",
	"enable",
	"disable",
];

/**
 * Parse plugin subcommand arguments.
 * Returns undefined if not a plugin command.
 */
export function parsePluginArgs(args: string[]): PluginCommandArgs | undefined {
	if (args.length === 0 || args[0] !== "plugin") {
		return undefined;
	}

	if (args.length < 2) {
		return { action: "list", args: [], flags: {} };
	}

	const action = args[1];
	if (!VALID_ACTIONS.includes(action as PluginAction)) {
		console.error(chalk.red(`Unknown plugin command: ${action}`));
		console.error(`Valid commands: ${VALID_ACTIONS.join(", ")}`);
		process.exit(1);
	}

	const result: PluginCommandArgs = {
		action: action as PluginAction,
		args: [],
		flags: {},
	};

	// Parse remaining arguments
	for (let i = 2; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--json") {
			result.flags.json = true;
		} else if (arg === "--fix") {
			result.flags.fix = true;
		} else if (arg === "--force") {
			result.flags.force = true;
		} else if (arg === "--dry-run") {
			result.flags.dryRun = true;
		} else if (arg === "-l" || arg === "--local") {
			result.flags.local = true;
		} else if (arg === "--enable" && i + 1 < args.length) {
			result.flags.enable = args[++i];
		} else if (arg === "--disable" && i + 1 < args.length) {
			result.flags.disable = args[++i];
		} else if (arg === "--set" && i + 1 < args.length) {
			result.flags.set = args[++i];
		} else if (!arg.startsWith("-")) {
			result.args.push(arg);
		}
	}

	return result;
}

// =============================================================================
// Command Handlers
// =============================================================================

/**
 * Run a plugin command.
 */
export async function runPluginCommand(cmd: PluginCommandArgs): Promise<void> {
	const manager = new PluginManager();

	switch (cmd.action) {
		case "install":
			await handleInstall(manager, cmd.args, cmd.flags);
			break;
		case "uninstall":
			await handleUninstall(manager, cmd.args, cmd.flags);
			break;
		case "list":
			await handleList(manager, cmd.flags);
			break;
		case "link":
			await handleLink(manager, cmd.args, cmd.flags);
			break;
		case "doctor":
			await handleDoctor(manager, cmd.flags);
			break;
		case "features":
			await handleFeatures(manager, cmd.args, cmd.flags);
			break;
		case "config":
			await handleConfig(manager, cmd.args, cmd.flags);
			break;
		case "enable":
			await handleEnable(manager, cmd.args, cmd.flags);
			break;
		case "disable":
			await handleDisable(manager, cmd.args, cmd.flags);
			break;
	}
}

async function handleInstall(
	manager: PluginManager,
	packages: string[],
	flags: { json?: boolean; force?: boolean; dryRun?: boolean },
): Promise<void> {
	if (packages.length === 0) {
		console.error(chalk.red(`Usage: ${APP_NAME} plugin install <package[@version]>[features] ...`));
		console.error(chalk.dim("Examples:"));
		console.error(chalk.dim(`  ${APP_NAME} plugin install @oh-my-pi/exa`));
		console.error(chalk.dim(`  ${APP_NAME} plugin install @oh-my-pi/exa[search,websets]`));
		console.error(chalk.dim(`  ${APP_NAME} plugin install @oh-my-pi/exa[*]  # all features`));
		console.error(chalk.dim(`  ${APP_NAME} plugin install @oh-my-pi/exa[]   # no optional features`));
		process.exit(1);
	}

	for (const spec of packages) {
		try {
			const result = await manager.install(spec, { force: flags.force, dryRun: flags.dryRun });

			if (flags.json) {
				console.log(JSON.stringify(result, null, 2));
			} else {
				if (flags.dryRun) {
					console.log(chalk.dim(`[dry-run] Would install ${spec}`));
				} else {
					console.log(chalk.green(`✓ Installed ${result.name}@${result.version}`));
					if (result.enabledFeatures && result.enabledFeatures.length > 0) {
						console.log(chalk.dim(`  Features: ${result.enabledFeatures.join(", ")}`));
					}
					if (result.manifest.description) {
						console.log(chalk.dim(`  ${result.manifest.description}`));
					}
				}
			}
		} catch (err) {
			console.error(chalk.red(`✗ Failed to install ${spec}: ${err}`));
			process.exit(1);
		}
	}
}

async function handleUninstall(manager: PluginManager, packages: string[], flags: { json?: boolean }): Promise<void> {
	if (packages.length === 0) {
		console.error(chalk.red(`Usage: ${APP_NAME} plugin uninstall <package> ...`));
		process.exit(1);
	}

	for (const name of packages) {
		try {
			await manager.uninstall(name);

			if (flags.json) {
				console.log(JSON.stringify({ uninstalled: name }));
			} else {
				console.log(chalk.green(`✓ Uninstalled ${name}`));
			}
		} catch (err) {
			console.error(chalk.red(`✗ Failed to uninstall ${name}: ${err}`));
			process.exit(1);
		}
	}
}

async function handleList(manager: PluginManager, flags: { json?: boolean }): Promise<void> {
	const plugins = await manager.list();

	if (flags.json) {
		console.log(JSON.stringify(plugins, null, 2));
		return;
	}

	if (plugins.length === 0) {
		console.log(chalk.dim("No plugins installed"));
		console.log(chalk.dim(`\nInstall plugins with: ${APP_NAME} plugin install <package>`));
		return;
	}

	console.log(chalk.bold("Installed Plugins:\n"));
	for (const plugin of plugins) {
		const status = plugin.enabled ? chalk.green("●") : chalk.dim("○");
		const nameVersion = `${plugin.name}@${plugin.version}`;
		console.log(`${status} ${nameVersion}`);

		if (plugin.manifest.description) {
			console.log(chalk.dim(`  ${plugin.manifest.description}`));
		}

		if (plugin.enabledFeatures && plugin.enabledFeatures.length > 0) {
			console.log(chalk.dim(`  Features: ${plugin.enabledFeatures.join(", ")}`));
		}

		// Show available features if manifest has them
		if (plugin.manifest.features) {
			const availableFeatures = Object.keys(plugin.manifest.features);
			if (availableFeatures.length > 0) {
				const enabledSet = new Set(plugin.enabledFeatures ?? []);
				const featureDisplay = availableFeatures
					.map((f) => (enabledSet.has(f) ? chalk.green(f) : chalk.dim(f)))
					.join(", ");
				console.log(chalk.dim(`  Available: [${featureDisplay}]`));
			}
		}
	}
}

async function handleLink(manager: PluginManager, paths: string[], flags: { json?: boolean }): Promise<void> {
	if (paths.length === 0) {
		console.error(chalk.red(`Usage: ${APP_NAME} plugin link <path>`));
		process.exit(1);
	}

	try {
		const result = await manager.link(paths[0]);

		if (flags.json) {
			console.log(JSON.stringify(result, null, 2));
		} else {
			console.log(chalk.green(`✓ Linked ${result.name} from ${paths[0]}`));
		}
	} catch (err) {
		console.error(chalk.red(`✗ Failed to link: ${err}`));
		process.exit(1);
	}
}

async function handleDoctor(manager: PluginManager, flags: { json?: boolean; fix?: boolean }): Promise<void> {
	const checks = await manager.doctor({ fix: flags.fix });

	if (flags.json) {
		console.log(JSON.stringify(checks, null, 2));
		return;
	}

	console.log(chalk.bold("Plugin Health Check\n"));

	for (const check of checks) {
		const icon =
			check.status === "ok" ? chalk.green("✓") : check.status === "warning" ? chalk.yellow("!") : chalk.red("✗");
		console.log(`${icon} ${check.name}: ${check.message}`);
		if (check.fixed) {
			console.log(chalk.dim(`  → Fixed`));
		}
	}

	const errors = checks.filter((c) => c.status === "error" && !c.fixed).length;
	const warnings = checks.filter((c) => c.status === "warning" && !c.fixed).length;
	const ok = checks.filter((c) => c.status === "ok").length;
	const fixed = checks.filter((c) => c.fixed).length;

	console.log("");
	console.log(`Summary: ${ok} ok, ${warnings} warnings, ${errors} errors${fixed > 0 ? `, ${fixed} fixed` : ""}`);

	if (errors > 0) {
		if (!flags.fix) {
			console.log(chalk.dim("\nRun with --fix to attempt automatic repair"));
		}
		process.exit(1);
	}
}

async function handleFeatures(
	manager: PluginManager,
	args: string[],
	flags: { json?: boolean; enable?: string; disable?: string; set?: string },
): Promise<void> {
	if (args.length === 0) {
		console.error(
			chalk.red(`Usage: ${APP_NAME} plugin features <plugin> [--enable f1,f2] [--disable f1] [--set f1,f2]`),
		);
		process.exit(1);
	}

	const pluginName = args[0];
	const plugins = await manager.list();
	const plugin = plugins.find((p) => p.name === pluginName);

	if (!plugin) {
		console.error(chalk.red(`Plugin "${pluginName}" not found`));
		process.exit(1);
	}

	// Handle modifications
	if (flags.enable || flags.disable || flags.set) {
		let currentFeatures = new Set(manager.getEnabledFeatures(pluginName) ?? []);

		if (flags.set) {
			// --set replaces all features
			currentFeatures = new Set(
				flags.set
					.split(",")
					.map((f) => f.trim())
					.filter(Boolean),
			);
		} else {
			if (flags.enable) {
				for (const f of flags.enable
					.split(",")
					.map((f) => f.trim())
					.filter(Boolean)) {
					currentFeatures.add(f);
				}
			}
			if (flags.disable) {
				for (const f of flags.disable
					.split(",")
					.map((f) => f.trim())
					.filter(Boolean)) {
					currentFeatures.delete(f);
				}
			}
		}

		await manager.setEnabledFeatures(pluginName, [...currentFeatures]);
		console.log(chalk.green(`✓ Updated features for ${pluginName}`));
	}

	// Display current state
	const updatedFeatures = manager.getEnabledFeatures(pluginName);

	if (flags.json) {
		console.log(
			JSON.stringify(
				{
					plugin: pluginName,
					enabledFeatures: updatedFeatures,
					availableFeatures: plugin.manifest.features ? Object.keys(plugin.manifest.features) : [],
				},
				null,
				2,
			),
		);
		return;
	}

	console.log(chalk.bold(`Features for ${pluginName}:\n`));

	if (!plugin.manifest.features || Object.keys(plugin.manifest.features).length === 0) {
		console.log(chalk.dim("  No optional features available"));
		return;
	}

	const enabledSet = new Set(updatedFeatures ?? []);
	for (const [name, feat] of Object.entries(plugin.manifest.features)) {
		const enabled = enabledSet.has(name);
		const icon = enabled ? chalk.green("●") : chalk.dim("○");
		const defaultLabel = feat.default ? chalk.dim(" (default)") : "";
		console.log(`${icon} ${name}${defaultLabel}`);
		if (feat.description) {
			console.log(chalk.dim(`    ${feat.description}`));
		}
	}
}

async function handleConfig(
	manager: PluginManager,
	args: string[],
	flags: { json?: boolean; local?: boolean },
): Promise<void> {
	if (args.length === 0) {
		console.error(
			chalk.red(`Usage: ${APP_NAME} plugin config <list|get|set|delete|validate> <plugin> [key] [value]`),
		);
		process.exit(1);
	}

	const [subcommand, pluginName, key, ...valueArgs] = args;

	// Special case: validate doesn't need a plugin name
	if (subcommand === "validate") {
		await handleConfigValidate(manager, flags);
		return;
	}

	if (!pluginName) {
		console.error(chalk.red("Plugin name required"));
		process.exit(1);
	}

	const plugins = await manager.list();
	const plugin = plugins.find((p) => p.name === pluginName);

	if (!plugin) {
		console.error(chalk.red(`Plugin "${pluginName}" not found`));
		process.exit(1);
	}

	switch (subcommand) {
		case "list": {
			const settings = manager.getPluginSettings(pluginName);
			const schema = plugin.manifest.settings || {};

			if (flags.json) {
				console.log(JSON.stringify({ settings, schema }, null, 2));
				return;
			}

			console.log(chalk.bold(`Settings for ${pluginName}:\n`));

			if (Object.keys(schema).length === 0) {
				console.log(chalk.dim("  No settings defined"));
				return;
			}

			for (const [k, s] of Object.entries(schema)) {
				const value = settings[k] ?? s.default;
				const displayValue = s.secret && value ? "********" : String(value ?? chalk.dim("(not set)"));
				console.log(`  ${k}: ${displayValue}`);
				if (s.description) {
					console.log(chalk.dim(`    ${s.description}`));
				}
				if (s.env) {
					console.log(chalk.dim(`    env: ${s.env}`));
				}
			}
			break;
		}

		case "get": {
			if (!key) {
				console.error(chalk.red("Key required"));
				process.exit(1);
			}

			const settings = manager.getPluginSettings(pluginName);
			const schema = plugin.manifest.settings?.[key];
			const value = settings[key] ?? schema?.default;

			if (flags.json) {
				console.log(JSON.stringify({ [key]: value }));
			} else {
				const displayValue = schema?.secret && value ? "********" : String(value ?? "(not set)");
				console.log(displayValue);
			}
			break;
		}

		case "set": {
			if (!key) {
				console.error(chalk.red("Key required"));
				process.exit(1);
			}

			const valueStr = valueArgs.join(" ");
			const schema = plugin.manifest.settings?.[key];

			// Parse value according to type
			let value: unknown = valueStr;
			if (schema) {
				value = parseSettingValue(valueStr, schema);

				// Validate
				const validation = validateSetting(value, schema);
				if (!validation.valid) {
					console.error(chalk.red(validation.error!));
					process.exit(1);
				}
			}

			manager.setPluginSetting(pluginName, key, value);
			console.log(chalk.green(`✓ Set ${key}`));
			break;
		}

		case "delete": {
			if (!key) {
				console.error(chalk.red("Key required"));
				process.exit(1);
			}

			manager.deletePluginSetting(pluginName, key);
			console.log(chalk.green(`✓ Deleted ${key}`));
			break;
		}

		default:
			console.error(chalk.red(`Unknown config subcommand: ${subcommand}`));
			console.error(chalk.dim("Valid subcommands: list, get, set, delete, validate"));
			process.exit(1);
	}
}

async function handleConfigValidate(manager: PluginManager, flags: { json?: boolean }): Promise<void> {
	const plugins = await manager.list();
	const results: Array<{ plugin: string; key: string; error: string }> = [];

	for (const plugin of plugins) {
		const settings = manager.getPluginSettings(plugin.name);
		const schema = plugin.manifest.settings || {};

		for (const [key, s] of Object.entries(schema)) {
			const value = settings[key];
			if (value !== undefined) {
				const validation = validateSetting(value, s);
				if (!validation.valid) {
					results.push({ plugin: plugin.name, key, error: validation.error! });
				}
			}
		}
	}

	if (flags.json) {
		console.log(JSON.stringify({ valid: results.length === 0, errors: results }, null, 2));
		return;
	}

	if (results.length === 0) {
		console.log(chalk.green("✓ All settings valid"));
	} else {
		for (const { plugin, key, error } of results) {
			console.log(chalk.red(`✗ ${plugin}.${key}: ${error}`));
		}
		process.exit(1);
	}
}

async function handleEnable(manager: PluginManager, plugins: string[], flags: { json?: boolean }): Promise<void> {
	if (plugins.length === 0) {
		console.error(chalk.red(`Usage: ${APP_NAME} plugin enable <plugin> ...`));
		process.exit(1);
	}

	for (const name of plugins) {
		try {
			await manager.setEnabled(name, true);

			if (flags.json) {
				console.log(JSON.stringify({ enabled: name }));
			} else {
				console.log(chalk.green(`✓ Enabled ${name}`));
			}
		} catch (err) {
			console.error(chalk.red(`✗ Failed to enable ${name}: ${err}`));
			process.exit(1);
		}
	}
}

async function handleDisable(manager: PluginManager, plugins: string[], flags: { json?: boolean }): Promise<void> {
	if (plugins.length === 0) {
		console.error(chalk.red(`Usage: ${APP_NAME} plugin disable <plugin> ...`));
		process.exit(1);
	}

	for (const name of plugins) {
		try {
			await manager.setEnabled(name, false);

			if (flags.json) {
				console.log(JSON.stringify({ disabled: name }));
			} else {
				console.log(chalk.green(`✓ Disabled ${name}`));
			}
		} catch (err) {
			console.error(chalk.red(`✗ Failed to disable ${name}: ${err}`));
			process.exit(1);
		}
	}
}

// =============================================================================
// Help
// =============================================================================

export function printPluginHelp(): void {
	console.log(`${chalk.bold(`${APP_NAME} plugin`)} - Plugin lifecycle management

${chalk.bold("Commands:")}
  install <pkg[@ver]>[features]  Install plugins from npm
  uninstall <pkg>                Remove plugins
  list                           Show installed plugins
  link <path>                    Link local plugin for development
  doctor                         Check plugin health
  features <pkg>                 View/modify enabled features
  config <cmd> <pkg> [key] [val] Manage plugin settings
  enable <pkg>                   Enable a disabled plugin
  disable <pkg>                  Disable plugin without uninstalling

${chalk.bold("Feature Syntax:")}
  pkg                Install with default features
  pkg[feat1,feat2]   Install with specific features
  pkg[*]             Install with all features
  pkg[]              Install with no optional features

${chalk.bold("Config Subcommands:")}
  config list <pkg>              List all settings
  config get <pkg> <key>         Get a setting value
  config set <pkg> <key> <val>   Set a setting value
  config delete <pkg> <key>      Delete a setting
  config validate                Validate all plugin settings

${chalk.bold("Options:")}
  --json       Output as JSON
  --fix        Attempt automatic fixes (doctor)
  --force      Overwrite without prompting (install)
  --dry-run    Preview changes without applying (install)
  -l, --local  Use project-local overrides

${chalk.bold("Examples:")}
  ${APP_NAME} plugin install @oh-my-pi/exa[search]
  ${APP_NAME} plugin list --json
  ${APP_NAME} plugin features my-plugin --enable search,web
  ${APP_NAME} plugin config set my-plugin apiKey sk-xxx
  ${APP_NAME} plugin doctor --fix
`);
}
