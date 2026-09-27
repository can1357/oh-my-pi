/**
 * Tool renderer contract: how a tool call and its result are turned into
 * transcript components. Built-in renderers live beside this file; the
 * coding-agent tools implement the matching `*Details` payloads.
 */
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
	mergeCallAndResult?: boolean;
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
