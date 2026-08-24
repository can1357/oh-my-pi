/** Runtime backend that an eval cell dispatches to. */
export type EvalLanguage = "python" | "js" | "ruby" | "julia";

import type { JsonValue, ToolFactBody } from "@oh-my-pi/pi-agent-core/presentation";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { evalTerminationSchema } from "../presentation/schemas/details";
import type { OutputMeta } from "../tools/output-meta";

/** Status event emitted by eval prelude helpers for TUI rendering. */
export interface EvalStatusEvent {
	op: string;
	[key: string]: unknown;
}

/** Display output captured during eval execution across supported backends. */
export type EvalDisplayOutput =
	| { type: "json"; data: unknown }
	| { type: "image"; data: string; mimeType: string }
	| { type: "markdown"; text?: string }
	| { type: "status"; event: EvalStatusEvent };

/** Per-cell execution result for transcript rendering. */
export interface EvalCellResult {
	index: number;
	title?: string;
	code: string;
	language?: EvalLanguage;
	output: string;
	status: "pending" | "running" | "complete" | "error";
	durationMs?: number;
	exitCode?: number;
	statusEvents?: EvalStatusEvent[];
	hasMarkdown?: boolean;
}

/** Tool result detail object surfaced to the UI/transcript. */
export interface EvalToolDetails {
	cells?: EvalCellResult[];
	jsonOutputs?: JsonValue[];
	images?: ImageContent[];
	statusEvents?: EvalStatusEvent[];
	isError?: boolean;
	/**
	 * How the cell terminated, if not by ordinary completion. A discriminated
	 * union so contradictory states (`timedOut` without `cancelled`) are
	 * unrepresentable. `undefined` means the cell completed normally.
	 */
	termination?: EvalTermination;
	meta?: OutputMeta;
	/** First backend that produced cells. Kept for transcript compatibility. */
	language?: EvalLanguage;
	/** Backends that produced cells in this call, in first-use order. */
	languages?: EvalLanguage[];
	/** Optional human-readable notice (e.g. fallback explanation). */
	notice?: string;
	/** Present when the cell was auto-backgrounded as an async job. */
	async?: {
		state: "running" | "completed" | "failed";
		jobId: string;
		type: "eval";
	};
	/**
	 * Agent-synthesized notes a producer wants a terminal-rendering client to
	 * see even though they never streamed through `onChunk`. No local backend
	 * writes this any more (the ordinary kernel-execution path composes its
	 * `ExecutorBackendResult.annotation` straight into the model-facing text
	 * and declares it as its own `stop_annotation` fact instead of mirroring
	 * it here) — the sole remaining writer is an injected `EvalProxyExecutor`
	 * (an MCP-proxied eval-shaped tool, permanently on the `legacy_snapshot`
	 * lifecycle), and the sole reader is `LegacyEvalPresentation`, that
	 * proxy's own compatibility adapter.
	 */
	notices?: readonly string[];
	/**
	 * Fact bodies this call declared for `EvalTool#modelContentProjection`
	 * (the typed model-content projection escape hatch, shared with `read`/`grep`/`glob`/`bash` via
	 * `renderNoticeTrail` in `presentation/projections.ts`) — see
	 * `ToolResultBuilder#truncationFactFromSummary`'s doc comment.
	 * `meta.truncation`/`meta.limits.columnTruncated` above stay populated
	 * exactly as before for every consumer that already reads them (eval's own
	 * `publishEvalTruncationFacts` live-wire publisher,
	 * `spillLargeResultToArtifact`, `formatStyledTruncationWarning`); this
	 * array is what `#modelContentProjection` and `eval-render.ts`'s TUI
	 * render function use instead of `stripOutputNotice`/`appendOutputNotice`'s
	 * string round-trip.
	 */
	presentationFacts?: readonly ToolFactBody[];
}

/**
 * How an eval cell terminated abnormally. A discriminated union derived from
 * `evalTerminationSchema` so the runtime schema and the static type cannot
 * drift — a rename on either side fails `bun check` (exact parity test in
 * `presentation-schemas.test.ts`).
 *
 * - `interrupted`: a user/system abort (not a timeout). Maps to
 *   `ToolOutcome.kind === "interrupted"`.
 * - `timed_out`: the cell's timeout deadline fired. Carries the configured
 *   timeout in milliseconds — never a fabricated `0`. Maps to
 *   `ToolOutcome.kind === "failed"` with `process.kind === "timed_out"`.
 */
export type EvalTermination = (typeof evalTerminationSchema)["_output"];
