/**
 * `eval`: each cell a framed code cell headed by its language icon, status,
 * `[i/n]` and title (with its run time), the source's last 20 rows
 * collapsed, an `Output` section with the output's tail (json views as a
 * tree, Markdown rendered), a `Status` tree of helper events, and `agent()`
 * progress as a tree under the cell. Call-level notes (timeout, notice,
 * background job, truncation) follow the cells. A pending call shows its
 * cells spinning; without cells, `>>> …`.
 *
 * Reads {@link EvalTerm}.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import type { Block, PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { SPINNER_INTERVAL_MS } from "@oh-my-pi/pi-tui/term/painters/spinner";
import { renderMarkdown } from "@oh-my-pi/pi-tui/text/markdown/index";
import { replaceTabs, truncate, visibleWidth, wrap } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { formatDuration, formatNumber, sanitizeText } from "@oh-my-pi/pi-utils";
import { type EvalStatusEvent, splitEvalOutput } from "../../../tools/details/eval";
import { formatArtifactErrorNotice, formatTruncationMetaNotice } from "../../../tools/output-meta-format";
import { FEED_MODEL_BADGE_WIDTH, isFeedModelBadgeEnabled, shortenPath } from "../../../utils/render-utils";
import { feedModel } from "../../tools/agent-common";
import { type EvalTerm, type EvalTermCell, formatMcpProgress, highlightLanguage, mcpProgress } from "../../tools/eval";
import { styledModelBadge } from "./agent-common";
import { resultPictures, withoutDrawnPlaceholders } from "./file-common";
import { codeCellRows } from "./code-cell";
import { bracketed, frameInner, PREVIEW_WINDOW_ROWS } from "./frame";
import { COLLAPSED_TREE, EXPANDED_TREE, jsonTreeRows } from "./json-tree";
import { defineToolLook, isExpanded, toolProps } from "./look";

/** Status lines a collapsed cell shows. */
const COLLAPSED_STATUS = 3;
/** Cells of a status value / agent detail. */
const STATUS_VALUE_WIDTH = 200;
const AGENT_DETAIL_WIDTH = 48;

/** Symbol of each helper op's status line. */
const OP_ICONS: Readonly<Record<string, string>> = {
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

function plural(count: unknown, one: string, many: string): string {
	return count !== 1 ? many : one;
}

/** One status event as a line: icon, muted op, dim summary. */
function statusEventLine(theme: Theme, event: EvalStatusEvent): string {
	const { op, ...data } = event;
	const icon = theme.fg("muted", theme.symbols.symbol(OP_ICONS[op] ?? "icon.file"));
	if (data.error) return `${icon} ${theme.fg("warning", op)}: ${theme.fg("dim", String(data.error))}`;
	const parts: string[] = [];
	switch (op) {
		case "mcp_progress": {
			if (data.tool)
				parts.push(truncate(sanitizeText(String(data.tool)).replace(/\s+/g, " ").trim(), STATUS_VALUE_WIDTH));
			const progress = mcpProgress(data);
			if (progress) parts.push(formatMcpProgress(progress, STATUS_VALUE_WIDTH));
			break;
		}
		case "read":
			parts.push(`${data.chars ?? data.bytes ?? 0} chars`);
			if (data.path) parts.push(`from ${shortenPath(String(data.path))}`);
			break;
		case "write":
			parts.push(`${data.chars ?? data.bytes ?? 0} chars`);
			if (data.path) parts.push(`to ${shortenPath(String(data.path))}`);
			break;
		case "cat":
			parts.push(`${data.files} ${plural(data.files, "file", "files")}`, `${data.chars} chars`);
			break;
		case "ls":
			parts.push(`${data.count} ${plural(data.count, "entry", "entries")}`);
			break;
		case "env":
			if (data.action === "set") parts.push(`set ${data.key}=${truncate(String(data.value ?? ""), 30)}`);
			else if (data.action === "get") parts.push(`${data.key}=${truncate(String(data.value ?? ""), 30)}`);
			else parts.push(`${data.count} ${plural(data.count, "variable", "variables")}`);
			break;
		case "git_status":
			if (data.clean) parts.push("clean");
			else {
				const status: string[] = [];
				if (data.staged) status.push(`${data.staged} staged`);
				if (data.modified) status.push(`${data.modified} modified`);
				if (data.untracked) status.push(`${data.untracked} untracked`);
				parts.push(status.join(", ") || "unknown");
			}
			if (data.branch) parts.push(`on ${data.branch}`);
			break;
		case "git_log":
			parts.push(`${data.commits} ${plural(data.commits, "commit", "commits")}`);
			break;
		case "git_diff":
			parts.push(`${data.lines} ${plural(data.lines, "line", "lines")}`);
			if (data.staged) parts.push("(staged)");
			break;
		case "batch":
			parts.push(`${data.files} ${plural(data.files, "file", "files")} processed`);
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
			if (data.count !== undefined)
				parts.push(data.action === "create" ? `${data.count} agent(s)` : `${data.count} item(s)`);
			break;
		case "judge_batch":
			parts.push(`${data.action} ${data.id}`, `${data.done ?? 0}/${data.total ?? 0}`);
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
			if (data.detail !== undefined) parts.push(truncate(replaceTabs(String(data.detail)), 80));
			if (data.count !== undefined) parts.push(String(data.count));
			if (data.path) parts.push(shortenPath(String(data.path)));
	}
	const desc = parts.length > 0 ? parts.join(" · ") : "";
	return `${icon} ${theme.fg("muted", op)}${desc ? ` ${theme.fg("dim", desc)}` : ""}`;
}

/** A status event's line plus, expanded, its listed items or preview. */
function statusEventLines(theme: Theme, event: EvalStatusEvent): string[] {
	const lines = [statusEventLine(theme, event)];
	const { op, ...data } = event;
	const items = (value: unknown, format: (item: unknown) => string, max = 5): void => {
		const list = Array.isArray(value) ? value : [];
		for (let i = 0; i < Math.min(list.length, max); i++) lines.push(`   ${theme.fg("dim", format(list[i]))}`);
		if (list.length > max) lines.push(`   ${theme.fg("dim", `… ${list.length - max} more`)}`);
	};
	const preview = (value: string, max = 3): void => {
		const all = value.split("\n");
		for (const line of all.slice(0, max)) lines.push(`   ${theme.fg("toolOutput", truncate(replaceTabs(line), 80))}`);
		if (all.length > max) lines.push(`   ${theme.fg("dim", `… ${all.length - max} more lines`)}`);
	};
	switch (op) {
		case "ls":
			if (data.items) items(data.items, item => String(item));
			break;
		case "env":
			if (data.keys) items(data.keys, key => String(key), 10);
			break;
		case "git_log":
			if (data.entries)
				items(data.entries, entry => {
					const e = entry as { sha: string; subject: string };
					return `${e.sha} ${truncate(e.subject, 50)}`;
				});
			break;
		case "git_status":
			if (data.files) items(data.files, file => String(file));
			break;
		case "git_branch":
			if (data.branches) items(data.branches, branch => String(branch));
			break;
		case "read":
		case "cat":
		case "head":
		case "tail":
		case "git_diff":
		case "sh":
			if (data.preview) preview(String(data.preview));
			break;
	}
	return lines;
}

/** Status events as a tree: the newest (3 collapsed, a window expanded) under `… N earlier`. */
function statusRows(theme: Theme, events: readonly EvalStatusEvent[], expanded: boolean, elided = 0): string[] {
	if (events.length === 0 && elided === 0) return [];
	const max = expanded ? Math.max(10, PREVIEW_WINDOW_ROWS) : COLLAPSED_STATUS;
	const from = Math.max(0, events.length - max);
	const hidden = from + elided;
	const visible = from > 0 ? events.slice(from) : events;
	const tree = {
		branch: theme.symbols.symbol("tree.branch"),
		last: theme.symbols.symbol("tree.last"),
		vertical: theme.symbols.symbol("tree.vertical"),
	};
	const rows: string[] = [];
	if (hidden > 0)
		rows.push(
			`${theme.fg("dim", visible.length > 0 ? tree.branch : tree.last)} ${theme.fg("dim", `… ${hidden} earlier`)}`,
		);
	visible.forEach((event, i) => {
		const last = i === visible.length - 1;
		const branch = theme.fg("dim", last ? tree.last : tree.branch);
		if (!expanded) {
			rows.push(`${branch} ${statusEventLine(theme, event)}`);
			return;
		}
		const lines = statusEventLines(theme, event);
		rows.push(`${branch} ${lines[0]}`);
		const cont = theme.fg("dim", last ? "   " : `${tree.vertical}  `);
		for (const line of lines.slice(1)) rows.push(`${cont}${line}`);
	});
	return rows;
}

/** Wrap rows at `width` and keep the last `limit` visual rows; the skipped count. */
function visualTail(lines: readonly string[], limit: number, width: number): { rows: string[]; skipped: number } {
	const rows: string[] = [];
	for (const line of lines) {
		const wrapped = wrap(line, Math.max(1, width));
		rows.push(...(wrapped.length > 0 ? wrapped : [""]));
	}
	if (rows.length <= limit) return { rows, skipped: 0 };
	return {
		rows: rows.slice(rows.length - limit),
		skipped: rows.length - limit,
	};
}

/** A cell's output rows (text in the output or error color, views as trees / Markdown), tail-capped while collapsed. */
function cellOutputRows(
	theme: Theme,
	cell: EvalTermCell,
	expanded: boolean,
	previewLines: number,
	width: number,
): { rows: string[]; hidden: number } {
	const output = cell.output;
	if (!output) return { rows: [], hidden: 0 };
	const inner = frameInner(width);
	const style = (line: string): string =>
		theme.fg(cell.status === "error" ? "error" : "toolOutput", replaceTabs(line));
	const parts = splitEvalOutput(
		output,
		cell.views?.filter(entry => entry.view.kind !== "table"),
	);
	const lines: string[] = [];
	if (parts.some(part => part.kind === "view")) {
		for (const part of parts) {
			if (part.kind === "text") {
				for (const line of part.text.split("\n")) lines.push(style(line));
				continue;
			}
			const view = part.view;
			if (view.kind === "json") {
				const tree = jsonTreeRows(theme, view.value, expanded ? EXPANDED_TREE : COLLAPSED_TREE);
				lines.push(...tree.rows);
				if (tree.truncated) lines.push(theme.fg("dim", "…"));
			} else if (view.kind === "markdown") lines.push(...renderMarkdown(view.text, inner, { theme }));
		}
	} else for (const line of output.split("\n")) lines.push(style(line));
	if (expanded) return { rows: lines, hidden: 0 };
	const tail = visualTail(lines, previewLines, inner);
	return { rows: tail.rows, hidden: tail.skipped };
}

/** The spinner (or the still running glyph) in the accent color. */
function runningGlyph(cx: PaintContext): string {
	const theme = cx.theme;
	if (cx.reduceMotion) return theme.fg("accent", theme.symbols.symbol("status.running"));
	const frames = theme.symbols.spinnerFrames;
	return theme.fg("accent", frames[Math.floor(cx.now() / SPINNER_INTERVAL_MS) % frames.length]!);
}

/** `agent()` progress rows under a cell. */
function agentRows(cx: PaintContext, events: readonly EvalStatusEvent[], width: number): string[] {
	const theme = cx.theme;
	const symbol = (key: string): string => theme.symbols.symbol(key);
	const rows: string[] = [];
	events.forEach((event, i) => {
		const last = i === events.length - 1;
		const prefix = theme.fg("dim", last ? symbol("tree.last") : symbol("tree.branch"));
		const cont = last ? "   " : `${theme.fg("dim", symbol("tree.vertical"))}  `;
		const raw = typeof event.status === "string" ? event.status : "running";
		const status = ["pending", "running", "completed", "failed", "aborted"].includes(raw) ? raw : "running";
		const text = (key: string): string | undefined => {
			const value = event[key];
			return typeof value === "string" && value.length > 0 ? value : undefined;
		};
		const number = (key: string): number => {
			const value = event[key];
			return typeof value === "number" && Number.isFinite(value) ? value : 0;
		};
		const icon =
			status === "completed"
				? theme.fg("accent", symbol("tool.eval"))
				: status === "running"
					? runningGlyph(cx)
					: status === "failed"
						? theme.fg("error", symbol("status.error"))
						: status === "aborted"
							? theme.fg("error", symbol("status.aborted"))
							: theme.fg("muted", symbol("status.pending"));
		const lead = `${prefix} ${icon} `;
		const failed = status === "failed" || status === "aborted";
		const badge = failed ? ` ${theme.fg("error", bracketed(theme, status))}` : "";
		const id = truncate(
			sanitizeText(text("id") ?? "agent").replace(/\s+/g, " "),
			Math.max(0, width - visibleWidth(lead) - visibleWidth(badge)),
		);
		// The agent's resolved model leads its id (`task.showResolvedModelBadge`), in the room the id leaves.
		const model = isFeedModelBadgeEnabled()
			? feedModel(
					event.resolvedModelIdentity ?? event.model ?? event.resolvedModel,
					event.resolvedThinkingLevel,
					event.advisor,
				)
			: undefined;
		const modelBadge = model
			? styledModelBadge(
					theme,
					model,
					Math.min(FEED_MODEL_BADGE_WIDTH, width - visibleWidth(`${lead}${id}${badge}`) - 1),
				)
			: "";
		let line = `${lead}${modelBadge ? `${modelBadge} ` : ""}${theme.fg("accent", `\x1b[1m${id}\x1b[22m`)}${badge}`;
		const tool = text("currentTool");
		const intent = text("lastIntent");
		const preview = status === "running" && !tool && !intent ? text("taskPreview") : undefined;
		if (preview) line += ` ${theme.fg("muted", truncate(replaceTabs(preview), AGENT_DETAIL_WIDTH))}`;
		const dot = symbol("sep.dot");
		const tools = number("toolCount");
		if (tools > 0) line += `${dot}${theme.fg("dim", `${formatNumber(tools)} ${symbol("icon.extensionTool")}`)}`;
		const contextTokens = number("contextTokens");
		const contextWindow = number("contextWindow");
		if (contextTokens > 0)
			line += `${dot}${theme.fg(
				"dim",
				contextWindow > 0
					? `${((contextTokens / contextWindow) * 100).toFixed(1)}%/${formatNumber(contextWindow)}`
					: formatNumber(contextTokens),
			)}`;
		const cost = number("cost");
		if (cost > 0) line += `${dot}${theme.fg("statusLineCost", `$${cost.toFixed(2)}`)}`;
		const duration = status === "completed" || status === "failed" || status === "aborted" ? number("durationMs") : 0;
		if (duration > 0) line += `${dot}${theme.fg("dim", formatDuration(duration))}`;
		rows.push(truncate(line, width, ""));
		if (status !== "running") return;
		const hook = symbol("tree.hook");
		if (tool) {
			let toolLine = `${cont}${hook} ${theme.fg("muted", tool)}`;
			const detail = intent ?? text("currentToolArgs");
			if (detail) toolLine += `: ${theme.fg("dim", truncate(replaceTabs(detail), AGENT_DETAIL_WIDTH))}`;
			rows.push(truncate(toolLine, width));
		} else if (intent)
			rows.push(
				truncate(`${cont}${hook} ${theme.fg("dim", truncate(replaceTabs(intent), AGENT_DETAIL_WIDTH))}`, width),
			);
	});
	return rows;
}

/**
 * Placeholders of the result's images under the cells, but for those the tool
 * block draws as pictures; the block links them to their images.
 */
function imagePlaceholderRows(node: UiNode, cx: PaintContext): string[] {
	const links = toolProps(node).term?.imageLinks ?? [];
	return links
		.slice(resultPictures(node, cx).length)
		.map(link => truncate(cx.theme.fg("toolOutput", link.text), cx.width));
}

/** Call-level notes: timeout, notice, background job, truncation warning. */
function callNotes(theme: Theme, term: EvalTerm): string[] {
	const notes: string[] = [];
	if (typeof term.timeout === "number") notes.push(theme.fg("dim", bracketed(theme, `Timeout: ${term.timeout}s`)));
	if (term.notice) notes.push(theme.fg("dim", bracketed(theme, term.notice)));
	if (term.jobId) notes.push(theme.fg("dim", bracketed(theme, `Backgrounded: ${term.jobId}`)));
	const meta = term.meta;
	if (meta?.truncation || meta?.artifactError) {
		const parts: string[] = [];
		if (meta.truncation) parts.push(formatTruncationMetaNotice(meta.truncation, meta.source));
		if (meta.artifactError) parts.push(formatArtifactErrorNotice(meta.artifactError));
		notes.push(theme.fg("warning", bracketed(theme, parts.join(". "))));
	}
	return notes;
}

function paintEval(node: UiNode, cx: PaintContext): Block {
	const props = toolProps(node);
	const term = props.term as unknown as EvalTerm;
	const theme = cx.theme;
	const width = cx.width;
	const expanded = term.cellsExpanded ?? isExpanded(props);
	const cells = term.cells;
	if (term.phase === "call") {
		if (cells.length === 0)
			return {
				rows: wrap(theme.fg("toolTitle", `\x1b[1m${theme.fg("accent", ">>>")} …\x1b[22m`), width),
			};
		const rows: string[] = [];
		cells.forEach((cell, i) => {
			if (i > 0) rows.push("");
			rows.push(
				...codeCellRows(
					cx,
					{
						code: cell.code,
						language: highlightLanguage(cell.language),
						showLanguage: true,
						index: i,
						total: cells.length,
						...(cell.title !== undefined ? { title: cell.title } : {}),
						status: cx.reduceMotion ? "pending" : "running",
						codeTail: true,
						codeMaxLines: PREVIEW_WINDOW_ROWS,
						expanded,
					},
					width,
				),
			);
		});
		return { rows };
	}
	const previewLines = Math.min(term.previewLines ?? 10, PREVIEW_WINDOW_ROWS);
	const notes = callNotes(theme, term);
	if (term.phase === "cells") {
		const rows: string[] = [];
		cells.forEach((cell, i) => {
			const status = statusRows(theme, cell.events ?? [], expanded, cell.elided);
			const output = cellOutputRows(theme, cell, expanded, previewLines, width);
			const lines = [...output.rows];
			if (!expanded && output.hidden > 0)
				lines.push(theme.fg("dim", `… ${output.hidden} more lines (⌃O to expand)`));
			if (status.length > 0) {
				if (lines.length > 0) lines.push(theme.fg("dim", "Status"));
				lines.push(...status);
			}
			rows.push(
				...codeCellRows(
					cx,
					{
						code: cell.code,
						language: highlightLanguage(cell.language),
						showLanguage: true,
						index: i,
						total: cells.length,
						...(cell.title !== undefined ? { title: cell.title } : {}),
						...(cell.status ? { status: cell.status } : {}),
						...(cell.durationMs !== undefined ? { duration: cell.durationMs } : {}),
						...(lines.length > 0 ? { output: lines.join("\n"), outputMaxLines: lines.length } : {}),
						codeTail: true,
						codeMaxLines: PREVIEW_WINDOW_ROWS,
						expanded,
					},
					width,
				),
			);
			if (cell.agents && cell.agents.length > 0) rows.push(...agentRows(cx, cell.agents, width));
			if (i < cells.length - 1) rows.push("");
		});
		return { rows: [...rows, ...imagePlaceholderRows(node, cx), ...notes] };
	}
	const output = withoutDrawnPlaceholders(
		term.output ?? "",
		props.term?.imageLinks,
		resultPictures(node, cx).length,
	).trimEnd();
	const status = statusRows(theme, term.events ?? [], expanded, term.elided);
	const statusBlock = status.length > 0 ? [theme.fg("dim", "Status"), ...status] : [];
	if (!output && status.length === 0) return { rows: notes.length > 0 ? wrap(notes.join("\n"), width) : [] };
	if (!output || expanded) {
		const styled = output ? output.split("\n").map(line => theme.fg("toolOutput", line)) : [];
		return {
			rows: wrap([...styled, ...statusBlock, ...notes].join("\n"), width),
		};
	}
	const styled = output.split("\n").map(line => theme.fg("toolOutput", line));
	const tail = visualTail(["", ...styled], previewLines, width);
	const rows: string[] = [];
	if (tail.skipped > 0) {
		rows.push(
			"",
			truncate(
				theme.fg(
					"dim",
					`… (${tail.skipped} earlier lines, showing ${tail.rows.length} of ${tail.skipped + tail.rows.length}) (⌃O to expand)`,
				),
				width,
			),
		);
	}
	rows.push(...tail.rows);
	for (const line of [...statusBlock, ...notes]) rows.push(truncate(line, width));
	return { rows };
}

defineToolLook("eval", { paint: paintEval, margin: true, animated: true });
