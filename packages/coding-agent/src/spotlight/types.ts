import type { SpotlightRank, SpotlightReason } from "@oh-my-pi/pi-tui/chat/spotlight";
import type { SpotlightClient } from "./client";

/**
 * Shared types of the Spotlight experiment: tool-output shaping for every tool's results, and file ranking in `find`,
 * both ranked by Stencil's Spotlight service (`POST /v1/spotlight`, {@link SpotlightClient}).
 *
 * With `spotlight.experiment.enabled`, every session shapes its tool output (code reads outlined, test logs cut to
 * failures, long docs to the needed sections, data dumps compacted, lines already seen collapsed, and any other result
 * over ~3.9k chars cut to the ~3k Spotlight ranks highest; source ranges the agent chose and ASCII pictures are never
 * cut, the agent's own script output only when very long; its rule, read narrowly and batch calls, is in the system
 * prompt), `find` ranks with Spotlight, and the session journals one entry per shaped result.
 *
 * "Plain" is what a result would be without shaping: the tool's own output with pi's read summarizer and bash
 * minimizer off (the experiment turns both off), under pi's normal limits. Held-out and gated results get it, and
 * savings count against it.
 */

/** Stencil Cloud's Spotlight route. */
export const DEFAULT_SPOTLIGHT_URL = "https://cloud.stencil.so/v1/spotlight";
/** The Spotlight model id requested by default. */
export const DEFAULT_SPOTLIGHT_MODEL = "whiskers-latest";

/**
 * The name of the tool whose result is shaped, as the agent called it. `read`, `bash` and `eval` shape their own
 * results ({@link SELF_SHAPED_TOOLS}); every other tool's result is shaped as command output when its call returns.
 */
export type ShapedTool = string;

/**
 * Tools that shape their own results inside their execution (a read's file window, a spilled bash output's whole
 * artifact, eval's untruncated output) and have steps of their own; the generic hook leaves them alone.
 */
export const SELF_SHAPED_TOOLS: Readonly<Record<string, true>> = { read: true, bash: true, eval: true };

/** Whether `tool` shapes its own results ({@link SELF_SHAPED_TOOLS}). */
export function shapesItself(tool: string): boolean {
	return Object.hasOwn(SELF_SHAPED_TOOLS, tool);
}

/** `spotlight.experiment.tools` entry meaning every tool. */
export const ALL_TOOLS = "*";

/** Largest spilled output a shaping arm reads whole from its artifact; past it, it shapes what `plain` shows. */
export const SPOTLIGHT_FULL_OUTPUT_MAX_BYTES = 4 * 1024 * 1024;

/** Spotlight's `thinking` level: higher levels cost more. */
export type SpotlightThinking = "low" | "med" | "high" | "max";

/**
 * What the agent is doing at one tool call, as Spotlight's `state` and `source` carry it. Every field is cut to
 * {@link CONTEXT_FIELD_CHARS}.
 */
export interface CallContext {
	/** The user's first message of the session (the task). */
	task: string;
	/** The agent's last text before the call; "" when the turn had none. */
	said: string;
	/** The call's intent argument `i`; "" when intent tracing is off or the call carried none. */
	intent: string;
	/** Up to three earlier bash commands of the session, oldest first. */
	commands: string[];
	/**
	 * The command (bash), code (eval), `read <path>` (read), or for any other tool its name and arguments
	 * (`grep {"pattern":"x"}`) that produced the output.
	 */
	source: string;
}

/** Longest text one {@link CallContext} field carries. */
export const CONTEXT_FIELD_CHARS = 2_000;

/**
 * Ranks the items of one output (lines or groups of lines) for the agent's current call; higher is more relevant.
 * Scores compare within one call only.
 */
export interface Scorer {
	/** Never asks Spotlight (the score-free coin): every step takes its no-score rule without counting a request. */
	readonly scoreFree?: boolean;
	/**
	 * One score per item, in item order, or null when Spotlight did not answer within its budget (no credential,
	 * timeout, HTTP error): callers then fall back to a rule that needs no scores. Never throws for those.
	 */
	score(items: readonly string[], ctx: CallContext, signal?: AbortSignal): Promise<number[] | null>;
}

/** Saves the full text a shaped result hides, so markers can point at it. */
export interface ShapeSink {
	/** Stores `text` and returns the internal URL the agent reads it back with, e.g. `artifact://12`. */
	save(text: string, label: ShapedTool): Promise<string>;
}

/** One tool result to shape. */
export interface ShapeInput {
	tool: ShapedTool;
	/** The model-facing text as the tool built it (pi's own summarizer and minimizer already off unless `native`). */
	text: string;
	/** Session cwd; bash/eval code windows resolve file paths against it. */
	cwd?: string;
	/** `bash`: the command; `eval`: the code; any other tool: its name and arguments, as {@link CallContext.source}. */
	command?: string;
	/**
	 * `read`: the path or URL as the agent wrote it, selectors included; any other tool: its `path` argument (a search
	 * of `artifact://` output pages it back and is left whole, as are `agent://`, `local://`, `skill://`, `rule://`, and
	 * a `read` of Markdown or of one line range without `:raw`).
	 */
	path?: string;
	/** `read` of a text file: its path as the agent named it, and the file's own content lines of the window. */
	read?: {
		path: string;
		/** The window's source lines, unprefixed. */
		lines: string[];
		/** The same lines as the tool shows them (line-number or hashline prefixes); same length as `lines`. */
		shown: string[];
		/** 1-based file line of `lines[0]`. */
		firstLine: number;
		/** The agent asked for this range (`path:A-B`): a source range it chose. */
		selected: boolean;
	};
	/**
	 * `bash` shaped from its whole artifact: that artifact's URL. It numbers the text's lines as cuts name them, so a
	 * cut points there instead of saving a copy.
	 */
	artifact?: string;
	exitCode?: number;
	/** The call's id: lines it notes as seen stay seen until its result is in the model's context. */
	toolCallId?: string;
}

/** A shaped result and what shaping did, for the session journal. */
export interface ShapeOutcome {
	text: string;
	/** Which step rewrote the result: `outline`, `docs`, `tests`, `dump`, `window`, `seen`, `lines`, or `none`. */
	steps: string[];
	/** Counters (chars in/out, hidden lines, Spotlight calls/failures/ms, …). */
	stats: Record<string, number>;
	/**
	 * Tokens of the input and of {@link text}. A changed text saves at least `MIN_SAVED_TOKENS` (`shape/shape.ts`):
	 * shaping that saves fewer is dropped (`stats.reverted`).
	 */
	inTokens: number;
	outTokens: number;
	/**
	 * The changed {@link text} saves fewer than `MIN_SAVED_TOKENS` against what `plain` shows for the call: the agent
	 * gets `plain`'s text and `text`/`outTokens` are the would-be cut's (`steps` ends with `plain-cap`).
	 */
	capped?: boolean;
	/** When shaping changed the text, what became of its subject's lines ({@link ShapedLines}). */
	lines?: ShapedLines;
	/**
	 * A session artifact holding exactly the input text, when a changed text's cut wrote or named one (the copy its
	 * markers point at, or the run's own artifact): the trace's original reuses it instead of saving the text again.
	 */
	textUrl?: string;
}

/**
 * What a changed text made of each line of its subject (a `read`'s window lines, else the text's lines). Positions
 * are 1-based in the subject.
 */
export interface ShapedLines {
	/** Spotlight's latest score per subject line (null: never scored). */
	scores: (number | null)[];
	/** Whether the shaped text shows the line verbatim (a capped line counts as shown). */
	kept: boolean[];
	/** Why shaping showed or hid each line, agreeing with {@link kept}; `-` where the steps' records do not. */
	why: SpotlightReason[];
	/**
	 * Per line of the shaped text: the subject line it shows, the run `[first, last]` a gap marker stands for, or null
	 * for a line of no subject line (a note, a header).
	 */
	map: (number | [number, number] | null)[];
	/** How the last step that cut by rank ranked the lines, when one did. */
	rank?: SpotlightRank;
}

/** Journal entry types written by the experiment. */
export const SPOTLIGHT_ENTRY = {
	session: "spotlight:session",
	shape: "spotlight:shape",
	find: "spotlight:find",
} as const;

export type SpotlightEntryType = (typeof SPOTLIGHT_ENTRY)[keyof typeof SPOTLIGHT_ENTRY];

/** The experiment's handle on one session, present on the tool session only while the experiment is enabled. */
export interface SpotlightSession {
	client: SpotlightClient;
	thinking: SpotlightThinking;
	/** Appends a journal entry; a no-op for sessions that are not persisted. */
	log(type: SpotlightEntryType, data: Record<string, unknown>): void;
}
