/**
 * Tool renderer contract: how a tool call and its result are turned into
 * transcript components. Built-in renderers live beside this file; the
 * coding-agent tools implement the matching `*Details` payloads.
 */
import type { TspPreview, TspText, TspTone, TspToolProps } from "@oh-my-pi/pi-wire";
import type { NativeChild } from "../native/node";
import type { Component } from "../tui";
import type { Theme } from "../theme/theme";

/** Display state handed to `renderCall`/`renderResult`. */
export interface RenderResultOptions {
	/** Whether the result view is expanded */
	expanded: boolean;
	/** Whether this is a partial/streaming result */
	isPartial: boolean;
	/** Current spinner frame index for animated elements (0-9, only provided during partial results) */
	spinnerFrame?: number;
	/**
	 * True once arguments are final (`message_end` / `setArgsComplete`).
	 * Exclusive tools can sit here while an earlier call still runs.
	 */
	argsComplete?: boolean;
	/**
	 * True once this specific call has begun executing (`tool_execution_start`).
	 * Streamed `xd://` previews stay queued until this is set.
	 */
	executionStarted?: boolean;
}

/** Render options for a result, plus the tool-specific context the transcript threads through. */
export type RenderResultContextOptions = RenderResultOptions & { renderContext?: Record<string, unknown> };

/** Tool result shape a renderer receives: content blocks plus the tool's typed `details`. */
export interface ToolRenderResult<TDetails = unknown> {
	content: Array<{ type: string; text?: string }>;
	details?: TDetails;
	isError?: boolean;
}

/**
 * A fence a tool call draws under its card, as assistant Markdown draws that
 * fence. Any fence language may be named (`svg`, `mermaid`, `obj`); the
 * transcript draws only those it draws as figures in assistant text.
 */
export interface ToolFigure {
	readonly lang: string;
	/** The body so far. */
	readonly source: string;
	/** No more of the body arrives. */
	readonly closed: boolean;
}

/**
 * Per-renderer opt-in for a full viewport replay when the first result
 * replaces a painted pending-call render. A predicate receives the painted
 * call args and render options so the repaint stays scoped to the pending
 * shapes that actually re-anchor (an over-eager replay wipes native
 * scrollback on direct terminals).
 */
export type FirstResultViewportRepaint<TArgs = unknown> =
	| boolean
	| ((args: TArgs, options: RenderResultOptions) => boolean);

/** Semantic activity text consumed by the transcript's generic compact card. */
export interface ToolActivitySummary {
	label: string;
	detail?: string;
}

/** Live execution fields that are safe for compact transcript presentation. */
export interface ToolActivityContext {
	readonly expanded: boolean;
	readonly isPartial: boolean;
	readonly spinnerFrame?: number;
	/** Tool-specific render context (same shape `renderCall` receives), when available. */
	readonly renderContext?: Record<string, unknown>;
}

/**
 * The data head of a tool call (NATIVE_REDESIGN §7.2): what the terminal
 * draws in the `tool` kind's head. Each fact appears once — a target named
 * here is never repeated in the body.
 */
export interface NativeToolHead {
	/** The verb ("Bash", "Edit"); defaults to the tool's label. */
	readonly title?: TspText;
	/** The primary argument, shown once: command, path, pattern, query. */
	readonly target?: TspText;
	readonly targetKind?: TspToolProps["targetKind"];
	/** Language for `command` targets. */
	readonly lang?: string;
	/** `file://` link for path targets. */
	readonly href?: string;
	/** Short facts after the target (`+8 −1`, `5 matches · 2 files`). */
	readonly meta?: readonly TspText[];
	readonly badges?: TspToolProps["badges"];
	/** A one-word state note ("timed out", "partial"). */
	readonly note?: TspText;
	/** A non-zero exit code (error chip). */
	readonly exit?: number | null;
}

/**
 * A tool's semantic presentation for Tern Surface Protocol terminals.
 * `ToolExecutionComponent` wraps it in a `tool` node (terminals that list
 * the kind) or, as the fallback, a `card` (role `omp.tool.<name>`, status,
 * elapsed timer, collapse): the renderer supplies only the head data and the
 * body nodes, never frames, padding or width math.
 */
export interface NativeToolView {
	/** The data head; the fallback card's head spans derive from it when {@link head} is absent. */
	readonly tool?: NativeToolHead;
	/** Header spans for the fallback card (and the `tool` title when {@link tool} is absent). */
	readonly head?: TspText;
	/** Body: sections, never frames. */
	readonly body?: readonly NativeChild[];
	/** Tone override; the frame otherwise derives it from the call status. */
	readonly tone?: TspTone;
	/** Body clamp while collapsed; `{tail}` keeps the end (terminal output). Defaults to the transcript's preview size. */
	readonly preview?: TspPreview | { readonly tail: number } | "none";
	/** Render frameless (`frame:"inline"`): a head line plus a disclosed body. */
	readonly inline?: boolean;
	/** Head actions offered on hover (`copy`, `retry`). */
	readonly tools?: TspToolProps["tools"];
}

/**
 * A tool's transcript presentation: call preview, result view, and repaint/animation hints.
 * Method signatures are intentionally bivariant so a renderer typed over its own
 * `TArgs`/`TDetails` is assignable to the untyped registry entry. Either render
 * hook may return `undefined` to paint nothing for that phase.
 */
export interface ToolRenderer<TArgs = unknown, TDetails = unknown> {
	renderCall(args: TArgs, options: RenderResultOptions, theme: Theme): Component | undefined;
	renderResult(
		result: ToolRenderResult<TDetails>,
		options: RenderResultContextOptions,
		theme: Theme,
		args?: TArgs,
	): Component | undefined;
	/**
	 * Semantic call preview for TSP terminals. When a renderer implements the
	 * describe hooks, the native backend never calls `renderCall`/`renderResult`.
	 */
	describeCall?(args: TArgs, options: RenderResultOptions): NativeToolView | undefined;
	/** Semantic result view for TSP terminals; merged with the call view when {@link mergeCallAndResult}. */
	describeResult?(
		result: ToolRenderResult<TDetails>,
		options: RenderResultContextOptions,
		args?: TArgs,
	): NativeToolView | undefined;
	mergeCallAndResult?: boolean;
	/**
	 * The fence a call draws under its card (a `.svg` being written, as its
	 * image): growing while the args stream, closed once they are final; none
	 * after an error. `result` is undefined until the call has one. Rendered
	 * TUI only, and only fences the terminal draws as figures; native views put
	 * their drawing in their describe hooks.
	 */
	figure?(
		args: TArgs,
		result: ToolRenderResult<TDetails> | undefined,
		options: RenderResultOptions,
	): ToolFigure | undefined;
	/** Describes current activity without coupling a renderer to terminal layout. */
	activitySummary?(args: TArgs, context: ToolActivityContext): ToolActivitySummary;
	/** Render without background box, inline in the response flow */
	inline?: boolean;
	/**
	 * Whether the renderer's pending-call path visibly consumes
	 * `options.spinnerFrame`. Used to avoid scheduling repaint ticks for live
	 * partial calls whose bytes cannot change between spinner frames.
	 */
	animatedPendingPreview?: boolean | ((args: TArgs) => boolean);
	/**
	 * Whether the renderer's partial-result path visibly consumes
	 * `options.spinnerFrame`.
	 */
	animatedPartialResult?: boolean | ((args: TArgs) => boolean);
	/**
	 * Whether replacing a pending call render with the first result requires a
	 * full viewport repaint. Use for merged renderers whose pending rows can be
	 * re-anchored instead of preserved by the result render.
	 */
	forceFirstResultViewportRepaint?: FirstResultViewportRepaint<TArgs>;
	/**
	 * Whether settling a provisional partial result into the final render requires
	 * a full viewport repaint. Use when the result renderer changes chrome or
	 * frame topology at `options.isPartial: true -> false`.
	 */
	forceResultViewportRepaintOnSettle?: boolean;
}
