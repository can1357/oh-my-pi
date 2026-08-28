/** Runtime backend that an eval cell dispatches to. */
export type EvalLanguage = "python" | "js" | "ruby" | "julia";

import type { ImageContent } from "@oh-my-pi/pi-ai";
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
	jsonOutputs?: unknown[];
	images?: ImageContent[];
	statusEvents?: EvalStatusEvent[];
	isError?: boolean;
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
}
