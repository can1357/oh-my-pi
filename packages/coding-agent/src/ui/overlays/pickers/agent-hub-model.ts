/**
 * What the Agent Hub derives from the registry, shared by the screen (its
 * native picker) and its terminal look: roster order and the by-parent tree,
 * status glyphs and tones, the model a row's work came from, activity glyphs,
 * clocks and the usage formats.
 */
import { formatDuration, formatNumber } from "@oh-my-pi/pi-utils";
import { type TspSpan, type TspTone, toolIntentLabel } from "@oh-my-pi/pi-wire";
import { sanitizeDisplaySingleLine } from "../../../extensibility/inventory/display-text";
import type { AgentActivityKind, AgentActivityRow } from "../../../modes/view-model/overlays/agent-activity";
import type { AgentMetrics } from "../../../modes/view-model/overlays/agent-hub-projection";
import { type AgentRecordLike, type AgentStatus, MAIN_AGENT_ID } from "../../../registry/agent-hub-types";
import type { ObservableSession } from "../../../task/session-observer-registry";
import { parseThinkingLevel } from "../../../thinking/levels";

/** The roster's lifecycle order: live first, killed last. */
export const STATUS_ORDER: Readonly<Record<AgentStatus, number>> = { running: 0, idle: 1, parked: 2, aborted: 3 };

/** Color of each status (glyphs, counts, the inspector's status word). */
export const STATUS_COLOR: Readonly<Record<AgentStatus, string>> = {
	running: "accent",
	idle: "success",
	parked: "muted",
	aborted: "error",
};

/** Picker dot per status: running agents take the live `pending` dot. */
export const STATUS_DOT: Readonly<Record<AgentStatus, TspTone>> = {
	running: "pending",
	idle: "success",
	parked: "muted",
	aborted: "error",
};

/** Symbol key of each status glyph. */
export const STATUS_SYMBOL: Readonly<Record<AgentStatus, string>> = {
	running: "status.running",
	idle: "status.enabled",
	parked: "status.shadowed",
	aborted: "status.aborted",
};

const ASSIGNMENT_PREFIX = /^\s*Complete assignment thoroughly:\s*/i;

/** One-line task summary: the subagent prompt's fixed assignment preamble is not part of the task. */
export function taskSummary(task: string): string {
	return sanitizeDisplaySingleLine(task.replace(ASSIGNMENT_PREFIX, ""));
}

/** What a row's agent is working on: the observer's description, its progress task, else its own activity line. */
export function agentTask(ref: AgentRecordLike, observed: ObservableSession | undefined): string | undefined {
	return observed?.description ?? observed?.progress?.task ?? ref.activity;
}

/** What the agent does right now: its current tool (and args), its last intent, else its activity line. */
export function agentCurrent(
	ref: AgentRecordLike,
	observed: ObservableSession | undefined,
	sep: string,
): string | undefined {
	const progress = observed?.progress;
	if (progress?.currentTool) {
		return `${progress.currentTool}${progress.currentToolArgs ? `${sep}${progress.currentToolArgs}` : ""}`;
	}
	return progress?.lastIntent === undefined ? ref.activity : toolIntentLabel(progress.lastIntent);
}

/** Host-resolved model-role label and color. */
export interface AgentRoleDisplay {
	color?: string;
	tag?: string;
	name?: string;
}

/** The role badge text and color of a row (its tag, else name, else the role id). */
export function roleBadge(role: string, info: AgentRoleDisplay): { text: string; color: string } {
	return { text: sanitizeDisplaySingleLine(info.tag ?? info.name ?? role), color: info.color ?? "muted" };
}

/** The model a row's work came from, with its reasoning level; `fallback` marks a fallback model serving. */
export interface HubModel {
	readonly text: string;
	/** Reasoning level shown after the model (`high`), when it reasons. */
	readonly level?: string;
	/** Theme color of {@link level}. */
	readonly levelColor?: string;
	readonly fallback: boolean;
}

const THINKING_COLOR: Readonly<Record<string, string>> = {
	minimal: "thinkingMinimal",
	low: "thinkingLow",
	medium: "thinkingMedium",
	high: "thinkingHigh",
	xhigh: "thinkingXhigh",
	max: "thinkingXhigh",
};

function shownLevel(level: string | undefined): string | undefined {
	return level !== undefined && level !== "off" && level !== "inherit" ? level : undefined;
}

/** `provider/model:level` as the badge shows it: the level split off when it parses as one. */
function selectorModel(selector: string, fallback: boolean, liveLevel: string | undefined): HubModel {
	const clean = sanitizeDisplaySingleLine(selector);
	const colon = clean.lastIndexOf(":");
	const explicit = colon >= 0 ? parseThinkingLevel(clean.slice(colon + 1)) : undefined;
	const model = explicit !== undefined ? clean.slice(0, colon) : clean;
	const level = shownLevel(explicit ?? liveLevel);
	return {
		// A fallback keeps its provider: which provider took over is the point.
		text: fallback ? model : model.slice(model.indexOf("/") + 1),
		...(level ? { level, levelColor: THINKING_COLOR[level] ?? "thinkingOff" } : {}),
		fallback,
	};
}

/**
 * The model that produced a row's work: a serving fallback first, then the
 * exact model progress or history resolved, then the live session's model.
 */
export function hubModel(ref: AgentRecordLike, observed: ObservableSession | undefined): HubModel | undefined {
	const progress = observed?.progress;
	const liveLevel = ref.session?.thinkingLevel;
	const serving = ref.session?.servingModel;
	const fallback =
		(serving?.isFallback ? serving.selector : undefined) ??
		(progress?.resolvedModelIsFallback ? progress.resolvedModel : undefined) ??
		(ref.history?.resolvedModelIsFallback ? ref.history.resolvedModel : undefined);
	if (fallback) return selectorModel(fallback, true, liveLevel);
	const resolved = progress?.resolvedModel ?? ref.history?.resolvedModel ?? serving?.selector;
	if (resolved) return selectorModel(resolved, false, liveLevel);
	const model = ref.session?.model;
	if (!model) return undefined;
	const level = model.thinking ? shownLevel(ref.session?.thinkingLevel) : undefined;
	return {
		text: sanitizeDisplaySingleLine(model.id),
		...(level ? { level, levelColor: THINKING_COLOR[level] ?? "thinkingOff" } : {}),
		fallback: false,
	};
}

/** `$0.0421`, `$0.389`, `$12.30`. */
export function formatCost(cost: number): string {
	const amount = Number.isFinite(cost) ? cost : 0;
	if (amount < 0.01) return `$${amount.toFixed(4)}`;
	if (amount < 1) return `$${amount.toFixed(3)}`;
	return `$${amount.toFixed(2)}`;
}

/** `1m5s active` (the duration's kind); undefined without a duration. */
export function formatMetricDuration(metrics: AgentMetrics): string | undefined {
	const ms = Number.isFinite(metrics.durationMs) ? metrics.durationMs : 0;
	if (ms <= 0) return undefined;
	const kind = metrics.durationKind === "active" ? "active" : metrics.durationKind === "span" ? "span" : "duration";
	return `${formatDuration(ms)} ${kind}`;
}

/** `$0.042 · 1m5s active · 4 req · 9 tools · 12K tok`. */
export function metricsText(metrics: AgentMetrics, sep: string): string {
	return [
		formatCost(metrics.cost),
		formatMetricDuration(metrics) ?? "time —",
		`${formatNumber(metrics.requests)} req`,
		`${formatNumber(metrics.tools)} tools`,
		`${formatNumber(metrics.tokens)} tok`,
	].join(sep);
}

/** Children named by the inspector before the rest are counted. */
export const NATIVE_CHILD_IDS = 12;

// ─── Roster order ───────────────────────────────────────────────────────────

/** A row's rank, frozen when the hub first saw its generation. */
export interface FrozenRank {
	readonly id: string;
	readonly status: AgentStatus;
	readonly lastActivity: number;
	/** 0 for agents the hub opened with (or the saved-agent scan found); each later batch of new generations is one lower. */
	readonly batch: number;
}

/** Newer spawn batches first, then lifecycle order, recency and id. */
export function compareFrozenRanks(a: FrozenRank, b: FrozenRank): number {
	return (
		a.batch - b.batch ||
		STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
		b.lastActivity - a.lastActivity ||
		a.id.localeCompare(b.id)
	);
}

/** The by-parent projection: rows parent before child, each child's depth, parent and sibling position. */
export interface AgentTree<T extends AgentRecordLike> {
	readonly rows: T[];
	readonly depthById: Map<string, number>;
	readonly parentById: Map<string, string>;
	readonly lastSiblingById: Map<string, boolean>;
}

/**
 * Group `refs` (in roster order) under their spawners. A group sits where its
 * earliest row would; a child spawned while the hub is open never lifts its
 * parent's group. Parents outside `refs` (or cycles) leave rows at the top.
 */
export function projectAgentTree<T extends AgentRecordLike>(
	refs: readonly T[],
	spawnedWhileOpen: (ref: T) => boolean,
): AgentTree<T> {
	const order = new Map<string, number>();
	refs.forEach((ref, index) => order.set(ref.id, index));
	const parentById = new Map<string, string>();
	const children = new Map<string, T[]>();
	for (const ref of refs) {
		const parent =
			ref.parentId && ref.parentId !== MAIN_AGENT_ID && order.has(ref.parentId) ? ref.parentId : MAIN_AGENT_ID;
		parentById.set(ref.id, parent);
		const siblings = children.get(parent);
		if (siblings) siblings.push(ref);
		else children.set(parent, [ref]);
	}
	// A group's place: the earliest row of its subtree (post-order, without recursion).
	const groupOrder = new Map<string, number>();
	const done = new Set<string>();
	const open = new Set<string>();
	for (const start of refs) {
		const stack: { ref: T; expanded: boolean }[] = [{ ref: start, expanded: false }];
		while (stack.length > 0) {
			const { ref, expanded } = stack.pop()!;
			if (expanded) {
				const own = order.get(ref.id)!;
				let at = own;
				for (const child of children.get(ref.id) ?? []) {
					if (spawnedWhileOpen(child) && order.get(child.id)! < own) continue;
					at = Math.min(at, groupOrder.get(child.id) ?? Number.MAX_SAFE_INTEGER);
				}
				groupOrder.set(ref.id, at);
				open.delete(ref.id);
				done.add(ref.id);
				continue;
			}
			if (done.has(ref.id) || open.has(ref.id)) continue;
			open.add(ref.id);
			stack.push({ ref, expanded: true });
			for (const child of (children.get(ref.id) ?? []).toReversed()) {
				if (!done.has(child.id) && !open.has(child.id)) stack.push({ ref: child, expanded: false });
			}
		}
	}
	const lastSiblingById = new Map<string, boolean>();
	for (const siblings of children.values()) {
		siblings.sort((a, b) => groupOrder.get(a.id)! - groupOrder.get(b.id)! || order.get(a.id)! - order.get(b.id)!);
		siblings.forEach((ref, index) => lastSiblingById.set(ref.id, index === siblings.length - 1));
	}
	const rows: T[] = [];
	const depthById = new Map<string, number>();
	const visit = (root: T): void => {
		const stack = [{ ref: root, depth: 0 }];
		while (stack.length > 0) {
			const { ref, depth } = stack.pop()!;
			if (depthById.has(ref.id)) continue;
			depthById.set(ref.id, depth);
			rows.push(ref);
			for (const child of (children.get(ref.id) ?? []).toReversed()) stack.push({ ref: child, depth: depth + 1 });
		}
	};
	for (const root of children.get(MAIN_AGENT_ID) ?? []) visit(root);
	// Rows a parent cycle cut off from the top still show, as roots.
	for (const ref of refs) visit(ref);
	return { rows, depthById, parentById, lastSiblingById };
}

/**
 * The tree rails of a row, innermost first: its own connector (`├── `,
 * `└── `; `│   `/`    ` on its continuation rows) then one rail per ancestor
 * below the top level. Empty for top-level rows.
 */
export function treeSegments<T extends AgentRecordLike>(ref: T, tree: AgentTree<T>, continuation: boolean): string[] {
	if ((tree.depthById.get(ref.id) ?? 0) === 0) return [];
	const last = tree.lastSiblingById.get(ref.id);
	const segments = [continuation ? (last ? "    " : "│   ") : last ? "└── " : "├── "];
	const seen = new Set<string>();
	let parent = tree.parentById.get(ref.id);
	while (parent && parent !== MAIN_AGENT_ID && !seen.has(parent)) {
		const grandparent = tree.parentById.get(parent);
		// A top-level parent draws no connector: its children hang directly under its glyph.
		if (!grandparent || grandparent === MAIN_AGENT_ID) break;
		seen.add(parent);
		segments.push(tree.lastSiblingById.get(parent) ? "    " : "│   ");
		parent = grandparent;
	}
	return segments;
}

// ─── Activity ───────────────────────────────────────────────────────────────

/** Native icon of each activity kind. */
export const ACTIVITY_KIND_ICON: Readonly<Record<AgentActivityKind, string>> = {
	response: "message",
	tool: "wrench",
	irc: "send",
	lifecycle: "activity",
};

/** An activity row's glyph and its color: its outcome when it failed, stopped or runs, else its kind's mark. */
export function activityGlyph(row: AgentActivityRow): { symbol?: string; text?: string; color: string } | undefined {
	if (row.status === "error") return { symbol: "status.error", color: "error" };
	if (row.status === "aborted") return { symbol: "status.aborted", color: "warning" };
	if (row.status === "pending") return { symbol: "status.running", color: "accent" };
	switch (row.kind) {
		case "response":
			return { text: "◆", color: "success" };
		case "tool":
			return { symbol: "status.success", color: "success" };
		case "irc":
			return { text: "→", color: "accent" };
		case "lifecycle":
			return { text: "○", color: "muted" };
	}
	return undefined;
}

/** The activity's name: a tool's name, else its title. */
export function activityTitle(row: AgentActivityRow): string {
	return row.kind === "tool" ? (row.toolName ?? row.title) : row.title;
}

/** The activity's summary as shown: a tool intent's label, else the summary. */
export function activitySummary(row: AgentActivityRow): string {
	return row.summaryIsToolIntent ? toolIntentLabel(row.summary) : row.summary;
}

const CLOCK = new Intl.DateTimeFormat(undefined, {
	hour: "2-digit",
	minute: "2-digit",
	second: "2-digit",
	hour12: false,
});

/** `21:59:20` in local time. */
export function activityClock(timestamp: number): string {
	return CLOCK.format(timestamp);
}

/** `2023-11-14 21:13 +00:00`: local date and minute with the UTC offset. */
export function localDateTime(at: number): string {
	const date = new Date(at);
	const pad = (value: number): string => String(value).padStart(2, "0");
	const offset = -date.getTimezoneOffset();
	const sign = offset >= 0 ? "+" : "-";
	const abs = Math.abs(offset);
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())} ${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** A span (TSP) of plain text with an optional style. */
export function span(t: string, s?: string): TspSpan {
	return s ? { t, s } : { t };
}
