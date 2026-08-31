/**
 * Top-level CLI command table.
 *
 * Lives in its own module (importable without side effects) so that tests can
 * inspect the registered subcommands without triggering the side-effectful
 * top-level await in `cli.ts`. Adding a new subcommand here is enough to make
 * `runCli` route to it instead of forwarding the argv as a prompt to
 * `launch` — see #1496 for the original "args silently leak to the LLM"
 * regression that motivated the split.
 */
import type { CommandEntry } from "@oh-my-pi/pi-utils/cli";
import * as commandHelp from "./cli/command-help";
import {
	EXTENSION_SHADOWABLE_STRING_FLAGS,
	flagConsumesValue,
	OPTIONAL_VALUE_FLAGS,
	STRING_VALUE_FLAGS,
	VALUELESS_FLAGS,
} from "./cli/flag-tables";
import Copy from "./commands/copy";
import { launchHelp } from "./commands/launch-help";

export const commands: CommandEntry[] = [
	{ name: "launch", load: () => import("./commands/launch").then(m => m.default), help: launchHelp },
	{
		name: "acp",
		load: () => import("./commands/acp").then(m => m.default),
		help: commandHelp.acpHelp,
	},
	{
		name: "auth-broker",
		load: () => import("./commands/auth-broker").then(m => m.default),
		help: commandHelp.authBrokerHelp,
	},
	{
		name: "auth-gateway",
		load: () => import("./commands/auth-gateway").then(m => m.default),
		help: commandHelp.authGatewayHelp,
	},
	{
		name: "agents",
		load: () => import("./commands/agents").then(m => m.default),
		help: commandHelp.agentsHelp,
	},
	{
		name: "bench",
		load: () => import("./commands/bench").then(m => m.default),
		help: commandHelp.benchHelp,
	},
	{
		name: "browser-relay",
		load: () => import("./commands/browser-relay").then(m => m.default),
		help: commandHelp.browserRelayHelp,
	},
	{
		name: "cleanse",
		load: () => import("./commands/cleanse").then(m => m.default),
		help: commandHelp.cleanseHelp,
	},
	{
		name: "commit",
		load: () => import("./commands/commit").then(m => m.default),
		help: commandHelp.commitHelp,
	},
	{
		name: "completions",
		load: () => import("./commands/completions").then(m => m.default),
		help: commandHelp.completionsHelp,
	},
	{
		name: "__complete",
		load: () => import("./commands/complete").then(m => m.default),
		help: commandHelp.completeHelp,
	},
	{
		name: "compress",
		load: () => import("./commands/compress").then(m => m.default),
		help: commandHelp.compressHelp,
	},
	{
		name: "copy",
		load: async () => Copy,
		help: commandHelp.copyHelp,
	},
	{
		name: "config",
		load: () => import("./commands/config").then(m => m.default),
		help: commandHelp.configHelp,
	},
	{
		name: "dry-balance",
		load: () => import("./commands/dry-balance").then(m => m.default),
		help: commandHelp.dryBalanceHelp,
	},
	{
		name: "gc",
		load: () => import("./commands/gc").then(m => m.default),
		help: commandHelp.gcHelp,
	},
	{
		name: "grep",
		load: () => import("./commands/grep").then(m => m.default),
		help: commandHelp.grepHelp,
	},
	{
		name: "gallery",
		load: () => import("./commands/gallery").then(m => m.default),
		help: commandHelp.galleryHelp,
	},
	{
		name: "git",
		load: () => import("./commands/git").then(m => m.default),
		help: commandHelp.gitHelp,
	},
	{
		name: "grievances",
		load: () => import("./commands/grievances").then(m => m.default),
		help: commandHelp.grievancesHelp,
	},
	{
		name: "images",
		load: () => import("./commands/images").then(m => m.default),
		aliases: ["img"],
		help: commandHelp.imagesHelp,
	},
	{
		name: "if-bench",
		load: () => import("./commands/if-bench").then(m => m.default),
		help: commandHelp.ifBenchHelp,
	},
	{
		name: "install",
		load: () => import("./commands/install").then(m => m.default),
		help: commandHelp.installHelp,
	},
	{
		name: "join",
		load: () => import("./commands/join").then(m => m.default),
		help: commandHelp.joinHelp,
	},
	{
		name: "models",
		load: () => import("./commands/models").then(m => m.default),
		help: commandHelp.modelsHelp,
	},
	{
		name: "plugin",
		load: () => import("./commands/plugin").then(m => m.default),
		help: commandHelp.pluginHelp,
	},
	{
		name: "ps",
		load: () => import("./commands/ps").then(m => m.default),
		help: commandHelp.psHelp,
	},
	{
		name: "say",
		load: () => import("./commands/say").then(m => m.default),
		help: commandHelp.sayHelp,
	},
	{
		name: "share",
		load: () => import("./commands/share").then(m => m.default),
		help: commandHelp.shareHelp,
	},
	{
		name: "setup",
		load: () => import("./commands/setup").then(m => m.default),
		help: commandHelp.setupHelp,
	},
	{
		name: "shell",
		load: () => import("./commands/shell").then(m => m.default),
		help: commandHelp.shellHelp,
	},
	{
		name: "read",
		load: () => import("./commands/read").then(m => m.default),
		help: commandHelp.readHelp,
	},
	{
		name: "render",
		load: () => import("./commands/render").then(m => m.default),
		help: commandHelp.renderHelp,
	},
	{
		name: "ssh",
		load: () => import("./commands/ssh").then(m => m.default),
		help: commandHelp.sshHelp,
	},
	{
		name: "stats",
		load: () => import("./commands/stats").then(m => m.default),
		help: commandHelp.statsHelp,
	},
	{
		name: "update",
		load: () => import("./commands/update").then(m => m.default),
		help: commandHelp.updateHelp,
	},
	{
		name: "usage",
		load: () => import("./commands/usage").then(m => m.default),
		help: commandHelp.usageHelp,
	},
	{
		name: "tiny-models",
		load: () => import("./commands/tiny-models").then(m => m.default),
		help: commandHelp.tinyModelsHelp,
	},
	{
		name: "token",
		load: () => import("./commands/token").then(m => m.default),
		help: commandHelp.tokenHelp,
	},
	{
		name: "ttsr",
		load: () => import("./commands/ttsr").then(m => m.default),
		help: commandHelp.ttsrHelp,
	},
	{
		name: "worktree",
		load: () => import("./commands/worktree").then(m => m.default),
		aliases: ["wt"],
		help: commandHelp.worktreeHelp,
	},
	{
		name: "search",
		load: () => import("./commands/web-search").then(m => m.default),
		aliases: ["q"],
		help: commandHelp.searchHelp,
	},
];

// Documented-looking plugin/marketplace verbs that are NOT registered top-level
// commands. Without a guard `resolveCliArgv` rewrites e.g. `omp marketplace add
// xyz` to `omp launch marketplace add xyz`, silently forwarding the argv to the
// model as a prompt instead of managing plugins (#4845; same class as the
// `list`/`remove` leak fixed in #2935 and the `install` leak in #1496/#1498).
// The real commands live under `omp plugin <action>`; each entry maps a verb to
// a hint pointing there. See {@link reservedTopLevelWordMessage} for when a hint
// fires vs. when the argv still falls through to `launch`.
const RESERVED_TOP_LEVEL_WORDS: Record<string, string> = {
	extensions:
		'`omp extensions` is not a management command. Use `omp plugin list` / `omp plugin install`, or run `omp launch extensions` if you meant to send "extensions" as a prompt.',
	list: '`omp list` is not a top-level command. Use `omp plugin list` to list installed plugins, or run `omp launch list` if you meant to send "list" as a prompt.',
	remove:
		'`omp remove` is not a top-level command. Use `omp plugin uninstall <name>` to remove a plugin, or run `omp launch remove` if you meant to send "remove" as a prompt.',
	uninstall:
		'`omp uninstall` is not a top-level command. Use `omp plugin uninstall <name@marketplace>` to remove a plugin, or run `omp launch uninstall` if you meant to send "uninstall" as a prompt.',
	marketplace:
		'`omp marketplace` is not a top-level command. Use `omp plugin marketplace <add|remove|update|list>` to manage marketplaces, or run `omp launch marketplace` if you meant to send "marketplace" as a prompt.',
	discover:
		'`omp discover` is not a top-level command. Use `omp plugin discover [marketplace]` to browse available plugins, or run `omp launch discover` if you meant to send "discover" as a prompt.',
	upgrade:
		'`omp upgrade` is not a top-level command. Use `omp plugin upgrade [name@marketplace]` to upgrade plugins, or run `omp launch upgrade` if you meant to send "upgrade" as a prompt.',
	enable:
		'`omp enable` is not a top-level command. Use `omp plugin enable <name@marketplace>` to enable a plugin, or run `omp launch enable` if you meant to send "enable" as a prompt.',
	disable:
		'`omp disable` is not a top-level command. Use `omp plugin disable <name@marketplace>` to disable a plugin, or run `omp launch disable` if you meant to send "disable" as a prompt.',
};

// Sub-actions that make `omp marketplace <sub>` unambiguously a management
// command even when multi-word (the reporter's `omp marketplace add xyz`,
// #4845). Mirrors the switch in `handleMarketplace` (cli/plugin-cli.ts).
const MARKETPLACE_SUBCOMMANDS: Record<string, true> = { add: true, remove: true, rm: true, update: true, list: true };

/**
 * Hint for a reserved plugin/marketplace verb used as a top-level command, or
 * `undefined` when the argv should fall through to `launch`.
 *
 * A bare verb (`omp marketplace`) always hints. A multi-word invocation only
 * hints when the arguments follow the documented plugin grammar — a marketplace
 * sub-action (`omp marketplace add …`) or a `name@marketplace` plugin id
 * (`omp uninstall foo@bar`) — so genuine prompts that merely begin with one of
 * these words (`omp list all my files`, `omp upgrade the deps`) still launch.
 *
 * Flags (`-…`) and `@file` arguments in the verb slot are never management
 * commands; those fall through to the default `launch` command.
 */
export function reservedTopLevelWordMessage(argv: readonly string[]): string | undefined {
	const first = argv[0];
	if (!first || first.startsWith("-") || first.startsWith("@")) return undefined;
	const hint = RESERVED_TOP_LEVEL_WORDS[first];
	if (!hint) return undefined;
	const second = argv[1];
	if (second === undefined) return hint;
	if (first === "marketplace" && MARKETPLACE_SUBCOMMANDS[second]) return hint;
	for (let index = 1; index < argv.length; index += 1) {
		const arg = argv[index];
		if (!arg.startsWith("-") && arg.includes("@")) return hint;
	}
	return undefined;
}

/**
 * Return true when `first` matches a registered subcommand name or alias.
 *
 * Flags (`-…`) and `@file` arguments are never subcommands; for those the CLI
 * runner skips ahead to the default `launch` command.
 */
export function isSubcommand(first: string | undefined): boolean {
	if (!first || first.startsWith("-") || first.startsWith("@")) return false;
	return commands.some(entry => entry.name === first || entry.aliases?.includes(first));
}

export type ResolvedCliArgv = { argv: string[] } | { error: string };

/**
 * Index of the first argv token that names a registered subcommand, skipping
 * leading global option flags (and any value they consume) with the same
 * contract as the launch parser ({@link flagConsumesValue}). Returns -1 when
 * scanning hits a non-subcommand positional, an end-of-options `--`, or the end
 * of argv first.
 */
function leadingSubcommandIndex(argv: string[]): number {
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--") return -1;
		if (!arg.startsWith("-")) return isSubcommand(arg) ? index : -1;
		if (flagConsumesValue(arg, argv[index + 1])) index += 1;
	}
	return -1;
}

/**
 * Subcommands that share the launch flag surface, so leading global flags
 * (`--cwd`, `--model`, `--approval-mode`, …) placed before them are meaningful
 * and must be forwarded ({@link resolveCliArgv}, #2970). Every other subcommand
 * parses only its own flags.
 */
export const LAUNCH_FLAG_COMMANDS: Record<string, true> = { launch: true, acp: true };

/** Whether `arg` names a flag from the launch surface (bare or `--flag=value`). */
function isLaunchGlobalFlag(arg: string): boolean {
	const eq = arg.indexOf("=");
	const name = arg.startsWith("--") && eq !== -1 ? arg.slice(0, eq) : arg;
	return (
		STRING_VALUE_FLAGS.has(name) ||
		OPTIONAL_VALUE_FLAGS.has(name) ||
		VALUELESS_FLAGS.has(name) ||
		EXTENSION_SHADOWABLE_STRING_FLAGS.has(name)
	);
}

/**
 * Drop recognized launch-global flags (and any value they consume) from the
 * leading segment before a hoisted non-launch subcommand. `--cwd` and friends
 * belong to the launch surface and mean nothing to a subcommand like `update`,
 * whose strict parser would otherwise reject them with a cryptic
 * `node:util.parseArgs` error (#8891). Tokens the launch tables don't recognize
 * are kept, so a subcommand's own leading flags still reach it.
 */
function stripLaunchGlobalFlags(leading: readonly string[]): string[] {
	const kept: string[] = [];
	for (let index = 0; index < leading.length; index += 1) {
		const arg = leading[index];
		if (isLaunchGlobalFlag(arg)) {
			if (flagConsumesValue(arg, leading[index + 1])) index += 1;
			continue;
		}
		kept.push(arg);
	}
	return kept;
}

/**
 * Decide what the CLI runner should do with raw argv: reject bare reserved
 * management words, pass help/version through untouched, route a recognized
 * subcommand (even behind leading global flags like `--approval-mode=yolo`) to
 * that command, and forward everything else to `launch` (#2970). Leading
 * launch-global flags are forwarded to launch-shaped commands but stripped for
 * other subcommands that cannot parse them (#8891).
 */
export function resolveCliArgv(argv: string[]): ResolvedCliArgv {
	const first = argv[0];
	const reservedMessage = reservedTopLevelWordMessage(argv);
	if (reservedMessage) return { error: reservedMessage };
	if (first === "--help" || first === "-h" || first === "--version" || first === "-v" || first === "help") {
		return { argv };
	}
	if (isSubcommand(first)) return { argv };
	// A subcommand can hide behind leading global option flags
	// (`omp --approval-mode=yolo acp`). `run` dispatches strictly on argv[0], so
	// hoist the subcommand to the front. Launch-shaped commands share the launch
	// flag surface, so their leading flags are forwarded and applied; every other
	// subcommand parses only its own flags, so launch-global flags placed before
	// it (`omp --cwd <dir> update`) are stripped rather than forwarded into a
	// crash (#8891). Genuine launch prompts (no trailing subcommand) are untouched.
	const subIndex = leadingSubcommandIndex(argv);
	if (subIndex >= 0) {
		const sub = argv[subIndex];
		const leading = argv.slice(0, subIndex);
		const trailing = argv.slice(subIndex + 1);
		const forwardedLeading = LAUNCH_FLAG_COMMANDS[sub] === true ? leading : stripLaunchGlobalFlags(leading);
		return { argv: [sub, ...forwardedLeading, ...trailing] };
	}
	return { argv: ["launch", ...argv] };
}
