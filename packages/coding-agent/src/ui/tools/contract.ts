/**
 * Tool presenters: how a tool call and its result appear in the transcript.
 *
 * A presenter is semantic only. It maps a call's args (streaming or final)
 * and its result to a {@link ToolView}: the head facts of the `tool` node and
 * a body of TSP nodes. The transcript's tool block wraps that in one `tool`
 * node; a Tern terminal draws it natively and the terminal backend paints it
 * with the `omp.tool.*` styles (`src/ui/styles/tools/*`). A presenter never
 * draws rows, measures widths or picks colors.
 */
import type { TspPickerAction, TspPreview, TspText, TspTone, TspToolProps } from "@oh-my-pi/pi-wire";
import type { JSXNode } from "@oh-my-pi/pi-tui";

/** What the transcript knows about a call while presenting it. */
export interface ToolViewState {
	/** The user expanded the block (ctrl+o / native toggle). */
	readonly expanded: boolean;
	/** The result is still streaming. */
	readonly isPartial: boolean;
	/** The args are final (message end). */
	readonly argsComplete: boolean;
	/** The call began executing. */
	readonly executionStarted: boolean;
	/** Ms since execution started, or the total once settled; undefined before it starts. */
	readonly elapsedMs?: number;
	/** The call was abandoned without a final result (turn aborted). */
	readonly cancelled?: boolean;
	/** Tool-specific context the transcript threads through (cwd, nested renderers, …). */
	readonly renderContext?: Readonly<Record<string, unknown>>;
}

/** A tool result as presenters receive it. */
export interface ToolResult<TDetails = unknown> {
	readonly content: readonly { readonly type: string; readonly text?: string }[];
	readonly details?: TDetails;
	readonly isError?: boolean;
}

/** The head facts of a call: the `tool` node's props, each fact once. */
export interface ToolHead {
	/** The verb ("Bash", "Edit"); defaults to the tool's label. */
	readonly title?: TspText;
	/** The primary argument: command, path, pattern, query. */
	readonly target?: TspText;
	readonly targetKind?: TspToolProps["targetKind"];
	readonly lang?: string;
	readonly command?: string;
	readonly href?: string;
	/** Short facts after the target (`+8 −1`, `5 matches · 2 files`). */
	readonly meta?: readonly TspText[];
	readonly badges?: TspToolProps["badges"];
	/** A one-word state note ("timed out", "partial"). */
	readonly note?: TspText;
	/** A non-zero exit code. */
	readonly exit?: number | null;
}

/** A call's presentation: head facts and body nodes, never frames. */
export interface ToolView {
	readonly head?: ToolHead;
	/** Header spans for views without a structured head (the card fallback's head; the `tool` title when `head` is absent). */
	readonly label?: TspText;
	/** Body nodes (sections, code, diff, ansi, lists, …). */
	readonly body?: JSXNode;
	/** Tone override; otherwise derived from the call status. */
	readonly tone?: TspTone;
	/** Body clamp while collapsed. */
	readonly preview?: TspPreview | { readonly tail: number } | "none" | "children";
	/** Starts expanded whatever the transcript's expand state. */
	readonly open?: boolean;
	/** Starts collapsed whatever the transcript's expand state. */
	readonly folded?: boolean;
	/** Frameless: a head line plus a disclosed body. */
	readonly inline?: boolean;
	/** Head actions offered on hover (`copy`, `retry`). */
	readonly tools?: readonly TspPickerAction[];
	/**
	 * Facts only the terminal look needs (a bash timeout, a grep scope): the
	 * tool block puts them on the node's `term` prop, which the native backend
	 * never sends.
	 */
	readonly term?: Readonly<Record<string, unknown>>;
}

/** A fence a call draws under its card (a `.svg` being written, as its image). */
export interface ToolFigure {
	readonly lang: string;
	readonly source: string;
	readonly closed: boolean;
}

/** Semantic activity text for the transcript's compact presentation. */
export interface ToolActivity {
	readonly label: string;
	readonly detail?: string;
}

/**
 * A tool's presenter. Either hook may return undefined to show nothing for
 * that phase. Method syntax keeps it assignable to the untyped registry.
 */
export interface ToolPresenter<TArgs = unknown, TDetails = unknown> {
	call?(args: TArgs, state: ToolViewState): ToolView | undefined;
	result?(result: ToolResult<TDetails>, state: ToolViewState, args?: TArgs): ToolView | undefined;
	/** Show call and result as one view (the result view replaces the call's once it exists). */
	readonly merge?: boolean;
	/** Frameless by default (a head line plus a disclosed body); a view's own `inline` overrides it. */
	readonly inline?: boolean;
	/** The body streams while the call is live: the transcript keeps the block open while pending/running. */
	readonly streamsBody?: boolean;
	figure?(args: TArgs, result: ToolResult<TDetails> | undefined, state: ToolViewState): ToolFigure | undefined;
	activity?(args: TArgs, state: ToolViewState): ToolActivity;
}
