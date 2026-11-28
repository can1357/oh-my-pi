/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * `eval`: notebook cells (Python, JavaScript) run in a kernel. Each cell is
 * one run box: a caption when there are several, the source (reflowed for
 * display), its outputs in print order (text as a following terminal; json,
 * table and Markdown views in place of the text they stand for), the status
 * events helpers emitted, and a foot with the state and run time.
 *
 * Terminal look: `eval` (`src/ui/styles/tools/eval.ts`), fed by {@link EvalTerm}.
 */

import type { JSXNode } from "@oh-my-pi/pi-tui";
import { replaceTabs, truncate } from "@oh-my-pi/pi-tui/text/width";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import {
	type EvalCellResult,
	type EvalLanguage,
	type EvalStatusEvent,
	type EvalToolDetails,
	type EvalView,
	type EvalViewEntry,
	type StatusEventLog,
	splitEvalOutput,
} from "../../tools/details/eval";
import { splitPathAndSel } from "../../tools/details/read";
import { formatEvalCodeForDisplay } from "../../tools/eval-format";
import { type OutputMeta, stripOutputNotice } from "../../tools/output-meta-format";
import type { ToolHead, ToolPresenter, ToolResult, ToolView, ToolViewState } from "./contract";
import { resultText } from "./default";
import { registerToolPresenter } from "./registry";
import { RunBox, RunFoot, type RunFootProps, RunInput, RunOutput, type RunState } from "./run";

interface EvalCellArg {
	readonly language?: string;
	readonly code?: string;
	readonly title?: string;
}

/** Eval call args. */
export interface EvalArgs extends EvalCellArg {
	readonly cells?: readonly EvalCellArg[];
	readonly __partialJson?: string;
}

/** The transcript's viewport context (`state.renderContext`). */
interface EvalRenderContext {
	readonly output?: string;
	readonly expanded?: boolean;
	readonly previewLines?: number;
	readonly timeout?: number;
}

/** One cell as the terminal draws it. */
export interface EvalTermCell {
	readonly language: EvalLanguage;
	/** Source reflowed for display. */
	readonly code: string;
	readonly title?: string;
	readonly status?: EvalCellResult["status"];
	readonly durationMs?: number;
	readonly output?: string;
	readonly views?: readonly EvalViewEntry[];
	/** Events other than `agent` snapshots (all of them when there are none). */
	readonly events?: readonly EvalStatusEvent[];
	readonly elided?: number;
	/** `agent()` progress snapshots, drawn as a tree under the cell. */
	readonly agents?: readonly EvalStatusEvent[];
}

/** Terminal-only facts of an eval call (`term`). */
export interface EvalTerm {
	readonly look: "eval";
	readonly phase: "call" | "cells" | "output";
	readonly cells: readonly EvalTermCell[];
	/** The viewport context's expansion (over the block's), results only. */
	readonly cellsExpanded?: boolean;
	/** Collapsed output rows of a cell. */
	readonly previewLines?: number;
	readonly timeout?: number;
	readonly notice?: string;
	/** A backgrounded job's id. */
	readonly jobId?: string;
	readonly meta?: OutputMeta;
	/** Call-level output (results without per-cell details). */
	readonly output?: string;
	readonly events?: readonly EvalStatusEvent[];
	readonly elided?: number;
}

/** Collapsed output rows of a cell's text output. */
const DEFAULT_PREVIEW_LINES = 10;
/** Status lines a folded cell keeps. */
const RUN_STATUS_TAIL = 8;
/** Cells a status value keeps on its one-line summary. */
const STATUS_VALUE_WIDTH = 200;
/** Lines of a helper's preview an expanded status shows, and folded. */
const STATUS_PREVIEW_LINES = 10;
const STATUS_PREVIEW_FOLDED = 3;

function cellLanguage(value: string | undefined): EvalLanguage {
	if (value === "v8") return "v8";
	return value === "js" ? "js" : "python";
}

/** The highlighter's name of a cell language. */
export function highlightLanguage(language: EvalLanguage | undefined): "python" | "javascript" {
	return language === "js" || language === "v8" ? "javascript" : "python";
}

/** The call's cells, source reflowed for display. */
function argCells(args: EvalArgs | undefined): EvalTermCell[] {
	if (!args) return [];
	const raw = Array.isArray(args.cells) ? args.cells : typeof args.code === "string" ? [args] : [];
	const out: EvalTermCell[] = [];
	for (const cell of raw) {
		if (!cell || typeof cell !== "object") continue;
		const language = cellLanguage(typeof cell.language === "string" ? cell.language : undefined);
		out.push({
			language,
			code: formatEvalCodeForDisplay(cell.code ?? "", language),
			...(typeof cell.title === "string" ? { title: cell.title } : {}),
		});
	}
	return out;
}

function plain(text: string): string {
	return replaceTabs(sanitizeText(text));
}

/** One line of a value: whitespace runs collapsed, cut to `max` cells. */
function previewLine(text: string, max: number): string {
	return truncate(text.replace(/\s+/g, " ").trim(), max);
}

/** MCP progress of an `mcp_progress` event. */
export function mcpProgress(
	event: Readonly<Record<string, unknown>>,
): { progress: number; total?: number; message?: string } | undefined {
	if (typeof event.progress !== "number" || !Number.isFinite(event.progress)) return undefined;
	return {
		progress: event.progress,
		...(typeof event.total === "number" && Number.isFinite(event.total) ? { total: event.total } : {}),
		...(typeof event.message === "string" ? { message: event.message } : {}),
	};
}

/** `message (p/t)`, at most `max` cells; the count stays when the message is cut. */
export function formatMcpProgress(progress: { progress: number; total?: number; message?: string }, max = 200): string {
	const message = progress.message === undefined ? "" : progress.message.replace(/\s+/g, " ").trim();
	const amount = progress.total === undefined ? `${progress.progress}` : `${progress.progress}/${progress.total}`;
	if (!message) return truncate(amount, max);
	if (progress.total === undefined) return truncate(message, max);
	const suffix = ` (${amount})`;
	const room = max - suffix.length;
	return room > 0 ? `${truncate(message, room)}${suffix}` : truncate(amount, max);
}

function eventString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function StatusEvent(props: {
	readonly event: EvalStatusEvent;
	readonly expanded: boolean;
	readonly nodeKey: string;
}): JSXNode {
	const { event } = props;
	const spans: TspSpan[] = [{ t: event.op, s: "accent" }];
	const progress = event.op === "mcp_progress" ? mcpProgress(event) : undefined;
	for (const key in event) {
		if (key === "op" || key === "preview" || key === "resolvedThinkingLevel") continue;
		if (event.op === "mcp_progress" && key !== "tool") continue;
		const value = event[key];
		if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
			spans.push({ t: ` ${key}=`, s: "muted" }, { t: previewLine(sanitizeText(String(value)), STATUS_VALUE_WIDTH) });
	}
	if (progress) spans.push({ t: ` ${formatMcpProgress(progress, STATUS_VALUE_WIDTH)}` });
	const preview = props.expanded ? eventString(event.preview)?.trimEnd() : undefined;
	if (!preview) return <text key={props.nodeKey} spans={spans} truncate="end" role="omp.tool.eval.status" />;
	const head = preview
		.split(/\r?\n/)
		.map(line => plain(line.slice(line.lastIndexOf("\r") + 1)))
		.slice(0, STATUS_PREVIEW_LINES);
	const path = eventString(event.path);
	return (
		<col key={props.nodeKey} role="omp.tool.eval.status.event" gap="none">
			<text key="line" spans={spans} truncate="end" role="omp.tool.eval.status" />
			<code
				key="preview"
				text={head.join("\n")}
				role="omp.tool.eval.status.preview"
				path={path ? splitPathAndSel(path).path : undefined}
				wrap={false}
				preview={{ lines: STATUS_PREVIEW_FOLDED }}
			/>
		</col>
	);
}

/** A cell's status events: the newest {@link RUN_STATUS_TAIL} folded, under an `N earlier` line. */
function StatusSection(props: { readonly log: StatusEventLog; readonly expanded: boolean }): JSXNode {
	const events = props.log.statusEvents ?? [];
	const elided = props.log.statusEventsElided ?? 0;
	if (events.length === 0 && elided === 0) return undefined;
	const from = props.expanded ? 0 : Math.max(0, events.length - RUN_STATUS_TAIL);
	const hidden = from + elided;
	return (
		<col key="status" role="omp.run.status" gap="none">
			{hidden > 0 && <text key="earlier" spans={[{ t: `${hidden} earlier`, s: "muted" }]} />}
			{events.slice(from).map((event, i) => (
				<StatusEvent event={event} expanded={props.expanded} nodeKey={`s${hidden + i}`} />
			))}
		</col>
	);
}

function TableView(props: { readonly view: Extract<EvalView, { kind: "table" }>; readonly nodeKey: string }): JSXNode {
	return (
		<table
			key={props.nodeKey}
			cols={props.view.columns.map((column, c) => ({
				id: `c${c}`,
				head: column.head,
				align: column.numeric ? "end" : undefined,
			}))}
			rows={props.view.rows.map((cells, r) => {
				const record: Record<string, string> = {};
				cells.forEach((cell, c) => {
					record[`c${c}`] = cell;
				});
				return { id: `r${r}`, cells: record };
			})}
			role="omp.tool.eval.table"
		/>
	);
}

/** A cell's outputs in print order: text as a following terminal, views in place of their text. */
function outputNodes(output: string, views: readonly EvalViewEntry[] | undefined, previewLines: number): JSXNode[] {
	if (output.trim().length === 0) return [];
	return splitEvalOutput(output, views).map((part, i) => {
		if (part.kind === "text")
			return (
				<RunOutput
					output={part.text}
					role="omp.tool.eval.output"
					previewLines={previewLines}
					nodeKey={i === 0 ? "output" : `output-${i}`}
				/>
			);
		const view = part.view;
		if (view.kind === "table") return <TableView view={view} nodeKey={`table-${i}`} />;
		if (view.kind === "json") return <json key={`json-${i}`} value={view.value as never} />;
		return <md key={`markdown-${i}`} text={view.text} />;
	});
}

function cellState(status: EvalCellResult["status"], cancelled: boolean): RunState | undefined {
	switch (status) {
		case "pending":
			return undefined;
		case "running":
			return cancelled ? "cancelled" : "running";
		case "complete":
			return "done";
		case "error":
			return "failed";
	}
}

interface CellRun {
	readonly language: EvalLanguage;
	readonly code: string;
	readonly title?: string;
	readonly outputs?: readonly JSXNode[];
	readonly status?: JSXNode;
	readonly foot?: RunFootProps;
}

/** One cell as one run box; a failed cell tints its box. */
function CellBox(props: { readonly cell: CellRun; readonly index: number; readonly total: number }): JSXNode {
	const { cell, index, total } = props;
	let caption: JSXNode;
	if (total > 1) {
		const spans: TspSpan[] = [{ t: `${index + 1}/${total}`, s: "muted" }];
		const title = plain(cell.title ?? "").trim();
		if (title) spans.push({ t: ` ${title}`, s: "toolTitle" });
		caption = <text key="caption" spans={spans} role="omp.run.caption" />;
	}
	return (
		<RunBox nodeKey={`cell-${index}`} tone={cell.foot?.state === "failed" ? "error" : undefined}>
			{caption}
			{cell.code.trim().length > 0 && (
				<RunInput
					source={cell.code}
					role="omp.tool.eval.input"
					lang={highlightLanguage(cell.language)}
					wrap={false}
				/>
			)}
			{cell.outputs}
			{cell.status}
			{cell.foot && <RunFoot {...cell.foot} />}
		</RunBox>
	);
}

/** The head: a single cell's title (else "Eval"), a badge per language, `background`, the cell count. */
function evalHead(
	title: string | undefined,
	languages: readonly EvalLanguage[],
	count: number,
	details?: EvalToolDetails,
): ToolHead {
	const badges: { text: string; title?: string }[] = [...new Set(languages)].map(language => ({ text: language }));
	if (details?.async?.state === "running")
		badges.push({
			text: "background",
			title: `Backgrounded as job ${details.async.jobId}`,
		});
	return {
		title: (count > 1 ? "" : plain(title ?? "").trim()) || "Eval",
		...(badges.length > 0 ? { badges } : {}),
		...(count > 1 ? { meta: [`${count} cells`] } : {}),
	};
}

function callView(args: EvalArgs, state: ToolViewState): ToolView {
	const cells = argCells(args);
	const startFoot: RunFootProps | undefined = state.executionStarted
		? {
				state: state.cancelled ? "cancelled" : "running",
				elapsedMs: state.elapsedMs,
			}
		: undefined;
	return {
		head: evalHead(
			cells[0]?.title,
			cells.map(cell => cell.language),
			cells.length,
		),
		body: cells.map((cell, i) => (
			<CellBox
				cell={{ ...cell, ...(i === 0 && startFoot ? { foot: startFoot } : {}) }}
				index={i}
				total={cells.length}
			/>
		)),
		preview: "children",
		term: { look: "eval", phase: "call", cells } satisfies EvalTerm,
	};
}

function resultView(result: ToolResult<EvalToolDetails>, state: ToolViewState, args?: EvalArgs): ToolView {
	const details = result.details;
	const context = state.renderContext as EvalRenderContext | undefined;
	const cancelled = state.cancelled === true;
	const expanded = context?.expanded ?? state.expanded;
	const previewLines = context?.previewLines ?? DEFAULT_PREVIEW_LINES;
	const callFacts = {
		facts: details?.notice ? [details.notice] : [],
		meta: details?.meta,
	};
	const shared = {
		cellsExpanded: expanded,
		previewLines,
		...(typeof context?.timeout === "number" ? { timeout: context.timeout } : {}),
		...(details?.notice ? { notice: details.notice } : {}),
		...(details?.async?.state === "running" ? { jobId: details.async.jobId } : {}),
		...(details?.meta ? { meta: details.meta } : {}),
	};
	const cellResults = details?.cells;
	if (cellResults && cellResults.length > 0) {
		const languages = cellResults.map(cell => cell.language ?? details?.language ?? "python");
		const states = cellResults.map(cell => cellState(cell.status, cancelled));
		const factsIndex = states.findLastIndex(value => value !== undefined);
		let earlierMs = 0;
		const boxes = cellResults.map((cell, i) => {
			const language = languages[i]!;
			const cellStateValue = states[i];
			const elapsedMs =
				cellStateValue === "running" || cellStateValue === "cancelled"
					? state.elapsedMs === undefined
						? undefined
						: Math.max(0, state.elapsedMs - earlierMs)
					: cell.durationMs;
			earlierMs += cell.durationMs ?? 0;
			return (
				<CellBox
					cell={{
						language,
						code: formatEvalCodeForDisplay(cell.code, language),
						...(cell.title !== undefined ? { title: cell.title } : {}),
						outputs: outputNodes(cell.output, cell.views, previewLines),
						status: <StatusSection log={cell} expanded={expanded} />,
						...(cellStateValue
							? {
									foot: {
										state: cellStateValue,
										exitCode: cell.exitCode,
										elapsedMs,
										...(i === factsIndex ? callFacts : {}),
									},
								}
							: {}),
					}}
					index={i}
					total={cellResults.length}
				/>
			);
		});
		const cells: EvalTermCell[] = cellResults.map((cell, i) => {
			const events = cell.statusEvents ?? [];
			const agents = events.filter(event => event.op === "agent");
			return {
				language: languages[i]!,
				code: formatEvalCodeForDisplay(cell.code, languages[i]!),
				...(cell.title !== undefined ? { title: cell.title } : {}),
				status: cell.status,
				...(cell.durationMs !== undefined ? { durationMs: cell.durationMs } : {}),
				output: cell.output,
				...(cell.views ? { views: cell.views } : {}),
				events: agents.length > 0 ? events.filter(event => event.op !== "agent") : events,
				...(cell.statusEventsElided ? { elided: cell.statusEventsElided } : {}),
				agents,
			};
		});
		return {
			head: evalHead(cellResults[0]!.title, languages, cellResults.length, details),
			body: boxes,
			preview: "children",
			term: {
				look: "eval",
				phase: "cells",
				cells,
				...shared,
			} satisfies EvalTerm,
		};
	}
	const calls = argCells(args);
	const languages = details?.languages ?? (details?.language ? [details.language] : []);
	const raw = context?.output ?? resultText(result).trimEnd();
	const output = stripOutputNotice(raw, details?.meta).trimEnd();
	const runState: RunState = cancelled
		? "cancelled"
		: state.isPartial
			? "running"
			: result.isError
				? "failed"
				: "done";
	const last: Omit<CellRun, "language" | "code" | "title"> = {
		outputs: outputNodes(output, undefined, previewLines),
		status: <StatusSection log={details ?? {}} expanded={expanded} />,
		foot: { state: runState, elapsedMs: state.elapsedMs, ...callFacts },
	};
	const runs: CellRun[] =
		calls.length > 0
			? calls.map((cell, i) => (i === calls.length - 1 ? { ...cell, ...last } : cell))
			: [{ language: languages[0] ?? "python", code: "", ...last }];
	return {
		head: evalHead(
			calls[0]?.title,
			calls.length > 0 ? calls.map(cell => cell.language) : languages,
			calls.length,
			details,
		),
		body: runs.map((run, i) => <CellBox cell={run} index={i} total={runs.length} />),
		preview: "children",
		term: {
			look: "eval",
			phase: "output",
			cells: calls,
			output,
			events: details?.statusEvents ?? [],
			...(details?.statusEventsElided ? { elided: details.statusEventsElided } : {}),
			...shared,
		} satisfies EvalTerm,
	};
}

export const evalPresenter: ToolPresenter<EvalArgs, EvalToolDetails> = {
	merge: true,
	call: callView,
	result: resultView,
};

registerToolPresenter("eval", evalPresenter);
