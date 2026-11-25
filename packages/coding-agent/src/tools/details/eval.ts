import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { SandboxResultMeta } from "../../sandbox/types";
import type { OutputMeta } from "../output-meta-format";
import { type ConfiguredThinkingLevel } from "../../utils/render-utils";

/** Runtime backend that an eval cell dispatches to. */
export type EvalLanguage = "python" | "js";

/** Status event emitted by eval prelude helpers for TUI rendering. */
export interface EvalStatusEvent {
	op: string;
	/** Validated thinking level supplied by the execution layer. */
	resolvedThinkingLevel?: ConfiguredThinkingLevel;
	[key: string]: unknown;
}

/** One column of a table view. */
export interface EvalTableColumn {
	head: string;
	/** Numeric values: renderers right-align the column. */
	numeric?: boolean;
}

/**
 * A pretty rendering of something a cell printed, shown to the user in place
 * of its text; the model only ever sees the text.
 * - `table`: a data frame or `console.table`; leading index columns are plain
 *   columns, and a truncated frame's elided rows/columns are `…` cells.
 * - `json`: a structured value (dict/list, object/array) as a collapsible tree.
 * - `markdown`: an object's Markdown representation.
 */
export type EvalView =
	| { kind: "table"; columns: EvalTableColumn[]; rows: string[][] }
	| { kind: "json"; value: unknown }
	| { kind: "markdown"; text: string };

/**
 * A view and the exact printed text it stands for. Renderers locate `text` in
 * the cell's `output` (entries in print order) and show the view there; an
 * entry whose text is no longer in the output (truncated) is skipped.
 */
export interface EvalViewEntry {
	text: string;
	view: EvalView;
}

/** Per-cell execution result for transcript rendering. */
export interface EvalCellResult {
	index: number;
	title?: string;
	code: string;
	language?: EvalLanguage;
	/** What the model saw: the cell's printed text plus image notes. */
	output: string;
	/** Pretty views of spans of `output`, in print order. */
	views?: EvalViewEntry[];
	status: "pending" | "running" | "complete" | "error";
	durationMs?: number;
	exitCode?: number;
	statusEvents?: EvalStatusEvent[];
	/** Evictable events dropped from the front of `statusEvents` (see {@link recordStatusEvent}). */
	statusEventsElided?: number;
}

/** Tool result detail object surfaced to the UI/transcript. */
export interface EvalToolDetails {
	cells?: EvalCellResult[];
	images?: ImageContent[];
	/**
	 * Call-level status events, written by older builds beside or instead of `cells`; current results
	 * keep them on each cell only.
	 */
	statusEvents?: EvalStatusEvent[];
	/** Evictable events dropped from the front of `statusEvents` (see {@link recordStatusEvent}). */
	statusEventsElided?: number;
	/** Text the cell's tool calls sent to `out://`, oldest first; transcripts draw each as a reply after the call. */
	replies?: string[];
	isError?: boolean;
	meta?: OutputMeta;
	/** First backend that produced cells. Kept for transcript compatibility. */
	language?: EvalLanguage;
	/** Backends that produced cells in this call, in first-use order. */
	languages?: EvalLanguage[];
	/** Optional human-readable notice (e.g. fallback explanation). */
	notice?: string;
	/** Present when the cell was auto-backgrounded as an async job; `cancelled`: killed before it finished. */
	async?: {
		state: "running" | "completed" | "failed" | "cancelled";
		jobId: string;
		type: "eval";
	};
	/** OS sandbox the cells ran in; absent when they ran uncontained. */
	sandbox?: SandboxResultMeta;
}

/**
 * Coalescing key of a progress-snapshot event: `agent`, `judge_batch`, and `mcp_progress`
 * events keyed by `id`, where only the newest snapshot matters. Discrete
 * actions (everything else) have no key. Shared by {@link upsertStatusEvent}
 * and the executors' display collectors so both coalesce identically.
 */
export function statusEventKey(event: { op: string; [key: string]: unknown }): string | undefined {
	if (
		(event.op === "agent" || event.op === "judge_batch" || event.op === "mcp_progress") &&
		typeof event.id === "string"
	) {
		return `${event.op}\0${event.id}`;
	}
	return undefined;
}

/**
 * Evictable status events a log keeps. A cell polling a helper in a loop emits
 * one event per call (hundreds of thousands), and every live update and the
 * persisted tool result would otherwise carry them all.
 */
export const MAX_STATUS_EVENTS = 200;

/** A status event list plus the count of evictable events dropped from its front. */
export type StatusEventLog = Pick<EvalCellResult, "statusEvents" | "statusEventsElided">;

/**
 * Append or replace a status event. Progress snapshots (see
 * {@link statusEventKey}) coalesce in place, preserving first-seen order; every
 * other op is a discrete action and simply appends.
 */
export function upsertStatusEvent(events: EvalStatusEvent[], event: EvalStatusEvent): void {
	const key = statusEventKey(event);
	if (key !== undefined) {
		const idx = events.findIndex(e => statusEventKey(e) === key);
		if (idx >= 0) {
			events[idx] = event;
			return;
		}
	}
	events.push(event);
}

/**
 * {@link upsertStatusEvent} into a bounded log. Past {@link MAX_STATUS_EVENTS},
 * the oldest discrete event or MCP progress snapshot is dropped and counted.
 * Agent/judgment-batch snapshots stay, since agent cards read them, and so does
 * the newest committed `todo` result, which the session todo panel refreshes
 * from. Renderers already show only the newest
 * events behind an "… N earlier" row.
 */
export function recordStatusEvent(log: StatusEventLog, event: EvalStatusEvent): void {
	const events = (log.statusEvents ??= []);
	upsertStatusEvent(events, event);
	if (events.length <= MAX_STATUS_EVENTS) return;
	const keep = events.findLastIndex(e => e.op === "todo" && e.committed === true);
	const oldest = events.findIndex(
		(e, i) => i !== keep && (e.op === "mcp_progress" || statusEventKey(e) === undefined),
	);
	if (oldest < 0) return;
	events.splice(oldest, 1);
	log.statusEventsElided = (log.statusEventsElided ?? 0) + 1;
}

/** One ordered piece of a cell's output: printed text, or a view shown in place of the text it matched. */
export type EvalOutputPart = { kind: "text"; text: string } | { kind: "view"; view: EvalView };

/**
 * Split `output` around its views, in order: each view's `text` is searched
 * from the end of the previous match, unmatched entries are skipped, and
 * blank text between views is dropped (newlines bordering a view trimmed).
 */
export function splitEvalOutput(output: string, views: readonly EvalViewEntry[] | undefined): EvalOutputPart[] {
	const parts: EvalOutputPart[] = [];
	const pushText = (chunk: string, trimStart: boolean, trimEnd: boolean): void => {
		let text = chunk;
		if (trimStart) text = text.replace(/^\n+/, "");
		if (trimEnd) text = text.replace(/\n+$/, "");
		if (text.trim().length > 0) parts.push({ kind: "text", text });
	};
	let cursor = 0;
	for (const entry of views ?? []) {
		if (!entry.text) continue;
		const at = output.indexOf(entry.text, cursor);
		if (at < 0) continue;
		pushText(output.slice(cursor, at), cursor > 0, true);
		parts.push({ kind: "view", view: entry.view });
		cursor = at + entry.text.length;
	}
	pushText(output.slice(cursor), cursor > 0, cursor > 0);
	return parts;
}
