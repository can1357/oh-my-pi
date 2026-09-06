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
import type { CompactionMethod } from "./compaction-methods";

/** Subcommand selecting a one-off compaction mode for manual `/compact`. */
export type CompactMode = "soft" | "remote" | "snapcompact";

/**
 * Per-invocation ordered methods merged over the configured
 * `compaction.methodOrder` for this run.
 */
export interface CompactionOverride {
	methodOrder?: CompactionMethod[];
}

export interface CompactModeDef {
	readonly name: CompactMode;
	/** One-line description surfaced in autocomplete + help. */
	readonly description: string;
	/** Settings overrides applied on top of `compaction.*` for this run. */
	readonly overrides: CompactionOverride;
	/**
	 * When true, the mode produces no LLM summary, so trailing focus text is
	 * meaningless and rejected by the parser (snapcompact archives history into
	 * images without a directed summary).
	 */
	readonly rejectsFocus?: boolean;
}

export const COMPACT_MODES: readonly CompactModeDef[] = [
	{
		name: "soft",
		description: "Summarize locally with the active model (skip server compaction)",
		overrides: { methodOrder: ["soft"] },
	},
	{
		name: "remote",
		description: "Summarize via OpenAI-compatible server compaction, then fall back to a local summary",
		overrides: { methodOrder: ["remote", "soft"] },
	},
	{
		name: "snapcompact",
		description: "Archive history onto dense bitmap images the model reads back (no LLM call)",
		overrides: { methodOrder: ["snapcompact"] },
		rejectsFocus: true,
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
 * A recognized mode with `rejectsFocus` and trailing text is an error.
 */
export function parseCompactArgs(args: string): ParsedCompactArgs | { error: string } {
	const trimmed = args.trim();
	if (!trimmed) return {};

	const spaceIndex = trimmed.search(/\s/);
	const firstToken = spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex);
	const mode = findCompactMode(firstToken);
	if (!mode) {
		// No recognized mode prefix — keep the whole thing as focus instructions.
		return { instructions: trimmed };
	}

	const focus = spaceIndex === -1 ? "" : trimmed.slice(spaceIndex + 1).trim();
	if (mode.rejectsFocus && focus) {
		return {
			error: `/compact ${mode.name} does not take focus instructions (it archives history without an LLM summary).`,
		};
	}
	return { mode: mode.name, instructions: focus || undefined };
}
