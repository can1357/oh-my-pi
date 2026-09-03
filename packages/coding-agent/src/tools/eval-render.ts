/**
 * TUI rendering for the eval tool.
 *
 * Split out from `eval.ts` so the renderer can be imported by `renderers.ts`
 * without dragging the eval *runtime* (JS/Python/Ruby/Julia backends ->
 * agent bridge -> task executor -> sdk -> extension loader -> root barrel)
 * into the renderer module graph. That transitive chain re-enters
 * `renderers.ts` while `eval.ts` is still initializing, which previously
 * crashed module load with a TDZ `Cannot access 'evalToolRenderer' before
 * initialization`.
 */
import type { Component } from "@oh-my-pi/pi-tui";
import { Markdown, Text } from "@oh-my-pi/pi-tui";
import { formatNumber } from "@oh-my-pi/pi-utils";
import { settings } from "../config/settings";
import type { EvalCellResult, EvalLanguage, EvalStatusEvent, EvalToolDetails } from "../eval/types";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { formatContextUsage } from "../modes/components/status-line/context-thresholds";
import { truncateToVisualLines } from "../modes/components/visual-truncate";
import { getMarkdownTheme, type Theme } from "../modes/theme/theme";
import { markFramedBlockComponent, outputBlockContentWidth, renderCodeCell } from "../tui";
import { formatEvalCodeForDisplay } from "./eval-format";
import {
	JSON_TREE_MAX_DEPTH_COLLAPSED,
	JSON_TREE_MAX_DEPTH_EXPANDED,
	JSON_TREE_MAX_LINES_COLLAPSED,
	JSON_TREE_MAX_LINES_EXPANDED,
	JSON_TREE_SCALAR_LEN_COLLAPSED,
	JSON_TREE_SCALAR_LEN_EXPANDED,
	renderJsonTreeLines,
} from "./json-tree";
import { formatStyledTruncationWarning, stripOutputNotice } from "./output-meta";
import {
	formatBadge,
	formatDuration,
	formatStatusIcon,
	formatTitle,
	previewWindowRows,
	replaceTabs,
	shortenPath,
	truncateToWidth,
	wrapBrackets,
} from "./render-utils";
export const EVAL_DEFAULT_PREVIEW_LINES = 10;

function languageForHighlighter(language: EvalLanguage | undefined): "python" | "javascript" | "ruby" | "julia" {
	if (language === "js") return "javascript";
	if (language === "ruby") return "ruby";
	if (language === "julia") return "julia";
	return "python";
}

interface EvalRenderCellArg {
	language?: string;
	code?: string;
	title?: string;
}

interface EvalRenderArgs {
	language?: string;
	code?: string;
	title?: string;
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
	if (value === "rb" || value === "ruby") return "ruby";
	if (value === "jl" || value === "julia") return "julia";
	return "python";
}

function getRenderCells(args: EvalRenderArgs | undefined): EvalRenderCell[] {
	if (!args) return [];
	const raw = Array.isArray(args.cells) ? args.cells : typeof args.code === "string" ? [args] : [];
	const out: EvalRenderCell[] = [];
	for (const cell of raw) {
		if (!cell || typeof cell !== "object") continue;
		const language = normalizeRenderLanguage(typeof cell.language === "string" ? cell.language : undefined);
		const code = typeof cell.code === "string" ? cell.code : "";
		out.push({
			language,
			code: formatEvalCodeForDisplay(code, language),
			title: typeof cell.title === "string" ? cell.title : undefined,
		});
	}
	return out;
}

type AgentEventStatus = "pending" | "running" | "completed" | "failed" | "aborted";

/**
 * Append or replace a status event. `agent` events are progress snapshots keyed
 * by `id`, so they coalesce in place (preserving first-seen order); every other
 * op is a discrete action and simply appends. Keeps the persisted event list
 * bounded even when a subagent emits hundreds of throttled progress ticks.
 */
export function upsertStatusEvent(events: EvalStatusEvent[], event: EvalStatusEvent): void {
	if (event.op === "agent" && typeof event.id === "string") {
		const id = event.id;
		const idx = events.findIndex(e => e.op === "agent" && e.id === id);
		if (idx >= 0) {
			events[idx] = event;
			return;
		}
	}
	events.push(event);
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

/** Append the toolCount · context · cost · model stat run, mirroring the task tool. */
function formatAgentStats(event: EvalStatusEvent, theme: Theme): string {
	let line = "";
	const toolCount = eventNumber(event.toolCount);
	if (toolCount > 0) {
		line += `${theme.sep.dot}${theme.fg("dim", `${formatNumber(toolCount)} ${theme.icon.extensionTool}`)}`;
	}
	const contextTokens = eventNumber(event.contextTokens);
	if (contextTokens > 0) {
		const contextWindow = eventNumber(event.contextWindow);
		const ctx =
			contextWindow > 0
				? formatContextUsage((contextTokens / contextWindow) * 100, contextWindow)
				: formatNumber(contextTokens);
		line += `${theme.sep.dot}${theme.fg("dim", ctx)}`;
	}
	const cost = eventNumber(event.cost);
	if (cost > 0) {
		line += `${theme.sep.dot}${theme.fg("statusLineCost", `$${cost.toFixed(2)}`)}`;
	}
	const model = eventString(event.model);
	if (model && settings.get("task.showResolvedModelBadge")) {
		line += `${theme.sep.dot}${theme.fg("dim", truncateToWidth(replaceTabs(model), 30))}`;
	}
	return line;
}

/**
 * Render coalesced `agent()` progress as a Task-tool-style tree, one entry per
 * subagent: a status line (icon · id · stats) plus, while running, the current
 * tool/intent. Drawn below the cell box so progress streams live.
 */
function renderAgentProgressEvents(events: EvalStatusEvent[], theme: Theme, spinnerFrame?: number): string[] {
	const lines: string[] = [];
	for (let i = 0; i < events.length; i++) {
		const event = events[i];
		const isLast = i === events.length - 1;
		const prefix = theme.fg("dim", isLast ? theme.tree.last : theme.tree.branch);
		const cont = isLast ? "   " : `${theme.fg("dim", theme.tree.vertical)}  `;

		const status = agentEventStatus(event.status);
		const iconStatus =
			status === "completed"
				? "done"
				: status === "failed"
					? "error"
					: status === "aborted"
						? "aborted"
						: status === "pending"
							? "pending"
							: "running";
		const iconColor =
			status === "completed" ? "success" : status === "failed" || status === "aborted" ? "error" : "accent";
		const icon =
			status === "completed"
				? theme.styledSymbol("tool.eval", "accent")
				: theme.fg(iconColor, formatStatusIcon(iconStatus, theme, status === "running" ? spinnerFrame : undefined));

		const id = eventString(event.id) ?? "agent";
		let line = `${prefix} ${icon} ${theme.fg("accent", theme.bold(id))}`;

		if (status === "failed" || status === "aborted") {
			line += ` ${formatBadge(status, iconColor, theme)}`;
		}

		const currentTool = eventString(event.currentTool);
		const lastIntent = eventString(event.lastIntent);
		if (status === "running" && !currentTool && !lastIntent) {
			const preview = eventString(event.taskPreview);
			if (preview) line += ` ${theme.fg("muted", truncateToWidth(replaceTabs(preview), 48))}`;
		}

		line += formatAgentStats(event, theme);
		if (status === "completed" || status === "failed" || status === "aborted") {
			const durationMs = eventNumber(event.durationMs);
			if (durationMs > 0) line += `${theme.sep.dot}${theme.fg("dim", formatDuration(durationMs))}`;
		}
		lines.push(line);

		if (status === "running") {
			if (currentTool) {
				let toolLine = `${cont}${theme.tree.hook} ${theme.fg("muted", currentTool)}`;
				const detail = lastIntent ?? eventString(event.currentToolArgs);
				if (detail) toolLine += `: ${theme.fg("dim", truncateToWidth(replaceTabs(detail), 48))}`;
				lines.push(toolLine);
			} else if (lastIntent) {
				lines.push(`${cont}${theme.tree.hook} ${theme.fg("dim", truncateToWidth(replaceTabs(lastIntent), 48))}`);
			}
		}
	}
	return lines;
}

/** Format a status event as a single line for display. */
function formatStatusEvent(event: EvalStatusEvent, theme: Theme): string {
	const { op, ...data } = event;

	type AvailableIcon = "icon.file" | "icon.folder" | "icon.git" | "icon.package";
	const opIcons: Record<string, AvailableIcon> = {
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
		const previewLines = String(preview).split("\n").slice(0, maxLines);
		for (const line of previewLines) {
			lines.push(`   ${theme.fg("toolOutput", truncateToWidth(replaceTabs(line), 80))}`);
		}
		const totalLines = String(preview).split("\n").length;
		if (totalLines > maxLines) {
			lines.push(`   ${theme.fg("dim", `… ${totalLines - maxLines} more lines`)}`);
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
 */
function renderStatusEvents(events: EvalStatusEvent[], theme: Theme, expanded: boolean): string[] {
	if (events.length === 0) return [];

	const max = expanded ? Math.max(10, previewWindowRows()) : 3;
	const hidden = Math.max(0, events.length - max);
	const visible = hidden > 0 ? events.slice(hidden) : events;

	const lines: string[] = [];
	if (hidden > 0) {
		lines.push(`${theme.fg("dim", theme.tree.branch)} ${theme.fg("dim", `… ${hidden} earlier`)}`);
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
	// duplicate "ctrl+o to expand" scrollback spray.
	const innerWidth = outputBlockContentWidth(width);

	if (cell.hasMarkdown && cell.status !== "error") {
		const md = new Markdown(cell.output, 0, 0, getMarkdownTheme());
		const allLines = md.render(innerWidth);
		const displayLines = expanded ? allLines : allLines.slice(-previewLines);
		const hiddenCount = allLines.length - displayLines.length;
		return { lines: displayLines, hiddenCount };
	}

	const styledOutput = cell.output
		.split("\n")
		.map(line => {
			const cleaned = replaceTabs(line);
			return cell.status === "error" ? theme.fg("error", cleaned) : theme.fg("toolOutput", cleaned);
		})
		.join("\n");
	if (expanded) {
		return { lines: styledOutput.split("\n"), hiddenCount: 0 };
	}
	const { visualLines, skippedCount } = truncateToVisualLines(styledOutput, previewLines, innerWidth);
	return { lines: visualLines, hiddenCount: skippedCount };
}

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

		let cached: { key: string; width: number; result: string[] } | undefined;

		return markFramedBlockComponent({
			render: (width: number): readonly string[] => {
				const key = `${options.expanded ? 1 : 0}|${options.spinnerFrame ?? "-"}|${previewWindowRows()}|${cells.map(c => `${c.language}:${c.title ?? ""}:${c.code.length}`).join("|")}`;
				if (cached && cached.key === key && cached.width === width) {
					return cached.result;
				}

				const lines: string[] = [];
				for (let i = 0; i < cells.length; i++) {
					const cell = cells[i];
					const cellLines = renderCodeCell(
						{
							code: cell.code,
							language: languageForHighlighter(cell.language),
							showLanguage: true,
							index: i,
							total: cells.length,
							title: cell.title,
							status: options.spinnerFrame !== undefined ? "running" : "pending",
							spinnerFrame: options.spinnerFrame,
							width,
							// Viewport-sized tail window following the newest streamed code
							// line; renderResult keeps the same cap so the cell never snaps
							// open on completion. Only ctrl+o uncaps.
							codeTail: true,
							codeMaxLines: previewWindowRows(),
							expanded: options.expanded,
						},
						uiTheme,
					);
					lines.push(...cellLines);
					if (i < cells.length - 1) {
						lines.push("");
					}
				}
				cached = { key, width, result: lines };
				return lines;
			},
			invalidate: () => {
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
		if (details?.meta?.truncation) {
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
				return { cell, code: formatEvalCodeForDisplay(cell.code, language), language };
			});
			let cached: { key: string; width: number; result: string[] } | undefined;

			return markFramedBlockComponent({
				render: (width: number): readonly string[] => {
					const expanded = options.renderContext?.expanded ?? options.expanded;
					const previewLines = Math.min(
						options.renderContext?.previewLines ?? EVAL_DEFAULT_PREVIEW_LINES,
						previewWindowRows(),
					);
					const key = `${expanded}|${previewLines}|${options.spinnerFrame}|${previewWindowRows()}`;
					if (cached && cached.key === key && cached.width === width) {
						return cached.result;
					}

					const lines: string[] = [];
					for (let i = 0; i < displayCells.length; i++) {
						const { cell, code, language } = displayCells[i];
						const allEvents = cell.statusEvents ?? [];
						const agentEvents = allEvents.filter(e => e.op === "agent");
						const otherEvents = agentEvents.length > 0 ? allEvents.filter(e => e.op !== "agent") : allEvents;
						const statusLines = renderStatusEvents(otherEvents, uiTheme, expanded);
						const outputContent = formatCellOutputLines(cell, expanded, previewLines, uiTheme, width);
						const outputLines = [...outputContent.lines];
						if (!expanded && outputContent.hiddenCount > 0) {
							outputLines.push(
								uiTheme.fg("dim", `… ${outputContent.hiddenCount} more lines (ctrl+o to expand)`),
							);
						}
						if (statusLines.length > 0) {
							if (outputLines.length > 0) {
								outputLines.push(uiTheme.fg("dim", "Status"));
							}
							outputLines.push(...statusLines);
						}
						const cellLines = renderCodeCell(
							{
								code,
								language: languageForHighlighter(language),
								showLanguage: true,
								index: i,
								total: cellResults.length,
								title: cell.title,
								status: cell.status,
								spinnerFrame: options.spinnerFrame,
								duration: cell.durationMs,
								output: outputLines.length > 0 ? outputLines.join("\n") : undefined,
								outputMaxLines: outputLines.length,
								// Same viewport-sized tail window as the pending preview so the
								// cell never snaps open on completion; only ctrl+o uncaps.
								// `output` keeps its own preview cap from above.
								codeTail: true,
								codeMaxLines: previewWindowRows(),
								expanded,
								width,
							},
							uiTheme,
						);
						lines.push(...cellLines);
						if (agentEvents.length > 0) {
							lines.push(...renderAgentProgressEvents(agentEvents, uiTheme, options.spinnerFrame));
						}
						if (i < cellResults.length - 1) {
							lines.push("");
						}
					}
					if (jsonLines.length > 0) {
						if (lines.length > 0) {
							lines.push("");
						}
						lines.push(...jsonLines);
					}
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
					cached = { key, width, result: lines };
					return lines;
				},
				invalidate: () => {
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
						`… (${cachedSkipped} earlier lines, showing ${cachedLines.length} of ${cachedSkipped + cachedLines.length}) (ctrl+o to expand)`,
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

	mergeCallAndResult: true,
	inline: true,
};
