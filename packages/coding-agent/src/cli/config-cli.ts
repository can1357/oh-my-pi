/**
 * Config CLI command handlers.
 *
 * Handles `omp config <command>` subcommands for managing settings.
 * Uses the settings schema as the source of truth for available settings.
 */

import { APP_NAME, getAgentDir } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import {
	getDefault,
	getEnumValues,
	getType,
	getUi,
	isCredential,
	type SettingPath,
	Settings,
	type SettingValue,
	settings,
	validateProviderMaxInFlightRequests,
} from "../config/settings";
import { SETTINGS_SCHEMA } from "../config/settings-schema";
import { theme } from "../modes/theme/theme";
import { initXdg } from "./commands/init-xdg";

// =============================================================================
// Types
// =============================================================================

export type ConfigAction = "list" | "get" | "set" | "reset" | "path" | "init-xdg";

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

type CliSettingDef = {
	path: SettingPath;
	type: string;
	description: string;
	tab: string;
};

const ALL_SETTING_PATHS = Object.keys(SETTINGS_SCHEMA) as SettingPath[];

/** Printed instead of a credential value in human output only. */
const REDACTED = "********";

/** Find setting definition by path */
function findSettingDef(path: string): CliSettingDef | undefined {
	if (!(path in SETTINGS_SCHEMA)) return undefined;
	const key = path as SettingPath;
	const ui = getUi(key);
	return {
		path: key,
		type: getType(key),
		description: ui?.description ?? "",
		tab: ui?.tab ?? "internal",
	};
}

/** Get available values for a setting */
function getSettingValues(def: CliSettingDef): readonly string[] | undefined {
	if (def.type === "enum") {
		return getEnumValues(def.path);
	}
	return undefined;
}

// =============================================================================
// Argument Parser
// =============================================================================

const VALID_ACTIONS: ConfigAction[] = ["list", "get", "set", "reset", "path", "init-xdg"];

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
// Value Formatting
// =============================================================================

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
	if (typeof value === "string") {
		return chalk.yellow(value);
	}
	if (Array.isArray(value) || typeof value === "object") {
		try {
			return chalk.yellow(JSON.stringify(value));
		} catch {
			return chalk.yellow(String(value));
		}
	}
	return chalk.yellow(String(value));
}

function getTypeDisplay(def: CliSettingDef): string {
	const values = getSettingValues(def);
	if (values && values.length > 0) {
		return `(${values.join("|")})`;
	}
	switch (def.type) {
		case "boolean":
			return "(boolean)";
		case "number":
			return "(number)";
		case "array":
			return "(array)";
		case "record":
			return "(record)";
		default:
			return "(string)";
	}
}

// =============================================================================
// Schema-Driven Value Parsing
// =============================================================================

function parseAndSetValue(path: SettingPath, rawValue: string): void {
	const schemaType = getType(path);
	let parsedValue: unknown;

	const trimmed = rawValue.trim();
	switch (schemaType) {
		case "boolean": {
			const lower = trimmed.toLowerCase();
			if (["true", "1", "yes", "on"].includes(lower)) parsedValue = true;
			else if (["false", "0", "no", "off"].includes(lower)) parsedValue = false;
			else throw new Error(`Invalid boolean value: ${rawValue}. Use true/false, yes/no, on/off, or 1/0`);
			break;
		}
		case "number":
			parsedValue = Number(trimmed);
			if (!Number.isFinite(parsedValue)) throw new Error(`Invalid number: ${rawValue}`);
			break;
		case "enum": {
			const valid = getEnumValues(path);
			if (valid && !valid.includes(trimmed)) {
				throw new Error(`Invalid value: ${rawValue}. Valid values: ${valid.join(", ")}`);
			}
			parsedValue = trimmed;
			break;
		}
		case "array": {
			let parsed: unknown;
			try {
				parsed = JSON.parse(trimmed);
			} catch {
				throw new Error(`Invalid array JSON: ${rawValue}`);
			}
			if (!Array.isArray(parsed)) {
				throw new Error(`Invalid array JSON: ${rawValue}`);
			}
			parsedValue = parsed;
			break;
		}
		case "record": {
			let parsed: unknown;
			try {
				parsed = JSON.parse(trimmed);
			} catch {
				throw new Error(`Invalid record JSON: ${rawValue}`);
			}
			if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
				throw new Error(`Invalid record JSON: ${rawValue}`);
			}
			if (path === "providers.maxInFlightRequests") {
				parsed = validateProviderMaxInFlightRequests(parsed);
			}
			parsedValue = parsed;
			break;
		}
		default:
			parsedValue = trimmed;
	}

	settings.set(path, parsedValue as SettingValue<typeof path>);
}

// =============================================================================
// Command Handlers
// =============================================================================

export async function runConfigCommand(cmd: ConfigCommandArgs): Promise<void> {
	await Settings.init();

	switch (cmd.action) {
		case "list":
			await handleList(cmd.flags);
			break;
		case "get":
			handleGet(cmd.key, cmd.flags);
			break;
		case "set":
			await handleSet(cmd.key, cmd.value, cmd.flags);
			break;
		case "reset":
			await handleReset(cmd.key, cmd.flags);
			break;
		case "path":
			handlePath();
			break;
		case "init-xdg":
			await initXdg();
			break;
	}
}

async function writeStdout(text: string): Promise<void> {
	const pending = Promise.withResolvers<void>();
	process.stdout.write(text, error => {
		if (error) {
			pending.reject(error);
			return;
		}
		pending.resolve();
	});
	await pending.promise;
}

async function handleList(flags: { json?: boolean }): Promise<void> {
	const defs = ALL_SETTING_PATHS.map(path => findSettingDef(path)).filter((def): def is CliSettingDef => !!def);

	if (flags.json) {
		// A redacted entry omits `value` and says so, rather than substituting a
		// placeholder string: a consumer cannot tell a stand-in from a real value
		// and could write it back as the credential.
		//
		// Redaction is driven by the value, not by classification alone. Marking an
		// unset credential as redacted would report every fresh install as having
		// one configured, which leaks the opposite of what redaction is for. The
		// settings panel persists "" when a credential is cleared and renders that
		// as unset; the same semantics apply here (credentials are all strings).
		const result: Record<string, { value?: unknown; redacted?: true; type: string; description: string }> = {};
		for (const def of defs) {
			const value = settings.get(def.path);
			result[def.path] =
				isCredential(def.path) && value
					? { redacted: true, type: def.type, description: def.description }
					: { value, type: def.type, description: def.description };
		}
		await writeStdout(`${JSON.stringify(result, null, 2)}\n`);
		return;
	}

	console.log(chalk.bold("Settings:\n"));

	const groups: Record<string, CliSettingDef[]> = {};
	for (const def of defs) {
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
			// `list` dumps every value without anyone asking for a specific
			// credential, so redact here. `get <path>` stays an explicit
			// single-value request and is left alone. An unset or cleared ("")
			// credential keeps its ordinary rendering: masking it would imply one
			// is configured.
			const value = settings.get(def.path);
			const valueStr = isCredential(def.path) && value ? REDACTED : formatValue(value);
			const typeStr = getTypeDisplay(def);
			console.log(`  ${chalk.white(def.path)} = ${valueStr} ${chalk.dim(typeStr)}`);
		}
		console.log("");
	}
}

function handleGet(key: string | undefined, flags: { json?: boolean }): void {
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

	const value = settings.get(def.path);

	if (flags.json) {
		console.log(JSON.stringify({ key: def.path, value, type: def.type, description: def.description }, null, 2));
		return;
	}

	console.log(formatValue(value));
}

async function handleSet(key: string | undefined, value: string | undefined, flags: { json?: boolean }): Promise<void> {
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

	try {
		parseAndSetValue(def.path, value);
		await settings.flush();
	} catch (err) {
		console.error(chalk.red(String(err)));
		process.exit(1);
	}

	const newValue = settings.get(def.path);

	if (flags.json) {
		console.log(JSON.stringify({ key: def.path, value: newValue }));
	} else {
		console.log(chalk.green(`${theme.status.success} Set ${def.path} = ${formatValue(newValue)}`));
	}
}

async function handleReset(key: string | undefined, flags: { json?: boolean }): Promise<void> {
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

	const path = def.path as SettingPath;
	const defaultValue = getDefault(path);
	try {
		settings.set(path, defaultValue as SettingValue<typeof path>);
		await settings.flush();
	} catch (err) {
		console.error(chalk.red(String(err)));
		process.exit(1);
	}

	if (flags.json) {
		console.log(JSON.stringify({ key: def.path, value: defaultValue }));
	} else {
		console.log(chalk.green(`${theme.status.success} Reset ${def.path} to ${formatValue(defaultValue)}`));
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
  init-xdg           Initialize XDG Base Directory structure

${chalk.bold("Options:")}
  --json             Output as JSON

${chalk.bold("Examples:")}
  ${APP_NAME} config list
  ${APP_NAME} config get theme
  ${APP_NAME} config set theme catppuccin-mocha
  ${APP_NAME} config set compaction.enabled false
  ${APP_NAME} config set defaultThinkingLevel medium
  ${APP_NAME} config reset steeringMode
  ${APP_NAME} config list --json
  ${APP_NAME} config init-xdg

${chalk.bold("Boolean Values:")}
  true, false, yes, no, on, off, 1, 0
`);
}
