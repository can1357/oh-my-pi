import type { Usage } from "@oh-my-pi/pi-ai";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { ThemeColor } from "../theme/theme";
import type { ConfiguredThinkingLevel } from "../render/render-utils";
import type { ToolRenderer } from "./renderer";
/**
 * TUI rendering for task tool.
 *
 * Provides renderCall and renderResult functions for displaying
 * task execution in the terminal UI.
 */
import * as path from "node:path";
import { Container, type Component } from "../tui";
import { Markdown } from "../components/markdown";
import { Text } from "../components/text";
import { visibleWidth, wrapTextWithAnsi } from "../utils";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { RenderResultOptions } from "./renderer";
import { formatAgentStatRun, renderAgentTreeRow } from "./agent-tree";
import { getMarkdownTheme, type Theme } from "../theme/theme";
import { stripGeneratedOutputNotice, stripRawOutputArtifactNotice, stripTrailingNotice } from "./output-meta";
import {
	capPreviewLines,
	FEED_MODEL_BADGE_WIDTH,
	formatBadge,
	formatDuration,
	formatExpandHint,
	formatFeedModelBadge,
	formatMoreItems,
	formatNumber,
	isFeedModelBadgeEnabled,
	previewLine,
	previewWindowRows,
	replaceTabs,
	shortenPath,
	type ToolUIStatus,
	TRUNCATE_LENGTHS,
	truncateToWidth,
} from "../render/render-utils";
import { renderStatusLine } from "../render/index";
import { framedToolCard } from "../render/tool-card";
import { formatOutputInline, renderJsonTreeLines } from "./json-tree";
import { repairDoubleEncodedJsonString } from "./task-repair-args";
import { getSubprocessToolRenderer } from "./subprocess";
import { assembleYieldResult } from "./task-yield-assembly";

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
	if (typeof item.data === "string") return previewLine(sanitizeText(item.data), 70);
	try {
		return previewLine(sanitizeText(JSON.stringify(item.data) ?? "null"), 70);
	} catch {
		return previewLine(sanitizeText(String(item.data)), 70);
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

/** Formats sanitized task identifiers as hierarchy breadcrumbs. */
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

const BASH_WALL_TIME_NOTICE_RE = /^Wall time: \d+(?:\.\d+)? seconds$/u;
const BASH_EXIT_CODE_NOTICE_RE = /^Command exited with code -?\d+$/u;

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
		const withoutRuntimeNotice = stripTrailingNotice(
			text,
			line => BASH_WALL_TIME_NOTICE_RE.test(line) || BASH_EXIT_CODE_NOTICE_RE.test(line),
		);
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
					lines.push(`${continuePrefix}  ${theme.fg("dim", formatOutputInline(parsed))}`);
					return lines;
				}

				const tree = renderJsonTreeLines(parsed, theme, {
					maxDepth: expanded ? 6 : 2,
					maxLines: expanded ? 24 : 6,
					maxScalarLen: 70,
					sanitizeText,
					hiddenRootKeys: [],
					multilineStrings: true,
					rootConnectors: "siblings",
					escapeStringWhitespace: false,
				});
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
				lines.push(`${continuePrefix}${theme.fg("dim", formatOutputInline(parsed))}`);
				return lines;
			}

			// Expanded: tree format
			lines.push(`${continuePrefix}${theme.fg("dim", "Output")}`);
			const tree = renderJsonTreeLines(parsed, theme, {
				maxDepth: expanded ? 6 : 2,
				maxLines: expanded ? 24 : 6,
				maxScalarLen: 70,
				sanitizeText,
				hiddenRootKeys: [],
				multilineStrings: true,
				rootConnectors: "siblings",
				escapeStringWhitespace: false,
			});
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
type TaskRenderSection = { label?: string; content: readonly string[]; separator?: boolean };
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
	return width => ({ content: markdown.render(Math.max(1, width - ASSIGNMENT_FRAME_INSET)) });
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
	return framedToolCard(theme, ({ width }) => {
		const sections: TaskRenderSection[] = [];

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
			if (callLines.length > 0) sections.push({ separator: true, content: callLines });
		}

		return {
			header,
			headerMeta: showIsolated ? "isolated" : undefined,
			sections,
			phase: "pending",
			borderColor: "borderMuted",
		};
	});
}

function truncateTaskRow(text: string, width: number, ellipsis?: ""): string {
	return Number.isFinite(width) ? truncateToWidth(text, width, ellipsis) : text;
}

function renderDescriptionLines(description: string, prefix: string, width: number, theme: Theme): string[] {
	if (!Number.isFinite(width)) return description.split("\n").map(line => `${prefix}${theme.fg("dim", line)}`);
	const boundedPrefix = truncateToWidth(prefix, Math.max(0, width - 1), "");
	const contentWidth = Math.max(1, width - visibleWidth(boundedPrefix));
	return wrapTextWithAnsi(description, contentWidth).map(line => `${boundedPrefix}${theme.fg("dim", line)}`);
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
	maxWidth = Number.POSITIVE_INFINITY,
): string[] {
	const lines: string[] = [];

	const fullDescription = progress.description ? replaceTabs(sanitizeText(progress.description)).trim() : undefined;
	let statusBadge: string | undefined;
	if ((progress.retryState ?? progress.providerRetryState) && progress.status === "running") {
		statusBadge = ` ${formatBadge("retrying", "warning", theme)}`;
	} else if (progress.retryFailure && (progress.status === "failed" || progress.status === "aborted")) {
		statusBadge = ` ${formatBadge("rate-limited", "error", theme)}`;
	}
	const row = renderAgentTreeRow(
		{
			presentation: "task",
			status: progress.status,
			prefix,
			id: formatTaskId(progress.id),
			width: maxWidth,
			model: progress.resolvedModelIdentity ?? progress.resolvedModel,
			thinkingLevel: progress.resolvedThinkingLevel,
			advisor: progress.advisor,
			spinnerFrame,
			frozen,
			roleBadge: agentTypeBadge(progress.agent, theme),
			statusBadge,
			description: fullDescription,
			preview:
				progress.status === "running" && !fullDescription
					? ` ${theme.fg("muted", previewLine(sanitizeText(progress.assignment ?? progress.task), 40))}`
					: undefined,
			stats: progress.status === "running" || progress.status === "completed" ? progress : undefined,
		},
		theme,
	);
	lines.push(row.line);
	if (fullDescription && !row.descriptionShown) {
		lines.push(...renderDescriptionLines(fullDescription, continuePrefix, maxWidth, theme));
	}

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
	} else if (progress.providerRetryState && progress.status === "running") {
		const state = progress.providerRetryState;
		const remainingMs = Math.max(0, state.startedAtMs + state.delayMs - nowMs);
		const waitLabel = remainingMs > 0 ? `in ${formatDuration(remainingMs)}` : "now";
		const count =
			state.attempt !== undefined && state.maxAttempts !== undefined ? ` ${state.attempt}/${state.maxAttempts}` : "";
		const summary = `provider retrying${count} ${waitLabel}: ${previewLine(sanitizeText(state.model), 60)}`;
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

			const handler = getSubprocessToolRenderer(toolName);
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
			Math.max(0, maxWidth - visibleWidth(continuePrefix)),
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
	maxWidth = Number.POSITIVE_INFINITY,
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

	// Reserve the name and required badges before optional model metadata and details.
	const fullDescription = result.description ? replaceTabs(sanitizeText(result.description)).trim() : undefined;
	const indent = prefix ? `${prefix} ` : "";
	const statusBadge = ` ${formatBadge(statusText, iconColor, theme)}`;
	const displayId = truncateTaskRow(
		formatTaskId(result.id),
		Math.max(0, maxWidth - visibleWidth(`${indent}${icon} ${statusBadge}`)),
	);
	const roleBadge = truncateTaskRow(
		agentTypeBadge(result.agent, theme),
		Math.max(0, maxWidth - visibleWidth(`${indent}${icon} ${displayId}${statusBadge}`)),
	);
	const badges = `${roleBadge}${statusBadge}`;
	const modelBadge = isFeedModelBadgeEnabled()
		? formatFeedModelBadge(
				result.resolvedModelIdentity ?? result.resolvedModel,
				result.resolvedThinkingLevel,
				result.advisor,
				theme,
				Math.min(
					FEED_MODEL_BADGE_WIDTH,
					Math.max(0, maxWidth - visibleWidth(`${indent}${icon} ${displayId}${badges}`) - 1),
				),
			)
		: "";
	const modelLead = modelBadge ? `${modelBadge} ` : "";
	const description =
		fullDescription &&
		visibleWidth(`${indent}${icon} ${modelLead}${displayId}: ${fullDescription}${badges}`) <= maxWidth
			? fullDescription
			: undefined;
	const titlePart = description ? `${theme.bold(displayId)}: ${description}` : displayId;
	let statusLine = `${indent}${theme.fg(iconColor, icon)} ${modelLead}${theme.fg(
		success && !needsWarning ? "text" : "accent",
		titlePart,
	)}${badges}`;
	statusLine += formatAgentStatRun(
		{
			requests: result.requests,
			contextTokens: result.contextTokens,
			contextWindow: result.contextWindow,
			cost: result.usage?.cost.total ?? 0,
		},
		theme,
	);
	statusLine += `${theme.sep.dot}${theme.fg("dim", formatDuration(result.durationMs))}`;

	if (result.truncated) {
		statusLine += ` ${theme.fg("warning", "[truncated]")}`;
	}

	lines.push(truncateTaskRow(statusLine, maxWidth, ""));
	if (fullDescription && !description) {
		lines.push(...renderDescriptionLines(fullDescription, continuePrefix, maxWidth, theme));
	}

	lines.push(...renderTaskSection(result.assignment ?? result.task, continuePrefix, expanded, theme));

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
					Math.max(0, maxWidth - visibleWidth(continuePrefix)),
				)) {
					deferredToolLines.push(`${continuePrefix}${line}`);
				}
				continue;
			}

			const handler = getSubprocessToolRenderer(toolName);
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

	// Artifact rows: paths shortened (home → `~`), tabs expanded, and width-bounded
	// like every other rendered line; the full paths live in the model-facing summary.
	// A nested-only run still carries its (empty) root patch path, so hide that
	// row when the runner reports no root changes — same as the model summary.
	if (result.patchPath && result.hasRootChanges !== false && !aborted && result.exitCode === 0) {
		lines.push(
			`${continuePrefix}${theme.fg("dim", truncateToWidth(`Patch: ${replaceTabs(shortenPath(result.patchPath))}`, TRUNCATE_LENGTHS.CONTENT))}`,
		);
	} else if (result.branchName && !aborted && result.exitCode === 0) {
		lines.push(
			`${continuePrefix}${theme.fg("dim", truncateToWidth(`Branch: ${replaceTabs(sanitizeText(result.branchName))}`, TRUNCATE_LENGTHS.CONTENT))}`,
		);
	}
	if (!aborted && result.exitCode === 0) {
		for (const nestedPath of result.nestedPatchPaths ?? []) {
			lines.push(
				`${continuePrefix}${theme.fg("dim", truncateToWidth(`Nested patch: ${replaceTabs(shortenPath(nestedPath))}`, TRUNCATE_LENGTHS.CONTENT))}`,
			);
		}
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
		return framedToolCard(theme, ({ width }) => ({
			header,
			sections: [
				...(contextSection ? [contextSection(width)] : []),
				...(assignmentSection ? [assignmentSection(width)] : []),
				...(text ? [{ separator: true, content: [theme.fg("dim", truncateToWidth(text, width))] }] : []),
			],
			phase: errored ? "error" : "success",
			borderColor: errored ? "error" : "borderMuted",
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

	return framedToolCard(theme, ({ width, contentWidth }) => {
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
					...renderAgentProgress(
						progress,
						"",
						"  ",
						expanded,
						theme,
						spinnerFrame,
						frozen,
						undefined,
						0,
						nowMs,
						contentWidth,
					),
				);
			}
		} else if (details.results && details.results.length > 0) {
			const ordered = orderResultsForDisplay(details.results);
			const visible = expanded ? ordered : selectCollapsedResults(ordered);
			for (const res of visible) {
				lines.push(...renderAgentResult(res, "", "  ", expanded, theme, undefined, 0, contentWidth));
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
					...renderAgentProgress(
						progress,
						"",
						"  ",
						expanded,
						theme,
						spinnerFrame,
						frozen,
						undefined,
						0,
						nowMs,
						contentWidth,
					),
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

		const phase = isPartial ? "partial" : isError ? "error" : mergeFailed ? "warning" : "success";
		const borderColor = isError ? "error" : "borderMuted";

		if (lines.length === 0) {
			const text = fallbackText.trim() ? fallbackText : "No results";
			return {
				header,
				sections: [
					...(contextSection ? [contextSection(width)] : []),
					...(assignmentSection ? [assignmentSection(width)] : []),
					{ separator: true, content: [theme.fg("dim", truncateToWidth(text, width))] },
				],
				phase,
				borderColor,
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
				...(lines.length > 0 ? [{ separator: true, content: lines }] : []),
			],
			phase,
			borderColor,
		};
	});
}

/** Tests whether a persisted tool result carries a task snapshot. */
export function isTaskToolDetails(value: unknown): value is TaskToolDetails {
	return (
		Boolean(value) &&
		typeof value === "object" &&
		"results" in (value as TaskToolDetails) &&
		Array.isArray((value as TaskToolDetails).results)
	);
}

/**
 * Subagent ids visible on a task tool card, for click-to-focus hit-testing.
 * Reads `progress[]` (in-flight) and `results[]` (settled) defensively — card
 * details arrive as `unknown` through the tool-result pipeline — and recurses
 * into the same nested snapshots the card renders (`extractedToolData.task`
 * details plus the in-flight snapshot), so a click on a nested worker row
 * resolves to that worker instead of an outer agent. Callers intersect with
 * the live registry, which decides focusability and recency.
 */
export function taskCardAgentIds(details: unknown): string[] {
	if (typeof details !== "object" || details === null) return [];
	const ids: string[] = [];
	const seen = new Set<unknown>();
	const pushId = (item: unknown): void => {
		if (typeof item !== "object" || item === null || !("id" in item)) return;
		const id: unknown = item.id;
		if (typeof id === "string" && id.length > 0 && !ids.includes(id)) ids.push(id);
	};
	const collectDetails = (value: unknown, depth: number): void => {
		if (typeof value !== "object" || value === null || depth > MAX_NESTED_TASK_RENDER_DEPTH) return;
		if (seen.has(value)) return;
		seen.add(value);
		const record = value as { results?: unknown; progress?: unknown };
		collectList(record.results, depth);
		collectList(record.progress, depth);
	};
	const collectList = (value: unknown, depth: number): void => {
		if (!Array.isArray(value)) return;
		for (const item of value) {
			pushId(item);
			if (typeof item !== "object" || item === null || seen.has(item)) continue;
			seen.add(item);
			const record = item as { extractedToolData?: unknown; inflightTaskDetails?: unknown };
			const nested = record.extractedToolData;
			if (typeof nested === "object" && nested !== null && "task" in nested) {
				const tasks = (nested as { task?: unknown }).task;
				if (Array.isArray(tasks)) for (const task of tasks) collectDetails(task, depth + 1);
			}
			collectDetails(record.inflightTaskDetails, depth + 1);
		}
	};
	collectList("progress" in details ? details.progress : undefined, 0);
	collectList("results" in details ? details.results : undefined, 0);
	return ids;
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

/** Renders settled child-task snapshots with bounded recursion and cycle detection. */
export function renderNestedTaskResults(
	detailsList: TaskToolDetails[],
	expanded: boolean,
	theme: Theme,
	seen: WeakSet<object> = new WeakSet<object>(),
	depth = 0,
	maxWidth = Number.POSITIVE_INFINITY,
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
			lines.push(...renderAgentResult(result, prefix, continuePrefix, expanded, theme, seen, depth + 1, maxWidth));
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
	maxWidth = Number.POSITIVE_INFINITY,
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
				lines.push(
					...renderAgentResult(result, prefix, continuePrefix, expanded, theme, seen, depth + 1, maxWidth),
				);
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
						maxWidth,
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

/** Renders task calls and their live or settled agent results. */
export const taskToolRenderer = { renderCall, renderResult, mergeCallAndResult: true } satisfies ToolRenderer<
	TaskParams,
	TaskToolDetails
>;

/** Source of an agent definition */
export type AgentSource = "bundled" | "user" | "project";

/**
 * Enforcement policy for a structured subagent output schema.
 *
 * `permissive` preserves legacy retry-budget overrides; `strict` turns every
 * invalid final payload, including an exhausted retry override, into a failed
 * `schema_violation` result.
 */
export type StructuredSubagentSchemaMode = "permissive" | "strict";

/** Origin of the schema selected for a structured subagent invocation. */
export type StructuredSubagentSchemaSource = "caller" | "agent" | "session" | "none";

/** Final validation state of a structured subagent invocation. */
export type StructuredSubagentValidationStatus = "valid" | "invalid" | "unavailable";

/**
 * Parsed structured completion and its schema-validation metadata.
 *
 * `data` is present whenever a payload could be assembled or parsed, even when
 * strict validation rejects it. `error` explains unavailable or invalid
 * validation without requiring consumers to parse presentation text.
 */
export interface StructuredSubagentOutput {
	source: StructuredSubagentSchemaSource;
	mode: StructuredSubagentSchemaMode;
	status: StructuredSubagentValidationStatus;
	data?: unknown;
	error?: string;
}

/** Display cap for a normalized one-line label (roster line, registry `displayName`, prompt field). */
export const LABEL_MAX = 80;

/** Single task item. Fields are optional defensively: args stream in token by token. */
export interface TaskItem {
	/** Stable agent name; becomes the registry/IRC id. Default = generated AdjectiveNoun. */
	name?: string;
	/** Agent type to run this item (e.g. "scout"). Defaults to the spawn policy's default agent. */
	agent?: string;
	/** The work; required by the schema. */
	task?: string;
	/** Per-spawn thinking effort: lowest/middle/highest level the resolved model supports. Overrides the agent's default selector (e.g. `auto`). */
	effort?: "lo" | "med" | "hi";
	/** Caller-provided output schema; its presence overrides the selected agent's schema. */
	outputSchema?: unknown;
	/** Validation behavior for a caller-provided or inherited output schema. */
	schemaMode?: "permissive" | "strict";
	/** Eval-defined tool names exposed to this child. */
	tools?: string[];
	/** Run this spawn in an isolated worktree (batch form; flat form carries it top-level). */
	isolated?: boolean;
}

/**
 * Runtime params union over both wire shapes. The model sees exactly one shape
 * (`{ context, tasks[] }` when `task.batch` is on, `{ name?, agent?, task }`
 * otherwise); runtime stays permissive so internal callers and stale
 * transcripts using the flat form keep working under either setting.
 */
export interface TaskParams {
	/** Stable agent name (flat form). */
	name?: string;
	/** Agent type to spawn (flat form); omitted values resolve from the session spawn policy. */
	agent?: string;
	/** The work (flat form). */
	task?: string;
	/** Per-spawn thinking effort (flat form): lowest/middle/highest level the resolved model supports. */
	effort?: "lo" | "med" | "hi";
	/** Caller-provided output schema; its presence overrides the selected agent's schema. */
	outputSchema?: unknown;
	/** Validation behavior for a caller-provided or inherited output schema. */
	schemaMode?: "permissive" | "strict";
	/** Eval-defined tool names exposed to the flat-form child. */
	tools?: string[];
	/** Batch form (`task.batch`): one subagent per item. */
	tasks?: TaskItem[];
	/** Batch form: shared background prepended to every assignment; required by the batch schema. */
	context?: string;
	/** Run in an isolated worktree (flat form; per-item in batch form). */
	isolated?: boolean;
}

/**
 * One-line, length-capped label safe for a single roster line, a registry
 * `displayName`, or a system-prompt field. Collapses every run of whitespace
 * AND control/format characters — including U+0085 NEL, ESC/ANSI, and the
 * zero-width separators that `\s` misses — to a single space, then caps length.
 * So untrusted text (a generated task label, a peer activity gist) can neither
 * break the line, inject prompt structure, nor smuggle terminal escapes. Caps at
 * `max` characters (clamped to >= 1; default `LABEL_MAX`), appending an ellipsis when truncated.
 */
export function oneLineLabel(text: string, max = LABEL_MAX): string {
	const oneLine = text.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();
	const cap = Math.max(1, max);
	// Count/cut by code point, not UTF-16 code unit, so truncation can never
	// split an astral character into a lone surrogate.
	const chars = [...oneLine];
	return chars.length > cap ? `${chars.slice(0, cap - 1).join("")}…` : oneLine;
}

/** A code review finding reported by the reviewer agent */
export interface ReviewFinding {
	title: string;
	body: string;
	priority: number;
	confidence: number;
	file_path: string;
	line_start: number;
	line_end: number;
}

/** Review summary submitted by the reviewer agent */
export interface ReviewSummary {
	overall_correctness: "correct" | "incorrect";
	explanation: string;
	confidence: number;
}

/** Structured review data extracted from reviewer agent */
export interface ReviewData {
	findings: ReviewFinding[];
	summary?: ReviewSummary;
}

/** Details extracted from a subagent `yield` tool call for final-result assembly and task rendering. */
export interface YieldItem {
	data?: unknown;
	status?: "success" | "aborted";
	error?: string;
	/** A string label is terminal; a non-empty array of labels is incremental. */
	type?: string | string[];
	/** Resolve this yield's payload from the latest durable assistant text instead of `data`. */
	useLastTurn?: boolean;
	/** True when an incremental workpool yield completed every item in its batch. */
	complete?: boolean;
	/**
	 * Set by the in-tool yield validator when it exhausted its retry budget and
	 * accepted schema-invalid data anyway. The executor preserves that override
	 * during post-mortem validation.
	 */
	schemaOverridden?: boolean;
}

/** Progress tracking for a single agent */
export interface AgentProgress {
	index: number;
	id: string;
	agent: string;
	agentSource: AgentSource;
	status: "pending" | "running" | "completed" | "failed" | "aborted";
	task: string;
	assignment?: string;
	description?: string;
	lastIntent?: string;
	currentTool?: string;
	currentToolArgs?: string;
	currentToolStartMs?: number;
	recentTools: Array<{ tool: string; args: string; endMs: number }>;
	recentOutput: string[];
	toolCount: number;
	/** Count of assistant requests (assistant message_end events) across the run. Drives the soft request budget guard. */
	requests: number;
	/** Cumulative input + output + cacheWrite tokens across all turns. Excludes cacheRead (re-reads cached context every turn, making cumulative sum misleading). */
	tokens: number;
	/**
	 * Current per-turn context size: latest assistant message's `usage.totalTokens`.
	 * This is the number to compare against `contextWindow` — what compaction
	 * decides on, what the user typically reads as "how full is the context".
	 * Distinct from `tokens`, which is a lifetime billing-volume counter.
	 */
	contextTokens?: number;
	/** Model's context window in tokens, when known. Lets the UI render `<curr>/<window>` gauges. */
	contextWindow?: number;
	/** Cumulative billing cost in USD, accumulated incrementally from message_end events. */
	cost: number;
	durationMs: number;
	modelOverride?: string | string[];
	/** Explicit pre-expansion model role alias selected for this run. */
	modelRole?: string;
	/** Resolved model display string in the form `<provider>/<id>`, optionally suffixed with `:<thinkingLevel>` when the level was set explicitly. Undefined when the model could not be resolved. */
	resolvedModel?: string;
	/** Provider/id including routing, with no added thinking suffix. */
	resolvedModelIdentity?: string;
	/** Explicit thinking metadata; never inferred from the model identity. */
	resolvedThinkingLevel?: ConfiguredThinkingLevel;
	/** True when {@link resolvedModel} is the target of an active retry fallback (not the originally configured model). Lets observer-only UIs (collab guests, Agent Hub rows with no live session) flag the fallback and keep the provider. */
	resolvedModelIsFallback?: boolean;
	/** True when a live advisor was attached to this run's session, not merely enabled in settings. */
	advisor?: boolean;
	/** Data extracted by registered subprocess tool handlers (keyed by tool name) */
	extractedToolData?: Record<string, unknown[]>;
	/**
	 * Auto-retry state when the subagent is sleeping between provider retries
	 * (e.g. 429 rate-limit with retry-after). Cleared when the retry resolves
	 * or fails. Surfacing this to the parent prevents the task tool from
	 * looking indefinitely "in progress" when a child is actually blocked on
	 * provider quota.
	 */
	retryState?: {
		attempt: number;
		maxAttempts: number;
		delayMs: number;
		errorMessage: string;
		startedAtMs: number;
	};
	/**
	 * Provider-internal retry backoff the subagent is sleeping through (pi-ai's
	 * own stream retry, e.g. an Anthropic `retry-after`). Unlike `retryState`
	 * no turn was superseded and there is no error to quote — the model and
	 * the wait's correlation id identify it. Cleared when the matching
	 * `provider_retry_wait_end` arrives.
	 */
	providerRetryState?: {
		waitId: number;
		delayMs: number;
		model: string;
		startedAtMs: number;
		attempt?: number;
		maxAttempts?: number;
	};
	/**
	 * Terminal retry failure surfaced once the subagent gave up retrying
	 * (e.g. retry-after exceeded the cap, or all attempts exhausted). Carries
	 * the final error so the parent UI can render "blocked: rate-limited"
	 * instead of waiting for a status that never arrives.
	 */
	retryFailure?: {
		attempt: number;
		errorMessage: string;
	};
	/**
	 * Snapshot of the most recent `task` tool call's in-flight `TaskToolDetails`,
	 * captured from `tool_execution_update`. Lets the parent UI surface live
	 * nested-subagent progress while this agent is still inside its own `task`
	 * call. Cleared when the call ends — finalized data lives in
	 * `extractedToolData.task` after that.
	 */
	inflightTaskDetails?: TaskToolDetails;
}

/** Result from a single agent execution */
export interface SingleResult {
	index: number;
	id: string;
	agent: string;
	agentSource: AgentSource;
	task: string;
	assignment?: string;
	description?: string;
	lastIntent?: string;
	exitCode: number;
	output: string;
	stderr: string;
	truncated: boolean;
	/**
	 * Parsed structured completion and validation metadata, when this invocation
	 * selected an output schema or strict schema mode.
	 */
	structuredOutput?: StructuredSubagentOutput;
	durationMs: number;
	/** Cumulative input + output + cacheWrite tokens across all turns. Excludes cacheRead (re-reads cached context every turn, making cumulative sum misleading). */
	tokens: number;
	/** Count of assistant requests (assistant message_end events) across the run. */
	requests: number;
	/** Latest per-turn context size at task completion. See `AgentProgress.contextTokens`. */
	contextTokens?: number;
	/** Model's context window in tokens, when known. */
	contextWindow?: number;
	modelOverride?: string | string[];
	/** Explicit pre-expansion model role alias selected for this run. */
	modelRole?: string;
	/** Resolved model display string in the form `<provider>/<id>`, optionally suffixed with `:<thinkingLevel>` when the level was set explicitly. Omitted from tool-result JSON when undefined to keep wire payloads small. */
	resolvedModel?: string;
	/** Retains the unambiguous identity from {@link AgentProgress.resolvedModelIdentity}. */
	resolvedModelIdentity?: string;
	/** Retains {@link AgentProgress.resolvedThinkingLevel} after settlement. */
	resolvedThinkingLevel?: ConfiguredThinkingLevel;
	/** True when {@link resolvedModel} is the target of an active retry fallback. Mirrors {@link AgentProgress.resolvedModelIsFallback} onto the settled result. */
	resolvedModelIsFallback?: boolean;
	/** Retains {@link AgentProgress.advisor} after the advised session is disposed. */
	advisor?: boolean;
	error?: string;
	aborted?: boolean;
	abortReason?: string;
	/** Aggregated usage from the subprocess, accumulated incrementally from message_end events. */
	usage?: Usage;
	/** Output path for the task result */
	outputPath?: string;
	/**
	 * Ran inside an isolation worktree. Such agents are parked without a
	 * reviver once the worktree is torn down, so they are never resumable or
	 * messageable after the run — summaries must not suggest otherwise.
	 */
	isolated?: boolean;
	/** Patch path for isolated worktree output */
	patchPath?: string;
	/**
	 * Whether `patchPath` holds a non-empty root-repo diff. `false` when the
	 * agent's changes all live in nested repos (see `nestedPatchPaths`), so
	 * summaries do not claim the root patch captured anything.
	 */
	hasRootChanges?: boolean;
	/** Branch name for isolated branch-mode output */
	branchName?: string;
	/**
	 * Baseline commit SHA the task branch was created from. Passed to
	 * `mergeTaskBranches` so cherry-pick uses the inclusive range
	 * `branchBaseSha..branchName` and preserves every agent commit's message.
	 */
	branchBaseSha?: string;
	/** Nested repo patches to apply after parent merge */
	nestedPatches?: NestedRepoPatch[];
	/**
	 * On-disk copies of `nestedPatches`, one file per nested repo, written
	 * before the isolation workspace is torn down. The workspace is the only
	 * other copy of that work, so these paths are the durable record.
	 */
	nestedPatchPaths?: string[];
	/** Data extracted by registered subprocess tool handlers (keyed by tool name) */
	extractedToolData?: Record<string, unknown[]>;
	/**
	 * Terminal retry failure, when the subagent exited because the auto-retry
	 * loop gave up (retry-after exceeded the cap, or all attempts exhausted).
	 * Lets the parent task tool surface a "blocked: rate-limited" outcome
	 * instead of a generic failure.
	 */
	retryFailure?: {
		attempt: number;
		errorMessage: string;
	};
	/** Output metadata for agent:// URL integration */
	outputMeta?: { lineCount: number; charCount: number };
}

/** Tool details for TUI rendering */
export interface TaskToolDetails {
	projectAgentsDir: string | null;
	results: SingleResult[];
	totalDurationMs: number;
	/** Aggregated usage across all subagents. */
	usage?: Usage;
	outputPaths?: string[];
	progress?: AgentProgress[];
	async?: {
		state: "running" | "completed" | "failed";
		jobId: string;
		type: "task";
	};
}

/** Patch and baseline metadata for an isolated nested repository. */
export interface NestedRepoPatch {
	relativePath: string;
	patch: string;
}

/** Severity level of a review finding. */
export type FindingPriority = "P0" | "P1" | "P2" | "P3";

/** Severity ordering, glyph, and color for a review finding. */
export interface FindingPriorityInfo {
	ord: 0 | 1 | 2 | 3;
	symbol: "status.error" | "status.warning" | "status.info";
	color: ThemeColor;
}

const PRIORITY_INFO: Record<FindingPriority, FindingPriorityInfo> = {
	P0: { ord: 0, symbol: "status.error", color: "error" },
	P1: { ord: 1, symbol: "status.warning", color: "warning" },
	P2: { ord: 2, symbol: "status.warning", color: "muted" },
	P3: { ord: 3, symbol: "status.info", color: "accent" },
};

/** Review severity levels in descending priority. */
export const PRIORITY_LABELS: FindingPriority[] = ["P0", "P1", "P2", "P3"];

/** Tests whether a value is a supported review severity. */
export function isFindingPriority(value: unknown): value is FindingPriority {
	return value === "P0" || value === "P1" || value === "P2" || value === "P3";
}

/** Returns display metadata for a review severity. */
export function getPriorityInfo(priority: FindingPriority): FindingPriorityInfo {
	return PRIORITY_INFO[priority] ?? { ord: 3, symbol: "status.info", color: "muted" };
}
/** Validated source location and content of a review finding. */
export interface FindingDetails {
	title: string;
	body: string;
	priority: FindingPriority;
	confidence: number;
	file_path: string;
	line_start: number;
	line_end: number;
}

function normalizeFindingPriority(value: unknown): FindingPriority | undefined {
	if (isFindingPriority(value)) return value;
	if (value === 0) return "P0";
	if (value === 1) return "P1";
	if (value === 2) return "P2";
	if (value === 3) return "P3";
	return undefined;
}

/** Validates and normalizes a persisted review finding. */
export function parseFindingDetails(value: unknown): FindingDetails | undefined {
	if (!isRecord(value)) return undefined;

	const title = typeof value.title === "string" ? value.title : undefined;
	const body = typeof value.body === "string" ? value.body : undefined;
	const priority = normalizeFindingPriority(value.priority);
	const confidence =
		typeof value.confidence === "number" &&
		Number.isFinite(value.confidence) &&
		value.confidence >= 0 &&
		value.confidence <= 1
			? value.confidence
			: undefined;
	const filePath = typeof value.file_path === "string" && value.file_path.length > 0 ? value.file_path : undefined;
	const lineStart =
		typeof value.line_start === "number" && Number.isFinite(value.line_start) ? value.line_start : undefined;
	const lineEnd = typeof value.line_end === "number" && Number.isFinite(value.line_end) ? value.line_end : undefined;

	if (
		title === undefined ||
		body === undefined ||
		priority === undefined ||
		confidence === undefined ||
		filePath === undefined ||
		lineStart === undefined ||
		lineEnd === undefined
	) {
		return undefined;
	}

	return {
		title,
		body,
		priority,
		confidence,
		file_path: filePath,
		line_start: lineStart,
		line_end: lineEnd,
	};
}
/** SubmitReviewDetails - used for rendering review results from yield tool */
export interface SubmitReviewDetails {
	overall_correctness: "correct" | "incorrect";
	explanation: string;
	confidence: number;
}
