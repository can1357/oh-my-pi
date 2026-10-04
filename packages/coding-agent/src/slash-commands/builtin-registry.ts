import { clearSubmittedText, restoreDetachedDraft } from "./helpers/draft";
import type { AutocompleteItem } from "@oh-my-pi/pi-tui";
import { COLLAB_GUEST_ALLOWED_COMMANDS } from "../collab/guest";
import { BUILTIN_COLLABORATION_SLASH_COMMANDS } from "./builtin-collaboration";
import {
	buildArgumentCompletions,
	buildDirectoryArgumentCompletions,
	buildEffortArgumentCompletions,
	buildEffortInlineHint,
	buildMcpArgumentCompletions,
	buildModelSelectorCompletions,
	buildStaticInlineHint,
	buildSubcommandInlineHint,
} from "./builtin-completions";
import { BUILTIN_CONTROL_SLASH_COMMANDS } from "./builtin-control";
import { BUILTIN_LIFECYCLE_SLASH_COMMANDS } from "./builtin-lifecycle";
import { BUILTIN_MARKETPLACE_SLASH_COMMANDS, reloadTuiPluginState } from "./builtin-marketplace";
import { BUILTIN_MODE_SLASH_COMMANDS } from "./builtin-modes";
import { BUILTIN_SESSION_SLASH_COMMANDS } from "./builtin-session";
import { BUILTIN_SKILLS_SLASH_COMMANDS } from "./builtin-skills";
import { parseSlashCommand } from "./helpers/parse";
import type {
	BuiltinSlashCommand,
	ParsedSlashCommand,
	SlashCommandResult,
	SlashCommandRuntime,
	SlashCommandSpec,
	TuiSlashCommandRuntime,
} from "./types";

export type { BuiltinSlashCommand, SubcommandDef } from "./types";

/** TUI-specific runtime accepted by `executeBuiltinSlashCommand`. */
export type BuiltinSlashCommandRuntime = TuiSlashCommandRuntime;

export interface TuiBuiltinSlashCommand extends BuiltinSlashCommand {
	getArgumentCompletions?: (prefix: string) => AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
	getInlineHint?: (argumentText: string) => string | null;
	getAutocompleteDescription?: () => string | undefined;
}

const BUILTIN_SLASH_COMMAND_REGISTRY: ReadonlyArray<SlashCommandSpec> = [
	...BUILTIN_MODE_SLASH_COMMANDS,
	...BUILTIN_COLLABORATION_SLASH_COMMANDS,
	...BUILTIN_SESSION_SLASH_COMMANDS,
	...BUILTIN_LIFECYCLE_SLASH_COMMANDS,
	...BUILTIN_MARKETPLACE_SLASH_COMMANDS,
	...BUILTIN_SKILLS_SLASH_COMMANDS,
	...BUILTIN_CONTROL_SLASH_COMMANDS,
];

const BUILTIN_SLASH_COMMAND_LOOKUP = new Map<string, SlashCommandSpec>();
for (const command of BUILTIN_SLASH_COMMAND_REGISTRY) {
	BUILTIN_SLASH_COMMAND_LOOKUP.set(command.name, command);
	for (const alias of command.aliases ?? []) {
		BUILTIN_SLASH_COMMAND_LOOKUP.set(alias, command);
	}
}

export const BUILTIN_SLASH_COMMAND_RESERVED_NAMES: ReadonlySet<string> = new Set(BUILTIN_SLASH_COMMAND_LOOKUP.keys());

/** Builtin command metadata used for slash-command autocomplete and help text. */
export const BUILTIN_SLASH_COMMAND_DEFS: ReadonlyArray<BuiltinSlashCommand> = BUILTIN_SLASH_COMMAND_REGISTRY.map(
	command => ({
		name: command.name,
		aliases: command.aliases,
		allowArgs: command.allowArgs === true,
		// Getter: some descriptions name keys, formatted at read time (theme/preset may change).
		get description() {
			return command.description;
		},
		icon: command.icon,
		subcommands: command.subcommands,
		inlineHint: command.inlineHint,
		getTuiAutocompleteDescription: command.getTuiAutocompleteDescription,
	}),
);

function materializeTuiBuiltinSlashCommand(
	cmd: BuiltinSlashCommand,
	runtime?: TuiSlashCommandRuntime,
): TuiBuiltinSlashCommand {
	const materialized: TuiBuiltinSlashCommand = { ...cmd };
	if (cmd.subcommands) {
		const subcommands = cmd.subcommands;
		// `/mcp` and `/effort` narrow their declarative lists to live session
		// state so the dropdown never offers a value the handler would reject.
		if (runtime && cmd.name === "mcp") {
			materialized.getArgumentCompletions = buildMcpArgumentCompletions(subcommands, runtime);
			materialized.getInlineHint = buildSubcommandInlineHint(subcommands);
		} else if (runtime && cmd.name === "effort") {
			materialized.getArgumentCompletions = buildEffortArgumentCompletions(runtime);
			materialized.getInlineHint = buildEffortInlineHint(runtime);
		} else {
			materialized.getArgumentCompletions = buildArgumentCompletions(subcommands);
			materialized.getInlineHint = buildSubcommandInlineHint(subcommands);
		}
	} else if (cmd.name === "move") {
		materialized.getArgumentCompletions = buildDirectoryArgumentCompletions();
		if (cmd.inlineHint) materialized.getInlineHint = buildStaticInlineHint(cmd.inlineHint);
	} else if (cmd.name === "switch" && runtime) {
		materialized.getArgumentCompletions = buildModelSelectorCompletions(runtime);
		if (cmd.inlineHint) materialized.getInlineHint = buildStaticInlineHint(cmd.inlineHint);
	} else if (cmd.inlineHint) {
		materialized.getInlineHint = buildStaticInlineHint(cmd.inlineHint);
	}
	if (runtime && cmd.getTuiAutocompleteDescription) {
		materialized.getAutocompleteDescription = () => cmd.getTuiAutocompleteDescription?.(runtime);
	}
	return materialized;
}

/**
 * Materialized builtin slash commands with completion functions derived from
 * declarative subcommand/hint definitions.
 */
export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<TuiBuiltinSlashCommand> = BUILTIN_SLASH_COMMAND_DEFS.map(cmd =>
	materializeTuiBuiltinSlashCommand(cmd),
);

export function buildTuiBuiltinSlashCommands(runtime: TuiSlashCommandRuntime): ReadonlyArray<TuiBuiltinSlashCommand> {
	return BUILTIN_SLASH_COMMAND_DEFS.map(cmd => materializeTuiBuiltinSlashCommand(cmd, runtime));
}

/**
 * Unified registry exposed for cross-mode tooling. Each spec carries at least
 * one of `handle` / `handleTui`. The TUI dispatcher prefers `handleTui`; the
 * ACP dispatcher requires `handle` and skips TUI-only entries.
 */
export const BUILTIN_SLASH_COMMANDS_INTERNAL: ReadonlyArray<SlashCommandSpec> = BUILTIN_SLASH_COMMAND_REGISTRY;

/**
 * Builtins that keep running in this process while the UI is a client of a session host: they read or move only
 * what is on this screen or this machine (hotkeys, clipboard, links) or end this client.
 */
const HOSTED_LOCAL_COMMANDS: Readonly<Record<string, true>> = {
	hotkeys: true,
	copy: true,
	open: true,
	detach: true,
	attach: true,
	exit: true,
	quit: true,
};

/**
 * Execute a builtin slash command in the interactive TUI.
 *
 * Returns `false` when no builtin matched. Returns `true` when a command
 * consumed the input entirely. Returns a `string` when the command was handled
 * but remaining text should be sent as a prompt.
 *
 * A hosted client (`ctx.hostedClientMode`) runs only {@link HOSTED_LOCAL_COMMANDS} here. A command with a
 * headless `handle` returns `false` as well, so the caller sends the submitted text to the host, which runs it;
 * the rest cannot run anywhere. Those, and any builtin given arguments it does not take, stay in the editor
 * with a status: for a hosted client the generic "not a command" `false` below would reach the host's model.
 */
export async function executeBuiltinSlashCommand(
	text: string,
	runtime: BuiltinSlashCommandRuntime,
): Promise<string | boolean> {
	const parsed = parseSlashCommand(text);
	if (!parsed) return false;

	const command = BUILTIN_SLASH_COMMAND_LOOKUP.get(parsed.name);
	if (!command) return false;
	if (runtime.ctx.hostedClientMode) {
		// Decided before the arguments check below, whose `false` means "ordinary prompt": for a hosted client that
		// would hand a command that cannot run here, or that takes no arguments, to the host's model.
		const local = HOSTED_LOCAL_COMMANDS[command.name] === true;
		const takesNoArgs = parsed.args.length > 0 && !command.allowArgs;
		const refusal =
			!local && !command.handle
				? `/${command.name} is unavailable when attached`
				: takesNoArgs
					? `/${command.name} takes no arguments`
					: undefined;
		if (refusal !== undefined) {
			runtime.ctx.showStatus(refusal);
			// Nothing ran and nothing was sent: the submission goes back to the editor.
			const { editor } = runtime.ctx;
			if (runtime.draftDetached) {
				restoreDetachedDraft(editor, text, runtime.input?.images, runtime.input?.imageLinks);
			} else {
				editor.setCollapsedText(text);
			}
			return true;
		}
		// The host runs what has a headless handler; the caller sends it the submitted text unchanged.
		if (!local) return false;
	}
	if (parsed.args.length > 0 && !command.allowArgs) {
		return false;
	}
	// Collab guests run a read-mostly replica: session-mutating builtins are
	// host-only; the allowlist covers purely local/read-only commands.
	if (runtime.ctx.collabGuest && !COLLAB_GUEST_ALLOWED_COMMANDS[command.name]) {
		runtime.ctx.showStatus(`/${command.name} is host-only during a collab session`);
		clearSubmittedText(runtime);
		return true;
	}
	if (command.handleTui) {
		const result = await command.handleTui(parsed, runtime);
		if (result && typeof result === "object" && "prompt" in result) return result.prompt;
		return true;
	}
	if (command.handle) {
		// No TUI-specific override → adapt the ACP/text-mode `handle` to the
		// TUI by routing `runtime.output` through `ctx.showStatus`, clearing
		// the editor after the call, and reusing the active session's plugin
		// reload pipeline. Spec authors get a single body usable from either
		// dispatcher without forcing every TUI test to construct the full
		// `SlashCommandRuntime` shape.
		const ctx = runtime.ctx;
		const adapted: SlashCommandRuntime = {
			session: ctx.session,
			sessionManager: ctx.sessionManager,
			settings: ctx.settings,
			cwd: ctx.sessionManager.getCwd(),
			output: (text: string) => {
				ctx.showStatus(text);
			},
			refreshCommands: () => ctx.refreshSlashCommandState(),
			reloadPlugins: () => reloadTuiPluginState(ctx),
		};
		const result = await command.handle(parsed, adapted);
		clearSubmittedText(runtime);
		if (result && typeof result === "object" && "prompt" in result) return result.prompt;
		return true;
	}
	return false;
}

/** Look up a unified spec by name or alias. Used by the ACP dispatcher. */
export function lookupBuiltinSlashCommand(name: string): SlashCommandSpec | undefined {
	return BUILTIN_SLASH_COMMAND_LOOKUP.get(name);
}

export type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime, SlashCommandSpec, TuiSlashCommandRuntime };
