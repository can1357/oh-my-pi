import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { TspSpan, TspTone } from "@oh-my-pi/pi-wire";
import { span } from "../native/describe";
import { Ellipsis, visibleWidth } from "../utils";
import { formatMetricRow } from "../components/metric";
import { renderProgressBar } from "../components/progress-bar";
import { renderTableRow } from "../components/table";
import { formatDuration, formatNumber } from "@oh-my-pi/pi-utils";
import type { ThemeColor } from "../theme/theme";
import { type AgentRecordLike, type AgentStatus, MAIN_AGENT_ID } from "./agent-hub-types";
import { parseThinkingLevel } from "../thinking";
import { TRUNCATE_LENGTHS, truncateToWidth } from "../render/render-utils";
import { sanitizeDisplaySingleLine } from "./extensions/display-text";
import type { ObservableSession } from "./session-observer-registry";
import { theme } from "../theme/theme";
import type { AgentMetrics } from "./agent-hub-projection";

export interface RosterRender {
	lines: string[];
	hitRows: Array<number | undefined>;
}

/** Legacy progress snapshots may omit counters; snapshot absence remains distinct. */
function metricNumber(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Compute the max content width for the current terminal, accounting for chrome. */
export function contentWidth(): number {
	return Math.max(TRUNCATE_LENGTHS.SHORT, (process.stdout.columns || 80) - 6);
}

/** Sanitize a line for TUI display and truncate it to the viewport width. */
export function sanitizeLine(text: string, maxWidth?: number): string {
	return truncateToWidth(sanitizeDisplaySingleLine(text), maxWidth ?? contentWidth());
}

export function clampHubLine(line: string, width: number): string {
	return truncateToWidth(line.replace(/[\r\n]+/g, " "), Math.max(1, width), Ellipsis.Omit);
}

/** Semantic tone of each roster status; shared by the ANSI glyphs and native spans. */
const STATUS_TONE = {
	running: "accent",
	idle: "success",
	parked: "muted",
	aborted: "error",
} as const satisfies Record<AgentStatus, TspTone & ThemeColor>;

function statusSymbol(status: AgentStatus): string {
	switch (status) {
		case "running":
			return theme.status.running;
		case "idle":
			return theme.status.enabled;
		case "parked":
			return theme.status.shadowed;
		case "aborted":
			return theme.status.aborted;
	}
}

/** Status glyph, colored per theme status conventions. The title-line counts spell out the words. */
export function statusGlyph(status: AgentRecordLike["status"]): string {
	return theme.fg(STATUS_TONE[status], statusSymbol(status));
}

/** Native tone for a roster status. */
export function statusTone(status: AgentStatus): TspTone {
	return STATUS_TONE[status];
}

/** Picker status dot per roster status: running agents take the live `pending` dot (§9.1). */
const STATUS_DOT = {
	running: "pending",
	idle: "success",
	parked: "muted",
	aborted: "error",
} as const satisfies Record<AgentStatus, TspTone>;

/** Picker row dot for a roster status. */
export function statusDot(status: AgentStatus): TspTone {
	return STATUS_DOT[status];
}

const ASSIGNMENT_PREFIX = /^\s*Complete assignment thoroughly:\s*/i;

/** One-line task summary: the subagent prompt's fixed assignment preamble is not part of the task. */
export function taskSummary(task: string): string {
	return sanitizeDisplaySingleLine(task.replace(ASSIGNMENT_PREFIX, ""));
}

/** Native span of {@link statusGlyph}. */
export function statusGlyphSpan(status: AgentStatus): TspSpan {
	return span(statusSymbol(status), STATUS_TONE[status]);
}

export function statusText(status: AgentRecordLike["status"], text: string): string {
	switch (status) {
		case "running":
			return theme.fg("accent", text);
		case "idle":
			return theme.fg("success", text);
		case "parked":
			return theme.fg("muted", text);
		case "aborted":
			return theme.fg("error", text);
	}
}

function showsThinkingLevel(level: ThinkingLevel | undefined): level is Exclude<ThinkingLevel, "off" | "inherit"> {
	return level !== undefined && level !== ThinkingLevel.Off && level !== ThinkingLevel.Inherit;
}

/** Model id, optional fast glyph, and thinking level, colored per theme. */
function formatModelBadge(modelId: string, level: ThinkingLevel | undefined, fastMode?: boolean): string {
	const model = theme.fg("muted", modelId);
	const label = fastMode && theme.icon.fast ? `${model} ${theme.fg("warning", theme.icon.fast)}` : model;
	if (!showsThinkingLevel(level)) return label;
	const display = theme.thinking[level] ?? level;
	return `${label} ${theme.getThinkingBorderColor(level)(display)}`;
}

/** Theme token matching {@link Theme.getThinkingBorderColor} for native spans. */
function thinkingToken(level: ThinkingLevel): ThemeColor {
	switch (level) {
		case ThinkingLevel.Minimal:
			return "thinkingMinimal";
		case ThinkingLevel.Low:
			return "thinkingLow";
		case ThinkingLevel.Medium:
			return "thinkingMedium";
		case ThinkingLevel.High:
			return "thinkingHigh";
		case ThinkingLevel.XHigh:
		case ThinkingLevel.Max:
			return "thinkingXhigh";
		default:
			return "thinkingOff";
	}
}

/** Host-resolved model-role label and color. */
export interface AgentRoleDisplay {
	color?: ThemeColor;
	tag?: string;
	name?: string;
}

/** Textual model-role tag; color reinforces (but never replaces) the label. */
export function formatRoleBadge(role: string, info: AgentRoleDisplay): string {
	return theme.fg(info.color ?? "muted", sanitizeDisplaySingleLine(info.tag ?? info.name ?? role));
}

/** Native span of {@link formatRoleBadge}. */
export function roleBadgeSpan(role: string, info: AgentRoleDisplay): TspSpan {
	return span(sanitizeDisplaySingleLine(info.tag ?? info.name ?? role), info.color ?? "muted");
}

/** Model label and reasoning level a hub row reports; `fallback` marks a fallback model serving. */
interface ResolvedModelBadge {
	model: string;
	level: ThinkingLevel | undefined;
	fallback: boolean;
	fastMode?: boolean;
}

/** Resolve a selector, preserving provider identity when requested. */
function resolveSelectorBadge(
	resolved: string,
	fallback: boolean,
	preserveProvider: boolean,
	fallbackLevel: ThinkingLevel | undefined,
	explicitIdentity?: string,
): ResolvedModelBadge {
	const cleanResolved = sanitizeDisplaySingleLine(resolved);
	// Model ids may themselves contain colons (`qwen3:14b`), so only treat the
	// suffix as a thinking level when it parses as one.
	const colon = cleanResolved.lastIndexOf(":");
	const explicitLevel =
		cleanResolved !== explicitIdentity && colon >= 0 ? parseThinkingLevel(cleanResolved.slice(colon + 1)) : undefined;
	const selector = explicitLevel !== undefined ? cleanResolved.slice(0, colon) : cleanResolved;
	const label = preserveProvider ? selector : selector.slice(selector.indexOf("/") + 1);
	return { model: label, level: explicitLevel ?? fallbackLevel, fallback };
}

/**
 * Resolved model + reasoning level for a hub row. Exact executor progress is
 * authoritative (and survives completion); direct live sessions are the
 * fallback for agents without an observer snapshot — the main session has no
 * snapshot at all, so its row is read straight off the live session.
 *
 * Every source reports the model that produced the row's work, never the one
 * the session merely points at: an armed fallback that has not served yet stays
 * attributed to whichever model last actually spoke.
 */
function resolveModelBadge(
	ref: AgentRecordLike,
	observed: ObservableSession | undefined,
): ResolvedModelBadge | undefined {
	// Detach captures the current policy after the completed run's monitor stopped.
	const parkedHistory = !ref.session && observed?.status !== "active" && ref.history?.resolvedModel !== undefined;
	const progress = parkedHistory ? undefined : observed?.progress;
	const historyProgress =
		parkedHistory && ref.history?.resolvedModel === observed?.progress?.resolvedModelIdentity
			? observed?.progress
			: undefined;
	const liveThinkingLevel =
		ref.session?.thinkingLevel ??
		(historyProgress?.resolvedModel
			? resolveSelectorBadge(
					historyProgress.resolvedModel,
					false,
					true,
					undefined,
					historyProgress.resolvedModelIdentity,
				).level
			: undefined);
	const serving = ref.session?.servingModel;
	const fallbackSelector =
		(serving?.isFallback && serving.served !== false ? serving.selector : undefined) ??
		(progress?.resolvedModelIsFallback ? progress.resolvedModel : undefined) ??
		(!progress?.resolvedModel && ref.history?.resolvedModelIsFallback ? ref.history.resolvedModel : undefined);
	const selector = fallbackSelector ?? progress?.resolvedModel ?? ref.history?.resolvedModel ?? serving?.selector;
	const model = ref.session?.model;
	// An armed fallback can point the session at a different model than the one shown.
	const modelIdentity = model ? `${model.provider}/${model.id}` : undefined;
	const explicitIdentity =
		(selector === progress?.resolvedModel ? progress?.resolvedModelIdentity : undefined) ??
		(selector === serving?.selector ? serving?.modelIdentity : undefined);
	const displayedIdentity =
		explicitIdentity ?? (selector ? resolveSelectorBadge(selector, false, true, undefined).model : modelIdentity);
	const servingIdentity = serving?.modelIdentity ?? serving?.selector ?? modelIdentity;
	const liveMatches =
		modelIdentity !== undefined &&
		(servingIdentity === modelIdentity || servingIdentity?.startsWith(`${modelIdentity}@`)) &&
		displayedIdentity === servingIdentity;
	const historyIdentity = ref.history?.resolvedModel;
	const historyMatches =
		historyIdentity !== undefined &&
		(historyIdentity === displayedIdentity ||
			(!explicitIdentity &&
				resolveSelectorBadge(historyIdentity, false, true, undefined).model === displayedIdentity));
	const snapshotFastMode =
		(progress && progress.resolvedModel === selector ? progress.fastMode : undefined) ??
		(historyMatches ? (ref.history?.fastMode ?? ref.history?.responseFastMode) : undefined);
	const fastMode = (liveMatches ? ref.session?.isFastModeActive?.() : undefined) ?? snapshotFastMode;
	if (selector) {
		return {
			...resolveSelectorBadge(
				selector,
				Boolean(fallbackSelector),
				Boolean(fallbackSelector),
				liveThinkingLevel,
				explicitIdentity ?? historyProgress?.resolvedModelIdentity,
			),
			fastMode,
		};
	}
	if (!model) return undefined;
	return {
		model: sanitizeDisplaySingleLine(model.id),
		level: model.thinking ? liveThinkingLevel : undefined,
		fallback: false,
		fastMode,
	};
}

/** Keep effort intact, sacrificing redundant role text before the model label. */
export function boundedModelMetadata(
	ref: AgentRecordLike,
	observed: ObservableSession | undefined,
	role: string | undefined,
	width: number,
): string {
	const badge = resolveModelBadge(ref, observed);
	const max = Math.max(0, width);
	if (!badge) return role ? truncateToWidth(role, max) : "";
	const modelText = formatModelBadge(badge.model, badge.level, badge.fastMode);
	const full = badge.fallback ? `${theme.fg("warning", "fallback →")} ${modelText}` : modelText;
	const combined = role ? `${role}${theme.sep.dot}${full}` : full;
	if (visibleWidth(combined) <= max) return combined;
	if (visibleWidth(full) <= max) {
		const roleWidth = max - visibleWidth(full) - visibleWidth(theme.sep.dot);
		const shortRole = role && roleWidth > 0 ? truncateToWidth(role, roleWidth) : "";
		return shortRole ? `${shortRole}${theme.sep.dot}${full}` : full;
	}
	const suffix = [
		badge.fastMode && theme.icon.fast ? theme.fg("warning", theme.icon.fast) : "",
		showsThinkingLevel(badge.level)
			? theme.getThinkingBorderColor(badge.level)(theme.thinking[badge.level] ?? badge.level)
			: "",
	]
		.filter(Boolean)
		.join(" ");
	const suffixWidth = visibleWidth(suffix);
	if (suffixWidth === max) return suffix;
	if (suffixWidth >= max) {
		const effort = showsThinkingLevel(badge.level)
			? theme.getThinkingBorderColor(badge.level)(theme.thinking[badge.level] ?? badge.level)
			: suffix;
		return truncateToWidth(effort, max, Ellipsis.Omit);
	}
	const modelWidth = max - suffixWidth - (suffix ? 1 : 0);
	const model = truncateToWidth(
		`${badge.fallback ? theme.fg("warning", "fallback → ") : ""}${theme.fg("muted", badge.model)}`,
		modelWidth,
		Ellipsis.Unicode,
	);
	return `${model}${model && suffix ? " " : ""}${suffix}`;
}

/** A picker chip for the model that produced a row's work: label plus thinking-level colour token. */
export interface ModelChip {
	text: string;
	/** Thinking level shown next to the model (`low`), when the model reasons. */
	level?: string;
	/** Theme token of {@link level}. */
	dot?: string;
	fallback: boolean;
	fastMode?: boolean;
}

/** Structured model metadata for picker chips. */
export function modelChip(ref: AgentRecordLike, observed: ObservableSession | undefined): ModelChip | undefined {
	const badge = resolveModelBadge(ref, observed);
	if (!badge) return undefined;
	return {
		text: badge.model,
		level: showsThinkingLevel(badge.level) ? badge.level : undefined,
		dot: showsThinkingLevel(badge.level) ? thinkingToken(badge.level) : undefined,
		fallback: badge.fallback,
		fastMode: badge.fastMode,
	};
}

/** Native spans of the resolved model metadata. */
export function modelBadgeSpans(ref: AgentRecordLike, observed: ObservableSession | undefined): TspSpan[] | undefined {
	const badge = resolveModelBadge(ref, observed);
	if (!badge) return undefined;
	const spans: TspSpan[] = [];
	if (badge.fallback) spans.push(span("fallback → ", "warning"));
	spans.push(span(badge.model, "muted"));
	if (badge.fastMode && theme.icon.fast) spans.push(span(` ${theme.icon.fast}`, "warning"));
	if (showsThinkingLevel(badge.level)) {
		spans.push(span(` ${theme.thinking[badge.level] ?? badge.level}`, thinkingToken(badge.level)));
	}
	return spans;
}

export function formatMetricDuration(metrics: AgentMetrics): string | undefined {
	const durationMs = metricNumber(metrics.durationMs);
	if (durationMs <= 0) return undefined;
	const label = metrics.durationKind === "active" ? "active" : metrics.durationKind === "span" ? "span" : "duration";
	return `${formatDuration(durationMs)} ${label}`;
}

export function formatCost(cost: number): string {
	const amount = metricNumber(cost);
	if (amount < 0.01) return `$${amount.toFixed(4)}`;
	if (amount < 1) return `$${amount.toFixed(3)}`;
	return `$${amount.toFixed(2)}`;
}

export function formatMetrics(metrics: AgentMetrics): string {
	return formatMetricRow(
		[
			{ value: formatCost(metrics.cost) },
			{ value: formatMetricDuration(metrics) ?? "time —" },
			{ value: `${formatNumber(metrics.requests)} req` },
			{ value: `${formatNumber(metrics.tools)} tools` },
			{ value: `${formatNumber(metrics.tokens)} tok` },
		],
		{ separator: theme.sep.dot },
	);
}

/** Plain-text {@link formatMetrics} for native spans. */
export function metricsText(metrics: AgentMetrics): string {
	return [
		formatCost(metrics.cost),
		formatMetricDuration(metrics) ?? "time —",
		`${formatNumber(metrics.requests)} req`,
		`${formatNumber(metrics.tools)} tools`,
		`${formatNumber(metrics.tokens)} tok`,
	].join(theme.sep.dot);
}

/** Row-grid variant of {@link formatMetrics}: fixed-width cells so every agent's metadata
 * line shares one column layout instead of flowing after wrapped text. Cost is left-aligned
 * so the line starts flush; the numeric cells are right-aligned so units line up. */
export function formatMetricColumns(metrics: AgentMetrics, age: string): string {
	return renderTableRow(
		[
			{ text: formatCost(metrics.cost) },
			{ text: formatMetricDuration(metrics) ?? "—" },
			{ text: `${formatNumber(metrics.requests)} req` },
			{ text: `${formatNumber(metrics.tools)} tools` },
			{ text: `${formatNumber(metrics.tokens)} tok` },
			{ text: age },
		],
		[
			{ width: 8, align: "left", overflow: "allow" },
			{ width: 13, align: "right", overflow: "truncate" },
			{ width: 8, align: "right", overflow: "truncate" },
			{ width: 9, align: "right", overflow: "truncate" },
			{ width: 8, align: "right", overflow: "truncate" },
			{ width: 8, align: "right", overflow: "truncate" },
		],
		undefined,
		{ gap: " ", fit: false },
	);
}

export function contextGauge(tokens: number, window: number): string {
	const ratio = Math.max(0, Math.min(1, tokens / window));
	const bar = renderProgressBar(ratio, 10, {
		min: 0,
		max: 1,
		style: {
			filled: "━",
			empty: "─",
			styleFilled: text => theme.fg("accent", text),
			styleEmpty: text => theme.fg("dim", text),
		},
	});
	return `${bar} ${formatNumber(tokens)}/${formatNumber(window)} ${Math.round(ratio * 100)}%`;
}

/** Fit a child-id preview without joining an arbitrarily large child set. */
export function formatChildIds(children: readonly AgentRecordLike[], width: number): string {
	const max = Math.max(1, width);
	let shown = 0;
	let text = "";
	while (shown < children.length) {
		const id = sanitizeLine(children[shown].id, max);
		const candidate = text ? `${text}, ${id}` : id;
		const remaining = children.length - shown - 1;
		const suffix = remaining > 0 ? `, … +${remaining}` : "";
		if (visibleWidth(candidate + suffix) > max) {
			const includesCurrent = text.length === 0;
			const omitted = children.length - shown - Number(includesCurrent);
			return truncateToWidth(`${includesCurrent ? id : text}${omitted > 0 ? `, … +${omitted}` : ""}`, max);
		}
		text = candidate;
		shown++;
	}
	return text;
}
const TREE_SEGMENT_WIDTH = 4;
const TREE_DETAIL_BASE_INDENT = 4;

/** Build one bash `tree`-style ancestry prefix. Continuation rows replace the
 * node's own branch with a rail only when a later sibling still needs it. */
function treePrefix(
	ref: AgentRecordLike,
	maxWidth: number,
	depthById: ReadonlyMap<string, number>,
	parentById: ReadonlyMap<string, string>,
	lastSiblingById: ReadonlyMap<string, boolean>,
	continuation: boolean,
): string {
	if ((depthById.get(ref.id) ?? 0) === 0) return "";
	const lastSibling = lastSiblingById.get(ref.id);
	const segments: string[] = [continuation ? (lastSibling ? "    " : "│   ") : lastSibling ? "└── " : "├── "];
	const ancestry = new Set<string>();
	let parent = parentById.get(ref.id);
	while (parent && parent !== MAIN_AGENT_ID && !ancestry.has(parent)) {
		const grandparent = parentById.get(parent);
		// A bare top-level parent (drawn without a connector, just its dot) has no
		// rail column — its children's connectors sit directly under that dot.
		if (!grandparent || grandparent === MAIN_AGENT_ID) break;
		ancestry.add(parent);
		segments.push(lastSiblingById.get(parent) ? "    " : "│   ");
		parent = grandparent;
	}
	const maxSegments = Math.max(1, Math.floor(Math.max(TREE_SEGMENT_WIDTH, maxWidth - 2) / TREE_SEGMENT_WIDTH));
	const omitted = Math.max(0, segments.length - maxSegments);
	const prefix = segments.slice(0, maxSegments).reverse().join("");
	const omittedPrefix = omitted > 0 ? (continuation ? "  " : "… ") : "";
	return theme.fg("dim", `${omittedPrefix}${prefix}`);
}

/** Bash `tree`-style branch for an agent's identity row. */
export function treeBranch(
	ref: AgentRecordLike,
	maxWidth: number,
	depthById: ReadonlyMap<string, number>,
	parentById: ReadonlyMap<string, string>,
	lastSiblingById: ReadonlyMap<string, boolean>,
): string {
	return treePrefix(ref, maxWidth, depthById, parentById, lastSiblingById, false);
}

/** Ancestry rails for the task and metrics rows beneath an agent identity. */
export function treeContinuation(
	ref: AgentRecordLike,
	maxWidth: number,
	depthById: ReadonlyMap<string, number>,
	parentById: ReadonlyMap<string, string>,
	lastSiblingById: ReadonlyMap<string, boolean>,
): string {
	return treePrefix(ref, maxWidth, depthById, parentById, lastSiblingById, true);
}
/** One roster-wide origin for metric columns, independent of tree depth. */
export function treeMetadataIndent(maxWidth: number, maxDepth: number): number {
	return Math.min(Math.max(0, maxWidth - 1), TREE_DETAIL_BASE_INDENT + Math.max(0, maxDepth) * TREE_SEGMENT_WIDTH);
}

/** Right-align `text` inside a fixed-width cell, truncating overflow. */
export function alignRightCell(text: string, width: number): string {
	return renderTableRow([{ text }], [{ width, align: "right", overflow: "truncate" }], undefined, {
		fit: false,
	});
}
