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
// Import APP_NAME from the side-effect-free `/dirs` subpath, NOT the root barrel:
// the root re-exports `./env`, which eagerly loads `.env` from the agent dir at
// import time. Because profile-bootstrap statically imports this module before
// `setProfile` runs, a root-barrel import here would snapshot the default
// profile's env and break `--profile` .env loading (keeps this module side-effect-free).

import type { CommandEntry } from "@pk-nerdsaver-ai/pi-utils/cli";
import { APP_NAME } from "@pk-nerdsaver-ai/pi-utils/dirs";
import {
	EXTENSION_SHADOWABLE_STRING_FLAGS,
	isUnknownLongValueCandidate,
	OPTIONAL_FLAGS,
	OPTIONAL_VALUE_FLAGS,
	STRING_VALUE_FLAGS,
} from "./cli/flag-tables";

export const commands: CommandEntry[] = [
	{ name: "launch", load: () => import("./commands/launch").then(m => m.default) },
	{ name: "acp", load: () => import("./commands/acp").then(m => m.default) },
	{ name: "auth-broker", load: () => import("./commands/auth-broker").then(m => m.default) },
	{ name: "auth-gateway", load: () => import("./commands/auth-gateway").then(m => m.default) },
	{ name: "agents", load: () => import("./commands/agents").then(m => m.default) },
	{ name: "bg", load: () => import("./commands/bg").then(m => m.default) },
	{ name: "bench", load: () => import("./commands/bench").then(m => m.default) },
	{ name: "commit", load: () => import("./commands/commit").then(m => m.default) },
	{ name: "completions", load: () => import("./commands/completions").then(m => m.default) },
	{ name: "__complete", load: () => import("./commands/complete").then(m => m.default) },
	{ name: "config", load: () => import("./commands/config").then(m => m.default) },
	{ name: "dry-balance", load: () => import("./commands/dry-balance").then(m => m.default) },
	{ name: "grep", load: () => import("./commands/grep").then(m => m.default) },
	{ name: "gallery", load: () => import("./commands/gallery").then(m => m.default) },
	{ name: "gc", load: () => import("./commands/gc").then(m => m.default) },
	{ name: "grievances", load: () => import("./commands/grievances").then(m => m.default) },
	{ name: "install", load: () => import("./commands/install").then(m => m.default) },
	{ name: "join", load: () => import("./commands/join").then(m => m.default) },
	{ name: "9router", load: () => import("./commands/9router").then(m => m.default) },
	{ name: "models", load: () => import("./commands/models").then(m => m.default) },
	{ name: "okf", load: () => import("./commands/okf").then(m => m.default) },
	{ name: "plugin", load: () => import("./commands/plugin").then(m => m.default) },
	{ name: "say", load: () => import("./commands/say").then(m => m.default) },
	{ name: "setup", load: () => import("./commands/setup").then(m => m.default) },
	{ name: "shell", load: () => import("./commands/shell").then(m => m.default) },
	{ name: "read", load: () => import("./commands/read").then(m => m.default) },
	{ name: "runtime", load: () => import("./commands/runtime").then(m => m.default) },
	{ name: "ssh", load: () => import("./commands/ssh").then(m => m.default) },
	{ name: "stats", load: () => import("./commands/stats").then(m => m.default) },
	{ name: "update", load: () => import("./commands/update").then(m => m.default) },
	{ name: "usage", load: () => import("./commands/usage").then(m => m.default) },
	{ name: "tiny-models", load: () => import("./commands/tiny-models").then(m => m.default) },
	{ name: "token", load: () => import("./commands/token").then(m => m.default) },
	{ name: "ttsr", load: () => import("./commands/ttsr").then(m => m.default) },
	{ name: "worktree", load: () => import("./commands/worktree").then(m => m.default), aliases: ["wt"] },
	{ name: "search", load: () => import("./commands/web-search").then(m => m.default), aliases: ["q"] },
];

const RESERVED_TOP_LEVEL_WORDS = new Map<string, string>([
	[
		"extensions",
		`\`${APP_NAME} extensions\` is not a management command. Use \`${APP_NAME} plugin list\` / \`${APP_NAME} plugin install\`, or run \`${APP_NAME} launch extensions\` if you meant to send "extensions" as a prompt.`,
	],
	[
		"list",
		`\`omp list\` is not a top-level command. Use \`omp plugin list\` to list installed plugins, or run \`omp launch list\` if you meant to send "list" as a prompt.`,
	],
	[
		"remove",
		`\`omp remove\` is not a top-level command. Use \`omp plugin uninstall\` to remove a plugin, or run \`omp launch remove\` if you meant to send "remove" as a prompt.`,
	],
]);

export function reservedTopLevelWordMessage(first: string | undefined, argc = 1): string | undefined {
	if (argc !== 1 || !first || first.startsWith("-") || first.startsWith("@")) return undefined;
	return RESERVED_TOP_LEVEL_WORDS.get(first);
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
 * Index of a subcommand hidden behind leading global option flags, or
 * `undefined` when the first non-flag token is not a registered subcommand
 * (or was consumed as a flag value).
 *
 * Mirrors the launch parser's value-consumption contract (see
 * `./cli/flag-tables` and the bootstrap pre-parser in
 * `./cli/profile-bootstrap`): known string flags consume the next token even
 * when it looks like a flag, shadowable/optional/unknown long flags consume
 * only a value-like successor, and `--` ends option scanning entirely.
 */
function hiddenSubcommandIndex(argv: string[]): number | undefined {
	let index = 0;
	while (index < argv.length) {
		const arg = argv[index];
		if (arg === "--") return undefined;
		if (!arg.startsWith("-")) {
			return isSubcommand(arg) ? index : undefined;
		}
		const next = argv[index + 1];
		if (EXTENSION_SHADOWABLE_STRING_FLAGS.has(arg)) {
			index += next !== undefined && !next.startsWith("-") ? 2 : 1;
			continue;
		}
		if (STRING_VALUE_FLAGS.has(arg)) {
			index += next !== undefined ? 2 : 1;
			continue;
		}
		if (OPTIONAL_VALUE_FLAGS.has(arg)) {
			const config = OPTIONAL_FLAGS[arg];
			index +=
				next !== undefined && !next.startsWith("-") && !(config.rejectEmpty === true && next.length === 0) ? 2 : 1;
			continue;
		}
		if (isUnknownLongValueCandidate(arg)) {
			index += next !== undefined && !next.startsWith("-") ? 2 : 1;
			continue;
		}
		index += 1;
	}
	return undefined;
}

/**
 * Decide what the CLI runner should do with raw argv: reject bare reserved
 * management words, pass help/version through untouched, hoist a subcommand
 * hidden behind leading global flags to the front (keeping those flags for the
 * subcommand's own parser — see #2970), and route everything else to `launch`.
 */
export function resolveCliArgv(argv: string[]): ResolvedCliArgv {
	const first = argv[0];
	const reservedMessage = reservedTopLevelWordMessage(first, argv.length);
	if (reservedMessage) return { error: reservedMessage };
	if (first === "--help" || first === "-h" || first === "--version" || first === "-v" || first === "help") {
		return { argv };
	}
	if (isSubcommand(first)) return { argv };
	const hidden = hiddenSubcommandIndex(argv);
	if (hidden !== undefined) {
		return { argv: [argv[hidden], ...argv.slice(0, hidden), ...argv.slice(hidden + 1)] };
	}
	return { argv: ["launch", ...argv] };
}
