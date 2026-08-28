import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { Ellipsis, visibleWidth } from "@oh-my-pi/pi-tui";
import { formatDuration, formatNumber, sanitizeText } from "@oh-my-pi/pi-utils";
import { getRoleInfo } from "../../config/model-roles";
import type { Settings } from "../../config/settings";
import { type AgentRef, MAIN_AGENT_ID } from "../../registry/agent-registry";
import { parseThinkingLevel } from "../../thinking";
import { replaceTabs, TRUNCATE_LENGTHS, truncateToWidth } from "../../tools/render-utils";
import type { ObservableSession } from "../session-observer-registry";
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

/** Remove terminal controls and normalize a value before it reaches the TUI. */
export function sanitizeDisplayText(text: string): string {
	return replaceTabs(sanitizeText(text)).replace(/[\r\n]+/g, " ");
}

/** Sanitize a line for TUI display and truncate it to the viewport width. */
export function sanitizeLine(text: string, maxWidth?: number): string {
	return truncateToWidth(sanitizeDisplayText(text), maxWidth ?? contentWidth());
}

export function clampHubLine(line: string, width: number): string {
	return truncateToWidth(line.replace(/[\r\n]+/g, " "), Math.max(1, width), Ellipsis.Omit);
}

/** Status glyph, colored per theme status conventions. The title-line counts spell out the words. */
export function statusGlyph(status: AgentRef["status"]): string {
	switch (status) {
		case "running":
			return theme.fg("accent", theme.status.running);
		case "idle":
			return theme.fg("success", theme.status.enabled);
		case "parked":
			return theme.fg("muted", theme.status.shadowed);
		case "aborted":
			return theme.fg("error", theme.status.aborted);
	}
}

export function statusText(status: AgentRef["status"], text: string): string {
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

/** Model id + thinking level (`sonnet-4-6 ◒ high`), level colored per theme. */
function formatModelBadge(modelId: string, level: ThinkingLevel | undefined): string {
	const model = theme.fg("muted", sanitizeDisplayText(modelId));
	if (!level || level === ThinkingLevel.Off || level === ThinkingLevel.Inherit) return model;
	const display = theme.thinking[level as keyof typeof theme.thinking] ?? level;
	return `${model} ${theme.getThinkingBorderColor(level)(display)}`;
}

/** Textual model-role tag; color reinforces (but never replaces) the label. */
export function formatRoleBadge(role: string, settings: Settings): string {
	const info = getRoleInfo(role, settings);
	return theme.fg(info.color ?? "muted", sanitizeDisplayText(info.tag ?? info.name ?? role));
}

/** Format a resolved selector, preserving provider identity when requested. */
function formatResolvedModelBadge(resolved: string, preserveProvider = false, fallbackLevel?: ThinkingLevel): string {
	const cleanResolved = sanitizeDisplayText(resolved);
	// Model ids may themselves contain colons (`qwen3:14b`), so only treat the
	// suffix as a thinking level when it parses as one.
	const colon = cleanResolved.lastIndexOf(":");
	const explicitLevel = colon >= 0 ? parseThinkingLevel(cleanResolved.slice(colon + 1)) : undefined;
	const selector = explicitLevel !== undefined ? cleanResolved.slice(0, colon) : cleanResolved;
	const label = preserveProvider ? selector : selector.slice(selector.indexOf("/") + 1);
	return formatModelBadge(label, explicitLevel ?? fallbackLevel);
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
export function modelBadge(ref: AgentRef, observed: ObservableSession | undefined): string | undefined {
	const progress = observed?.progress;
	const liveThinkingLevel = ref.session?.thinkingLevel;
	const serving = ref.session?.servingModel;
	const fallbackSelector =
		(serving?.isFallback ? serving.selector : undefined) ??
		(progress?.resolvedModelIsFallback ? progress.resolvedModel : undefined) ??
		(ref.history?.resolvedModelIsFallback ? ref.history.resolvedModel : undefined);
	if (fallbackSelector) {
		return `${theme.fg("warning", "fallback →")} ${formatResolvedModelBadge(fallbackSelector, true, liveThinkingLevel)}`;
	}
	const resolvedModel = progress?.resolvedModel ?? ref.history?.resolvedModel ?? serving?.selector;
	if (resolvedModel) return formatResolvedModelBadge(resolvedModel, false, liveThinkingLevel);
	const model = ref.session?.model;
	if (!model) return undefined;
	const level = model.thinking ? liveThinkingLevel : undefined;
	return formatModelBadge(model.id, level);
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
	return [
		formatCost(metrics.cost),
		formatMetricDuration(metrics) ?? "time —",
		`${formatNumber(metrics.requests)} req`,
		`${formatNumber(metrics.tools)} tools`,
		`${formatNumber(metrics.tokens)} tok`,
	].join(theme.sep.dot);
}

export function contextGauge(tokens: number, window: number): string {
	const ratio = Math.max(0, Math.min(1, tokens / window));
	const filled = Math.round(ratio * 10);
	return `${theme.fg("accent", "━".repeat(filled))}${theme.fg("dim", "─".repeat(10 - filled))} ${formatNumber(tokens)}/${formatNumber(window)} ${Math.round(ratio * 100)}%`;
}

/** Fit a child-id preview without joining an arbitrarily large child set. */
export function formatChildIds(children: readonly AgentRef[], width: number): string {
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

/** Bash `tree`-style ancestry prefix, clipped from the left on pathological depth. */
export function treeBranch(
	ref: AgentRef,
	maxWidth: number,
	depthById: ReadonlyMap<string, number>,
	parentById: ReadonlyMap<string, string>,
	lastSiblingById: ReadonlyMap<string, boolean>,
): string {
	if ((depthById.get(ref.id) ?? 0) === 0) return "";
	const segments: string[] = [lastSiblingById.get(ref.id) ? "└── " : "├── "];
	const ancestry = new Set<string>();
	let parent = parentById.get(ref.id);
	while (parent && parentById.get(parent) !== MAIN_AGENT_ID && !ancestry.has(parent)) {
		ancestry.add(parent);
		segments.push(lastSiblingById.get(parent) ? "    " : "│   ");
		parent = parentById.get(parent);
	}
	const maxSegments = Math.max(1, Math.floor(Math.max(4, maxWidth - 2) / 4));
	const omitted = Math.max(0, segments.length - maxSegments);
	const prefix = segments.slice(0, maxSegments).reverse().join("");
	return theme.fg("dim", `${omitted > 0 ? "… " : ""}${prefix}`);
}
