import type { Component } from "../index";
import { Markdown, Text } from "../index";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type {
	NativeToolHead,
	NativeToolView,
	RenderResultContextOptions,
	RenderResultOptions,
	ToolRenderer,
} from "./renderer";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import { compact, keyed, md, node, span, text } from "../native/describe";
import type { NativeChild, NativeNode } from "../native/node";
import { plainText } from "../native/spans";
import { resultText, runBox, runFoot, type RunFootInput, runInput, runOutput, type RunState } from "./native-view";
import { renderAgentTreeRow } from "./agent-tree";
import { truncateToVisualLines } from "../chrome/visual-truncate";
import { getMarkdownTheme, type Theme } from "../theme/theme";
import {
	type CodeCellOptions,
	markFramedBlockComponent,
	outputBlockContentWidth,
	renderCodeCell,
} from "../render/index";
import { formatOutputPaneLines } from "../render/output-pane";
import { formatEvalCodeForDisplay } from "./eval-format/index";
import {
	JSON_TREE_MAX_DEPTH_COLLAPSED,
	JSON_TREE_MAX_DEPTH_EXPANDED,
	JSON_TREE_MAX_LINES_COLLAPSED,
	JSON_TREE_MAX_LINES_EXPANDED,
	JSON_TREE_SCALAR_LEN_COLLAPSED,
	JSON_TREE_SCALAR_LEN_EXPANDED,
	describeJsonTree,
	renderJsonTreeLines,
} from "./json-tree";
import { formatStyledTruncationWarning, stripOutputNotice } from "./output-meta";
import {
	DEFAULT_TERMINAL_PREVIEW_LINES,
	cappedHeadLines,
	formatTitle,
	previewWindowRows,
	replaceTabs,
	shortenPath,
	truncateToWidth,
	wrapBrackets,
} from "../render/render-utils";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { OutputMeta } from "./output-meta";
import { type ConfiguredThinkingLevel, expandKeyHint } from "../render/render-utils";

/** Runtime backend that an eval cell dispatches to. */
export type EvalLanguage = "python" | "js";

/** Status event emitted by eval prelude helpers for TUI rendering. */
export interface EvalStatusEvent {
	op: string;
	/** Validated thinking level supplied by the execution layer. */
	resolvedThinkingLevel?: ConfiguredThinkingLevel;
	[key: string]: unknown;
}

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
	/** Discrete events dropped from the front of `statusEvents` (see {@link recordStatusEvent}). */
	statusEventsElided?: number;
	hasMarkdown?: boolean;
}

/** Tool result detail object surfaced to the UI/transcript. */
export interface EvalToolDetails {
	cells?: EvalCellResult[];
	jsonOutputs?: unknown[];
	images?: ImageContent[];
	statusEvents?: EvalStatusEvent[];
	/** Discrete events dropped from the front of `statusEvents` (see {@link recordStatusEvent}). */
	statusEventsElided?: number;
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

/** Default collapsed eval output preview height; kept as a named alias (consumed by chat/tool-execution). */
export const EVAL_DEFAULT_PREVIEW_LINES: number = DEFAULT_TERMINAL_PREVIEW_LINES;

function languageForHighlighter(language: EvalLanguage | undefined): "python" | "javascript" {
	if (language === "js") return "javascript";
	return "python";
}

interface EvalRenderCellArg {
	language?: string;
	code?: string;
	title?: string;
}

interface EvalRenderArgs extends EvalRenderCellArg {
	cells?: EvalRenderCellArg[];
	__partialJson?: string;
}

interface EvalRenderContext {
	output?: string;
	expanded?: boolean;
	previewLines?: number;
	timeout?: number;
}

interface EvalRenderCell {
	language: EvalLanguage;
	code: string;
	title?: string;
}

function normalizeRenderLanguage(value: string | undefined): EvalLanguage {
	if (value === "js") return "js";
	return "python";
}

function getRenderCells(args: EvalRenderArgs | undefined): EvalRenderCell[] {
	if (!args) return [];
	const raw = Array.isArray(args.cells) ? args.cells : typeof args.code === "string" ? [args] : [];
	const out: EvalRenderCell[] = [];
	for (const cell of raw) {
		if (!cell || typeof cell !== "object") continue;
		const language = normalizeRenderLanguage(typeof cell.language === "string" ? cell.language : undefined);
		out.push({
			language,
			code: formatEvalCodeForDisplay(cell.code ?? "", language),
			title: typeof cell.title === "string" ? cell.title : undefined,
		});
	}
	return out;
}

/**
 * A rendered {@link renderCodeCell} box. Its first row is the header bar, the
 * only row that depends on `spinnerFrame`; the code and output rows below it
 * are reused across spinner ticks.
 */
interface RenderedCodeCell {
	readonly options: CodeCellOptions;
	readonly lines: readonly string[];
}

/**
 * Append `cell` for `spinnerFrame`. Only a running header animates, so only it
 * is redrawn for a new frame: `renderOutputBlock` lays the header bar out from
 * the header fields and width alone, so rendering an empty cell with the same
 * header yields the identical bar row.
 */
function pushCodeCellLines(
	out: string[],
	cell: RenderedCodeCell,
	spinnerFrame: number | undefined,
	theme: Theme,
): void {
	const { options, lines } = cell;
	const header =
		options.status === "running" && options.spinnerFrame !== spinnerFrame
			? renderCodeCell({ ...options, code: "", output: undefined, spinnerFrame }, theme)[0]!
			: lines[0]!;
	out.push(header);
	for (let i = 1; i < lines.length; i++) out.push(lines[i]!);
}

type AgentEventStatus = "pending" | "running" | "completed" | "failed" | "aborted";

/**
 * Coalescing key of a progress-snapshot event: `agent` and `judge_batch`
 * events keyed by `id`, where only the newest snapshot matters. Discrete
 * actions (everything else) have no key. Shared by {@link upsertStatusEvent}
 * and the executors' display collectors so both coalesce identically.
 */
export function statusEventKey(event: { op: string; [key: string]: unknown }): string | undefined {
	if ((event.op === "agent" || event.op === "judge_batch") && typeof event.id === "string") {
		return `${event.op}\0${event.id}`;
	}
	return undefined;
}

/**
 * Discrete status events a log keeps. A cell polling a helper in a loop emits
 * one event per call (hundreds of thousands), and every live update and the
 * persisted tool result would otherwise carry them all.
 */
export const MAX_STATUS_EVENTS = 200;

/** A status event list plus the count of discrete events dropped from its front. */
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
 * the oldest discrete event is dropped and counted. Snapshots stay, since agent
 * cards read them, and so does the newest committed `todo` result, which the
 * session todo panel refreshes from. Renderers already show only the newest
 * events behind an "… N earlier" row.
 */
export function recordStatusEvent(log: StatusEventLog, event: EvalStatusEvent): void {
	const events = (log.statusEvents ??= []);
	upsertStatusEvent(events, event);
	if (events.length <= MAX_STATUS_EVENTS) return;
	const keep = events.findLastIndex(e => e.op === "todo" && e.committed === true);
	const oldest = events.findIndex((e, i) => i !== keep && statusEventKey(e) === undefined);
	if (oldest < 0) return;
	events.splice(oldest, 1);
	log.statusEventsElided = (log.statusEventsElided ?? 0) + 1;
}

function eventString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function eventNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function agentEventStatus(value: unknown): AgentEventStatus {
	switch (value) {
		case "pending":
		case "running":
		case "completed":
		case "failed":
		case "aborted":
			return value;
		default:
			return "running";
	}
}

/**
 * Render coalesced `agent()` progress as a Task-tool-style tree, one entry per
 * subagent: a status line (icon · id · stats) plus, while running, the current
 * tool/intent. Drawn below the cell box so progress streams live.
 */
function renderAgentProgressEvents(
	events: EvalStatusEvent[],
	theme: Theme,
	width: number,
	spinnerFrame?: number,
): string[] {
	const lines: string[] = [];
	for (let i = 0; i < events.length; i++) {
		const event = events[i];
		const isLast = i === events.length - 1;
		const prefix = theme.fg("dim", isLast ? theme.tree.last : theme.tree.branch);
		const cont = isLast ? "   " : `${theme.fg("dim", theme.tree.vertical)}  `;

		const status = agentEventStatus(event.status);
		const currentTool = eventString(event.currentTool);
		const lastIntent = eventString(event.lastIntent);
		const preview = status === "running" && !currentTool && !lastIntent ? eventString(event.taskPreview) : undefined;
		const toolCount = eventNumber(event.toolCount);
		lines.push(
			renderAgentTreeRow(
				{
					presentation: "eval",
					status,
					prefix,
					id: sanitizeText(eventString(event.id) ?? "agent").replace(/\s+/g, " "),
					width,
					model: eventString(event.resolvedModelIdentity ?? event.model ?? event.resolvedModel),
					thinkingLevel: event.resolvedThinkingLevel,
					advisor: event.advisor === true,
					spinnerFrame,
					preview: preview ? ` ${theme.fg("muted", truncateToWidth(replaceTabs(preview), 48))}` : undefined,
					stats: {
						toolCount: toolCount > 0 ? toolCount : 0,
						contextTokens: eventNumber(event.contextTokens),
						contextWindow: eventNumber(event.contextWindow),
						cost: eventNumber(event.cost),
					},
					durationMs:
						status === "completed" || status === "failed" || status === "aborted"
							? eventNumber(event.durationMs)
							: undefined,
				},
				theme,
			).line,
		);

		if (status === "running") {
			if (currentTool) {
				let toolLine = `${cont}${theme.tree.hook} ${theme.fg("muted", currentTool)}`;
				const detail = lastIntent ?? eventString(event.currentToolArgs);
				if (detail) toolLine += `: ${theme.fg("dim", truncateToWidth(replaceTabs(detail), 48))}`;
				lines.push(truncateToWidth(toolLine, width));
			} else if (lastIntent) {
				lines.push(
					truncateToWidth(
						`${cont}${theme.tree.hook} ${theme.fg("dim", truncateToWidth(replaceTabs(lastIntent), 48))}`,
						width,
					),
				);
			}
		}
	}
	return lines;
}

/** Format a status event as a single line for display. */
function formatStatusEvent(event: EvalStatusEvent, theme: Theme): string {
	const { op, ...data } = event;

	type AvailableIcon = "icon.file" | "icon.folder" | "icon.git" | "icon.package" | "cmd.globe" | "cmd.computer";
	const opIcons: Record<string, AvailableIcon> = {
		browser: "cmd.globe",
		computer: "cmd.computer",
		read: "icon.file",
		write: "icon.file",
		cat: "icon.file",
		touch: "icon.file",
		ls: "icon.folder",
		cd: "icon.folder",
		pwd: "icon.folder",
		mkdir: "icon.folder",
		git_status: "icon.git",
		git_diff: "icon.git",
		git_log: "icon.git",
		git_show: "icon.git",
		git_branch: "icon.git",
		git_file_at: "icon.git",
		git_has_changes: "icon.git",
		run: "icon.package",
		sh: "icon.package",
		env: "icon.package",
		batch: "icon.package",
		completion: "icon.package",
		tool_define: "icon.package",
		workpool: "icon.package",
		log: "icon.package",
		phase: "icon.package",
	};

	const iconKey = opIcons[op] ?? "icon.file";
	const icon = theme.styledSymbol(iconKey, "muted");

	const parts: string[] = [];

	if (data.error) {
		return `${icon} ${theme.fg("warning", op)}: ${theme.fg("dim", String(data.error))}`;
	}

	switch (op) {
		case "read":
			parts.push(`${data.chars ?? data.bytes ?? 0} chars`);
			if (data.path) parts.push(`from ${shortenPath(String(data.path))}`);
			break;
		case "write":
			parts.push(`${data.chars ?? data.bytes ?? 0} chars`);
			if (data.path) parts.push(`to ${shortenPath(String(data.path))}`);
			break;
		case "cat":
			parts.push(`${data.files} file${(data.files as number) !== 1 ? "s" : ""}`);
			parts.push(`${data.chars} chars`);
			break;
		case "ls":
			parts.push(`${data.count} entr${(data.count as number) !== 1 ? "ies" : "y"}`);
			break;
		case "env":
			if (data.action === "set") {
				parts.push(`set ${data.key}=${truncateToWidth(String(data.value ?? ""), 30)}`);
			} else if (data.action === "get") {
				parts.push(`${data.key}=${truncateToWidth(String(data.value ?? ""), 30)}`);
			} else {
				parts.push(`${data.count} variable${(data.count as number) !== 1 ? "s" : ""}`);
			}
			break;
		case "git_status":
			if (data.clean) {
				parts.push("clean");
			} else {
				const statusParts: string[] = [];
				if (data.staged) statusParts.push(`${data.staged} staged`);
				if (data.modified) statusParts.push(`${data.modified} modified`);
				if (data.untracked) statusParts.push(`${data.untracked} untracked`);
				parts.push(statusParts.join(", ") || "unknown");
			}
			if (data.branch) parts.push(`on ${data.branch}`);
			break;
		case "git_log":
			parts.push(`${data.commits} commit${(data.commits as number) !== 1 ? "s" : ""}`);
			break;
		case "git_diff":
			parts.push(`${data.lines} line${(data.lines as number) !== 1 ? "s" : ""}`);
			if (data.staged) parts.push("(staged)");
			break;
		case "batch":
			parts.push(`${data.files} file${(data.files as number) !== 1 ? "s" : ""} processed`);
			break;
		case "completion":
			if (data.model) parts.push(String(data.model));
			if (data.tier && data.tier !== data.model) parts.push(`(${data.tier})`);
			parts.push(`${data.chars ?? 0} chars`);
			break;
		case "tool_define":
			parts.push(`${data.name}(${(Array.isArray(data.params) ? data.params : []).join(", ")})`);
			break;
		case "workpool":
			parts.push(`${data.action} ${data.pool}`);
			if (data.count !== undefined) {
				parts.push(data.action === "create" ? `${data.count} agent(s)` : `${data.count} item(s)`);
			}
			break;
		case "judge_batch":
			parts.push(`${data.action} ${data.id}`);
			parts.push(`${data.done ?? 0}/${data.total ?? 0}`);
			if (data.failed) parts.push(`${data.failed} failed`);
			if (data.model) parts.push(String(data.model));
			break;
		case "wc":
			parts.push(`${data.lines}L ${data.words}W ${data.chars}C`);
			break;
		case "cd":
		case "pwd":
		case "mkdir":
		case "touch":
			if (data.path) parts.push(shortenPath(String(data.path)));
			break;
		case "log":
			parts.push(String(data.message ?? ""));
			break;
		case "phase":
			parts.push(String(data.title ?? ""));
			break;
		default:
			if (data.detail !== undefined) {
				parts.push(truncateToWidth(replaceTabs(String(data.detail)), 80));
			}
			if (data.count !== undefined) {
				parts.push(String(data.count));
			}
			if (data.path) {
				parts.push(shortenPath(String(data.path)));
			}
	}

	const desc = parts.length > 0 ? parts.join(" · ") : "";
	return `${icon} ${theme.fg("muted", op)}${desc ? ` ${theme.fg("dim", desc)}` : ""}`;
}

/** Format status event with expanded detail lines. */
function formatStatusEventExpanded(event: EvalStatusEvent, theme: Theme): string[] {
	const lines: string[] = [];
	const { op, ...data } = event;

	lines.push(formatStatusEvent(event, theme));

	const addItems = (items: unknown[], formatter: (item: unknown) => string, max = 5) => {
		const arr = Array.isArray(items) ? items : [];
		for (let i = 0; i < Math.min(arr.length, max); i++) {
			lines.push(`   ${theme.fg("dim", formatter(arr[i]))}`);
		}
		if (arr.length > max) {
			lines.push(`   ${theme.fg("dim", `… ${arr.length - max} more`)}`);
		}
	};

	const addPreview = (preview: string, maxLines = 3) => {
		const previewLines = cappedHeadLines(String(preview).split("\n"), maxLines);
		for (const line of previewLines.lines) {
			lines.push(`   ${theme.fg("toolOutput", truncateToWidth(replaceTabs(line), 80))}`);
		}
		if (previewLines.hidden > 0) {
			lines.push(`   ${theme.fg("dim", `… ${previewLines.hidden} more lines`)}`);
		}
	};

	switch (op) {
		case "ls":
			if (data.items) addItems(data.items as unknown[], m => String(m));
			break;
		case "env":
			if (data.keys) addItems(data.keys as unknown[], k => String(k), 10);
			break;
		case "git_log":
			if (data.entries) {
				addItems(data.entries as unknown[], e => {
					const entry = e as { sha: string; subject: string };
					return `${entry.sha} ${truncateToWidth(entry.subject, 50)}`;
				});
			}
			break;
		case "git_status":
			if (data.files) addItems(data.files as unknown[], f => String(f));
			break;
		case "git_branch":
			if (data.branches) addItems(data.branches as unknown[], b => String(b));
			break;
		case "read":
		case "cat":
		case "head":
		case "tail":
		case "git_diff":
		case "sh":
			if (data.preview) addPreview(String(data.preview));
			break;
	}

	return lines;
}

/**
 * Render status events as tree lines. Shows a tail window (newest events are
 * the live edge for `log()` progress loops) behind an "… N earlier" marker,
 * matching the code/output tail-window convention. Collapsed keeps a small
 * fixed window; expanded widens to the viewport-sized preview window.
 * `elided` counts events already dropped from the log's front.
 */
function renderStatusEvents(events: EvalStatusEvent[], theme: Theme, expanded: boolean, elided = 0): string[] {
	if (events.length === 0 && elided === 0) return [];

	const max = expanded ? Math.max(10, previewWindowRows()) : 3;
	const shownFrom = Math.max(0, events.length - max);
	const hidden = shownFrom + elided;
	const visible = shownFrom > 0 ? events.slice(shownFrom) : events;

	const lines: string[] = [];
	if (hidden > 0) {
		const glyph = visible.length > 0 ? theme.tree.branch : theme.tree.last;
		lines.push(`${theme.fg("dim", glyph)} ${theme.fg("dim", `… ${hidden} earlier`)}`);
	}
	for (let i = 0; i < visible.length; i++) {
		const isLast = i === visible.length - 1;
		const branch = isLast ? theme.tree.last : theme.tree.branch;

		if (expanded) {
			const eventLines = formatStatusEventExpanded(visible[i], theme);
			lines.push(`${theme.fg("dim", branch)} ${eventLines[0]}`);
			const continueBranch = isLast ? "   " : `${theme.tree.vertical}  `;
			for (let j = 1; j < eventLines.length; j++) {
				lines.push(`${theme.fg("dim", continueBranch)}${eventLines[j]}`);
			}
		} else {
			lines.push(`${theme.fg("dim", branch)} ${formatStatusEvent(visible[i], theme)}`);
		}
	}

	return lines;
}

function formatCellOutputLines(
	cell: EvalCellResult,
	expanded: boolean,
	previewLines: number,
	theme: Theme,
	width: number,
): { lines: readonly string[]; hiddenCount: number } {
	if (!cell.output) {
		return { lines: [], hiddenCount: 0 };
	}

	// Cell output lands in renderCodeCell → renderOutputBlock, which re-wraps it
	// at the box's inner content width. Bound the collapsed tail by VISUAL rows
	// at that width so a long-line tail can't wrap into more rows than budgeted
	// and scroll its mutating preview above the live-region window — the
	// duplicate "ctrl+o to expand" scrollback spray. The caller appends its own
	// exact hidden-count row, so the pane marker stays off here.
	const innerWidth = outputBlockContentWidth(width);

	if (cell.hasMarkdown && cell.status !== "error") {
		const md = new Markdown(cell.output, 0, 0, getMarkdownTheme());
		const allLines = md.render(innerWidth);
		const formatted = formatOutputPaneLines(
			{
				lines: allLines,
				expanded,
				collapsedMaxLines: previewLines,
				edge: "tail",
				showHiddenMarker: false,
			},
			theme,
		);
		return { lines: formatted.lines, hiddenCount: formatted.hiddenCount };
	}

	const isError = cell.status === "error";
	const formatted = formatOutputPaneLines(
		{
			lines: cell.output.split("\n"),
			expanded,
			collapsedMaxLines: previewLines,
			edge: "tail",
			visual: true,
			width: innerWidth,
			styleLine: line => theme.fg(isError ? "error" : "toolOutput", replaceTabs(line)),
			showHiddenMarker: false,
		},
		theme,
	);
	return { lines: formatted.lines, hiddenCount: formatted.hiddenCount };
}

/** Plain one-line summary of a status event: op plus its scalar fields. */
function describeStatusEvent(event: EvalStatusEvent): NativeNode {
	const spans: TspSpan[] = [span(event.op, "accent")];
	for (const key in event) {
		if (key === "op" || key === "resolvedThinkingLevel") continue;
		const value = event[key];
		if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
			spans.push(span(` ${key}=`, "muted"), span(sanitizeText(String(value))));
		}
	}
	return text(spans, { truncate: "end", role: "omp.tool.eval.status" });
}

/**
 * The eval head (§7.3): a single cell's title as the verb (else "Eval"; with
 * several cells each section carries its own title), a badge per language in
 * first-use order, a `background` badge for a backgrounded job, and the cell
 * count when there are several.
 */
function evalToolHead(
	title: string | undefined,
	languages: readonly EvalLanguage[],
	cellCount: number,
	details?: EvalToolDetails,
): NativeToolHead {
	const badges: { text: string; title?: string }[] = [...new Set(languages)].map(language => ({ text: language }));
	if (details?.async?.state === "running") {
		badges.push({ text: "background", title: `Backgrounded as job ${details.async.jobId}` });
	}
	return {
		title: (cellCount > 1 ? "" : plainText(title ?? "").trim()) || "Eval",
		badges: badges.length > 0 ? badges : undefined,
		meta: cellCount > 1 ? [`${cellCount} cells`] : undefined,
	};
}

/** Box-drawing `console.table` output split out of plain text: `text` runs and parsed tables, in order. */
type EvalOutputPart =
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "table"; readonly head: readonly string[]; readonly rows: readonly string[][] };

/** The cells of a `│ a │ b │` row, trimmed; undefined when the line is not a table row. */
function tableRowCells(line: string): string[] | undefined {
	const plain = plainText(line).trim();
	if (plain.length < 2 || !plain.startsWith("│") || !plain.endsWith("│")) return undefined;
	return plain
		.slice(1, -1)
		.split("│")
		.map(cell => cell.trim());
}

/**
 * Split `console.table` blocks (`┌…┐` header `├…┤` rows `└…┘`, as Node/Bun
 * print them) out of cell output so they render as a `table`; anything that
 * does not parse as one stays text.
 */
function splitConsoleTables(output: string): EvalOutputPart[] {
	const lines = output.split("\n");
	const parts: EvalOutputPart[] = [];
	let textStart = 0;
	const flushText = (end: number): void => {
		const chunk = lines
			.slice(textStart, end)
			.join("\n")
			.replace(/^\n+|\s+$/g, "");
		if (chunk.length > 0) parts.push({ kind: "text", text: chunk });
	};
	for (let i = 0; i < lines.length; i++) {
		if (!plainText(lines[i]!).trimStart().startsWith("┌")) continue;
		const head = tableRowCells(lines[i + 1] ?? "");
		if (
			!head ||
			!plainText(lines[i + 2] ?? "")
				.trimStart()
				.startsWith("├")
		)
			continue;
		const rows: string[][] = [];
		let end = i + 3;
		for (; end < lines.length; end++) {
			const cells = tableRowCells(lines[end]!);
			if (!cells) break;
			rows.push(cells);
		}
		if (
			!plainText(lines[end] ?? "")
				.trimStart()
				.startsWith("└")
		)
			continue;
		if (rows.some(row => row.length !== head.length)) continue;
		flushText(i);
		parts.push({ kind: "table", head, rows });
		i = end;
		textStart = end + 1;
	}
	flushText(lines.length);
	return parts;
}

/**
 * One cell's outputs: markdown, else terminal text (following its tail,
 * clamped to the last `previewLines` while folded) with any `console.table`
 * blocks as tables.
 */
function evalOutputNodes(output: string, markdown: boolean, previewLines: number): NativeNode[] {
	if (output.trim().length === 0) return [];
	if (markdown) return [keyed(md(output), "output")];
	return splitConsoleTables(output).map((part, i) =>
		part.kind === "text"
			? runOutput(part.text, { role: "omp.tool.eval.output", previewLines, key: i === 0 ? "output" : `output-${i}` })
			: node(
					"table",
					{
						// Node's index column header is noise in a real table.
						cols: part.head.map((head, c) => ({ id: `c${c}`, head: head === "(index)" ? "" : head })),
						rows: part.rows.map((cells, r) => ({
							id: `r${r}`,
							cells: Object.fromEntries(cells.map((cell, c) => [`c${c}`, cell])),
						})),
						role: "omp.tool.eval.table",
					},
					undefined,
					`table-${i}`,
				),
	);
}

/** Status lines a folded cell keeps: the newest ones. */
const RUN_STATUS_TAIL = 8;

/**
 * A status log's events (`omp.run.status`): all kept ones when expanded, else
 * the newest {@link RUN_STATUS_TAIL}, after a muted `N earlier` line that also
 * counts events already dropped from the log's front.
 */
function evalStatusSection(log: StatusEventLog, expanded: boolean): NativeNode | undefined {
	const events = log.statusEvents ?? [];
	const elided = log.statusEventsElided ?? 0;
	if (events.length === 0 && elided === 0) return undefined;
	const shownFrom = expanded ? 0 : Math.max(0, events.length - RUN_STATUS_TAIL);
	const hidden = shownFrom + elided;
	const lines = events.slice(shownFrom).map((event, i) => keyed(describeStatusEvent(event), `s${hidden + i}`));
	return node(
		"col",
		{ role: "omp.run.status", gap: "none" },
		compact<NativeNode>([hidden > 0 && keyed(text([span(`${hidden} earlier`, "muted")]), "earlier"), ...lines]),
		"status",
	);
}

/** The foot state of a cell, or undefined while it has not started. */
function evalCellState(status: EvalCellResult["status"], cancelled: boolean): RunState | undefined {
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

/** Inputs of one eval cell box. */
interface EvalCellRun {
	readonly language: EvalLanguage;
	readonly code: string;
	readonly title?: string;
	readonly outputs?: readonly NativeChild[];
	readonly status?: NativeNode;
	/** Omitted while the cell has not started. */
	readonly foot?: RunFootInput;
}

/**
 * A notebook cell as one run box: the caption (multi-cell calls only), the
 * source, its outputs, status lines and foot. A failed cell tints its box.
 */
function evalCellBox(cell: EvalCellRun, index: number, total: number): NativeNode {
	let caption: NativeNode | undefined;
	if (total > 1) {
		const spans: TspSpan[] = [span(`${index + 1}/${total}`, "muted")];
		const title = plainText(cell.title ?? "").trim();
		if (title) spans.push(span(` ${title}`, "toolTitle"));
		caption = keyed(text(spans, { role: "omp.run.caption" }), "caption");
	}
	return runBox(
		[
			caption,
			cell.code.trim().length > 0 &&
				runInput(cell.code, {
					role: "omp.tool.eval.input",
					lang: languageForHighlighter(cell.language),
					wrap: false,
				}),
			...(cell.outputs ?? []),
			cell.status,
			cell.foot && runFoot(cell.foot),
		],
		{ key: `cell-${index}`, tone: cell.foot?.state === "failed" ? "error" : undefined },
	);
}

/** Render eval code cells, structured display output, and progress events. */
export const evalToolRenderer = {
	animatedPendingPreview: true,
	animatedPartialResult: true,
	renderCall(args: EvalRenderArgs, options: RenderResultOptions, uiTheme: Theme): Component {
		const cells = getRenderCells(args);

		if (cells.length === 0) {
			const promptSym = uiTheme.fg("accent", ">>>");
			const text = formatTitle(`${promptSym} …`, uiTheme);
			return new Text(text, 0, 0);
		}

		// Cell bodies depend on width, expansion, the viewport window and whether
		// the call is live; a spinner tick only redraws the running header rows.
		let bodies: { key: string; cells: RenderedCodeCell[] } | undefined;
		let cached: { key: string; result: string[] } | undefined;

		return markFramedBlockComponent({
			render: (width: number): readonly string[] => {
				const spinnerFrame = options.spinnerFrame;
				const windowRows = previewWindowRows();
				const bodyKey = `${width}|${options.expanded ? 1 : 0}|${windowRows}|${spinnerFrame === undefined ? 0 : 1}`;
				const key = `${bodyKey}|${spinnerFrame ?? "-"}`;
				if (cached?.key === key) {
					return cached.result;
				}

				if (bodies?.key !== bodyKey) {
					bodies = {
						key: bodyKey,
						cells: cells.map((cell, i) => {
							const cellOptions: CodeCellOptions = {
								code: cell.code,
								language: languageForHighlighter(cell.language),
								showLanguage: true,
								index: i,
								total: cells.length,
								title: cell.title,
								status: spinnerFrame !== undefined ? "running" : "pending",
								spinnerFrame,
								width,
								// Viewport-sized tail window following the newest streamed code
								// line; renderResult keeps the same cap so the cell never snaps
								// open on completion. Only ctrl+o uncaps.
								codeTail: true,
								codeMaxLines: windowRows,
								expanded: options.expanded,
							};
							return { options: cellOptions, lines: renderCodeCell(cellOptions, uiTheme) };
						}),
					};
				}

				const lines: string[] = [];
				for (let i = 0; i < bodies.cells.length; i++) {
					pushCodeCellLines(lines, bodies.cells[i]!, spinnerFrame, uiTheme);
					if (i < cells.length - 1) {
						lines.push("");
					}
				}
				cached = { key, result: lines };
				return lines;
			},
			invalidate: () => {
				bodies = undefined;
				cached = undefined;
			},
		});
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: EvalToolDetails },
		options: RenderResultOptions & { renderContext?: EvalRenderContext },
		uiTheme: Theme,
		_args?: EvalRenderArgs,
	): Component {
		const details = result.details;

		const rawOutput =
			options.renderContext?.output ?? (result.content?.find(c => c.type === "text")?.text ?? "").trimEnd();
		// Strip the LLM-facing notice (appended by wrappedExecute) before display;
		// the styled `warningLine` below carries the same text in ⟨…⟩ form.
		const output = stripOutputNotice(rawOutput, details?.meta).trimEnd();

		const jsonOutputs = details?.jsonOutputs ?? [];
		const treeExpanded = options.renderContext?.expanded ?? options.expanded;
		const treeDepth = treeExpanded ? JSON_TREE_MAX_DEPTH_EXPANDED : JSON_TREE_MAX_DEPTH_COLLAPSED;
		const treeLineCap = treeExpanded ? JSON_TREE_MAX_LINES_EXPANDED : JSON_TREE_MAX_LINES_COLLAPSED;
		const treeScalarLen = treeExpanded ? JSON_TREE_SCALAR_LEN_EXPANDED : JSON_TREE_SCALAR_LEN_COLLAPSED;
		const labelOutputs = jsonOutputs.length > 1;
		const jsonLines = jsonOutputs.flatMap((value, index) => {
			const tree = renderJsonTreeLines(value, uiTheme, treeDepth, treeLineCap, treeScalarLen);
			const body = tree.truncated ? [...tree.lines, uiTheme.fg("dim", "…")] : tree.lines;
			return labelOutputs ? [uiTheme.fg("dim", `display[${index + 1}]`), ...body] : body;
		});

		const timeoutSeconds = options.renderContext?.timeout;
		const timeoutLine =
			typeof timeoutSeconds === "number"
				? uiTheme.fg("dim", wrapBrackets(`Timeout: ${timeoutSeconds}s`, uiTheme))
				: undefined;
		let warningLine: string | undefined;
		if (details?.meta?.truncation || details?.meta?.artifactError) {
			warningLine = formatStyledTruncationWarning(details.meta, uiTheme) ?? undefined;
		}
		const noticeLine = details?.notice ? uiTheme.fg("dim", wrapBrackets(details.notice, uiTheme)) : undefined;
		const asyncLine =
			details?.async?.state === "running"
				? uiTheme.fg("dim", wrapBrackets(`Backgrounded: ${details.async.jobId}`, uiTheme))
				: undefined;

		const cellResults = details?.cells;
		if (cellResults && cellResults.length > 0) {
			const displayCells = cellResults.map(cell => {
				const language = cell.language ?? details?.language ?? "python";
				const allEvents = cell.statusEvents ?? [];
				const agentEvents = allEvents.filter(e => e.op === "agent");
				return {
					cell,
					code: formatEvalCodeForDisplay(cell.code, language),
					language,
					agentEvents,
					otherEvents: agentEvents.length > 0 ? allEvents.filter(e => e.op !== "agent") : allEvents,
					// Running agent rows carry the spinner; settled ones are frame-independent.
					agentLive: agentEvents.some(e => agentEventStatus(e.status) === "running"),
				};
			});
			// Per-cell rows keyed by everything but the spinner frame: a tick only
			// redraws running headers and running agent rows.
			let bodies:
				| {
						key: string;
						cells: { codeCell: RenderedCodeCell; agentLines: string[]; agentFrame: number | undefined }[];
				  }
				| undefined;
			let cached: { key: string; result: string[] } | undefined;

			return markFramedBlockComponent({
				render: (width: number): readonly string[] => {
					const spinnerFrame = options.spinnerFrame;
					const expanded = options.renderContext?.expanded ?? options.expanded;
					const windowRows = previewWindowRows();
					const previewLines = Math.min(
						options.renderContext?.previewLines ?? EVAL_DEFAULT_PREVIEW_LINES,
						windowRows,
					);
					const bodyKey = `${width}|${expanded}|${previewLines}|${windowRows}`;
					const key = `${bodyKey}|${spinnerFrame}`;
					if (cached?.key === key) {
						return cached.result;
					}

					if (bodies?.key !== bodyKey) {
						bodies = {
							key: bodyKey,
							cells: displayCells.map(({ cell, code, language, agentEvents, otherEvents }, i) => {
								const statusLines = renderStatusEvents(otherEvents, uiTheme, expanded, cell.statusEventsElided);
								const outputContent = formatCellOutputLines(cell, expanded, previewLines, uiTheme, width);
								const outputLines = [...outputContent.lines];
								if (!expanded && outputContent.hiddenCount > 0) {
									outputLines.push(
										uiTheme.fg(
											"dim",
											`… ${outputContent.hiddenCount} more lines (${expandKeyHint()} to expand)`,
										),
									);
								}
								if (statusLines.length > 0) {
									if (outputLines.length > 0) {
										outputLines.push(uiTheme.fg("dim", "Status"));
									}
									outputLines.push(...statusLines);
								}
								const cellOptions: CodeCellOptions = {
									code,
									language: languageForHighlighter(language),
									showLanguage: true,
									index: i,
									total: cellResults.length,
									title: cell.title,
									status: cell.status,
									spinnerFrame,
									duration: cell.durationMs,
									output: outputLines.length > 0 ? outputLines.join("\n") : undefined,
									outputMaxLines: outputLines.length,
									// Same viewport-sized tail window as the pending preview so the
									// cell never snaps open on completion; only ctrl+o uncaps.
									// `output` keeps its own preview cap from above.
									codeTail: true,
									codeMaxLines: windowRows,
									expanded,
									width,
								};
								return {
									codeCell: { options: cellOptions, lines: renderCodeCell(cellOptions, uiTheme) },
									agentLines:
										agentEvents.length > 0
											? renderAgentProgressEvents(agentEvents, uiTheme, width, spinnerFrame)
											: [],
									agentFrame: spinnerFrame,
								};
							}),
						};
					}

					const lines: string[] = [];
					for (let i = 0; i < displayCells.length; i++) {
						const { agentEvents, agentLive } = displayCells[i]!;
						const body = bodies.cells[i]!;
						pushCodeCellLines(lines, body.codeCell, spinnerFrame, uiTheme);
						if (agentLive && body.agentFrame !== spinnerFrame) {
							body.agentLines = renderAgentProgressEvents(agentEvents, uiTheme, width, spinnerFrame);
							body.agentFrame = spinnerFrame;
						}
						lines.push(...body.agentLines);
						if (i < cellResults.length - 1) {
							lines.push("");
						}
					}
					lines.push(...jsonLines);
					if (timeoutLine) {
						lines.push(timeoutLine);
					}
					if (noticeLine) {
						lines.push(noticeLine);
					}
					if (asyncLine) {
						lines.push(asyncLine);
					}
					if (warningLine) {
						lines.push(warningLine);
					}
					cached = { key, result: lines };
					return lines;
				},
				invalidate: () => {
					bodies = undefined;
					cached = undefined;
				},
			});
		}

		const displayOutput = output;
		const combinedOutput = [displayOutput, ...jsonLines].filter(Boolean).join("\n");

		const statusEvents = details?.statusEvents ?? [];
		const statusLines = renderStatusEvents(
			statusEvents,
			uiTheme,
			options.renderContext?.expanded ?? options.expanded,
			details?.statusEventsElided,
		);

		if (!combinedOutput && statusLines.length === 0) {
			const lines = [timeoutLine, noticeLine, asyncLine, warningLine].filter(Boolean) as string[];
			return new Text(lines.join("\n"), 0, 0);
		}

		if (!combinedOutput && statusLines.length > 0) {
			const lines = [
				uiTheme.fg("dim", "Status"),
				...statusLines,
				timeoutLine,
				noticeLine,
				asyncLine,
				warningLine,
			].filter(Boolean) as string[];
			return new Text(lines.join("\n"), 0, 0);
		}

		if (options.renderContext?.expanded ?? options.expanded) {
			const styledOutput = combinedOutput
				.split("\n")
				.map(line => uiTheme.fg("toolOutput", line))
				.join("\n");
			const lines = [
				styledOutput,
				...(statusLines.length > 0 ? [uiTheme.fg("dim", "Status"), ...statusLines] : []),
				timeoutLine,
				noticeLine,
				asyncLine,
				warningLine,
			].filter(Boolean) as string[];
			return new Text(lines.join("\n"), 0, 0);
		}

		const styledOutput = combinedOutput
			.split("\n")
			.map(line => uiTheme.fg("toolOutput", line))
			.join("\n");
		const textContent = `\n${styledOutput}`;

		let cachedWidth: number | undefined;
		let cachedLines: readonly string[] | undefined;
		let cachedSkipped: number | undefined;
		let cachedPreviewLines: number | undefined;

		return {
			render: (width: number): readonly string[] => {
				const previewLines = Math.min(
					options.renderContext?.previewLines ?? EVAL_DEFAULT_PREVIEW_LINES,
					previewWindowRows(),
				);
				if (cachedLines === undefined || cachedWidth !== width || cachedPreviewLines !== previewLines) {
					const result = truncateToVisualLines(textContent, previewLines, width);
					cachedLines = result.visualLines;
					cachedSkipped = result.skippedCount;
					cachedWidth = width;
					cachedPreviewLines = previewLines;
				}
				const outputLines: string[] = [];
				if (cachedSkipped && cachedSkipped > 0) {
					outputLines.push("");
					const skippedLine = uiTheme.fg(
						"dim",
						`… (${cachedSkipped} earlier lines, showing ${cachedLines.length} of ${cachedSkipped + cachedLines.length}) (${expandKeyHint()} to expand)`,
					);
					outputLines.push(truncateToWidth(skippedLine, width));
				}
				outputLines.push(...cachedLines);
				if (statusLines.length > 0) {
					outputLines.push(truncateToWidth(uiTheme.fg("dim", "Status"), width));
					for (const statusLine of statusLines) {
						outputLines.push(truncateToWidth(statusLine, width));
					}
				}
				if (timeoutLine) {
					outputLines.push(truncateToWidth(timeoutLine, width));
				}
				if (noticeLine) {
					outputLines.push(truncateToWidth(noticeLine, width));
				}
				if (asyncLine) {
					outputLines.push(truncateToWidth(asyncLine, width));
				}
				if (warningLine) {
					outputLines.push(truncateToWidth(warningLine, width));
				}
				return outputLines;
			},
			invalidate: () => {
				cachedWidth = undefined;
				cachedLines = undefined;
				cachedSkipped = undefined;
				cachedPreviewLines = undefined;
			},
		};
	},

	describeCall(args: EvalRenderArgs, options: RenderResultOptions): NativeToolView {
		const cells = getRenderCells(args);
		// No foot until the call starts; then the first cell runs (before any result names it).
		const startFoot: RunFootInput | undefined = options.executionStarted
			? { state: options.cancelled ? "cancelled" : "running", elapsedMs: options.elapsedMs }
			: undefined;
		return {
			tool: evalToolHead(
				cells[0]?.title,
				cells.map(cell => cell.language),
				cells.length,
			),
			body: cells.map((cell, i) => evalCellBox({ ...cell, foot: i === 0 ? startFoot : undefined }, i, cells.length)),
			preview: "children",
		};
	},

	describeResult(
		result: { content: Array<{ type: string; text?: string }>; details?: EvalToolDetails; isError?: boolean },
		options: RenderResultContextOptions & { renderContext?: EvalRenderContext },
		args?: EvalRenderArgs,
	): NativeToolView {
		const details = result.details;
		const isPartial = options.isPartial === true;
		const cancelled = options.cancelled === true;
		const expanded = options.renderContext?.expanded ?? options.expanded;
		const previewLines = options.renderContext?.previewLines ?? EVAL_DEFAULT_PREVIEW_LINES;
		const jsonNodes = (details?.jsonOutputs ?? []).map((value, index) =>
			keyed(describeJsonTree(value, { hiddenRootKeys: [] }), `display-${index}`),
		);
		// The call's notice and truncation join the last run's foot facts (a background job is a head badge).
		const callFacts = { facts: compact([details?.notice]), meta: details?.meta };
		const cellResults = details?.cells;
		if (cellResults && cellResults.length > 0) {
			const languages = cellResults.map(cell => cell.language ?? details?.language ?? "python");
			const states = cellResults.map(cell => evalCellState(cell.status, cancelled));
			// A cell that never started has no foot to carry the call's facts: the last one that ran does.
			const factsIndex = states.findLastIndex(state => state !== undefined);
			let earlierMs = 0;
			const cells = cellResults.map((cell, i) => {
				const language = languages[i]!;
				const state = states[i];
				// A running cell's clock is the call's minus the cells that finished before it.
				const elapsedMs =
					state === "running" || state === "cancelled"
						? options.elapsedMs === undefined
							? undefined
							: Math.max(0, options.elapsedMs - earlierMs)
						: cell.durationMs;
				earlierMs += cell.durationMs ?? 0;
				return evalCellBox(
					{
						language,
						code: formatEvalCodeForDisplay(cell.code, language),
						title: cell.title,
						outputs: [
							...evalOutputNodes(
								cell.output,
								cell.hasMarkdown === true && cell.status !== "error",
								previewLines,
							),

							...(i === cellResults.length - 1 ? jsonNodes : []),
						],
						status: evalStatusSection(cell, expanded),
						foot: state && {
							state,
							exitCode: cell.exitCode,
							elapsedMs,
							...(i === factsIndex ? callFacts : {}),
						},
					},
					i,
					cellResults.length,
				);
			});
			return {
				tool: evalToolHead(cellResults[0]!.title, languages, cellResults.length, details),
				body: cells,
				preview: "children",
			};
		}
		// No per-cell results (older details): the call's cells, the whole output and foot under the last.
		const argCells = getRenderCells(args);
		const languages = details?.languages ?? (details?.language ? [details.language] : []);
		const rawOutput = options.renderContext?.output ?? resultText(result).trimEnd();
		const state: RunState = cancelled ? "cancelled" : isPartial ? "running" : result.isError ? "failed" : "done";
		const last: Omit<EvalCellRun, "language" | "code" | "title"> = {
			outputs: [
				...evalOutputNodes(stripOutputNotice(rawOutput, details?.meta).trimEnd(), false, previewLines),
				...jsonNodes,
			],
			status: evalStatusSection(details ?? {}, expanded),
			foot: { state, elapsedMs: options.elapsedMs, ...callFacts },
		};
		const runs: EvalCellRun[] =
			argCells.length > 0
				? argCells.map((cell, i) => (i === argCells.length - 1 ? { ...cell, ...last } : cell))
				: [{ language: languages[0] ?? "python", code: "", ...last }];
		return {
			tool: evalToolHead(
				argCells[0]?.title,
				argCells.length > 0 ? argCells.map(cell => cell.language) : languages,
				argCells.length,
				details,
			),
			body: runs.map((run, i) => evalCellBox(run, i, runs.length)),
			preview: "children",
		};
	},

	mergeCallAndResult: true,
	inline: true,
} satisfies ToolRenderer<EvalRenderArgs, EvalToolDetails>;
