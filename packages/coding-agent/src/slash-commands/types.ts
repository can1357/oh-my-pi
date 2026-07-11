import type { Settings } from "../config/settings";
import type { InteractiveModeContext } from "../modes/types";
import type { AgentSession } from "../session/agent-session";
import type { SessionManager } from "../session/session-manager";

/** Declarative subcommand definition for commands like /mcp. */
export interface SubcommandDef {
	name: string;
	description: string;
	/** Usage hint shown as dim ghost text, e.g. "<name> [--scope project|user]". */
	usage?: string;
}

/** Declarative builtin slash command metadata used by autocomplete and help UI. */
export interface BuiltinSlashCommand {
	name: string;
	aliases?: string[];
	description: string;
	/** Subcommands for dropdown completion (e.g. /mcp add, /mcp list). */
	subcommands?: SubcommandDef[];
	/** Static inline hint when command takes a simple argument (no subcommands). */
	inlineHint?: string;
	/** TUI-only dynamic status text for command-name autocomplete. Static `description` remains canonical for ACP/help. */
	getTuiAutocompleteDescription?: (runtime: TuiSlashCommandRuntime) => string | undefined;
}

/** Parsed slash-command text after stripping the leading "/". */
export interface ParsedSlashCommand {
	name: string;
	args: string;
	text: string;
}

/**
 * Result returned by a slash-command handler.
 *
 * - `undefined` (and the implicit `void` return) — command was handled and
 *   consumed; no further input. Handlers may simply omit a `return` rather than
 *   building `{ consumed: true }`; `void` is accepted in the handler signatures
 *   below so the contract typechecks under TypeScript 5.x (which does not
 *   coerce `() => void` to `() => T | undefined`) as well as 6.x / tsgo.
 * - `{ consumed: true }` — explicit equivalent of the above (ACP shape).
 * - `{ prompt: string }` — command handled, pass `prompt` through as the new
 *   user input (e.g. `/force <tool> <prompt>` keeps `<prompt>` as the message).
 */
export type SlashCommandResult = undefined | { consumed: true } | { prompt: string };

/**
 * Runtime visible to slash-command handlers that run in text/ACP mode.
 *
 * Both the TUI dispatcher (when invoking a `handle` via its adapter) and the
 * ACP dispatcher pass this shape. Implementations MUST NOT depend on TUI-only
 * state (editor, selectors, status line).
 */
export interface SlashCommandRuntime {
	session: AgentSession;
	sessionManager: SessionManager;
	settings: Settings;
	cwd: string;
	/** Emit text to the operator. TUI maps to `ctx.showStatus`, ACP to `sessionUpdate`. */
	output: (text: string) => Promise<void> | void;
	/** Re-advertise the available command list (no-op outside ACP). */
	refreshCommands: () => Promise<void> | void;
	/**
	 * Reload plugin state (caches, slash command registry, project registries)
	 * and re-emit available commands. Used by `/reload-plugins`, `/move`, and
	 * `/marketplace`/`/plugins` mutations so the session sees a consistent view
	 * after plugin or project-scope changes.
	 */
	reloadPlugins: () => Promise<void>;
	notifyTitleChanged?: () => Promise<void> | void;
	notifyConfigChanged?: () => Promise<void> | void;
}

/**
 * Runtime visible to TUI-only handlers (`handleTui`). Carries the interactive
 * mode context. Intentionally narrower than `SlashCommandRuntime` so existing
 * callers can keep building it from just `{ ctx }`; when the TUI dispatcher
 * needs to invoke a `handle` (no `handleTui` override), it synthesizes a
 * `SlashCommandRuntime` from `ctx`.
 */
export interface TuiSlashCommandRuntime {
	ctx: InteractiveModeContext;
}

/** Unified slash-command spec consumed by both TUI and ACP dispatchers. */
export interface SlashCommandSpec extends BuiltinSlashCommand {
	/** When false, the dispatcher refuses to handle invocations that include arguments. */
	allowArgs?: boolean;
	/**
	 * ACP-specific override for `description`. Used by `ACP_BUILTIN_SLASH_COMMANDS`
	 * when building `available_commands_update` payloads so the client receives
	 * mode-appropriate copy (e.g. `/dump` advertises "Return full transcript as
	 * plain text" in ACP rather than the TUI's clipboard-centric copy).
	 */
	acpDescription?: string;
	/**
	 * ACP-specific override for the advertised input hint. `subcommands`-only
	 * specs that historically advertised `<subcommand>` / `[on|off|status]` /
	 * `info|delete` to ACP clients carry the hint here so the unification does
	 * not silently drop it from `available_commands_update`.
	 */
	acpInputHint?: string;
	/**
	 * Text/ACP-mode handler. The same body is invoked from the ACP dispatcher
	 * and, via the TUI adapter, when no `handleTui` override is provided.
	 *
	 * Expressed as a union of two function types — one returning a
	 * `SlashCommandResult`, one returning `void` — so handlers that simply
	 * `return` (or omit the return) typecheck under TypeScript 5.x as well as
	 * 6.x / tsgo. TS 5.x does not coerce a `() => void` value into a
	 * `() => T | undefined` slot, so the two return shapes must be siblings
	 * rather than a `T | void` union inside one function type (which Biome's
	 * `noConfusingVoidType` also rejects).
	 */
	handle?:
		| ((
				command: ParsedSlashCommand,
				runtime: SlashCommandRuntime,
		  ) => SlashCommandResult | Promise<SlashCommandResult>)
		| ((command: ParsedSlashCommand, runtime: SlashCommandRuntime) => void | Promise<void>);
	/**
	 * TUI-only handler that supersedes `handle` when both are present. Use for
	 * selectors, wizards, dashboards, and anything else that requires
	 * `InteractiveModeContext`. See `handle` for the rationale behind the
	 * function-type union shape.
	 */
	handleTui?:
		| ((
				command: ParsedSlashCommand,
				runtime: TuiSlashCommandRuntime,
		  ) => SlashCommandResult | Promise<SlashCommandResult>)
		| ((command: ParsedSlashCommand, runtime: TuiSlashCommandRuntime) => void | Promise<void>);
}

/** Result returned by `executeAcpBuiltinSlashCommand`. */
export type AcpBuiltinSlashCommandResult = false | { consumed: true } | { prompt: string };
