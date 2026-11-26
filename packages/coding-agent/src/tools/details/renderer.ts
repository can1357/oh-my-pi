import type { ShellTrace, ShellVizPresentation } from "@oh-my-pi/pi-wire";
import type { ShellStepView } from "../shell-steps";

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
	 */
	executionStarted?: boolean;
	/**
	 * Milliseconds since this call began executing (`tool_execution_start`),
	 * or its total once settled; undefined before it starts. The terminal
	 * transcript's options object computes it on read, so a render-time read
	 * is live while the block's spinner ticks.
	 */
	elapsedMs?: number;
	/** The call was abandoned without a final result (turn aborted, sealed). Native describe hooks only. */
	cancelled?: boolean;
	/** The native host shows files by path (`cx.supports("media")`). Native describe hooks only. */
	media?: boolean;
	/** The native host draws raw JSON values (`cx.supports("json")`). Native describe hooks only. */
	json?: boolean;
	/** The native host draws a live shell trace (`cx.supports("shell")`). Native describe hooks only. */
	shell?: boolean;
	/** The native host shows running agents and jobs in its tray (`cx.feature("tray")`). Native describe hooks only. */
	tray?: boolean;
	/** Native semantic presentation, decoded and cached by the tool component. */
	shellPresentation?: ShellVizPresentation;
	/** Validated immutable trace associated with shellPresentation. */
	shellTrace?: ShellTrace;
	/** Explicit seeks/resets change this epoch; ordinary playback ticks do not. */
	shellReplayEpoch?: number;
	/** The output source of the traced command the card shows: a clicked step's, or what flows now. Native describe hooks only. */
	shellStep?: ShellStepView;
}
