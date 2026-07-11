/** Runtime backend that an eval cell dispatches to. */
export type EvalLanguage = "python" | "js" | "ruby" | "julia";

/** Why an eval cell stopped before completion. */
export type EvalCancellationCause = "idle_watchdog_timeout" | "abort";

/** Structured child-process failure evidence emitted by the Python runner. */
export interface EvalProcessErrorEvidence {
	readonly command?: string | readonly string[];
	readonly returncode?: number;
	readonly stdout?: string;
	readonly stderr?: string;
	readonly stdoutArtifactRef?: string;
	readonly stderrArtifactRef?: string;
}

import type { ImageContent } from "@pk-nerdsaver-ai/pi-ai";
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
	/** Typed cancellation cause when status is `error` because execution was cancelled. */
	cancellationCause?: EvalCancellationCause;
	/** Effective clamped timeout budget used by this cell. */
	effectiveTimeoutSeconds?: number;
	/** True only when the idle watchdog exhausted the effective timeout. */
	timedOut?: boolean;
	/** Structured CalledProcessError / TimeoutExpired evidence from explicit runtime fields. */
	processError?: EvalProcessErrorEvidence;
}

/** Tool result detail object surfaced to the UI/transcript. */
export interface EvalToolDetails {
	cells?: EvalCellResult[];
	jsonOutputs?: unknown[];
	images?: ImageContent[];
	statusEvents?: EvalStatusEvent[];
	isError?: boolean;
	/** Cancellation cause for the terminal cell, when the tool stopped early. */
	cancellationCause?: EvalCancellationCause;
	/** Effective clamped timeout budget for the terminal cell. */
	effectiveTimeoutSeconds?: number;
	/** True only when the terminal cell exhausted its idle watchdog budget. */
	timedOut?: boolean;
	/** Structured process-failure evidence from the failing cell, if any. */
	processError?: EvalProcessErrorEvidence;
	meta?: OutputMeta;
	/** First backend that produced cells. Kept for transcript compatibility. */
	language?: EvalLanguage;
	/** Backends that produced cells in this call, in first-use order. */
	languages?: EvalLanguage[];
	/** Optional human-readable notice (e.g. fallback explanation). */
	notice?: string;
}
