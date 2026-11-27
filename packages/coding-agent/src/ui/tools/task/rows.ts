/**
 * The task card's text rows as styled segments: the call preview's spawn
 * list, settled and live agent rows with their detail lines, nested task
 * trees, the collapsed-list summaries and the run footer.
 *
 * A segment is text with theme span tokens and, for an agent name, the
 * agent whose identity colour it takes. The terminal look draws segments
 * with the theme (and the agent identity service); the nested-task view
 * sends them as spans (identity colours are terminal-only). Widths are
 * cells; `Infinity` leaves rows whole.
 */
import { flattenLine } from "@oh-my-pi/pi-tui/text/sanitize";
import { formatDuration, formatNumber, pluralize, sanitizeText } from "@oh-my-pi/pi-utils";
import { toolIntentLabel, type TspSpan, type TspText } from "@oh-my-pi/pi-wire";
import { replaceTabs, truncate, visibleWidth, wrap } from "@oh-my-pi/pi-tui/text/width";
import { stripGeneratedOutputNotice, stripTrailingNotice } from "../../../tools/output-meta-format";
import type {
	AgentProgress,
	FindingDetails,
	FindingPriority,
	SingleResult,
	TaskParams,
	TaskToolDetails,
} from "../../../task/task-details";
import { formatTaskId, isTaskToolDetails } from "../../../task/task-details";
import {
	FEED_MODEL_BADGE_WIDTH,
	isFeedModelBadgeEnabled,
	shortenEmbeddedPaths,
	shortenPath,
	shortenToolArgumentPaths,
} from "../../../utils/render-utils";
import { feedModel, feedModelBadge } from "../agent-common";
import {
	COLLAPSED_AGENT_LIMIT,
	MAX_NESTED_DEPTH,
	orderProgress,
	orderResults,
	pickCollapsedResults,
	requestedSpawns,
	resultOutcome,
	type ReviewVerdict,
	reviewVerdict,
	type RunTally,
	taskFirstLine,
	yieldLabels,
	yieldRecords,
} from "./model";
import { subprocessToolView } from "./subprocess-views";

/** A run of text: theme span tokens, and the agent whose name colour it takes. */
export interface Seg {
	readonly t: string;
	readonly s?: string;
	readonly agent?: string;
}

/** One row. */
export type Line = readonly Seg[];

/** A glyph by symbol key (`status.success`, `tree.branch`, …). */
export type Glyph = (key: string) => string;

/** What rows are built against. */
export interface RowContext {
	readonly glyph: Glyph;
	readonly expandKey: () => string;
	readonly expanded: boolean;
	/** The transcript clock (ms) time-derived rows sample. */
	readonly nowMs: number;
	/** The card left the live region: live rows draw dim. */
	readonly frozen: boolean;
}

/** Collapsed output lines of a settled agent, and expanded. */
const OUTPUT_COLLAPSED = 3;
const OUTPUT_EXPANDED = 12;
/** Task brief lines an expanded row shows. */
const TASK_LINES = 20;
/** Recent output lines a live expanded row shows. */
const RECENT_OUTPUT_ROWS = 20;
/** Widest one-line container in an output tree. */
const TREE_INLINE = 60;
const TREE_MAX_DEPTH = 6;
const TREE_MAX_LINES = 24;
const TREE_MAX_SCALAR = 70;
/** Artifact rows (patch, branch) are cut to this many cells. */
const ARTIFACT_WIDTH = 80;

const seg = (t: string, s?: string): Seg => (s ? { t, s } : { t });

/** Cells a row takes. */
export function lineWidth(line: Line): number {
	let width = 0;
	for (const part of line) width += visibleWidth(part.t);
	return width;
}

/** A row cut to `width` cells, ending in `ellipsis` when cut. */
export function truncLine(line: Line, width: number, ellipsis = "…"): Line {
	if (!Number.isFinite(width) || lineWidth(line) <= width) return line;
	const room = Math.max(0, width - visibleWidth(ellipsis));
	const out: Seg[] = [];
	let used = 0;
	for (const part of line) {
		const w = visibleWidth(part.t);
		if (used + w <= room) {
			out.push(part);
			used += w;
			continue;
		}
		const cut = truncate(part.t, room - used, "");
		if (cut) out.push({ ...part, t: cut });
		break;
	}
	if (ellipsis) out.push(seg(ellipsis));
	return out;
}

/** Spans of rows joined by newlines; agent colours dropped, equal styles merged. */
export function linesToSpans(lines: readonly Line[]): TspSpan[] {
	const spans: { t: string; s?: string }[] = [];
	const push = (t: string, s: string | undefined): void => {
		if (!t) return;
		const last = spans.at(-1);
		if (last && last.s === s) last.t += t;
		else spans.push(s ? { s, t } : { t });
	};
	lines.forEach((line, index) => {
		if (index > 0) push("\n", undefined);
		for (const part of line) push(part.t, part.s);
	});
	return spans;
}

/** A text's lines as rows (a subprocess view's output). */
function textLines(text: TspText): Line[] {
	const spans: readonly TspSpan[] = typeof text === "string" ? [{ t: text }] : text;
	const lines: Seg[][] = [[]];
	for (const span of spans) {
		span.t.split("\n").forEach((part, index) => {
			if (index > 0) lines.push([]);
			if (part) lines.at(-1)!.push(seg(part, span.s));
		});
	}
	return lines;
}

/** `text` on one line, cut to `width` cells. */
function previewLine(text: string, width: number): string {
	return truncate(flattenLine(text), width);
}

/** Cut to `width` only while collapsed (expanded rows wrap whole). */
function clip(text: string, width: number, expanded: boolean): string {
	return expanded ? text : truncate(text, width);
}

/** `… 3 more agents`. */
function moreItems(count: number, noun: string): string {
	return `… ${count} more ${pluralize(noun, count)}`;
}

function bracket(cx: RowContext, label: string): string {
	return `${cx.glyph("format.bracketLeft")}${label}${cx.glyph("format.bracketRight")}`;
}

/** The bracketed hint to expand the task, dim. */
function expandHint(cx: RowContext): Seg {
	return seg(bracket(cx, `${cx.expandKey()}: Expand`), "dim");
}

type IconStatus = "success" | "error" | "warning" | "pending" | "running" | "aborted";

const ICONS: Record<IconStatus, readonly [key: string, token: string]> = {
	success: ["status.success", "success"],
	error: ["status.error", "error"],
	warning: ["status.warning", "warning"],
	pending: ["status.pending", "muted"],
	running: ["status.running", "accent"],
	aborted: ["status.aborted", "error"],
};

function icon(cx: RowContext, status: IconStatus): Seg {
	const [key, token] = ICONS[status];
	return seg(cx.glyph(key), token);
}

/** ` ⟦explore⟧`, dim; nothing for the generic worker. */
function agentTypeBadge(cx: RowContext, agent: string | undefined): Seg[] {
	const trimmed = agent?.trim();
	if (!trimmed || trimmed === "task") return [];
	return [seg(" "), seg(bracket(cx, trimmed), "dim")];
}

/**
 * The resolved-model badge leading an agent's name (`task.showResolvedModelBadge`)
 * in at most `width` cells, its trailing space included; none while off or
 * when nothing fits.
 */
function modelBadge(
	cx: RowContext,
	agent: Pick<AgentProgress, "resolvedModel" | "resolvedModelIdentity" | "resolvedThinkingLevel" | "advisor">,
	width: number,
): Seg[] {
	if (!isFeedModelBadgeEnabled()) return [];
	const model = feedModel(
		agent.resolvedModelIdentity ?? agent.resolvedModel,
		agent.resolvedThinkingLevel,
		agent.advisor,
	);
	const badge = model && feedModelBadge(cx.glyph, model, Math.min(FEED_MODEL_BADGE_WIDTH, width));
	if (!badge) return [];
	const out: Seg[] = [];
	if (badge.lead) out.push(seg(badge.lead, "accent"));
	if (badge.rest) out.push(seg(badge.rest, "dim"));
	out.push(seg(" "));
	return out;
}

/** The ` · N 🛠 · N req · 12.3%/200K · $0.12` stat run. */
function statRun(
	cx: RowContext,
	stats: {
		readonly toolCount?: number;
		readonly requests?: number;
		readonly contextTokens?: number;
		readonly contextWindow?: number;
		readonly cost?: number;
	},
): Seg[] {
	const dot = cx.glyph("sep.dot");
	const out: Seg[] = [];
	if (stats.toolCount)
		out.push(seg(dot), seg(`${formatNumber(stats.toolCount)} ${cx.glyph("icon.extensionTool")}`, "dim"));
	if (stats.requests) out.push(seg(dot), seg(`${formatNumber(stats.requests)} req`, "dim"));
	if (stats.contextTokens && stats.contextTokens > 0) {
		const window = stats.contextWindow;
		const context =
			window && window > 0
				? `${((stats.contextTokens / window) * 100).toFixed(1)}%/${formatNumber(window)}`
				: formatNumber(stats.contextTokens);
		out.push(seg(dot), seg(context, "dim"));
	}
	if (stats.cost && stats.cost > 0) out.push(seg(dot), seg(`$${stats.cost.toFixed(2)}`, "statusLineCost"));
	return out;
}

/** A spawn's sequential steps as a dim ` [N steps]`. */
function stepsBadge(steps: number | undefined): Seg[] {
	return steps ? [seg(` [${steps} ${pluralize("step", steps)}]`, "dim")] : [];
}

// ─── Call preview ───────────────────────────────────────────────────────────

/** The spawns a streaming call requests, one bullet row each (the batch capped at four). */
export function callLines(cx: RowContext, args: Partial<TaskParams> | undefined): Line[] {
	const lines: Line[] = [];
	const bullet = seg(cx.glyph("format.bullet"), "dim");
	const spawns = requestedSpawns(args);
	const items = spawns.filter(spawn => spawn.item);
	for (const spawn of spawns) {
		if (spawn.item && items.indexOf(spawn) >= COLLAPSED_AGENT_LIMIT) continue;
		const line: Seg[] = [bullet, seg(" "), seg(spawn.name, "accent strong")];
		const brief = taskFirstLine(spawn.brief);
		if (brief) line.push(seg(": "), seg(previewLine(brief, 64), "muted"));
		line.push(...agentTypeBadge(cx, spawn.agent), ...stepsBadge(spawn.steps));
		if (spawn.item && spawn.isolated) line.push(seg(" [isolated]", "dim"));
		lines.push(line);
	}
	if (items.length > COLLAPSED_AGENT_LIMIT)
		lines.push([bullet, seg(" "), seg(moreItems(items.length - COLLAPSED_AGENT_LIMIT, "agent"), "dim")]);
	return lines;
}

// ─── Detail sections ────────────────────────────────────────────────────────

/** The expanded `Task` section: the brief, indented. */
function taskSection(task: string, cp: Line, expanded: boolean): Line[] {
	const trimmed = sanitizeText(task).trim();
	if (!expanded || !trimmed) return [];
	const lines: Line[] = [[...cp, seg("Task", "dim")]];
	const taskLines = trimmed.split("\n");
	for (const line of taskLines.slice(0, TASK_LINES)) lines.push([...cp, seg("  "), seg(replaceTabs(line), "dim")]);
	if (taskLines.length > TASK_LINES)
		lines.push([...cp, seg("  "), seg(moreItems(taskLines.length - TASK_LINES, "line"), "dim")]);
	return lines;
}

const SCALAR_COLOR = (value: unknown): string =>
	typeof value === "string" ? "syntaxString" : typeof value === "number" ? "syntaxNumber" : "syntaxKeyword";

function scalarText(value: unknown, max: number): string {
	if (typeof value === "string") return JSON.stringify(truncate(sanitizeText(value), max));
	return String(value);
}

/** A container on one row (`[1, 2]`, `{a: 1}`), or undefined past {@link TREE_INLINE} cells. */
function inlineContainer(value: unknown): Seg[] | undefined {
	const out: Seg[] = [];
	let width = 0;
	const push = (t: string, s: string): boolean => {
		width += visibleWidth(t);
		if (width > TREE_INLINE) return false;
		const last = out.at(-1);
		if (last && last.s === s) out[out.length - 1] = seg(last.t + t, s);
		else out.push(seg(t, s));
		return true;
	};
	const walk = (entry: unknown): boolean => {
		if (Array.isArray(entry)) {
			if (!push("[", "muted")) return false;
			for (let i = 0; i < entry.length; i++) if ((i > 0 && !push(", ", "muted")) || !walk(entry[i])) return false;
			return push("]", "muted");
		}
		if (entry !== null && typeof entry === "object") {
			if (!push("{", "muted")) return false;
			let sep = "";
			const record = entry as Record<string, unknown>;
			for (const key in record) {
				if (!push(`${sep}${key}: `, "muted") || !walk(record[key])) return false;
				sep = ", ";
			}
			return push("}", "muted");
		}
		return push(scalarText(entry, TREE_MAX_SCALAR), SCALAR_COLOR(entry));
	};
	return walk(value) ? out : undefined;
}

/** A JSON value as `├─ key: value` rows; small containers inline, larger ones open a subtree. */
function jsonTreeLines(cx: RowContext, value: unknown): { lines: Line[]; truncated: boolean } {
	const lines: Line[] = [];
	let truncated = false;
	if (value === null || typeof value !== "object") {
		return { lines: [[seg(scalarText(value, TREE_MAX_SCALAR), SCALAR_COLOR(value))]], truncated };
	}
	const walk = (container: object, depth: number, gutter: Line): void => {
		const entries = Object.entries(container);
		entries.forEach(([key, entry], index) => {
			if (lines.length >= TREE_MAX_LINES) {
				truncated = true;
				return;
			}
			const last = index === entries.length - 1;
			const row: Seg[] = [
				...gutter,
				seg(cx.glyph(last ? "tree.last" : "tree.branch"), "dim"),
				seg(" "),
				seg(key, Array.isArray(container) ? "dim" : "muted"),
			];
			if (entry !== null && typeof entry === "object") {
				const inline = inlineContainer(entry);
				if (inline) {
					lines.push([...row, seg(": "), ...inline]);
					return;
				}
				const size = Array.isArray(entry) ? `[${entry.length}]` : `{${Object.keys(entry).length}}`;
				lines.push([...row, seg(" "), seg(size, "dim")]);
				if (depth < TREE_MAX_DEPTH)
					walk(entry, depth + 1, [...gutter, last ? seg("   ") : seg(`${cx.glyph("tree.vertical")}  `, "dim")]);
				return;
			}
			lines.push([...row, seg(": "), seg(scalarText(entry, TREE_MAX_SCALAR), SCALAR_COLOR(entry))]);
		});
	};
	walk(value, 1, []);
	return { lines, truncated };
}

/** A scalar for a one-line summary. */
function inlineScalar(value: unknown, max: number): string {
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	if (typeof value === "string")
		return `"${truncate(sanitizeText(value).replace(/\n/g, "\\n").replace(/\t/g, "\\t"), max)}"`;
	if (Array.isArray(value)) return `[${value.length} items]`;
	if (typeof value === "object") return `{${Object.keys(value).length} keys}`;
	return String(value);
}

/** `Output: a=1, b=[2 items]`: a JSON output on one row. */
function outputInline(data: unknown): string {
	const lead = "Output: ";
	if (data === null || data === undefined) return `${lead}none`;
	if (typeof data !== "object") return `${lead}${inlineScalar(data, 60)}`;
	if (Array.isArray(data)) {
		if (data.length === 0) return `${lead}[]`;
		return `${lead}[${data.length} items] ${inlineScalar(data[0], 40)}${data.length > 1 ? "…" : ""}`;
	}
	const budget = 80 - lead.length;
	const pairs: string[] = [];
	let width = 0;
	const record = data as Record<string, unknown>;
	for (const key in record) {
		const pair = `${sanitizeText(key)}=${inlineScalar(record[key], 24)}`;
		const added = visibleWidth(pair) + (pairs.length > 0 ? 2 : 0);
		if (width + added > budget && pairs.length > 0) {
			pairs.push("…");
			break;
		}
		pairs.push(pair);
		width += added;
	}
	return `${lead}${pairs.join(", ") || "{}"}`;
}

/**
 * An agent's output: JSON on one summary row (a tree when expanded), else an
 * `Output` label over its first lines; a missing-yield warning heads it.
 */
function outputSection(
	cx: RowContext,
	output: string,
	cp: Line,
	collapsedLines: number,
	expandedLines: number,
	warning?: string,
): Line[] {
	const lines: Line[] = [];
	const text = sanitizeText(output).trimEnd();
	if (!text && !warning) return lines;
	// With a warning the output sits one level in, under an `Output` label.
	const inner: Line = warning ? [...cp, seg("  ")] : cp;
	if (warning) {
		lines.push([...cp, seg("Output", "dim")]);
		lines.push([
			...cp,
			seg("  "),
			icon(cx, "warning"),
			seg(" "),
			seg(clip(sanitizeText(warning), 80, cx.expanded), "dim"),
		]);
		if (!text) return lines;
	}
	if (text.startsWith("{") || text.startsWith("[")) {
		let parsed: unknown;
		let json = true;
		try {
			parsed = JSON.parse(text);
		} catch {
			json = false;
		}
		if (json) {
			if (!cx.expanded) {
				lines.push([...inner, seg(outputInline(parsed), "dim")]);
				return lines;
			}
			const tree = jsonTreeLines(cx, parsed);
			if (tree.lines.length > 0) {
				if (!warning) lines.push([...cp, seg("Output", "dim")]);
				for (const line of tree.lines) lines.push([...cp, seg("  "), ...line]);
				if (tree.truncated) lines.push([...cp, seg("  "), seg("…", "dim")]);
				return lines;
			}
		}
	}
	if (!warning) lines.push([...cp, seg("Output", "dim")]);
	const outputLines = text.split("\n");
	const shown = cx.expanded ? expandedLines : collapsedLines;
	for (const line of outputLines.slice(0, shown))
		lines.push([...cp, seg("  "), seg(clip(replaceTabs(line), 70, cx.expanded), "dim")]);
	if (outputLines.length > shown)
		lines.push([...cp, seg("  "), seg(moreItems(outputLines.length - shown, "line"), "dim")]);
	return lines;
}

const PRIORITY: Record<FindingPriority, { readonly ord: number; readonly symbol: string; readonly color: string }> = {
	P0: { ord: 0, symbol: "status.error", color: "error" },
	P1: { ord: 1, symbol: "status.warning", color: "warning" },
	P2: { ord: 2, symbol: "status.warning", color: "muted" },
	P3: { ord: 3, symbol: "status.info", color: "accent" },
};

/** A reviewer's verdict, explanation, finding counts and findings. */
function reviewRows(cx: RowContext, review: ReviewVerdict, cp: Line): Line[] {
	const { summary, findings } = review;
	const correct = summary.overall_correctness === "correct";
	const lines: Line[] = [
		[
			...cp,
			seg("Patch is "),
			seg(summary.overall_correctness, correct ? "success" : "error"),
			seg(" "),
			icon(cx, correct ? "success" : "error"),
			seg(" "),
			seg(`(${(summary.confidence * 100).toFixed(0)}% confidence)`, "dim"),
		],
	];
	if (summary.explanation) {
		if (cx.expanded) {
			lines.push([...cp, seg("Summary", "dim")]);
			for (const line of sanitizeText(summary.explanation).split("\n"))
				lines.push([...cp, seg("  "), seg(replaceTabs(line), "dim")]);
		} else {
			const flat = replaceTabs(sanitizeText(summary.explanation)).replace(/[\r\n]+/g, " ");
			const sentence = flat.split(/[.!?]/)[0]!.trim();
			lines.push([...cp, seg(truncate(`${sentence}.`, 100), "dim")]);
		}
	}
	if (findings.length === 0) lines.push([...cp, seg("Findings: none", "dim")]);
	else {
		const counts: Partial<Record<FindingPriority, number>> = {};
		for (const finding of findings) counts[finding.priority] = (counts[finding.priority] ?? 0) + 1;
		const row: Seg[] = [...cp, seg("Findings:", "dim"), seg(" ")];
		(Object.keys(PRIORITY) as FindingPriority[]).forEach((label, index) => {
			const info = PRIORITY[label];
			if (index > 0) row.push(seg(cx.glyph("sep.dot")));
			const glyph = cx.glyph(info.symbol);
			if (glyph) row.push(seg(glyph, info.color), seg(" "));
			row.push(seg(`${label}:${counts[label] ?? 0}`, info.color));
		});
		lines.push(row);
		lines.push(...findingRows(cx, findings, cp));
	}
	return lines;
}

function findingRows(cx: RowContext, findings: readonly FindingDetails[], cp: Line): Line[] {
	const sorted = cx.expanded
		? findings
		: [...findings].sort((a, b) => PRIORITY[a.priority].ord - PRIORITY[b.priority].ord);
	const shown = cx.expanded ? sorted.length : Math.min(3, sorted.length);
	const lines: Line[] = [];
	for (let i = 0; i < shown; i++) {
		const finding = sorted[i]!;
		const last = i === shown - 1 && (cx.expanded || sorted.length <= 3);
		const title = replaceTabs(sanitizeText(finding.title.replace(/^\[P\d\]\s*/, ""))).replace(/[\r\n]+/g, " ");
		const file = sanitizeText(finding.file_path || "<unknown>")
			.split(/[\\/]/)
			.pop();
		lines.push([
			...cp,
			seg(cx.glyph(last ? "tree.last" : "tree.branch")),
			seg(" "),
			seg(`[${finding.priority}]`, PRIORITY[finding.priority].color),
			seg(` ${title} `),
			seg(`${file}:${finding.line_start}`, "dim"),
		]);
		if (cx.expanded && finding.body) {
			const gutter = last ? [seg("   ")] : [seg(cx.glyph("tree.vertical")), seg("  ")];
			for (const line of sanitizeText(finding.body).split("\n"))
				lines.push([...cp, ...gutter, seg(replaceTabs(line), "dim")]);
		}
	}
	if (!cx.expanded && findings.length > 3)
		lines.push([...cp, seg(cx.glyph("tree.last")), seg(" "), seg(moreItems(findings.length - 3, "finding"), "dim")]);
	return lines;
}

/** `yield[label]: preview` rows of a structured agent's typed yields (the last three while collapsed). */
function typedYieldRows(cx: RowContext, value: unknown, cp: Line): Line[] {
	const typed = yieldRecords(value)
		.map(item => ({ item, labels: yieldLabels(item.type) }))
		.filter(entry => entry.labels.length > 0);
	const shown = cx.expanded ? typed.length : 3;
	const lines: Line[] = [];
	for (const { item, labels } of typed.slice(-shown)) {
		const label = `${Array.isArray(item.type) ? "yield+" : "yield"}[${labels.join(", ")}]`;
		let preview: string;
		if (item.data === undefined) preview = "finalize sections";
		else if (typeof item.data === "string") preview = previewLine(sanitizeText(item.data), 70);
		else {
			let json: string;
			try {
				json = JSON.stringify(item.data) ?? "null";
			} catch {
				json = String(item.data);
			}
			preview = previewLine(sanitizeText(json), 70);
		}
		lines.push([...cp, seg(label, "dim"), seg(": "), seg(preview, "dim")]);
	}
	if (typed.length > shown) lines.push([...cp, seg(moreItems(typed.length - shown, "yield"), "dim")]);
	return lines;
}

/** The `routed:` note of a model replacement. */
function routeLine(route: string | undefined, cp: Line, maxWidth: number): Line[] {
	if (!route) return [];
	return [truncLine([...cp, seg(`routed: ${replaceTabs(sanitizeText(route))}`, "dim")], maxWidth, "")];
}

/** A description too long for the head row, wrapped under it. */
function descriptionLines(description: string, cp: Line, maxWidth: number): Line[] {
	if (!Number.isFinite(maxWidth)) return description.split("\n").map(line => [...cp, seg(line, "dim")]);
	const prefix = truncLine(cp, Math.max(0, maxWidth - 1), "");
	const width = Math.max(1, maxWidth - lineWidth(prefix));
	return wrap(description, width).map(line => [...prefix, seg(line, "dim")]);
}

// ─── Agent rows ─────────────────────────────────────────────────────────────

/** Tree markers of a nested agent: its row prefix and its detail lines' gutter. */
function nestedMarkers(cx: RowContext, last: boolean): { prefix: Line; cp: Line } {
	return {
		prefix: [seg(cx.glyph(last ? "tree.last" : "tree.branch"), "dim")],
		cp: last ? [seg("   ")] : [seg(cx.glyph("tree.vertical"), "dim"), seg("  ")],
	};
}

/** Nesting bookkeeping: snapshots drawn on the current path (cycles), and depth. */
interface Nesting {
	readonly seen: Set<object>;
	readonly depth: number;
}

/** A settled agent: its status row, then brief, output, artifacts and error. */
export function resultRows(
	cx: RowContext,
	result: SingleResult,
	prefix: Line,
	cp: Line,
	maxWidth: number,
	nesting: Nesting = { seen: new Set(), depth: 0 },
): Line[] {
	const lines: Line[] = [];
	const outcome = resultOutcome(result);
	const { aborted, mergeFailed, success } = outcome;
	const warned = Boolean(outcome.missingYield) && success;
	const iconStatus: IconStatus = aborted
		? "aborted"
		: warned || mergeFailed
			? "warning"
			: success
				? "success"
				: "error";
	const badgeColor = warned ? "warning" : success ? "success" : mergeFailed ? "warning" : "error";
	const statusText = aborted
		? "aborted"
		: warned
			? "warning"
			: success
				? "done"
				: mergeFailed
					? "merge failed"
					: "failed";
	const fullDescription = result.description ? replaceTabs(sanitizeText(result.description)).trim() : undefined;
	const indent: Line = prefix.length > 0 ? [...prefix, seg(" ")] : [];
	const lead: Line = [...indent, icon(cx, iconStatus), seg(" ")];
	const statusBadge: Seg[] = [seg(" "), seg(bracket(cx, statusText), badgeColor)];
	const id = formatTaskId(result.id);
	const displayId = Number.isFinite(maxWidth)
		? truncate(id, Math.max(0, maxWidth - lineWidth(lead) - lineWidth(statusBadge)))
		: id;
	const roleBadge = truncLine(
		agentTypeBadge(cx, result.agent),
		Math.max(0, maxWidth - lineWidth([...lead, seg(displayId), ...statusBadge])),
	);
	const badges = [...roleBadge, ...statusBadge];
	const model = modelBadge(cx, result, maxWidth - lineWidth([...lead, seg(displayId), ...badges]) - 1);
	const description =
		fullDescription && lineWidth([...lead, ...model, seg(`${displayId}: ${fullDescription}`), ...badges]) <= maxWidth
			? fullDescription
			: undefined;
	const titleColor = success && !warned ? undefined : "accent";
	const row: Seg[] = [...lead, ...model, { t: displayId, s: description ? "strong" : undefined, agent: result.id }];
	if (description) row.push(seg(`: ${description}`, titleColor));
	row.push(...badges);
	row.push(
		...statRun(cx, {
			requests: result.requests,
			contextTokens: result.contextTokens,
			contextWindow: result.contextWindow,
			cost: result.usage?.cost.total ?? 0,
		}),
	);
	row.push(seg(cx.glyph("sep.dot")), seg(formatDuration(result.durationMs), "dim"));
	if (result.truncated) row.push(seg(" "), seg("[truncated]", "warning"));
	lines.push(truncLine(row, maxWidth, ""));
	if (fullDescription && !description) lines.push(...descriptionLines(fullDescription, cp, maxWidth));
	lines.push(...routeLine(result.resolvedModelRoute, cp, maxWidth));
	lines.push(...taskSection(result.assignment ?? result.task, cp, cx.expanded));
	if (aborted && result.abortReason) {
		lines.push([
			...cp,
			icon(cx, "aborted"),
			seg(" "),
			seg(clip(flattenLine(sanitizeText(result.abortReason)), 80, cx.expanded), "dim"),
		]);
	}
	const review = reviewVerdict(yieldRecords(result.extractedToolData?.yield));
	if (review) {
		lines.push(...reviewRows(cx, review, cp));
		return lines;
	}
	let custom = false;
	const deferred: Line[] = [];
	const extracted = result.extractedToolData ?? {};
	for (const tool in extracted) {
		const data = extracted[tool]!;
		if (tool === "yield") {
			const rows = typedYieldRows(cx, data, cp);
			if (rows.length > 0) {
				custom = true;
				lines.push(...rows);
			}
			continue;
		}
		if (tool === "task") {
			if (data.length > 0) {
				const nested = nestedResultLines(
					cx,
					data.filter(isTaskToolDetails),
					Math.max(0, maxWidth - lineWidth(cp)),
					nesting,
				);
				for (const line of nested) deferred.push([...cp, ...line]);
			}
			continue;
		}
		const view = subprocessToolView(tool);
		if (view?.final && data.length > 0) {
			custom = true;
			lines.push([...cp, seg(`Tool: ${tool}`, "dim")]);
			for (const line of textLines(view.final(data, cx.expanded))) lines.push([...cp, ...line]);
		}
	}
	if (custom && outcome.missingYield) {
		lines.push([
			...cp,
			icon(cx, "warning"),
			seg(" "),
			seg(clip(sanitizeText(outcome.missingYield), 80, cx.expanded), "dim"),
		]);
	}
	if (!custom)
		lines.push(...outputSection(cx, outcome.output, cp, OUTPUT_COLLAPSED, OUTPUT_EXPANDED, outcome.missingYield));
	lines.push(...deferred);
	const settledOk = !aborted && result.exitCode === 0;
	if (result.patchPath && result.hasRootChanges !== false && settledOk) {
		lines.push([...cp, seg(truncate(`Patch: ${replaceTabs(shortenPath(result.patchPath))}`, ARTIFACT_WIDTH), "dim")]);
	} else if (result.branchName && settledOk) {
		lines.push([
			...cp,
			seg(truncate(`Branch: ${replaceTabs(sanitizeText(result.branchName))}`, ARTIFACT_WIDTH), "dim"),
		]);
	}
	if (settledOk) {
		for (const nested of result.nestedPatchPaths ?? [])
			lines.push([...cp, seg(truncate(`Nested patch: ${replaceTabs(shortenPath(nested))}`, ARTIFACT_WIDTH), "dim")]);
	}
	if (result.error && (!success || mergeFailed) && (!aborted || result.error !== result.abortReason)) {
		lines.push([
			...cp,
			seg(clip(flattenLine(sanitizeText(result.error)), 70, cx.expanded), mergeFailed ? "warning" : "error"),
		]);
	}
	return lines;
}

/** A tool call's own intent, else its argument (home paths shortened). */
export function toolCallDetail(
	intent: string | undefined,
	args: string | undefined,
	argsKey: string | undefined,
): string {
	return intent ? shortenEmbeddedPaths(toolIntentLabel(intent)) : shortenToolArgumentPaths(args ?? "", argsKey);
}

/** The agent's recent output, newest last, without runner notices. */
function recentOutputText(recent: readonly string[]): string {
	let text = sanitizeText([...recent].reverse().join("\n")).trimEnd();
	for (;;) {
		const next = stripTrailingNotice(
			stripGeneratedOutputNotice(text),
			line => /^\[took \d+(?:\.\d+)?s\]$/u.test(line) || /^\[exit code -?\d+\]$/u.test(line),
		);
		if (next === text) return text;
		text = next;
	}
}

/** A live (or finished, not yet settled) agent: its status row, stage, current tool, retry and extracted data. */
export function progressRows(
	cx: RowContext,
	progress: AgentProgress,
	prefix: Line,
	cp: Line,
	maxWidth: number,
	nesting: Nesting = { seen: new Set(), depth: 0 },
): Line[] {
	const lines: Line[] = [];
	const { status } = progress;
	const live = status === "pending" || status === "running";
	const running = status === "running";
	const frozen = live && cx.frozen;
	const description = progress.description ? replaceTabs(sanitizeText(progress.description)).trim() : undefined;
	let statusBadge: Seg[] = [];
	if (progress.retryState && running) statusBadge = [seg(" "), seg(bracket(cx, "retrying"), "warning")];
	else if (progress.retryFailure && (status === "failed" || status === "aborted"))
		statusBadge = [seg(" "), seg(bracket(cx, "rate-limited"), "error")];
	else if (status === "failed" || status === "aborted") statusBadge = [seg(" "), seg(bracket(cx, status), "error")];
	const glyph: Seg = frozen
		? seg(cx.glyph(running ? "status.running" : "status.pending"), "dim")
		: icon(cx, status === "failed" ? "error" : status === "completed" ? "success" : status);
	const lead: Line = [...prefix, ...(prefix.length > 0 ? [seg(" ")] : []), glyph, seg(" ")];
	const id = formatTaskId(progress.id);
	const shownId = Number.isFinite(maxWidth)
		? truncate(id, Math.max(0, maxWidth - lineWidth(lead) - lineWidth(statusBadge)))
		: id;
	const roleBadge = truncLine(
		agentTypeBadge(cx, progress.agent),
		Math.max(0, maxWidth - lineWidth(lead) - visibleWidth(shownId) - lineWidth(statusBadge)),
	);
	const badges = [...roleBadge, ...statusBadge];
	const model = modelBadge(cx, progress, maxWidth - lineWidth([...lead, seg(shownId), ...badges]) - 1);
	const descriptionShown = Boolean(
		description && lineWidth([...lead, ...model, seg(`${shownId}: ${description}`), ...badges]) <= maxWidth,
	);
	const nameColor = frozen ? "dim" : status === "completed" ? undefined : "accent";
	const row: Seg[] = [...lead, ...model];
	const nameSeg: Seg = frozen
		? seg(shownId, descriptionShown ? "dim strong" : "dim")
		: { t: shownId, s: descriptionShown ? "strong" : undefined, agent: progress.id };
	row.push(nameSeg);
	if (descriptionShown) row.push(seg(":", nameColor), seg(" "), seg(description!, nameColor));
	row.push(...badges);
	if (running && !description)
		row.push(seg(" "), seg(previewLine(sanitizeText(progress.assignment ?? progress.task), 40), "muted"));
	if (live && progress.completionPercent !== undefined)
		row.push(seg(cx.glyph("sep.dot")), seg(`${progress.completionPercent}%`, "accent"));
	if (running || status === "completed") row.push(...statRun(cx, progress));
	lines.push(truncLine(row, maxWidth, ""));
	if (description && !descriptionShown) lines.push(...descriptionLines(description, cp, maxWidth));
	lines.push(...routeLine(progress.resolvedModelRoute, cp, maxWidth));
	lines.push(...taskSection(progress.assignment ?? progress.task, cp, cx.expanded));
	const hook = seg(cx.glyph("tree.hook"));
	if (running) {
		if (progress.stage)
			lines.push(truncLine([...cp, seg(replaceTabs(sanitizeText(progress.stage)), "muted")], maxWidth, ""));
		if (progress.currentTool) {
			const line: Seg[] = [...cp, hook, seg(" "), seg(sanitizeText(progress.currentTool), "muted")];
			const detail = toolCallDetail(
				progress.currentToolIntent,
				progress.currentToolArgs,
				progress.currentToolArgsKey,
			);
			if (detail) line.push(seg(": "), seg(previewLine(sanitizeText(detail), 40), "dim"));
			if (progress.currentToolStartMs) {
				const elapsed = cx.nowMs - progress.currentToolStartMs;
				if (elapsed > 5000) line.push(seg(cx.glyph("sep.dot")), seg(formatDuration(elapsed), "warning"));
			}
			lines.push(line);
		} else if (progress.recentTools.length > 0) {
			const recent = progress.recentTools[0]!;
			const line: Seg[] = [...cp, hook, seg(" "), seg(sanitizeText(recent.tool), "dim")];
			const detail = toolCallDetail(recent.intent, recent.args, recent.argsKey);
			if (detail) line.push(seg(": "), seg(previewLine(sanitizeText(detail), 40), "dim"));
			lines.push(line);
		}
	}
	if (progress.retryState && running) {
		const retry = progress.retryState;
		const remaining = Math.max(0, retry.startedAtMs + retry.delayMs - cx.nowMs);
		const wait = remaining > 0 ? `in ${formatDuration(remaining)}` : "now";
		const summary = `retrying ${retry.attempt}/${retry.maxAttempts} ${wait}: ${previewLine(sanitizeText(retry.errorMessage), 60)}`;
		lines.push([...cp, hook, seg(" "), seg(summary, "warning")]);
	} else if (progress.retryFailure && !running) {
		const failure = progress.retryFailure;
		const summary = `auto-retry gave up after ${failure.attempt} ${pluralize("attempt", failure.attempt)}: ${previewLine(sanitizeText(failure.errorMessage), 80)}`;
		lines.push([...cp, hook, seg(" "), seg(summary, "error")]);
	}
	const extracted = progress.extractedToolData;
	if (extracted) {
		if (status === "completed") {
			const review = reviewVerdict(yieldRecords(extracted.yield));
			if (review) {
				lines.push(...reviewRows(cx, review, cp));
				return lines;
			}
		}
		for (const tool in extracted) {
			const data = extracted[tool]!;
			if (tool === "yield") {
				lines.push(...typedYieldRows(cx, data, cp));
				continue;
			}
			if (tool === "task") continue;
			const view = subprocessToolView(tool);
			if (!view?.inline) continue;
			const shown = cx.expanded ? data.length : 3;
			for (const item of data.slice(-shown))
				for (const line of textLines(view.inline(item))) lines.push([...cp, ...line]);
			if (data.length > shown) lines.push([...cp, seg(moreItems(data.length - shown, "item"), "dim")]);
		}
	}
	const settledNested = (extracted?.task ?? []).filter(isTaskToolDetails);
	const snapshots = progress.inflightTaskDetails ? [...settledNested, progress.inflightTaskDetails] : settledNested;
	if (snapshots.length > 0) {
		for (const line of nestedTreeLines(cx, snapshots, Math.max(0, maxWidth - lineWidth(cp)), nesting))
			lines.push([...cp, ...line]);
	}
	if (cx.expanded && running) {
		let recent = recentOutputText(progress.recentOutput).split("\n");
		if (recent.length > RECENT_OUTPUT_ROWS) {
			const visible = recent.slice(recent.length - (RECENT_OUTPUT_ROWS - 1));
			const hidden = recent.length - visible.length;
			recent = [`… ${hidden} earlier ${pluralize("line", hidden)}`, ...visible];
		}
		lines.push(...outputSection(cx, recent.join("\n"), cp, 2, RECENT_OUTPUT_ROWS));
	}
	return lines;
}

/** Child task snapshots: each settled result as a tree item, the collapsed list capped. */
export function nestedResultLines(
	cx: RowContext,
	snapshots: readonly TaskToolDetails[],
	maxWidth: number,
	nesting: Nesting = { seen: new Set(), depth: 0 },
): Line[] {
	return nestedLines(cx, snapshots, maxWidth, nesting, false);
}

/** Child task snapshots, settled or in flight (live rows for snapshots without results). */
function nestedTreeLines(
	cx: RowContext,
	snapshots: readonly TaskToolDetails[],
	maxWidth: number,
	nesting: Nesting,
): Line[] {
	return nestedLines(cx, snapshots, maxWidth, nesting, true);
}

function nestedLines(
	cx: RowContext,
	snapshots: readonly TaskToolDetails[],
	maxWidth: number,
	nesting: Nesting,
	withProgress: boolean,
): Line[] {
	const lines: Line[] = [];
	for (const details of snapshots) {
		if (nesting.seen.has(details)) {
			lines.push([seg("… nested task progress already shown", "dim")]);
			continue;
		}
		if (nesting.depth >= MAX_NESTED_DEPTH) {
			lines.push([seg("… nested task depth limit reached", "dim")]);
			continue;
		}
		nesting.seen.add(details);
		const inner: Nesting = { seen: nesting.seen, depth: nesting.depth + 1 };
		if (details.results.length > 0) {
			const ordered = orderResults(details.results);
			const visible = cx.expanded ? ordered : pickCollapsedResults(ordered);
			const hidden = ordered.length - visible.length;
			visible.forEach((result, index) => {
				const { prefix, cp } = nestedMarkers(cx, hidden === 0 && index === visible.length - 1);
				lines.push(...resultRows(cx, result, prefix, cp, maxWidth, inner));
			});
			if (hidden > 0)
				lines.push([...nestedMarkers(cx, true).prefix, seg(" "), seg(moreItems(hidden, "agent"), "dim")]);
		} else if (withProgress && details.progress && details.progress.length > 0) {
			const ordered = orderProgress(details.progress);
			const visible = cx.expanded ? ordered : ordered.slice(Math.max(0, ordered.length - COLLAPSED_AGENT_LIMIT));
			const hidden = ordered.length - visible.length;
			visible.forEach((progress, index) => {
				const { prefix, cp } = nestedMarkers(cx, hidden === 0 && index === visible.length - 1);
				lines.push(...progressRows(cx, progress, prefix, cp, maxWidth, inner));
			});
			if (hidden > 0)
				lines.push([...nestedMarkers(cx, true).prefix, seg(" "), seg(moreItems(hidden, "agent"), "dim")]);
		}
		nesting.seen.delete(details);
	}
	return lines;
}

// ─── Card body ──────────────────────────────────────────────────────────────

/** Count of live rows folded above the visible ones, with the tool expansion hint. */
function hiddenProgressLine(cx: RowContext, hidden: readonly AgentProgress[]): Line {
	const counts = { completed: 0, running: 0, pending: 0, failed: 0, aborted: 0 };
	for (const p of hidden) counts[p.status]++;
	const parts: Seg[] = [];
	if (counts.completed > 0) parts.push(seg(`${counts.completed} done`, "dim"));
	if (counts.running > 0) parts.push(seg(`${counts.running} running`, "dim"));
	if (counts.pending > 0) parts.push(seg(`${counts.pending} pending`, "dim"));
	if (counts.failed > 0) parts.push(seg(`${counts.failed} failed`, "error"));
	if (counts.aborted > 0) parts.push(seg(`${counts.aborted} aborted`, "error"));
	const line: Seg[] = [seg(moreItems(hidden.length, "agent"), "dim")];
	if (parts.length > 0) {
		line.push(seg(" (", "dim"));
		parts.forEach((part, index) => {
			if (index > 0) line.push(seg(cx.glyph("sep.dot"), "dim"));
			line.push(part);
		});
		line.push(seg(")", "dim"));
	}
	line.push(seg(" "), expandHint(cx));
	return line;
}

/** `⟦1 aborted · 3 succeeded · 1 merge failed · 1 failed · 18 req · 9.0s⟧`. */
function footerLine(cx: RowContext, tally: RunTally, durationMs: number): Line {
	const parts: Seg[] = [];
	if (tally.aborted > 0) parts.push(seg(`${tally.aborted} aborted`, "error"));
	if (tally.succeeded > 0) parts.push(seg(`${tally.succeeded} succeeded`, "success"));
	if (tally.mergeFailed > 0) parts.push(seg(`${tally.mergeFailed} merge failed`, "warning"));
	if (tally.failed > 0) parts.push(seg(`${tally.failed} failed`, "error"));
	if (tally.requests > 0) parts.push(seg(`${formatNumber(tally.requests)} req`, "dim"));
	parts.push(seg(formatDuration(durationMs), "dim"));
	const line: Seg[] = [seg(cx.glyph("format.bracketLeft"), "dim")];
	parts.forEach((part, index) => {
		if (index > 0) line.push(seg(cx.glyph("sep.dot"), "dim"));
		line.push(part);
	});
	line.push(seg(cx.glyph("format.bracketRight"), "dim"));
	return line;
}

/**
 * The agent rows of a task snapshot: live rows until results exist
 * (collapsed: the last four under a summary of the rest), else results
 * (collapsed: problems and the fastest four), live rows of spawns without a
 * result, and the run footer.
 */
/**
 * The agent rows of a run: settled results, then the agents still running, then the footer. With
 * `owners`, each line's running agent id (undefined for other lines) is pushed in step: the
 * terminal look makes a live agent's rows a hit that focuses it.
 */
export function agentLines(
	cx: RowContext,
	details: TaskToolDetails,
	tally: RunTally,
	maxWidth: number,
	owners?: (string | undefined)[],
): Line[] {
	const lines: Line[] = [];
	const progress = details.progress ?? [];
	const pushLive = (p: AgentProgress): void => {
		const rows = progressRows(cx, p, [], [seg("  ")], maxWidth);
		lines.push(...rows);
		owners?.push(...rows.map(() => p.id));
	};
	const pushOther = (...rows: Line[]): void => {
		lines.push(...rows);
		owners?.push(...rows.map(() => undefined));
	};
	if (details.results.length === 0) {
		if (progress.length === 0) return lines;
		const ordered = orderProgress(progress);
		const visible = cx.expanded ? ordered : ordered.slice(Math.max(0, ordered.length - COLLAPSED_AGENT_LIMIT));
		if (visible.length < ordered.length)
			pushOther(hiddenProgressLine(cx, ordered.slice(0, ordered.length - visible.length)));
		for (const p of visible) pushLive(p);
		return lines;
	}
	const ordered = orderResults(details.results);
	const visible = cx.expanded ? ordered : pickCollapsedResults(ordered);
	for (const result of visible) pushOther(...resultRows(cx, result, [], [seg("  ")], maxWidth));
	if (visible.length < ordered.length)
		pushOther([seg(moreItems(ordered.length - visible.length, "agent"), "dim"), seg(" "), expandHint(cx)]);
	const settled = new Set(details.results.map(result => result.id));
	for (const p of orderProgress(progress.filter(entry => !settled.has(entry.id)))) pushLive(p);
	pushOther(footerLine(cx, tally, details.totalDurationMs));
	return lines;
}
