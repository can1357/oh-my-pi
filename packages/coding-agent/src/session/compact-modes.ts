/**
 * Manual `/compact` subcommands. Kept in a dependency-free leaf module so the
 * slash-command registry, the interactive controllers, and `AgentSession`
 * can all import the mode metadata + parser without pulling in the heavy
 * `agent-session` module graph (which would form an import cycle through the
 * slash-command registry) — same rationale as `shake-types.ts`.
 *
 * Each mode is a one-off override layered on top of the configured
 * `compaction.*` settings for a single invocation; it never mutates settings.
 * Adding a mode is a single entry here: the command surface (autocomplete +
 * ACP hint), the parser, and the engine override all read this table.
 */

/** Shared error surfaced when callers request the retired snapcompact mode. */
export const SNAPCOMPACT_RETIREMENT_ERROR =
	"/compact snapcompact was removed for safety because active conversation history must remain native text.";

/** Subcommand selecting a one-off compaction mode for manual `/compact`. */
export type CompactMode = "soft" | "remote";

/**
 * Per-invocation overrides merged over the configured `compaction.*` settings.
 * Narrowed to the two knobs the modes actually flip; the result stays
 * assignable to the full `CompactionSettings`.
 */
export interface CompactionOverride {
	strategy?: "context-full";
	remoteEnabled?: boolean;
}

export interface CompactModeDef {
	readonly name: CompactMode;
	/** One-line description surfaced in autocomplete + help. */
	readonly description: string;
	/** Settings overrides applied on top of `compaction.*` for this run. */
	readonly overrides: CompactionOverride;
	/**
	 * When true, the mode explicitly demands a remote path; the engine warns and
	 * falls back to a local summary if neither a remote endpoint nor a
	 * provider-native compaction path is available.
	 */
	readonly requiresRemote?: boolean;
}

export const COMPACT_MODES: readonly CompactModeDef[] = [
	{
		name: "soft",
		description: "Summarize locally with the active model (skip remote endpoints)",
		overrides: { strategy: "context-full", remoteEnabled: false },
	},
	{
		name: "remote",
		description: "Summarize via the remote endpoint / provider-native compaction",
		overrides: { strategy: "context-full", remoteEnabled: true },
		requiresRemote: true,
	},
];

/** Resolve a subcommand token (case-insensitive) to its mode definition. */
export function findCompactMode(name: string): CompactModeDef | undefined {
	const key = name.trim().toLowerCase();
	return COMPACT_MODES.find(mode => mode.name === key);
}

/** Parsed `/compact` arguments: an optional mode plus optional focus text. */
export interface ParsedCompactArgs {
	mode?: CompactMode;
	instructions?: string;
}

/**
 * Split `/compact` args into a leading mode subcommand + focus instructions.
 *
 * Backward compatible: when the first token is not a known mode, the entire
 * argument string is treated as focus instructions (the historical behavior).
 */
export function parseCompactArgs(args: string): ParsedCompactArgs | { error: string } {
	const trimmed = args.trim();
	if (!trimmed) return {};

	const spaceIndex = trimmed.search(/\s/);
	const firstToken = spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex);
	const mode = findCompactMode(firstToken);
	if (firstToken.toLowerCase() === "snapcompact") {
		return { error: SNAPCOMPACT_RETIREMENT_ERROR };
	}
	if (!mode) {
		// No recognized mode prefix — keep the whole thing as focus instructions.
		return { instructions: trimmed };
	}

	const focus = spaceIndex === -1 ? "" : trimmed.slice(spaceIndex + 1).trim();
	return { mode: mode.name, instructions: focus || undefined };
}
