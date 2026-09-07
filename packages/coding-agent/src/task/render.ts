/**
 * TUI rendering for task tool.
 *
 * Provides renderCall and renderResult functions for displaying
 * task execution in the terminal UI.
 */
import path from "node:path";
import type { Component } from "@oh-my-pi/pi-tui";
import { Container, Markdown, Text } from "@oh-my-pi/pi-tui";
import { formatNumber, sanitizeText } from "@oh-my-pi/pi-utils";
import { settings } from "../config/settings";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { formatContextUsage } from "../modes/components/status-line/context-thresholds";
import { getMarkdownTheme, type Theme } from "../modes/theme/theme";
import { stripGeneratedOutputNotice, stripRawOutputArtifactNotice } from "../tools/output-meta";
import {
	capPreviewLines,
	formatBadge,
	formatDuration,
	formatExpandHint,
	formatMoreItems,
	formatStatusIcon,
	previewLine,
	previewWindowRows,
	replaceTabs,
	type ToolUIStatus,
	truncateToWidth,
} from "../tools/render-utils";
import {
	type FindingDetails,
	type FindingPriority,
	getPriorityInfo,
	PRIORITY_LABELS,
	parseFindingDetails,
	type SubmitReviewDetails,
} from "../tools/review";
import { framedBlock, renderStatusLine } from "../tui";
import { repairDoubleEncodedJsonString } from "./repair-args";
import { subprocessToolRegistry } from "./subprocess-tool-registry";
import type { AgentProgress, SingleResult, TaskItem, TaskParams, TaskToolDetails, YieldItem } from "./types";
import { assembleYieldResult } from "./yield-assembly";

/** Render context threaded in from `ToolExecutionComponent.#buildRenderContext`. */
interface TaskRenderContext {
	hasResult?: boolean;
	/**
	 * The block left the transcript live region (detached spawn the transcript
	 * has moved past, or a sealed block): progress rows render static gray, so
	 * commit-eligible rows do not repaint after entering native scrollback.
	 */
	frozen?: boolean;
	/**
	 * Wall clock for time-derived rows (current-tool elapsed, retry countdown).
	 * The component freezes it once the block settles or any of its rows enter
	 * native scrollback, so identical-input rebuilds stay byte-identical with
	 * committed history. Absent: render with the live clock.
	 */
	nowMs?: number;
}
type TaskRenderOptions = RenderResultOptions & { renderContext?: TaskRenderContext };

const MAX_NESTED_TASK_RENDER_DEPTH = 8;

function renderNestedCycleLine(theme: Theme): string {
	return theme.fg("dim", "… nested task progress already shown");
}

/**
 * Get status icon for agent state.
 * For running status, uses animated spinner if spinnerFrame is provided.
 * Maps AgentProgress status to styled icon format.
 */
function getStatusIcon(status: AgentProgress["status"], theme: Theme, spinnerFrame?: number): string {
	switch (status) {
		case "pending":
			return formatStatusIcon("pending", theme);
		case "running":
			return formatStatusIcon("running", theme, spinnerFrame);
		case "completed":
			return formatStatusIcon("success", theme);
		case "failed":
			return formatStatusIcon("error", theme);
		case "aborted":
			return formatStatusIcon("aborted", theme);
	}
}

/**
 * Append tool-count, context, and cost stats to a status line string.
 */
function appendAgentStats(
	line: string,
	opts: {
		toolCount?: number;
		requests?: number;
		tokens: number;
		contextTokens?: number;
		contextWindow?: number;
		cost: number;
		resolvedModel?: string;
		showResolvedModelBadge?: boolean;
	},
	theme: Theme,
): string {
	if (opts.toolCount) {
		line += `${theme.sep.dot}${theme.fg("dim", `${formatNumber(opts.toolCount)} ${theme.icon.extensionTool}`)}`;
	}
	if (opts.requests) {
		line += `${theme.sep.dot}${theme.fg("dim", `${formatNumber(opts.requests)} req`)}`;
	}
	// Current per-turn context — match the status line's `<pct>%/<window>` gauge (e.g. `5.1%/1M`).
	if (opts.contextTokens && opts.contextTokens > 0) {
		const ctx =
			opts.contextWindow && opts.contextWindow > 0
				? formatContextUsage((opts.contextTokens / opts.contextWindow) * 100, opts.contextWindow)
				: `${formatNumber(opts.contextTokens)}`;
		line += `${theme.sep.dot}${theme.fg("dim", ctx)}`;
	}
	if (opts.cost > 0) {
		line += `${theme.sep.dot}${theme.fg("statusLineCost", `$${opts.cost.toFixed(2)}`)}`;
	}
	if (opts.resolvedModel && opts.showResolvedModelBadge) {
		line += `${theme.sep.dot}${theme.fg("dim", truncateToWidth(replaceTabs(opts.resolvedModel), 30))}`;
	}
	return line;
}

function formatFindingSummary(findings: FindingDetails[], theme: Theme): string {
	if (findings.length === 0) return theme.fg("dim", "Findings: none");

	const counts: { [P in FindingPriority]?: number } = {};
	for (const finding of findings) {
		counts[finding.priority] = (counts[finding.priority] ?? 0) + 1;
	}

	const parts: string[] = [];
	for (const label of PRIORITY_LABELS) {
		const { symbol, color } = getPriorityInfo(label);
		const count = counts[label] ?? 0;
		const text = theme.fg(color, `${label}:${count}`);
		parts.push(theme.styledSymbol(symbol, color) ? `${theme.styledSymbol(symbol, color)} ${text}` : text);
	}

	return `${theme.fg("dim", "Findings:")} ${parts.join(theme.sep.dot)}`;
}

function normalizeFindings(value: unknown): FindingDetails[] {
	if (!Array.isArray(value)) return [];
	const findings: FindingDetails[] = [];
	for (const item of value) {
		const finding = parseFindingDetails(item);
		if (finding) findings.push(finding);
	}
	return findings;
}

/** Reviewer output declares `findings` as an array, so a lone finding section still assembles as a list. */
const REVIEWER_ARRAY_LABELS: ReadonlySet<string> = new Set(["findings"]);

function extractIncrementalReviewResult(
	items: RenderYieldItem[],
): { summary: SubmitReviewDetails; findings: FindingDetails[] } | undefined {
	const yieldItems: YieldItem[] = items.map(item => ({
		data: item.data,
		type: item.type,
		status: item.status === "aborted" ? "aborted" : item.status === "success" ? "success" : undefined,
		useLastTurn: item.useLastTurn,
	}));
	const assembled = assembleYieldResult(yieldItems, undefined, REVIEWER_ARRAY_LABELS);
	const data = assembled?.data;
	if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
	const record = data as Record<string, unknown>;
	const overallCorrectness = record.overall_correctness;
	const explanation = record.explanation;
	const confidence = record.confidence;
	if (
		(overallCorrectness !== "correct" && overallCorrectness !== "incorrect") ||
		typeof explanation !== "string" ||
		typeof confidence !== "number"
	) {
		return undefined;
	}
	return {
		summary: {
			overall_correctness: overallCorrectness,
			explanation,
			confidence,
		},
		findings: normalizeFindings(record.findings),
	};
}

interface RenderYieldItem {
	data?: unknown;
	type?: string | string[];
	status?: string;
	useLastTurn?: boolean;
}

/**
 * Normalize the `yield` slot of `extractedToolData` into an array of
 * yield-detail records. The subprocess executor always populates this slot as
 * `unknown[]` (see `executor.ts` `extractData` handler), but the renderer
 * MUST also tolerate a stray single object — optional chaining short-circuits
 * on `null`/`undefined` only, so calling `.map` on a plain object would throw
 * `TypeError: completeData?.map is not a function` and crash the TUI.
 * A single object is wrapped as a 1-element array so the review verdict still
 * renders; non-object primitives drop out.
 */
function normalizeYieldData(value: unknown): RenderYieldItem[] {
	const items = Array.isArray(value) ? value : value !== null && typeof value === "object" ? [value] : [];
	const normalized: RenderYieldItem[] = [];
	for (const item of items) {
		if (item === null || typeof item !== "object") continue;
		const record = item as Record<string, unknown>;
		const typeValue = record.type;
		let type: RenderYieldItem["type"];
		if (typeof typeValue === "string") {
			type = typeValue;
		} else if (Array.isArray(typeValue)) {
			const labels: string[] = [];
			let allLabels = true;
			for (const label of typeValue) {
				if (typeof label !== "string") {
					allLabels = false;
					break;
				}
				labels.push(label);
			}
			if (allLabels) type = labels;
		}
		normalized.push({
			data: record.data,
			type,
			status: typeof record.status === "string" ? record.status : undefined,
			useLastTurn: record.useLastTurn === true ? true : undefined,
		});
	}
	return normalized;
}

function getRenderYieldLabels(type: RenderYieldItem["type"]): string[] {
	if (typeof type === "string") {
		const label = type.trim();
		return label ? [label] : [];
	}
	if (!Array.isArray(type)) return [];
	const labels: string[] = [];
	for (const value of type) {
		const label = value.trim();
		if (label) labels.push(label);
	}
	return labels;
}

function formatYieldPreview(item: RenderYieldItem): string {
	if (item.useLastTurn === true && item.data === undefined) return "last assistant turn";
	if (item.data === undefined) return "last assistant turn";
	if (typeof item.data === "string") return previewLine(replaceTabs(sanitizeText(item.data)), 70);
	try {
		return previewLine(replaceTabs(sanitizeText(JSON.stringify(item.data) ?? "null")), 70);
	} catch {
		return previewLine(replaceTabs(sanitizeText(String(item.data))), 70);
	}
}

function renderTypedYieldSections(value: unknown, continuePrefix: string, expanded: boolean, theme: Theme): string[] {
	const typedItems: Array<{ item: RenderYieldItem; labels: string[] }> = [];
	for (const item of normalizeYieldData(value)) {
		const labels = getRenderYieldLabels(item.type);
		if (labels.length === 0) continue;
		typedItems.push({ item, labels });
	}
	const displayCount = expanded ? typedItems.length : 3;
	const lines: string[] = [];
	for (const { item, labels } of typedItems.slice(-displayCount)) {
		const terminal = !Array.isArray(item.type);
		const prefix = terminal ? "yield" : "yield+";
		const label = `${prefix}[${labels.join(", ")}]`;
		lines.push(`${continuePrefix}${theme.fg("dim", label)}: ${theme.fg("dim", formatYieldPreview(item))}`);
	}
	if (typedItems.length > displayCount) {
		lines.push(`${continuePrefix}${theme.fg("dim", formatMoreItems(typedItems.length - displayCount, "yield"))}`);
	}
	return lines;
}

function formatJsonScalar(value: unknown, _theme: Theme): string {
	if (value === null) return "null";
	if (typeof value === "string") {
		const trimmed = truncateToWidth(sanitizeText(value), 70);
		return `"${trimmed}"`;
	}
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return "";
}

export function formatTaskId(id: string): string {
	// Ids are name-based (e.g. "Anna", "Anna-2"); a "." separates nesting levels
	// (e.g. "Anna.Bob"). Render the hierarchy with a ">" breadcrumb.
	const sanitizedId = sanitizeText(id);
	const segments = sanitizedId.split(".");
	return segments.length < 2 ? sanitizedId : segments.join(">");
}

const MISSING_YIELD_WARNING_PREFIX = "SYSTEM WARNING: Subagent exited without calling yield tool";

function extractMissingYieldWarning(output: string): { warning?: string; rest: string } {
	const lines = output.split("\n");
	const firstLine = lines[0]?.trim() ?? "";
	if (!firstLine.startsWith(MISSING_YIELD_WARNING_PREFIX)) {
		return { rest: output };
	}
	const rest = lines
		.slice(1)
		.join("\n")
		.replace(/^\s*\n+/, "");
	return { warning: firstLine, rest };
}

function buildTreePrefix(ancestors: boolean[], theme: Theme): string {
	return ancestors.map(hasNext => (hasNext ? `${theme.tree.vertical}  ` : "   ")).join("");
}

function renderJsonTreeLines(
	value: unknown,
	theme: Theme,
	maxDepth: number,
	maxLines: number,
): { lines: string[]; truncated: boolean } {
	const lines: string[] = [];
	let truncated = false;

	const iconObject = theme.styledSymbol("icon.folder", "muted");
	const iconArray = theme.styledSymbol("icon.package", "muted");
	const iconScalar = theme.styledSymbol("icon.file", "muted");

	const pushLine = (line: string) => {
		if (lines.length >= maxLines) {
			truncated = true;
			return false;
		}
		lines.push(line);
		return true;
	};

	const renderNode = (val: unknown, key: string | undefined, ancestors: boolean[], isLast: boolean, depth: number) => {
		if (lines.length >= maxLines) {
			truncated = true;
			return;
		}

		const connector = isLast ? theme.tree.last : theme.tree.branch;
		const prefix = `${buildTreePrefix(ancestors, theme)}${theme.fg("dim", connector)} `;
		const scalar = formatJsonScalar(val, theme);

		if (scalar) {
			const label = key ? theme.fg("muted", sanitizeText(key)) : theme.fg("muted", "value");
			pushLine(`${prefix}${iconScalar} ${label}: ${theme.fg("dim", scalar)}`);
			return;
		}

		if (Array.isArray(val)) {
			const header = key ? theme.fg("muted", sanitizeText(key)) : theme.fg("muted", "array");
			pushLine(`${prefix}${iconArray} ${header}`);
			if (val.length === 0) {
				pushLine(
					`${buildTreePrefix([...ancestors, !isLast], theme)}${theme.fg("dim", theme.tree.last)} ${theme.fg(
						"dim",
						"[]",
					)}`,
				);
				return;
			}
			if (depth >= maxDepth) {
				pushLine(
					`${buildTreePrefix([...ancestors, !isLast], theme)}${theme.fg("dim", theme.tree.last)} ${theme.fg(
						"dim",
						"…",
					)}`,
				);
				return;
			}
			const nextAncestors = [...ancestors, !isLast];
			for (let i = 0; i < val.length; i++) {
				renderNode(val[i], `[${i}]`, nextAncestors, i === val.length - 1, depth + 1);
				if (lines.length >= maxLines) {
					truncated = true;
					return;
				}
			}
			return;
		}

		if (val && typeof val === "object") {
			const header = key ? theme.fg("muted", sanitizeText(key)) : theme.fg("muted", "object");
			pushLine(`${prefix}${iconObject} ${header}`);
			const entries = Object.entries(val as Record<string, unknown>);
			if (entries.length === 0) {
				pushLine(
					`${buildTreePrefix([...ancestors, !isLast], theme)}${theme.fg("dim", theme.tree.last)} ${theme.fg(
						"dim",
						"{}",
					)}`,
				);
				return;
			}
			if (depth >= maxDepth) {
				pushLine(
					`${buildTreePrefix([...ancestors, !isLast], theme)}${theme.fg("dim", theme.tree.last)} ${theme.fg(
						"dim",
						"…",
					)}`,
				);
				return;
			}
			const nextAncestors = [...ancestors, !isLast];
			for (let i = 0; i < entries.length; i++) {
				const [childKey, child] = entries[i];
				renderNode(child, childKey, nextAncestors, i === entries.length - 1, depth + 1);
				if (lines.length >= maxLines) {
					truncated = true;
					return;
				}
			}
			return;
		}

		const label = key ? theme.fg("muted", sanitizeText(key)) : theme.fg("muted", "value");
		pushLine(`${prefix}${iconScalar} ${label}: ${theme.fg("dim", sanitizeText(String(val)))}`);
	};

	const renderRoot = (val: unknown) => {
		if (Array.isArray(val)) {
			for (let i = 0; i < val.length; i++) {
				renderNode(val[i], `[${i}]`, [], i === val.length - 1, 1);
				if (lines.length >= maxLines) {
					truncated = true;
					return;
				}
			}
			return;
		}
		if (val && typeof val === "object") {
			const entries = Object.entries(val as Record<string, unknown>);
			for (let i = 0; i < entries.length; i++) {
				const [childKey, child] = entries[i];
				renderNode(child, childKey, [], i === entries.length - 1, 1);
				if (lines.length >= maxLines) {
					truncated = true;
					return;
				}
			}
			return;
		}
		renderNode(val, undefined, [], true, 0);
	};

	renderRoot(value);

	return { lines, truncated };
}

const BASH_WALL_TIME_NOTICE_RE = /^Wall time: \d+(?:\.\d+)? seconds$/u;
const BASH_EXIT_CODE_NOTICE_RE = /^Command exited with code -?\d+$/u;

function stripRecentOutputNoticeLine(text: string): string {
	const trimmed = text.trimEnd();
	const lineStart = trimmed.lastIndexOf("\n");
	const candidateStart = lineStart === -1 ? 0 : lineStart + 1;
	const line = trimmed.slice(candidateStart);
	if (!BASH_WALL_TIME_NOTICE_RE.test(line) && !BASH_EXIT_CODE_NOTICE_RE.test(line)) return text;
	return trimmed.slice(0, lineStart === -1 ? 0 : lineStart).trimEnd();
}

function sanitizeRecentOutput(output: string): string {
	let text = sanitizeText(output).trimEnd();
	while (text) {
		const withoutArtifactNotice = stripRawOutputArtifactNotice(text).text;
		if (withoutArtifactNotice !== text) {
			text = withoutArtifactNotice;
			continue;
		}
		const withoutOutputNotice = stripGeneratedOutputNotice(text);
		if (withoutOutputNotice !== text) {
			text = withoutOutputNotice;
			continue;
		}
		const withoutRuntimeNotice = stripRecentOutputNoticeLine(text);
		if (withoutRuntimeNotice !== text) {
			text = withoutRuntimeNotice;
			continue;
		}
		break;
	}
	return text;
}

function renderOutputSection(
	output: string,
	continuePrefix: string,
	expanded: boolean,
	theme: Theme,
	maxCollapsed = 3,
	maxExpanded = 10,
	warning?: string,
): string[] {
	const lines: string[] = [];
	const sanitizedOutput = sanitizeText(output);
	const trimmedOutput = sanitizedOutput.trimEnd();
	if (!trimmedOutput && !warning) return lines;

	if (warning) {
		lines.push(`${continuePrefix}${theme.fg("dim", "Output")}`);
		lines.push(
			`${continuePrefix}  ${theme.fg("warning", theme.status.warning)} ${theme.fg(
				"dim",
				truncateToWidth(sanitizeText(warning), 80),
			)}`,
		);

		if (!trimmedOutput) {
			return lines;
		}

		if (trimmedOutput.startsWith("{") || trimmedOutput.startsWith("[")) {
			try {
				const parsed = JSON.parse(trimmedOutput);

				if (!expanded) {
					lines.push(`${continuePrefix}  ${theme.fg("dim", formatOutputInline(parsed, theme))}`);
					return lines;
				}

				const tree = renderJsonTreeLines(parsed, theme, expanded ? 6 : 2, expanded ? 24 : 6);
				if (tree.lines.length > 0) {
					for (const line of tree.lines) {
						lines.push(`${continuePrefix}  ${line}`);
					}
					if (tree.truncated) {
						lines.push(`${continuePrefix}  ${theme.fg("dim", "…")}`);
					}
					return lines;
				}
			} catch {
				// Fall back to raw output
			}
		}

		const outputLines = trimmedOutput.split("\n");
		const previewCount = expanded ? maxExpanded : maxCollapsed;
		for (const line of outputLines.slice(0, previewCount)) {
			lines.push(`${continuePrefix}  ${theme.fg("dim", truncateToWidth(replaceTabs(line), 70))}`);
		}

		if (outputLines.length > previewCount) {
			lines.push(
				`${continuePrefix}  ${theme.fg("dim", formatMoreItems(outputLines.length - previewCount, "line"))}`,
			);
		}

		return lines;
	}

	if (trimmedOutput.startsWith("{") || trimmedOutput.startsWith("[")) {
		try {
			const parsed = JSON.parse(trimmedOutput);

			// Collapsed: inline format like Args
			if (!expanded) {
				lines.push(`${continuePrefix}${theme.fg("dim", formatOutputInline(parsed, theme))}`);
				return lines;
			}

			// Expanded: tree format
			lines.push(`${continuePrefix}${theme.fg("dim", "Output")}`);
			const tree = renderJsonTreeLines(parsed, theme, expanded ? 6 : 2, expanded ? 24 : 6);
			if (tree.lines.length > 0) {
				for (const line of tree.lines) {
					lines.push(`${continuePrefix}  ${line}`);
				}
				if (tree.truncated) {
					lines.push(`${continuePrefix}  ${theme.fg("dim", "…")}`);
				}
				return lines;
			}
		} catch {
			// Fall back to raw output
		}
	}

	lines.push(`${continuePrefix}${theme.fg("dim", "Output")}`);

	const outputLines = trimmedOutput.split("\n");
	const previewCount = expanded ? maxExpanded : maxCollapsed;
	for (const line of outputLines.slice(0, previewCount)) {
		lines.push(`${continuePrefix}  ${theme.fg("dim", truncateToWidth(replaceTabs(line), 70))}`);
	}

	if (outputLines.length > previewCount) {
		lines.push(`${continuePrefix}  ${theme.fg("dim", formatMoreItems(outputLines.length - previewCount, "line"))}`);
	}

	return lines;
}

function renderTaskSection(
	task: string,
	continuePrefix: string,
	expanded: boolean,
	theme: Theme,
	maxExpanded = 20,
): string[] {
	const lines: string[] = [];
	const trimmed = sanitizeText(task).trim();
	if (!expanded || !trimmed) return lines;

	lines.push(`${continuePrefix}${theme.fg("dim", "Task")}`);
	const taskLines = trimmed.split("\n");
	for (const line of taskLines.slice(0, maxExpanded)) {
		lines.push(`${continuePrefix}  ${theme.fg("dim", truncateToWidth(replaceTabs(line), 70))}`);
	}
	if (taskLines.length > maxExpanded) {
		lines.push(`${continuePrefix}  ${theme.fg("dim", formatMoreItems(taskLines.length - maxExpanded, "line"))}`);
	}

	return lines;
}

function formatScalarInline(value: unknown, maxLen: number, _theme: Theme): string {
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	if (typeof value === "boolean") return String(value);
	if (typeof value === "number") return String(value);
	if (typeof value === "string") {
		const sanitizedValue = sanitizeText(value);
		const firstLine = sanitizedValue.split("\n")[0].trim();
		if (firstLine.length === 0) return `"" (${sanitizedValue.split("\n").length} lines)`;
		const preview = truncateToWidth(firstLine, maxLen);
		if (sanitizedValue.includes("\n")) return `"${preview}…" (${sanitizedValue.split("\n").length} lines)`;
		return `"${preview}"`;
	}
	if (Array.isArray(value)) return `[${value.length} items]`;
	if (typeof value === "object") {
		const keys = Object.keys(value);
		return `{${keys.length} keys}`;
	}
	return sanitizeText(String(value));
}

function formatOutputInline(data: unknown, theme: Theme, maxWidth = 80): string {
	if (data === null || data === undefined) return "Output: none";

	// For scalars, show directly
	if (typeof data !== "object") {
		return `Output: ${formatScalarInline(data, 60, theme)}`;
	}

	// For arrays, show count and first element preview
	if (Array.isArray(data)) {
		if (data.length === 0) return "Output: []";
		const preview = formatScalarInline(data[0], 40, theme);
		return `Output: [${data.length} items] ${preview}${data.length > 1 ? "…" : ""}`;
	}

	// For objects, show key=value pairs inline
	const entries = Object.entries(data as Record<string, unknown>);
	if (entries.length === 0) return "Output: {}";

	const pairs: string[] = [];
	let totalLen = "Output: ".length;

	for (const [key, value] of entries) {
		const valueStr = formatScalarInline(value, 24, theme);
		const pairStr = `${sanitizeText(key)}=${valueStr}`;
		const addLen = pairs.length > 0 ? pairStr.length + 2 : pairStr.length; // +2 for ", "

		if (totalLen + addLen > maxWidth && pairs.length > 0) {
			pairs.push("…");
			break;
		}

		pairs.push(pairStr);
		totalLen += addLen;
	}

	return `Output: ${pairs.join(", ")}`;
}

/**
 * First line of a streamed `task` brief, trimmed — a row's secondary text.
 * The args stream in token by token, so non-string values fall through to "".
 */
function taskFirstLine(task: unknown): string {
	if (typeof task !== "string") return "";
	const trimmed = sanitizeText(task).trim();
	const newline = trimmed.indexOf("\n");
	return newline === -1 ? trimmed : trimmed.slice(0, newline);
}

/**
 * Header label for a task call while nothing has spawned yet: the flat form's
 * `agent` type. Batch calls return undefined — each item row carries its own
 * `⟨agent⟩` badge, so a joined list in the header would just repeat them.
 */
function formatAgentHeaderLabel(args: Partial<TaskParams> | undefined): string | undefined {
	if (!args) return undefined;
	const flat = typeof args.agent === "string" ? args.agent.trim() : "";
	return flat || undefined;
}

/** Dim `⟨agent⟩` badge for a non-default agent type; empty for the generic worker. */
export function agentTypeBadge(agent: string | undefined, theme: Theme): string {
	const trimmed = agent?.trim();
	if (!trimmed || trimmed === "task") return "";
	return ` ${theme.fg("dim", `${theme.format.bracketLeft}${trimmed}${theme.format.bracketRight}`)}`;
}

/**
 * Render the call preview lines for the single spawned agent. The
 * args stream in token by token, so every field access is defensive.
 */
function renderTaskCallLines(args: Partial<TaskParams> | undefined, theme: Theme): string[] {
	if (!args) return [];
	const bullet = theme.fg("dim", "•");
	const lines: string[] = [];

	const rawName = typeof args.name === "string" ? args.name.trim() : "";
	const idLabel = rawName ? formatTaskId(rawName) : "";
	const brief = taskFirstLine(args.task);
	if (idLabel || brief) {
		let line = `${bullet} ${theme.fg("accent", theme.bold(idLabel || "agent"))}`;
		if (brief) {
			line += `: ${theme.fg("muted", previewLine(brief, 64))}`;
		}
		line += agentTypeBadge(args.agent, theme);
		lines.push(line);
	}
	lines.push(...renderTaskItemLines(args.tasks, theme));
	return lines;
}

/**
 * Agent rows shown per collapsed task list; the rest fold into a single
 * `… N more agents` summary line (expand uncaps).
 */
const COLLAPSED_AGENT_LIMIT = 4;

/**
 * Render the per-item list (`name` + `task` brief) for a batch call's
 * streaming preview. The args stream in token by token, so the array grows
 * over time and trailing entries may be partially parsed — every field access
 * is defensive.
 */
function renderTaskItemLines(tasks: TaskItem[] | undefined, theme: Theme): string[] {
	if (!Array.isArray(tasks) || tasks.length === 0) return [];

	const bullet = theme.fg("dim", "•");
	const cap = Math.min(tasks.length, COLLAPSED_AGENT_LIMIT);
	const lines: string[] = [];
	for (let i = 0; i < cap; i++) {
		const item = tasks[i] as Partial<TaskItem> | undefined;
		const rawName = typeof item?.name === "string" ? item.name.trim() : "";
		const idLabel = rawName ? formatTaskId(rawName) : `#${i + 1}`;
		let line = `${bullet} ${theme.fg("accent", theme.bold(idLabel))}`;
		const brief = taskFirstLine(item?.task);
		if (brief) {
			line += `: ${theme.fg("muted", previewLine(brief, 64))}`;
		}
		line += agentTypeBadge(item?.agent, theme);
		if (item?.isolated === true) {
			line += theme.fg("dim", " [isolated]");
		}
		lines.push(line);
	}
	if (cap < tasks.length) {
		lines.push(`${bullet} ${theme.fg("dim", formatMoreItems(tasks.length - cap, "agent"))}`);
	}
	return lines;
}

/** One renderable frame section: optional label, body rows, leading divider. */
type TaskRenderSection = { label?: string; lines: readonly string[]; separator?: boolean };
type AssignmentSectionRenderer = (width: number) => TaskRenderSection;

// Default output-block layout is: left border + one-cell content inset + right
// border. Render markdown at that inner width so the output block does not need
// to rewrap already-rendered assignment lines.
const ASSIGNMENT_FRAME_INSET = 3;

/**
 * Build the assignment section (the markdown brief handed to the subagent).
 * Rendered in both the streaming call preview and the result frame so the
 * brief stays visible for the whole task lifecycle — not just until the first
 * progress snapshot replaces the call view.
 */
function createAssignmentSectionRenderer(
	args: Partial<TaskParams> | undefined,
	theme: Theme,
): AssignmentSectionRenderer | undefined {
	// `renderResult` receives the raw tool args (unlike `renderCall`, which is
	// fed through `repairTaskParams`), so undo any per-field double-encoding
	// here too. The repair is idempotent on already-clean text.
	const assignment = sanitizeText(
		repairDoubleEncodedJsonString(typeof args?.task === "string" ? args.task : ""),
	).trim();
	if (!assignment) return undefined;
	return createMarkdownSectionRenderer(assignment, theme);
}

/**
 * Build the shared-context section (the `# Goal / # Constraints` background a
 * batch call hands every subagent). Rendered like the assignment brief so the
 * shared background stays visible for the whole task lifecycle.
 */
function createContextSectionRenderer(
	args: Partial<TaskParams> | undefined,
	theme: Theme,
): AssignmentSectionRenderer | undefined {
	const context = sanitizeText(
		repairDoubleEncodedJsonString(typeof args?.context === "string" ? args.context : ""),
	).trim();
	if (!context) return undefined;
	return createMarkdownSectionRenderer(context, theme);
}

function createMarkdownSectionRenderer(text: string, theme: Theme): AssignmentSectionRenderer {
	const markdown = new Markdown(text, 0, 0, getMarkdownTheme(), {
		color: line => theme.fg("muted", line),
	});
	return width => ({ lines: markdown.render(Math.max(1, width - ASSIGNMENT_FRAME_INSET)) });
}

/**
 * Render the tool call arguments.
 */
export function renderCall(args: TaskParams, options: TaskRenderOptions, theme: Theme): Component {
	const showIsolated = "isolated" in args && args.isolated === true;
	// Dispatch glyph from the first frame: spawning is non-blocking, so a
	// pending/hourglass icon would misread the call as something the turn
	// waits on.
	const header = renderStatusLine(
		{
			iconOverride: theme.styledSymbol("tool.task", "accent"),
			title: "Task",
			description: formatAgentHeaderLabel(args),
		},
		theme,
	);
	const assignmentSection = createAssignmentSectionRenderer(args, theme);
	const contextSection = createContextSectionRenderer(args, theme);
	return framedBlock(theme, width => {
		const sections: Array<{ label?: string; lines: readonly string[]; separator?: boolean }> = [];

		// The call preview only exists to surface the dispatched agent while the
		// args stream in. Once a result snapshot exists, `renderResult` draws the
		// same agent (and the assignment brief) itself, so showing it here would
		// repeat what the result frame already shows.
		if (!options.renderContext?.hasResult) {
			// Mirror renderResult's layout — context, assignment, then the
			// per-agent list — so the agent rows do not jump from above the
			// brief to below it when the first progress snapshot replaces the
			// call view. This also matches the schema's field order (`context`
			// streams before `tasks`), so the streaming preview grows
			// append-only instead of inserting agent rows above the
			// already-rendered markdown and pushing it down on every item.
			if (contextSection) sections.push(contextSection(width));
			if (assignmentSection) sections.push(assignmentSection(width));
			const callLines = renderTaskCallLines(args, theme);
			// Guarded: an empty trailing section would still draw its divider.
			if (callLines.length > 0) sections.push({ separator: true, lines: callLines });
		}

		return {
			header,
			headerMeta: showIsolated ? "isolated" : undefined,
			sections,
			state: "pending",
			borderColor: "borderMuted",
			width,
		};
	});
}

/**
 * Render streaming progress for a single agent.
 */
function renderAgentProgress(
	progress: AgentProgress,
	prefix: string,
	continuePrefix: string,
	expanded: boolean,
	theme: Theme,
	spinnerFrame?: number,
	frozen = false,
	seenNestedTasks?: WeakSet<object>,
	nestedDepth = 0,
	nowMs = Date.now(),
): string[] {
	const lines: string[] = [];

	const icon = getStatusIcon(progress.status, theme, spinnerFrame);
	const iconColor =
		progress.status === "completed"
			? "success"
			: progress.status === "failed" || progress.status === "aborted"
				? "error"
				: "accent";

	// Main status line: id: description [status] · stats · ⟨agent⟩
	const trimmedDescription = progress.description?.trim();
	const description = trimmedDescription ? previewLine(sanitizeText(trimmedDescription), 64) : undefined;
	const displayId = formatTaskId(progress.id);
	const titlePart = description ? `${theme.bold(displayId)}: ${description}` : displayId;
	const indent = prefix ? `${prefix} ` : "";
	let statusLine: string;
	if (progress.status === "running" || progress.status === "pending") {
		// Live (or queued) agents use the same dot finished rows keep: detached
		// async spawns can stay "pending" while real work is running, so a
		// pending/hourglass or spinner glyph reads wrong in the transcript. Keep
		// the row static; the Task tool header already carries the dispatch icon.
		const dot = theme.styledSymbol("status.done", frozen ? "dim" : "accent");
		const nameColor = frozen ? "dim" : "accent";
		const name = theme.fg(nameColor, description ? theme.bold(displayId) : displayId);
		statusLine = `${indent}${dot} ${name}`;
		if (description) {
			statusLine += `${theme.fg(nameColor, ":")} ${theme.fg(nameColor, description)}`;
		}
	} else if (progress.status === "completed") {
		// Finished rows keep the dot but settle from accent to the plain
		// foreground: completion reads as a color change, not a new glyph.
		statusLine = `${indent}${theme.styledSymbol("status.done", "text")} ${theme.fg("text", titlePart)}`;
	} else {
		statusLine = `${indent}${theme.fg(iconColor, icon)} ${theme.fg("accent", titlePart)}`;
	}
	statusLine += agentTypeBadge(progress.agent, theme);

	// Show retry-blocked badge so the parent immediately sees that a child
	// is sleeping on a provider 429, not silently progressing. Wins over the
	// generic running marker because "we're waiting on a quota window" is
	// the operationally meaningful state.
	if (progress.retryState && progress.status === "running") {
		statusLine += ` ${formatBadge("retrying", "warning", theme)}`;
	} else if (progress.retryFailure && (progress.status === "failed" || progress.status === "aborted")) {
		statusLine += ` ${formatBadge("rate-limited", "error", theme)}`;
	} else if (progress.status === "failed" || progress.status === "aborted") {
		const statusLabel = progress.status === "failed" ? "failed" : "aborted";
		statusLine += ` ${formatBadge(statusLabel, iconColor, theme)}`;
	}

	const showBadge = settings.get("task.showResolvedModelBadge");
	if (progress.status === "running") {
		if (!description) {
			const taskPreview = previewLine(sanitizeText(progress.assignment ?? progress.task), 40);
			statusLine += ` ${theme.fg("muted", taskPreview)}`;
		}
		statusLine = appendAgentStats(statusLine, { ...progress, showResolvedModelBadge: showBadge }, theme);
	} else if (progress.status === "completed") {
		statusLine = appendAgentStats(statusLine, { ...progress, showResolvedModelBadge: showBadge }, theme);
	}

	lines.push(statusLine);

	lines.push(...renderTaskSection(progress.assignment ?? progress.task, continuePrefix, expanded, theme));

	// Current tool (if running) or most recent completed tool
	if (progress.status === "running") {
		if (progress.currentTool) {
			let toolLine = `${continuePrefix}${theme.tree.hook} ${theme.fg("muted", sanitizeText(progress.currentTool))}`;
			const toolDetail = progress.lastIntent ?? progress.currentToolArgs;
			if (toolDetail) {
				toolLine += `: ${theme.fg("dim", previewLine(sanitizeText(toolDetail), 40))}`;
			}
			if (progress.currentToolStartMs) {
				const elapsed = nowMs - progress.currentToolStartMs;
				if (elapsed > 5000) {
					toolLine += `${theme.sep.dot}${theme.fg("warning", formatDuration(elapsed))}`;
				}
			}
			lines.push(toolLine);
		} else if (progress.recentTools.length > 0) {
			// Show most recent completed tool when idle between tools
			const recent = progress.recentTools[0];
			let toolLine = `${continuePrefix}${theme.tree.hook} ${theme.fg("dim", sanitizeText(recent.tool))}`;
			const toolDetail = progress.lastIntent ?? recent.args;
			if (toolDetail) {
				toolLine += `: ${theme.fg("dim", previewLine(sanitizeText(toolDetail), 40))}`;
			}
			lines.push(toolLine);
		}
	}

	// Retry detail line: surface why the subagent is paused and roughly how
	// long until the next attempt. Without this, the parent UI would just
	// keep spinning while a child sleeps on a 3-hour provider rate-limit.
	if (progress.retryState && progress.status === "running") {
		const remainingMs = Math.max(0, progress.retryState.startedAtMs + progress.retryState.delayMs - nowMs);
		const waitLabel = remainingMs > 0 ? `in ${formatDuration(remainingMs)}` : "now";
		const summary =
			`retrying ${progress.retryState.attempt}/${progress.retryState.maxAttempts} ${waitLabel}: ` +
			previewLine(sanitizeText(progress.retryState.errorMessage), 60);
		lines.push(`${continuePrefix}${theme.tree.hook} ${theme.fg("warning", summary)}`);
	} else if (progress.retryFailure && progress.status !== "running") {
		const summary = `auto-retry gave up after ${progress.retryFailure.attempt} attempt${
			progress.retryFailure.attempt === 1 ? "" : "s"
		}: ${previewLine(sanitizeText(progress.retryFailure.errorMessage), 80)}`;
		lines.push(`${continuePrefix}${theme.tree.hook} ${theme.fg("error", summary)}`);
	}

	// Render extracted tool data inline (e.g., review findings)
	if (progress.extractedToolData) {
		// For completed tasks, render review verdicts assembled from incremental
		// yield sections.
		if (progress.status === "completed") {
			const completeData = normalizeYieldData(progress.extractedToolData.yield);
			const incrementalReview = extractIncrementalReviewResult(completeData);
			if (incrementalReview) {
				lines.push(
					...renderReviewResult(
						incrementalReview.summary,
						incrementalReview.findings,
						continuePrefix,
						expanded,
						theme,
					),
				);
				return lines; // Review result handles its own rendering
			}
			const reviewData = completeData
				.map(c => c.data as SubmitReviewDetails)
				.filter(d => d && typeof d === "object" && "overall_correctness" in d);
			if (reviewData.length > 0) {
				const summary = reviewData[reviewData.length - 1];
				const findings: FindingDetails[] = [];
				lines.push(...renderReviewResult(summary, findings, continuePrefix, expanded, theme));
				return lines; // Review result handles its own rendering
			}
		}

		for (const toolName in progress.extractedToolData) {
			const dataArray = progress.extractedToolData[toolName];
			if (toolName === "yield") {
				lines.push(...renderTypedYieldSections(dataArray, continuePrefix, expanded, theme));
				continue;
			}

			// Nested `task` data has its own dedicated tree renderer below that
			// also merges in the in-flight snapshot — skip the generic inline
			// path so we don't render twice.
			if (toolName === "task") continue;

			const handler = subprocessToolRegistry.getHandler(toolName);
			if (handler?.renderInline) {
				const displayCount = expanded ? (dataArray as unknown[]).length : 3;
				const recentData = (dataArray as unknown[]).slice(-displayCount);
				for (const data of recentData) {
					const component = handler.renderInline(data, theme);
					if (component instanceof Text) {
						lines.push(`${continuePrefix}${component.getText()}`);
					}
				}
				if ((dataArray as unknown[]).length > displayCount) {
					lines.push(
						`${continuePrefix}${theme.fg(
							"dim",
							formatMoreItems((dataArray as unknown[]).length - displayCount, "item"),
						)}`,
					);
				}
			}
		}
	}

	// Nested `task` tree: completed sub-calls from `extractedToolData.task` plus
	// the in-flight snapshot (if any). Surfacing this in the live view means
	// the user sees deep-tree progress without waiting for this agent to finish
	// its own turn.
	const completedTaskCalls = (progress.extractedToolData?.task as TaskToolDetails[] | undefined) ?? [];
	const inflight = progress.inflightTaskDetails;
	if (completedTaskCalls.length > 0 || inflight) {
		const snapshots = inflight ? [...completedTaskCalls, inflight] : completedTaskCalls;
		const nestedLines = renderNestedTaskTree(
			snapshots,
			expanded,
			theme,
			spinnerFrame,
			frozen,
			seenNestedTasks,
			nestedDepth,
			nowMs,
		);
		for (const line of nestedLines) {
			lines.push(`${continuePrefix}${line}`);
		}
	}

	// Expanded view: recent output and tools
	if (expanded && progress.status === "running") {
		const previewRows = previewWindowRows();
		const output = capPreviewLines(
			sanitizeRecentOutput([...progress.recentOutput].reverse().join("\n")).split("\n"),
			theme,
			{
				max: previewRows,
				expandHint: false,
			},
		).join("\n");
		lines.push(...renderOutputSection(output, continuePrefix, expanded, theme, 2, previewRows));
	}

	return lines;
}

/**
 * Render review result with combined verdict + findings in tree structure.
 */
function renderReviewResult(
	summary: SubmitReviewDetails,
	findings: FindingDetails[],
	continuePrefix: string,
	expanded: boolean,
	theme: Theme,
): string[] {
	const lines: string[] = [];

	// Verdict line
	const verdictColor = summary.overall_correctness === "correct" ? "success" : "error";
	const isCorrect = summary.overall_correctness === "correct";
	const verdictIcon = isCorrect
		? theme.styledSymbol("status.done", "accent")
		: theme.fg(verdictColor, theme.status.error);
	lines.push(
		`${continuePrefix} Patch is ${theme.fg(verdictColor, summary.overall_correctness)} ${verdictIcon} ${theme.fg(
			"dim",
			`(${(summary.confidence * 100).toFixed(0)}% confidence)`,
		)}`,
	);

	// Explanation preview (first ~80 chars when collapsed, full when expanded)
	if (summary.explanation) {
		if (expanded) {
			lines.push(`${continuePrefix}${theme.fg("dim", "Summary")}`);
			const explanationLines = sanitizeText(summary.explanation).split("\n");
			for (const line of explanationLines) {
				lines.push(`${continuePrefix}  ${theme.fg("dim", replaceTabs(line))}`);
			}
		} else {
			// Preview: first sentence or ~100 chars (flatten tabs/newlines first)
			const flat = replaceTabs(sanitizeText(summary.explanation)).replace(/[\r\n]+/g, " ");
			const firstSentence = flat.split(/[.!?]/)[0].trim();
			const preview = truncateToWidth(`${firstSentence}.`, 100);
			lines.push(`${continuePrefix}${theme.fg("dim", preview)}`);
		}
	}

	// Findings summary + list
	lines.push(`${continuePrefix}${formatFindingSummary(findings, theme)}`);

	if (findings.length > 0) {
		lines.push(...renderFindings(findings, continuePrefix, expanded, theme));
	}

	return lines;
}

/**
 * Render review findings list.
 */
function renderFindings(findings: FindingDetails[], continuePrefix: string, expanded: boolean, theme: Theme): string[] {
	const lines: string[] = [];

	// Sort by priority (lower = more severe) when collapsed to show most important first
	const sortedFindings = expanded
		? findings
		: [...findings].sort((a, b) => getPriorityInfo(a.priority).ord - getPriorityInfo(b.priority).ord);
	const displayCount = expanded ? sortedFindings.length : Math.min(3, sortedFindings.length);

	for (let i = 0; i < displayCount; i++) {
		const finding = sortedFindings[i];
		const isLastFinding = i === displayCount - 1 && (expanded || sortedFindings.length <= 3);
		const findingPrefix = isLastFinding ? theme.tree.last : theme.tree.branch;
		const findingContinue = isLastFinding ? "   " : `${theme.tree.vertical}  `;

		const { color } = getPriorityInfo(finding.priority);
		const rawTitle = sanitizeText(finding.title?.replace(/^\[P\d\]\s*/, "") ?? "Untitled");
		const titleText = replaceTabs(rawTitle).replace(/[\r\n]+/g, " ");
		const loc = `${path.basename(sanitizeText(finding.file_path || "<unknown>"))}:${finding.line_start}`;

		lines.push(
			`${continuePrefix}${findingPrefix} ${theme.fg(color, `[${finding.priority}]`)} ${titleText} ${theme.fg("dim", loc)}`,
		);

		// Show body when expanded
		if (expanded && finding.body) {
			// Wrap body text
			const bodyLines = sanitizeText(finding.body).split("\n");
			for (const bodyLine of bodyLines) {
				lines.push(`${continuePrefix}${findingContinue}${theme.fg("dim", replaceTabs(bodyLine))}`);
			}
		}
	}

	if (!expanded && findings.length > 3) {
		lines.push(`${continuePrefix}${theme.fg("dim", formatMoreItems(findings.length - 3, "finding"))}`);
	}

	return lines;
}

function renderModelReceipt(
	receipt: SingleResult["modelReceipt"],
	continuePrefix: string,
	theme: Theme,
): string | undefined {
	if (!receipt) return undefined;
	const requestedModel = receipt.requestedModel?.join(", ");
	let text = "model receipt:";
	let hasModel = false;
	if (requestedModel) {
		text += ` ${requestedModel}`;
		hasModel = true;
	}
	if (receipt.requestedRole && requestedModel !== `@${receipt.requestedRole}`) {
		text += ` (@${receipt.requestedRole})`;
		hasModel = true;
	}
	if (receipt.resolvedModel) {
		text += `${hasModel ? " →" : ""} ${receipt.resolvedModel}`;
		hasModel = true;
	} else if (hasModel) {
		text += " → unresolved";
	}
	if (receipt.requestedEffort) {
		text += `${hasModel ? ";" : ""} effort ${receipt.requestedEffort}`;
		if (receipt.resolvedEffort) text += ` → ${receipt.resolvedEffort}`;
	} else if (receipt.resolvedEffort) {
		text += `${hasModel ? ";" : ""} effort ${receipt.resolvedEffort}`;
	}
	if (receipt.overrides?.length) text += `; overrides ${receipt.overrides.join(", ")}`;
	return `${continuePrefix}${theme.fg("dim", previewLine(replaceTabs(sanitizeText(text)), 100))}`;
}

/**
 * Render final result for a single agent.
 */
function renderAgentResult(
	result: SingleResult,
	prefix: string,
	continuePrefix: string,
	expanded: boolean,
	theme: Theme,
	seenNestedTasks?: WeakSet<object>,
	nestedDepth = 0,
): string[] {
	const lines: string[] = [];

	const { warning: missingCompleteWarning, rest: outputWithoutWarning } = extractMissingYieldWarning(result.output);
	const aborted = result.aborted ?? false;
	const mergeFailed = !aborted && result.exitCode === 0 && !!result.error;
	const success = !aborted && result.exitCode === 0 && !result.error;
	const needsWarning = Boolean(missingCompleteWarning) && success;
	const icon = aborted
		? theme.status.aborted
		: needsWarning
			? theme.status.warning
			: success
				? theme.styledSymbol("status.done", "text")
				: theme.status.error;
	const iconColor = needsWarning ? "warning" : success ? "success" : mergeFailed ? "warning" : "error";
	const statusText = aborted
		? "aborted"
		: needsWarning
			? "warning"
			: success
				? "done"
				: mergeFailed
					? "merge failed"
					: "failed";

	// Main status line: id: description [status] · stats · ⟨agent⟩
	const trimmedDescription = result.description ? sanitizeText(result.description).trim() : undefined;
	const description = trimmedDescription ? previewLine(trimmedDescription, 64) : undefined;
	const displayId = formatTaskId(result.id);
	const titlePart = description ? `${theme.bold(displayId)}: ${description}` : displayId;
	let statusLine = `${prefix ? `${prefix} ` : ""}${theme.fg(iconColor, icon)} ${theme.fg(
		success && !needsWarning ? "text" : "accent",
		titlePart,
	)}${agentTypeBadge(result.agent, theme)} ${formatBadge(statusText, iconColor, theme)}`;
	const showBadge = settings.get("task.showResolvedModelBadge");
	statusLine = appendAgentStats(
		statusLine,
		{
			tokens: result.tokens,
			requests: result.requests,
			contextTokens: result.contextTokens,
			contextWindow: result.contextWindow,
			cost: result.usage?.cost.total ?? 0,
			resolvedModel: result.resolvedModel,
			showResolvedModelBadge: showBadge,
		},
		theme,
	);
	statusLine += `${theme.sep.dot}${theme.fg("dim", formatDuration(result.durationMs))}`;

	if (result.truncated) {
		statusLine += ` ${theme.fg("warning", "[truncated]")}`;
	}

	lines.push(statusLine);

	lines.push(...renderTaskSection(result.assignment ?? result.task, continuePrefix, expanded, theme));

	const modelReceiptLine = renderModelReceipt(result.modelReceipt, continuePrefix, theme);
	if (modelReceiptLine) lines.push(modelReceiptLine);

	if (aborted && result.abortReason) {
		lines.push(
			`${continuePrefix}${theme.fg("error", theme.status.aborted)} ${theme.fg(
				"dim",
				previewLine(sanitizeText(result.abortReason), 80),
			)}`,
		);
	}
	// Check for review result from incremental yield sections.
	// `normalizeYieldData` guards against a stray non-array `yield` slot —
	// optional chaining on `.map` only short-circuits on null/undefined and
	// would otherwise crash the renderer with `TypeError: completeData?.map
	// is not a function` when the slot is a plain object (see issue #1987).
	const completeData = normalizeYieldData(result.extractedToolData?.yield);
	const incrementalReview = extractIncrementalReviewResult(completeData);

	if (incrementalReview) {
		lines.push(
			...renderReviewResult(incrementalReview.summary, incrementalReview.findings, continuePrefix, expanded, theme),
		);
		return lines;
	}

	// Extract review verdict from legacy yield summary objects if present.
	const reviewData = completeData
		.map(c => c.data as SubmitReviewDetails)
		.filter(d => d && typeof d === "object" && "overall_correctness" in d);
	const submitReviewData = reviewData.length > 0 ? reviewData : undefined;

	if (submitReviewData) {
		const summary = submitReviewData[submitReviewData.length - 1];
		const findings: FindingDetails[] = [];
		lines.push(...renderReviewResult(summary, findings, continuePrefix, expanded, theme));
		return lines;
	}

	// Check for extracted tool data with custom renderers (skip review tools)
	let hasCustomRendering = false;
	const deferredToolLines: string[] = [];
	if (result.extractedToolData) {
		for (const toolName in result.extractedToolData) {
			const dataArray = result.extractedToolData[toolName];
			if (toolName === "yield") {
				const yieldLines = renderTypedYieldSections(dataArray, continuePrefix, expanded, theme);
				if (yieldLines.length > 0) {
					hasCustomRendering = true;
					lines.push(...yieldLines);
				}
				continue;
			}

			const isTaskTool = toolName === "task";
			if (isTaskTool && (dataArray as unknown[]).length > 0) {
				for (const line of renderNestedTaskResults(
					dataArray as TaskToolDetails[],
					expanded,
					theme,
					seenNestedTasks,
					nestedDepth,
				)) {
					deferredToolLines.push(`${continuePrefix}${line}`);
				}
				continue;
			}

			const handler = subprocessToolRegistry.getHandler(toolName);
			if (handler?.renderFinal && (dataArray as unknown[]).length > 0) {
				const component = handler.renderFinal(dataArray as unknown[], theme, expanded);
				const target = lines;
				if (!isTaskTool) {
					hasCustomRendering = true;
					target.push(`${continuePrefix}${theme.fg("dim", `Tool: ${toolName}`)}`);
				}
				if (component instanceof Text) {
					// Prefix each line with continuePrefix
					const text = component.getText();
					for (const line of text.split("\n")) {
						target.push(`${continuePrefix}${line}`);
					}
				} else if (component instanceof Container) {
					// For containers, render each child
					for (const child of (component as Container).children) {
						if (child instanceof Text) {
							target.push(`${continuePrefix}${child.getText()}`);
						}
					}
				}
			}
		}
	}

	if (hasCustomRendering && missingCompleteWarning) {
		lines.push(
			`${continuePrefix}${theme.fg("warning", theme.status.warning)} ${theme.fg(
				"dim",
				truncateToWidth(sanitizeText(missingCompleteWarning), 80),
			)}`,
		);
	}

	// Fallback to output preview if no custom rendering
	if (!hasCustomRendering) {
		lines.push(
			...renderOutputSection(outputWithoutWarning, continuePrefix, expanded, theme, 3, 12, missingCompleteWarning),
		);
	}

	if (deferredToolLines.length > 0) {
		lines.push(...deferredToolLines);
	}

	if (result.patchPath && !aborted && result.exitCode === 0) {
		lines.push(`${continuePrefix}${theme.fg("dim", `Patch: ${result.patchPath}`)}`);
	} else if (result.branchName && !aborted && result.exitCode === 0) {
		lines.push(`${continuePrefix}${theme.fg("dim", `Branch: ${result.branchName}`)}`);
	}

	// Error message
	if (result.error && (!success || mergeFailed) && (!aborted || result.error !== result.abortReason)) {
		lines.push(
			`${continuePrefix}${theme.fg(mergeFailed ? "warning" : "error", previewLine(sanitizeText(result.error), 70))}`,
		);
	}

	return lines;
}

/**
 * Order live progress entries so finished agents render first — sorted by
 * runtime ascending, matching {@link orderResultsForDisplay} — while
 * unfinished (pending/running) ones stay pinned at the bottom in dispatch
 * order. Because a finished agent's runtime is fixed, finalization renders
 * the same order and rows never reshuffle.
 */
function orderProgressForDisplay(progress: readonly AgentProgress[]): AgentProgress[] {
	const finished: AgentProgress[] = [];
	const unfinished: AgentProgress[] = [];
	for (const p of progress) {
		(p.status === "pending" || p.status === "running" ? unfinished : finished).push(p);
	}
	finished.sort((a, b) => a.durationMs - b.durationMs || a.index - b.index);
	return finished.concat(unfinished);
}

/**
 * Order finalized results by runtime ascending (tie-break: dispatch index) so
 * the finalized list matches the live-progress order produced by
 * {@link orderProgressForDisplay}.
 */
function orderResultsForDisplay(results: readonly SingleResult[]): SingleResult[] {
	return [...results].sort((a, b) => a.durationMs - b.durationMs || a.index - b.index);
}

/**
 * Summary line for progress rows folded away by the collapsed cap: per-status
 * counts plus the expand hint, e.g. `… 21 more agents (18 pending · 3 done)`.
 */
function formatHiddenProgressLine(hidden: readonly AgentProgress[], theme: Theme): string {
	const counts: Record<AgentProgress["status"], number> = {
		pending: 0,
		running: 0,
		completed: 0,
		failed: 0,
		aborted: 0,
	};
	for (const p of hidden) counts[p.status]++;
	const parts: string[] = [];
	if (counts.completed > 0) parts.push(theme.fg("dim", `${counts.completed} done`));
	if (counts.running > 0) parts.push(theme.fg("dim", `${counts.running} running`));
	if (counts.pending > 0) parts.push(theme.fg("dim", `${counts.pending} pending`));
	if (counts.failed > 0) parts.push(theme.fg("error", `${counts.failed} failed`));
	if (counts.aborted > 0) parts.push(theme.fg("error", `${counts.aborted} aborted`));
	const breakdown =
		parts.length > 0
			? `${theme.fg("dim", " (")}${parts.join(theme.fg("dim", theme.sep.dot))}${theme.fg("dim", ")")}`
			: "";
	const hint = formatExpandHint(theme, false, true);
	return `${theme.fg("dim", formatMoreItems(hidden.length, "agent"))}${breakdown}${hint ? ` ${hint}` : ""}`;
}

/**
 * Pick the agent rows that stay visible when a finalized batch is collapsed:
 * problem rows (aborted/failed/merge-failed) claim slots first so they are
 * never folded away, then fastest finishers fill the remainder. The pick is
 * filtered out of the display order, so visible rows keep the expanded layout.
 */
function selectCollapsedResults(ordered: readonly SingleResult[]): readonly SingleResult[] {
	if (ordered.length <= COLLAPSED_AGENT_LIMIT) return ordered;
	const picked = new Set<SingleResult>();
	for (const result of ordered) {
		if (picked.size >= COLLAPSED_AGENT_LIMIT) break;
		if (result.aborted || result.exitCode !== 0 || result.error) picked.add(result);
	}
	for (const result of ordered) {
		if (picked.size >= COLLAPSED_AGENT_LIMIT) break;
		picked.add(result);
	}
	return ordered.filter(result => picked.has(result));
}

/**
 * Render the tool result.
 */
export function renderResult(
	result: { content: Array<{ type: string; text?: string }>; details?: TaskToolDetails; isError?: boolean },
	options: TaskRenderOptions,
	theme: Theme,
	args?: TaskParams,
): Component {
	const fallbackText = result.content.find(c => c.type === "text")?.text ?? "";
	const details = result.details;
	const agentLabel = formatAgentHeaderLabel(args);
	const assignmentSection = createAssignmentSectionRenderer(args, theme);
	const contextSection = createContextSectionRenderer(args, theme);

	if (!details) {
		const text = result.content.find(c => c.type === "text")?.text || "";
		const errored = result.isError === true;
		const header = errored
			? renderStatusLine({ icon: "error", title: "Task", description: agentLabel }, theme)
			: renderStatusLine(
					{
						iconOverride: theme.styledSymbol("status.done", "accent"),
						title: "Task",
						description: agentLabel,
					},
					theme,
				);
		return framedBlock(theme, width => ({
			header,
			sections: [
				...(contextSection ? [contextSection(width)] : []),
				...(assignmentSection ? [assignmentSection(width)] : []),
				...(text ? [{ separator: true, lines: [theme.fg("dim", truncateToWidth(text, width))] }] : []),
			],
			state: errored ? "error" : "success",
			borderColor: errored ? "error" : "borderMuted",
			width,
		}));
	}

	const hasResults = Boolean(details.results && details.results.length > 0);
	// Single pass over details.results derives the header booleans AND the footer
	// counts/totals. This block re-runs ~30×/sec via the 33ms spinner render; the
	// previous form did 3× `.some()` here plus 3× `.filter()` + `.reduce()` again
	// inside the frame below (7+ full passes per tick).
	let abortedCount = 0;
	let failCount = 0;
	let mergeFailedCount = 0;
	let successCount = 0;
	let requestTotal = 0;
	if (hasResults) {
		for (const r of details.results) {
			requestTotal += r.requests ?? 0;
			if (r.aborted) abortedCount++;
			else if (r.exitCode !== 0) failCount++;
			else if (r.error) mergeFailedCount++;
			else successCount++;
		}
	}
	const aborted = abortedCount > 0;
	const failed = failCount > 0;
	const mergeFailed = mergeFailedCount > 0;
	const isError = aborted || failed;
	const agentCount = hasResults ? details.results.length : (details.progress?.length ?? 0);
	const icon: ToolUIStatus = options.isPartial ? "running" : isError ? "error" : mergeFailed ? "warning" : "success";
	// Header meta is the spawn count only; each row carries its own ⟨agent⟩
	// badge, so a joined type list here would repeat them. Before anything
	// spawns, fall back to the flat form's agent type from the call args.
	const countLabel = agentCount > 0 ? `${agentCount} ${agentCount === 1 ? "agent" : "agents"}` : undefined;
	const metaLabel = countLabel ?? agentLabel;
	const header = renderStatusLine(
		{
			icon: icon === "success" || icon === "running" ? undefined : icon,
			// While agents are in flight the header shows the dispatch glyph, not a
			// spinner: async spawns return immediately, so "running" means
			// "delegated to peers", not "this call is blocking the turn".
			iconOverride:
				icon === "running"
					? theme.styledSymbol("tool.task", "accent")
					: icon === "success"
						? theme.styledSymbol("status.done", "accent")
						: undefined,
			title: "Task",
			meta: metaLabel ? [metaLabel] : undefined,
		},
		theme,
	);

	return framedBlock(theme, width => {
		const { expanded, isPartial, spinnerFrame } = options;
		const frozen = options.renderContext?.frozen === true;
		const nowMs = options.renderContext?.nowMs ?? Date.now();
		const lines: string[] = [];

		// Result rows win once any exist; progress rows for spawns without a
		// result (a mixed call's async subset) render as a supplement below.
		const shouldRenderProgress =
			Boolean(details.progress && details.progress.length > 0) && details.results.length === 0;
		if (shouldRenderProgress && details.progress) {
			const ordered = orderProgressForDisplay(details.progress);
			// Collapsed view keeps the live edge: finished rows sort to the top of
			// the display order, so folding from the top keeps running/pending
			// agents (and their current-tool lines) visible while one summary line
			// stands in for everything above it.
			const visible = expanded ? ordered : ordered.slice(Math.max(0, ordered.length - COLLAPSED_AGENT_LIMIT));
			if (visible.length < ordered.length) {
				lines.push(formatHiddenProgressLine(ordered.slice(0, ordered.length - visible.length), theme));
			}
			for (const progress of visible) {
				lines.push(
					...renderAgentProgress(progress, "", "  ", expanded, theme, spinnerFrame, frozen, undefined, 0, nowMs),
				);
			}
		} else if (details.results && details.results.length > 0) {
			const ordered = orderResultsForDisplay(details.results);
			const visible = expanded ? ordered : selectCollapsedResults(ordered);
			for (const res of visible) {
				lines.push(...renderAgentResult(res, "", "  ", expanded, theme));
			}
			if (visible.length < ordered.length) {
				const hint = formatExpandHint(theme, false, true);
				lines.push(
					`${theme.fg("dim", formatMoreItems(ordered.length - visible.length, "agent"))}${hint ? ` ${hint}` : ""}`,
				);
			}

			// Mixed blocking+async call: async spawns never land in `results`
			// (their payloads deliver through jobs) — keep their rows visible
			// beside the finalized inline results, live while running and
			// settled once their jobs finish.
			const supplementalProgress = details.progress
				? orderProgressForDisplay(
						details.progress.filter(progress => !details.results.some(res => res.id === progress.id)),
					)
				: [];
			for (const progress of supplementalProgress) {
				lines.push(
					...renderAgentProgress(progress, "", "  ", expanded, theme, spinnerFrame, frozen, undefined, 0, nowMs),
				);
			}

			const summaryParts: string[] = [];
			if (abortedCount > 0) summaryParts.push(theme.fg("error", `${abortedCount} aborted`));
			if (successCount > 0) summaryParts.push(theme.fg("success", `${successCount} succeeded`));
			if (mergeFailedCount > 0) summaryParts.push(theme.fg("warning", `${mergeFailedCount} merge failed`));
			if (failCount > 0) summaryParts.push(theme.fg("error", `${failCount} failed`));
			const totalRequests = requestTotal;
			if (totalRequests > 0) summaryParts.push(theme.fg("dim", `${formatNumber(totalRequests)} req`));
			summaryParts.push(theme.fg("dim", formatDuration(details.totalDurationMs)));
			// Wrap the run summary in the theme's bracket glyphs (dim chrome, colored
			// counts) to match the bash tool's `[Wall: … | Exit: …]` footer.
			lines.push(
				theme.fg("dim", theme.format.bracketLeft) +
					summaryParts.join(theme.fg("dim", theme.sep.dot)) +
					theme.fg("dim", theme.format.bracketRight),
			);
		}

		const state = isPartial ? "running" : isError ? "error" : mergeFailed ? "warning" : "success";
		const borderColor = isError ? "error" : "borderMuted";

		if (lines.length === 0) {
			const text = fallbackText.trim() ? fallbackText : "No results";
			return {
				header,
				sections: [
					...(contextSection ? [contextSection(width)] : []),
					...(assignmentSection ? [assignmentSection(width)] : []),
					{ separator: true, lines: [theme.fg("dim", truncateToWidth(text, width))] },
				],
				state,
				borderColor,
				width,
			};
		}

		if (fallbackText.trim()) {
			const summaryLines = fallbackText.split("\n");
			const markerIndex = summaryLines.findIndex(
				line =>
					line.includes("<system-notification>") ||
					line.startsWith("Applied patches:") ||
					line.startsWith("No changes to apply."),
			);
			if (markerIndex >= 0) {
				const extra = summaryLines.slice(markerIndex);
				for (const line of extra) {
					if (!line.trim()) continue;
					lines.push(theme.fg("dim", line));
				}
			}
		}

		while (lines.length > 0 && lines[0].trim() === "") lines.shift();
		return {
			header,
			sections: [
				...(contextSection ? [contextSection(width)] : []),
				...(assignmentSection ? [assignmentSection(width)] : []),
				...(lines.length > 0 ? [{ separator: true, lines }] : []),
			],
			state,
			borderColor,
			width,
		};
	});
}

function isTaskToolDetails(value: unknown): value is TaskToolDetails {
	return (
		Boolean(value) &&
		typeof value === "object" &&
		"results" in (value as TaskToolDetails) &&
		Array.isArray((value as TaskToolDetails).results)
	);
}

// Nested subagent snapshots sit one or more levels below the frame border, so
// they keep tree guides to convey depth (the parent prepends its own continue
// prefix). Only the top-level agent list drops guides (the frame is its box).
function nestedMarkers(isLast: boolean, theme: Theme): { prefix: string; continuePrefix: string } {
	return {
		prefix: isLast ? theme.fg("dim", theme.tree.last) : theme.fg("dim", theme.tree.branch),
		continuePrefix: isLast ? "   " : `${theme.fg("dim", theme.tree.vertical)}  `,
	};
}

function renderNestedTaskResults(
	detailsList: TaskToolDetails[],
	expanded: boolean,
	theme: Theme,
	seen: WeakSet<object> = new WeakSet<object>(),
	depth = 0,
): string[] {
	const lines: string[] = [];
	for (const details of detailsList) {
		if (seen.has(details)) {
			lines.push(renderNestedCycleLine(theme));
			continue;
		}
		if (depth >= MAX_NESTED_TASK_RENDER_DEPTH) {
			lines.push(theme.fg("dim", "… nested task depth limit reached"));
			continue;
		}
		seen.add(details);
		if (!details.results || details.results.length === 0) {
			seen.delete(details);
			continue;
		}
		const ordered = orderResultsForDisplay(details.results);
		const visible = expanded ? ordered : selectCollapsedResults(ordered);
		const hiddenCount = ordered.length - visible.length;
		visible.forEach((result, index) => {
			const { prefix, continuePrefix } = nestedMarkers(hiddenCount === 0 && index === visible.length - 1, theme);
			lines.push(...renderAgentResult(result, prefix, continuePrefix, expanded, theme, seen, depth + 1));
		});
		if (hiddenCount > 0) {
			const { prefix } = nestedMarkers(true, theme);
			lines.push(`${prefix} ${theme.fg("dim", formatMoreItems(hiddenCount, "agent"))}`);
		}
		seen.delete(details);
	}
	return lines;
}

/**
 * Render a list of `TaskToolDetails` snapshots — completed (`results[]`) or
 * in-flight (`progress[]`) — as an interleaved tree. Used by the live progress
 * view to surface nested subagent activity while this agent is still running.
 */
function renderNestedTaskTree(
	detailsList: TaskToolDetails[],
	expanded: boolean,
	theme: Theme,
	spinnerFrame?: number,
	frozen = false,
	seen: WeakSet<object> = new WeakSet<object>(),
	depth = 0,
	nowMs = Date.now(),
): string[] {
	const lines: string[] = [];
	for (const details of detailsList) {
		if (seen.has(details)) {
			lines.push(renderNestedCycleLine(theme));
			continue;
		}
		if (depth >= MAX_NESTED_TASK_RENDER_DEPTH) {
			lines.push(theme.fg("dim", "… nested task depth limit reached"));
			continue;
		}
		seen.add(details);
		const hasResults = Boolean(details.results && details.results.length > 0);
		if (hasResults) {
			const ordered = orderResultsForDisplay(details.results);
			const visible = expanded ? ordered : selectCollapsedResults(ordered);
			const hiddenCount = ordered.length - visible.length;
			visible.forEach((result, index) => {
				const { prefix, continuePrefix } = nestedMarkers(hiddenCount === 0 && index === visible.length - 1, theme);
				lines.push(...renderAgentResult(result, prefix, continuePrefix, expanded, theme, seen, depth + 1));
			});
			if (hiddenCount > 0) {
				const { prefix } = nestedMarkers(true, theme);
				lines.push(`${prefix} ${theme.fg("dim", formatMoreItems(hiddenCount, "agent"))}`);
			}
			seen.delete(details);
			continue;
		}
		const inflight = details.progress;
		if (inflight && inflight.length > 0) {
			const ordered = orderProgressForDisplay(inflight);
			const visible = expanded ? ordered : ordered.slice(Math.max(0, ordered.length - COLLAPSED_AGENT_LIMIT));
			const hiddenCount = ordered.length - visible.length;
			visible.forEach((prog, index) => {
				const { prefix, continuePrefix } = nestedMarkers(hiddenCount === 0 && index === visible.length - 1, theme);
				lines.push(
					...renderAgentProgress(
						prog,
						prefix,
						continuePrefix,
						expanded,
						theme,
						spinnerFrame,
						frozen,
						seen,
						depth + 1,
						nowMs,
					),
				);
			});
			if (hiddenCount > 0) {
				const { prefix } = nestedMarkers(true, theme);
				lines.push(`${prefix} ${theme.fg("dim", formatMoreItems(hiddenCount, "agent"))}`);
			}
		}
		seen.delete(details);
	}
	return lines;
}

// Register task tool subprocess handler
subprocessToolRegistry.register<TaskToolDetails>("task", {
	extractData: event => {
		const details = event.result?.details;
		return isTaskToolDetails(details) ? details : undefined;
	},
	renderFinal: (allData, theme, expanded) => {
		const lines = renderNestedTaskResults(allData, expanded, theme);
		return new Text(lines.join("\n"), 0, 0);
	},
});
