import { getSSHConfigPath } from "@oh-my-pi/pi-utils";
import { reset as resetCapabilities } from "../../capability";
import { addSSHHost, readSSHConfigFile, removeSSHHost, type SSHHostConfig } from "../../ssh/config-writer";
import { parseCommandArgs } from "../../utils/command-args";
import type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime } from "../types";
import { commandConsumed, errorMessage, parseNamedScopeArgs, parseSubcommand, usage } from "./parse";

interface ParsedSshAddArgs {
	name?: string;
	scope: "user" | "project";
	host?: string;
	username?: string;
	port?: number;
	keyPath?: string;
	error?: string;
}

type SshAddOptionParser = (parsed: ParsedSshAddArgs, value: string | undefined) => string | undefined;

const SSH_ADD_USAGE =
	"Usage: /ssh add <name> --host <host> [--user <user>] [--port <port>] [--key <keyPath>] [--scope project|user]";

const SSH_ADD_OPTION_PARSERS = new Map<string, SshAddOptionParser>([
	[
		"--host",
		(parsed, value) => {
			if (!value) return "Missing value for --host.";
			parsed.host = value;
			return undefined;
		},
	],
	[
		"--user",
		(parsed, value) => {
			if (!value) return "Missing value for --user.";
			parsed.username = value;
			return undefined;
		},
	],
	[
		"--port",
		(parsed, value) => {
			if (!value) return "Missing value for --port.";
			// Reject any non-integer token. `Number.parseInt` accepts trailing
			// garbage (parseInt("22oops") === 22) which silently coerces typos
			// to valid-looking ports.
			if (!/^\d+$/.test(value)) {
				return "Invalid --port value. Must be an integer between 1 and 65535.";
			}
			const port = Number.parseInt(value, 10);
			if (port < 1 || port > 65535) {
				return "Invalid --port value. Must be an integer between 1 and 65535.";
			}
			parsed.port = port;
			return undefined;
		},
	],
	[
		"--key",
		(parsed, value) => {
			if (!value) return "Missing value for --key.";
			parsed.keyPath = value;
			return undefined;
		},
	],
	[
		"--scope",
		(parsed, value) => {
			if (!value || (value !== "project" && value !== "user")) return "Invalid --scope value. Use project or user.";
			parsed.scope = value;
			return undefined;
		},
	],
]);

function parseSshAddArgs(rest: string): ParsedSshAddArgs {
	const tokens = parseCommandArgs(rest);
	const parsed: ParsedSshAddArgs = { scope: "project" };
	let index = 0;
	if (tokens.length > 0 && !tokens[0]!.startsWith("-")) {
		parsed.name = tokens[0];
		index = 1;
	}
	while (index < tokens.length) {
		const arg = tokens[index]!;
		const parser = SSH_ADD_OPTION_PARSERS.get(arg);
		if (!parser) return { ...parsed, error: `Unknown option: ${arg}` };
		const error = parser(parsed, tokens[index + 1]);
		if (error) return { ...parsed, error };
		index += 2;
	}
	return parsed;
}

const SSH_HELP_TEXT = [
	"SSH host management (ACP mode)",
	"  /ssh add <name> --host <host> [--user <user>] [--port <port>] [--key <keyPath>] [--scope project|user]",
	"  /ssh list                                       List configured SSH hosts",
	"  /ssh remove <name> [--scope project|user]       Remove an SSH host",
	"  /ssh help                                        Show this help",
].join("\n");

async function handleListCommand(runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	try {
		const userPath = getSSHConfigPath("user", runtime.cwd);
		const projectPath = getSSHConfigPath("project", runtime.cwd);
		const [userConfig, projectConfig] = await Promise.all([
			readSSHConfigFile(userPath),
			readSSHConfigFile(projectPath),
		]);
		const entries: Array<{ name: string; host: string; user?: string; port?: number; scope: string }> = [];
		// Capability loader resolves project before user, so list project hosts
		// first and let the user-scope loop skip duplicates. Otherwise a host
		// shared between scopes shows up under "user" when the project entry
		// is the one actually in effect.
		for (const [name, config] of Object.entries(projectConfig.hosts ?? {})) {
			entries.push({ name, host: config.host, user: config.username, port: config.port, scope: "project" });
		}
		for (const [name, config] of Object.entries(userConfig.hosts ?? {})) {
			if (!entries.some(entry => entry.name === name)) {
				entries.push({ name, host: config.host, user: config.username, port: config.port, scope: "user" });
			}
		}
		if (entries.length === 0) {
			await runtime.output("No SSH hosts configured.");
			return commandConsumed();
		}
		await runtime.output(
			entries
				.map(entry => `${entry.name} | ${entry.host} | ${entry.user ?? "-"} | ${entry.port ?? 22} [${entry.scope}]`)
				.join("\n"),
		);
		return commandConsumed();
	} catch (err) {
		return usage(`Failed to list SSH hosts: ${errorMessage(err)}`, runtime);
	}
}

async function handleRemoveCommand(rest: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const parsed = parseNamedScopeArgs(rest, "Invalid --scope value. Use project or user.");
	if (parsed.error) return usage(parsed.error, runtime);
	if (!parsed.name) return usage("Usage: /ssh remove <name> [--scope project|user]", runtime);
	try {
		const filePath = getSSHConfigPath(parsed.scope, runtime.cwd);
		await removeSSHHost(filePath, parsed.name);
		resetCapabilities();
		await runtime.output(`Removed SSH host "${parsed.name}" from ${parsed.scope} config.`);
		return commandConsumed();
	} catch (err) {
		return usage(`Failed to remove SSH host: ${errorMessage(err)}`, runtime);
	}
}

async function handleAddCommand(rest: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	if (!rest) return usage(SSH_ADD_USAGE, runtime);
	const parsed = parseSshAddArgs(rest);
	if (parsed.error) return usage(parsed.error, runtime);
	if (!parsed.name) return usage("Host name required. Usage: /ssh add <name> --host <host> ...", runtime);
	if (!parsed.host) return usage("--host is required. Usage: /ssh add <name> --host <host> ...", runtime);
	const hostConfig: SSHHostConfig = { host: parsed.host };
	if (parsed.username) hostConfig.username = parsed.username;
	if (parsed.port) hostConfig.port = parsed.port;
	if (parsed.keyPath) hostConfig.keyPath = parsed.keyPath;
	try {
		const filePath = getSSHConfigPath(parsed.scope, runtime.cwd);
		await addSSHHost(filePath, parsed.name, hostConfig);
		resetCapabilities();
		await runtime.output(`Added SSH host "${parsed.name}" (${parsed.scope}).`);
		return commandConsumed();
	} catch (err) {
		return usage(`Failed to add SSH host: ${errorMessage(err)}`, runtime);
	}
}

/** ACP/text-mode `/ssh` handler. Shared by both dispatchers via the spec. */
export async function handleSshAcp(
	command: ParsedSlashCommand,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	const { verb, rest } = parseSubcommand(command.args);
	if (!verb || verb === "help") {
		await runtime.output(SSH_HELP_TEXT);
		return commandConsumed();
	}
	switch (verb) {
		case "list":
			return await handleListCommand(runtime);
		case "remove":
		case "rm":
			return await handleRemoveCommand(rest, runtime);
		case "add":
			return await handleAddCommand(rest, runtime);
		default:
			return usage(`Unknown /ssh subcommand: ${verb}. Use /ssh help for available subcommands.`, runtime);
	}
}
