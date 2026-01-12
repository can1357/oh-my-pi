/**
 * Config CLI command handlers.
 *
 * Handles `omp config <command>` subcommands for managing settings.
 * Uses SETTINGS_DEFS as the source of truth for available settings.
 */

import chalk from "chalk";
import { APP_NAME, getAgentDir } from "../config";
import { SettingsManager } from "../core/settings-manager";
import { SETTINGS_DEFS, type SettingDef } from "../modes/interactive/components/settings-defs";
import { theme } from "../modes/interactive/theme/theme";

// =============================================================================
// Types
// =============================================================================

export type ConfigAction = "list" | "get" | "set" | "reset" | "path";

export interface ConfigCommandArgs {
	action: ConfigAction;
	key?: string;
	value?: string;
	flags: {
		json?: boolean;
	};
}

// =============================================================================
// Setting Filtering
// =============================================================================

/** Find setting definition by ID */
function findSettingDef(id: string): SettingDef | undefined {
	return SETTINGS_DEFS.find((def) => def.id === id);
}

/** Get available values for a setting */
function getSettingValues(def: SettingDef, sm: SettingsManager): readonly string[] | undefined {
	if (def.type === "enum") {
		return def.values;
	}
	if (def.type === "submenu") {
		const options = def.getOptions(sm);
		if (options.length > 0) {
			return options.map((o) => o.value);
		}
	}
	return undefined;
}

// =============================================================================
// Argument Parser
// =============================================================================

const VALID_ACTIONS: ConfigAction[] = ["list", "get", "set", "reset", "path"];

/**
 * Parse config subcommand arguments.
 * Returns undefined if not a config command.
 */
export function parseConfigArgs(args: string[]): ConfigCommandArgs | undefined {
	if (args.length === 0 || args[0] !== "config") {
		return undefined;
	}

	if (args.length < 2 || args[1] === "--help" || args[1] === "-h") {
		return { action: "list", flags: {} };
	}

	const action = args[1];
	if (!VALID_ACTIONS.includes(action as ConfigAction)) {
		console.error(chalk.red(`Unknown config command: ${action}`));
		console.error(`Valid commands: ${VALID_ACTIONS.join(", ")}`);
		process.exit(1);
	}

	const result: ConfigCommandArgs = {
		action: action as ConfigAction,
		flags: {},
	};

	const positionalArgs: string[] = [];
	for (let i = 2; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--json") {
			result.flags.json = true;
		} else if (!arg.startsWith("-")) {
			positionalArgs.push(arg);
		}
	}

	if (positionalArgs.length > 0) {
		result.key = positionalArgs[0];
	}
	if (positionalArgs.length > 1) {
		result.value = positionalArgs.slice(1).join(" ");
	}

	return result;
}

// =============================================================================
// Value Parsing
// =============================================================================

function parseValue(value: string, def: SettingDef, sm: SettingsManager): unknown {
	if (def.type === "boolean") {
		const lower = value.toLowerCase();
		if (lower === "true" || lower === "1" || lower === "yes" || lower === "on") {
			return true;
		}
		if (lower === "false" || lower === "0" || lower === "no" || lower === "off") {
			return false;
		}
		throw new Error(`Invalid boolean value: ${value}. Use true/false, yes/no, on/off, or 1/0`);
	}

	const validValues = getSettingValues(def, sm);
	if (validValues && validValues.length > 0 && !validValues.includes(value)) {
		throw new Error(`Invalid value: ${value}. Valid values: ${validValues.join(", ")}`);
	}

	return value;
}

function formatValue(value: unknown): string {
	if (value === undefined || value === null) {
		return chalk.dim("(not set)");
	}
	if (typeof value === "boolean") {
		return value ? chalk.green("true") : chalk.red("false");
	}
	if (typeof value === "number") {
		return chalk.cyan(String(value));
	}
	return chalk.yellow(String(value));
}

function getTypeDisplay(def: SettingDef, sm: SettingsManager): string {
	if (def.type === "boolean") {
		return "(boolean)";
	}
	const values = getSettingValues(def, sm);
	if (values && values.length > 0) {
		return `(${values.join("|")})`;
	}
	return "(string)";
}

// =============================================================================
// Command Handlers
// =============================================================================

export async function runConfigCommand(cmd: ConfigCommandArgs): Promise<void> {
	const settingsManager = await SettingsManager.create();

	switch (cmd.action) {
		case "list":
			handleList(settingsManager, cmd.flags);
			break;
		case "get":
			handleGet(settingsManager, cmd.key, cmd.flags);
			break;
		case "set":
			await handleSet(settingsManager, cmd.key, cmd.value, cmd.flags);
			break;
		case "reset":
			await handleReset(settingsManager, cmd.key, cmd.flags);
			break;
		case "path":
			handlePath();
			break;
	}
}

function handleList(settingsManager: SettingsManager, flags: { json?: boolean }): void {
	if (flags.json) {
		const result: Record<string, { value: unknown; type: string; description: string }> = {};
		for (const def of SETTINGS_DEFS) {
			result[def.id] = {
				value: def.get(settingsManager),
				type: def.type,
				description: def.description,
			};
		}
		console.log(JSON.stringify(result, null, 2));
		return;
	}

	console.log(chalk.bold("Settings:\n"));

	// Group by tab
	const groups: Record<string, SettingDef[]> = {};
	for (const def of SETTINGS_DEFS) {
		if (!groups[def.tab]) {
			groups[def.tab] = [];
		}
		groups[def.tab].push(def);
	}

	const sortedGroups = Object.keys(groups).sort((a, b) => {
		if (a === "config") return -1;
		if (b === "config") return 1;
		return a.localeCompare(b);
	});

	for (const group of sortedGroups) {
		console.log(chalk.bold.blue(`[${group}]`));
		for (const def of groups[group]) {
			const value = def.get(settingsManager);
			const valueStr = formatValue(value);
			const typeStr = getTypeDisplay(def, settingsManager);
			console.log(`  ${chalk.white(def.id)} = ${valueStr} ${chalk.dim(typeStr)}`);
		}
		console.log("");
	}
}

function handleGet(settingsManager: SettingsManager, key: string | undefined, flags: { json?: boolean }): void {
	if (!key) {
		console.error(chalk.red(`Usage: ${APP_NAME} config get <key>`));
		console.error(chalk.dim(`\nRun '${APP_NAME} config list' to see available keys`));
		process.exit(1);
	}

	const def = findSettingDef(key);
	if (!def) {
		console.error(chalk.red(`Unknown setting: ${key}`));
		console.error(chalk.dim(`\nRun '${APP_NAME} config list' to see available keys`));
		process.exit(1);
	}

	const value = def.get(settingsManager);

	if (flags.json) {
		console.log(JSON.stringify({ key: def.id, value, type: def.type, description: def.description }, null, 2));
		return;
	}

	console.log(formatValue(value));
}

async function handleSet(
	settingsManager: SettingsManager,
	key: string | undefined,
	value: string | undefined,
	flags: { json?: boolean },
): Promise<void> {
	if (!key || value === undefined) {
		console.error(chalk.red(`Usage: ${APP_NAME} config set <key> <value>`));
		console.error(chalk.dim(`\nRun '${APP_NAME} config list' to see available keys`));
		process.exit(1);
	}

	const def = findSettingDef(key);
	if (!def) {
		console.error(chalk.red(`Unknown setting: ${key}`));
		console.error(chalk.dim(`\nRun '${APP_NAME} config list' to see available keys`));
		process.exit(1);
	}

	let parsedValue: unknown;
	try {
		parsedValue = parseValue(value, def, settingsManager);
	} catch (err) {
		console.error(chalk.red(String(err)));
		process.exit(1);
	}

	def.set(settingsManager, parsedValue as never);

	if (flags.json) {
		console.log(JSON.stringify({ key: def.id, value: parsedValue }));
	} else {
		console.log(chalk.green(`${theme.status.success} Set ${def.id} = ${formatValue(parsedValue)}`));
	}
}

async function handleReset(
	settingsManager: SettingsManager,
	key: string | undefined,
	flags: { json?: boolean },
): Promise<void> {
	if (!key) {
		console.error(chalk.red(`Usage: ${APP_NAME} config reset <key>`));
		console.error(chalk.dim(`\nRun '${APP_NAME} config list' to see available keys`));
		process.exit(1);
	}

	const def = findSettingDef(key);
	if (!def) {
		console.error(chalk.red(`Unknown setting: ${key}`));
		console.error(chalk.dim(`\nRun '${APP_NAME} config list' to see available keys`));
		process.exit(1);
	}

	// Get default value from a fresh in-memory settings manager
	const defaults = SettingsManager.inMemory();
	const defaultValue = def.get(defaults);

	def.set(settingsManager, defaultValue as never);

	if (flags.json) {
		console.log(JSON.stringify({ key: def.id, value: defaultValue }));
	} else {
		console.log(chalk.green(`${theme.status.success} Reset ${def.id} to ${formatValue(defaultValue)}`));
	}
}

function handlePath(): void {
	console.log(getAgentDir());
}

// =============================================================================
// Help
// =============================================================================

export function printConfigHelp(): void {
	console.log(`${chalk.bold(`${APP_NAME} config`)} - Manage settings

${chalk.bold("Commands:")}
  list               List all settings with current values
  get <key>          Get a specific setting value
  set <key> <value>  Set a setting value
  reset <key>        Reset a setting to its default value
  path               Print the config directory path

${chalk.bold("Options:")}
  --json             Output as JSON

${chalk.bold("Examples:")}
  ${APP_NAME} config list
  ${APP_NAME} config get theme
  ${APP_NAME} config set theme catppuccin-mocha
  ${APP_NAME} config set autoCompact false
  ${APP_NAME} config set thinkingLevel medium
  ${APP_NAME} config reset steeringMode
  ${APP_NAME} config list --json

${chalk.bold("Boolean Values:")}
  true, false, yes, no, on, off, 1, 0
`);
}
