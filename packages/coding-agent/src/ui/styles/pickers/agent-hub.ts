/**
 * The Agent Hub in the terminal (`term.look = "omp.hub"`): a rounded box
 * filling the terminal's rows.
 *
 * - Agents, wide (≥ 96 columns): the roster beside the selected agent's
 *   inspector, split under a `┬`. The roster leads with the projection
 *   switch and status counts, then the usage line, then the entries (status
 *   glyph, id in the agent's colour, parent, unread count, role and model on
 *   the right; the task and usage under it), windowed around the selection.
 * - Agents, narrow: the roster alone; Tab swaps in the inspector.
 * - Activity: the section tabs, the scope/filter/follow/search line and one
 *   row per event, following the newest.
 *
 * The key hints sit under a rule. Row hits name the agent or event under the
 * pointer; the hovered entry is highlighted.
 */
import { formatNumber } from "@oh-my-pi/pi-utils";
import type { Hit, PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { definePickerLook, PICKER_HOVER, pickerState, sheetHit } from "@oh-my-pi/pi-tui/term/painters/picker";
import { pickerStep } from "@oh-my-pi/pi-tui/term/widgets/picker";
import { defineRoleWidget } from "@oh-my-pi/pi-tui/term/widgets";
import type { UiNode } from "@oh-my-pi/pi-tui";
import type { PickerTerm } from "@oh-my-pi/pi-tui/term/painters/picker";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { padTo, spaces, truncate, visibleWidth, wrap } from "@oh-my-pi/pi-tui/text/width";
import { sanitizeDisplaySingleLine } from "../../../extensibility/inventory/display-text";
import type { AggregateMetrics, AgentMetrics } from "../../../modes/view-model/overlays/agent-hub-projection";
import type { AgentStatus } from "../../../registry/agent-hub-types";
import {
	formatCost,
	formatMetricDuration,
	type HubModel,
	metricsText,
	STATUS_COLOR,
	STATUS_SYMBOL,
} from "../../overlays/pickers/agent-hub-model";
import { agentColored } from "../../tools/agent-identity";
import { bindingGlyph } from "../panels/common";

/** A row's role badge. */
export interface HubBadge {
	readonly text: string;
	readonly color: string;
}

/** One roster entry. */
export interface HubEntry {
	readonly id: string;
	readonly status: AgentStatus;
	/** The spawner shown as `↳ parent` (flat roster, below the top level). */
	readonly parent?: string;
	readonly readOnly: boolean;
	readonly unread: number;
	readonly role?: HubBadge;
	readonly model?: HubModel;
	readonly task?: string;
	/** `just now`, `10m ago`. */
	readonly age: string;
	readonly metrics?: AgentMetrics;
	/** Tree rails of the identity row, innermost first (empty at the top level and in the flat roster). */
	readonly branch: readonly string[];
	/** Tree rails of the rows under it. */
	readonly continuation: readonly string[];
	readonly hasChildren: boolean;
}

/** The roster's entries, built on demand: the look reads only the window it shows. */
export interface HubEntries {
	readonly length: number;
	at(index: number): HubEntry;
}

/** An activity glyph: a theme symbol or literal text, colored. */
export interface HubGlyph {
	readonly symbol?: string;
	readonly text?: string;
	readonly color: string;
}

/** One recent-activity line of the inspector. */
export interface HubRecentLine {
	readonly clock: string;
	readonly glyph?: HubGlyph;
	readonly title: string;
	readonly summary: string;
}

/** The selected agent's inspector. */
export interface HubDetail {
	readonly id: string;
	readonly name: string;
	readonly status: AgentStatus;
	readonly duration?: string;
	readonly active: string;
	readonly role?: HubBadge;
	readonly model?: HubModel;
	readonly task?: string;
	readonly current?: string;
	readonly retry?: string;
	readonly metrics?: AgentMetrics;
	readonly parent: string;
	readonly children: readonly string[];
	readonly registered: string;
	readonly readOnly: boolean;
	/** `Output …`, `Patch …`, `Worktree branch …` lines. */
	readonly artifacts: readonly string[];
	/** Its newest activity, oldest first. */
	readonly recent: readonly HubRecentLine[];
}

/** A text field's state. */
export interface HubField {
	readonly text: string;
	readonly cursor: number;
	readonly editing: boolean;
}

export interface HubAgentsView {
	readonly viewMode: "roster" | "tree";
	readonly counts: Readonly<Record<AgentStatus, number>>;
	readonly aggregate: AggregateMetrics;
	readonly notice?: string;
	/** The saved-agent scan still runs. */
	readonly loading: boolean;
	readonly filter: HubField;
	readonly entries: HubEntries;
	readonly selected: number;
	readonly treeMaxDepth: number;
	/** Tab swapped the inspector in (narrow terminals). */
	readonly narrowDetails: boolean;
	readonly detail?: HubDetail;
}

/** One activity-log row. */
export interface HubActivityLine extends HubRecentLine {
	readonly id: string;
	readonly agent: string;
	readonly role?: HubBadge;
	readonly response: boolean;
}

export interface HubActivityView {
	/** `all agents`, `Alpha`, `Alpha subtree`. */
	readonly scope: string;
	readonly filter: string;
	readonly follow: boolean;
	readonly search: HubField;
	readonly rows: readonly HubActivityLine[];
	readonly selected: number;
}

/** The look's term facts. */
export type HubLookTerm = PickerTerm & {
	readonly look: "omp.hub";
	/** Routes the terminal's pointer through the hub's widget (hover, wheel, click-to-open). */
	readonly role: "omp.hub";
	readonly hub:
		| { readonly section: "agents"; readonly height: number; readonly agents: HubAgentsView }
		| { readonly section: "activity"; readonly height: number; readonly activity: HubActivityView };
};

/** The two panes need this many columns. */
const SPLIT_MIN_WIDTH = 96;
const ROSTER_MIN_WIDTH = 48;
const DETAIL_MIN_WIDTH = 34;
const ROSTER_RATIO = 0.58;
/** Columns the split's borders and divider take (`│ ` … ` │ ` … ` │`). */
const SPLIT_CHROME = 7;
/** Rows the frame takes around the body: top border, rule, hints, bottom border. */
const FRAME_ROWS = 4;
const TREE_SEGMENT_WIDTH = 4;
const TREE_DETAIL_BASE_INDENT = 4;
/** Hints shorten below this inner width. */
const FULL_HINTS_WIDTH = 96;
/** A PgUp/PgDn scrolls the inspector by this many rows. */
const DETAIL_SCROLL_STEP = 5;
/** Lines are cut to this before they are wrapped (the old content width for an 80-column terminal). */
const LINE_WIDTH = 74;

/** A row hit before the node is known. */
type RowHit = Omit<Hit, "node">;

/** Paint context pieces every function below needs. */
interface Pen {
	readonly theme: Theme;
	readonly sep: string;
	readonly dimSep: string;
	glyph(symbol: string): string;
}

function penOf(theme: Theme): Pen {
	const sep = theme.symbols.symbol("sep.dot");
	return { theme, sep, dimSep: theme.fg("dim", sep), glyph: symbol => theme.symbols.symbol(symbol) };
}

function oneLine(text: string, width = LINE_WIDTH): string {
	return truncate(sanitizeDisplaySingleLine(text), width);
}

function statusGlyph(pen: Pen, status: AgentStatus): string {
	return pen.theme.fg(STATUS_COLOR[status], pen.glyph(STATUS_SYMBOL[status]));
}

function glyphText(pen: Pen, glyph: HubGlyph | undefined): string {
	if (!glyph) return "";
	return pen.theme.fg(glyph.color, glyph.text ?? pen.glyph(glyph.symbol!));
}

/** `claude-haiku ◒ high`, a fallback led by `fallback →`. */
function modelBadge(pen: Pen, model: HubModel | undefined): string | undefined {
	if (!model) return undefined;
	const { theme } = pen;
	let text = theme.fg("muted", model.text);
	if (model.level)
		text += ` ${theme.fg(model.levelColor ?? "thinkingOff", pen.glyph(`thinking.${model.level}`) || model.level)}`;
	return model.fallback ? `${theme.fg("warning", "fallback →")} ${text}` : text;
}

/** Role and model, joined: what an entry's right side and the inspector's model line show. */
function modelLine(pen: Pen, role: HubBadge | undefined, model: HubModel | undefined): string {
	const parts: string[] = [];
	if (role) parts.push(pen.theme.fg(role.color, role.text));
	const badge = modelBadge(pen, model);
	if (badge) parts.push(badge);
	return parts.join(pen.sep);
}

/** A text field as drawn while edited: the text with its caret cell in reverse video. */
function fieldText(field: HubField): string {
	const { text, cursor } = field;
	const at = text.slice(cursor, cursor + 1) || " ";
	return `${text.slice(0, cursor)}\x1b[7m${at}\x1b[27m${text.slice(cursor + 1)}`;
}

// ─── Frame ──────────────────────────────────────────────────────────────────

function border(pen: Pen, text: string): string {
	return pen.theme.fg("border", text);
}

function titledEdge(pen: Pen, title: string, length: number): string {
	const box = pen.theme.symbols.box;
	const shown = truncate(` ${title} `, Math.max(0, length - 1));
	return `${border(pen, `${box.topLeft}${box.horizontal}`)}${pen.theme.fg("accent", pen.theme.style("strong", shown))}${border(pen, box.horizontal.repeat(Math.max(0, length - 1 - visibleWidth(shown))))}`;
}

function topBorder(pen: Pen, width: number, title: string): string {
	const box = pen.theme.symbols.box;
	const inner = Math.max(0, width - 2);
	const shown = truncate(` ${title} `, Math.max(0, inner - 2));
	const fill = Math.max(0, inner - 1 - visibleWidth(shown));
	return `${border(pen, `${box.topLeft}${box.horizontal}`)}${pen.theme.style("strong", pen.theme.fg("accent", shown))}${border(pen, `${box.horizontal.repeat(fill)}${box.topRight}`)}`;
}

function frameRow(pen: Pen, content: string, width: number): string {
	const bar = border(pen, pen.theme.symbols.box.vertical);
	return `${bar} ${width > 4 ? padTo(truncate(content, width - 4), width - 4) : ""} ${bar}`;
}

function rule(pen: Pen, width: number, splitAt?: number): string {
	const box = pen.theme.symbols.box;
	if (splitAt === undefined)
		return border(pen, `${box.teeRight}${box.horizontal.repeat(Math.max(0, width - 2))}${box.teeLeft}`);
	const left = splitAt + 2;
	return border(
		pen,
		`${box.teeRight}${box.horizontal.repeat(left)}${box.teeUp}${box.horizontal.repeat(Math.max(0, width - 3 - left))}${box.teeLeft}`,
	);
}

function bottomBorder(pen: Pen, width: number): string {
	const box = pen.theme.symbols.box;
	return border(pen, `${box.bottomLeft}${box.horizontal.repeat(Math.max(0, width - 2))}${box.bottomRight}`);
}

/** Frame rows with the body; a terminal too short for the chrome keeps the title and the hints. */
function fitFrame(lines: string[], width: number, height: number): string[] {
	const clamped = lines.map(line => truncate(line.replace(/[\r\n]+/g, " "), Math.max(1, width), ""));
	if (clamped.length <= height) return clamped;
	const footer = Math.min(3, clamped.length);
	return [...clamped.slice(0, Math.max(0, height - footer)), ...clamped.slice(-footer)].slice(0, height);
}

// ─── Roster ─────────────────────────────────────────────────────────────────

/** The `Roster · Flat/By parent · counts` head and the usage line, wrapped. */
function summaryLines(pen: Pen, view: HubAgentsView, width: number): string[] {
	const { theme, dimSep } = pen;
	const active = (label: string) => theme.bg("selectedBg", theme.style("strong", theme.fg("accent", ` ${label} `)));
	const inactive = (label: string) => theme.fg("muted", ` ${label} `);
	const tree = view.viewMode === "tree";
	const projection = `${tree ? inactive("Flat") : active("Flat")}${theme.fg("dim", "/")}${tree ? active("By parent") : inactive("By parent")}`;
	const counts: string[] = [];
	for (const status of ["running", "idle", "parked", "aborted"] as const) {
		const count = view.counts[status];
		if (count > 0) counts.push(`${statusGlyph(pen, status)} ${theme.fg(STATUS_COLOR[status], `${count} ${status}`)}`);
	}
	const head = `${theme.style("strong", "Roster")}${dimSep}${projection}${counts.length > 0 ? dimSep + counts.join(pen.sep) : ""}`;
	const lines = wrap(head, Math.max(1, width));
	const metrics = view.aggregate;
	if (metrics.reportedAgents === 0) {
		lines.push(...wrap(theme.fg("dim", `Usage —${pen.sep}0/${view.entries.length} measured`), Math.max(1, width)));
		return lines;
	}
	const time = formatMetricDuration(metrics);
	const usage = [
		theme.fg("statusLineCost", formatCost(metrics.cost)),
		theme.fg("dim", time ? `${time} agent time` : "agent time —"),
		theme.fg("dim", `${formatNumber(metrics.requests)} req`),
		theme.fg("dim", `${formatNumber(metrics.tools)} tools`),
		theme.fg("dim", `${formatNumber(metrics.tokens)} tok`),
		theme.fg("dim", `${metrics.activeDurationAgents}/${metrics.reportedAgents} timed`),
		theme.fg("dim", `${metrics.reportedAgents}/${view.entries.length} measured`),
	].join(dimSep);
	lines.push(...wrap(usage, Math.max(1, width)));
	return lines;
}

/** Tree rails drawn at most this deep for `width`; deeper ancestry collapses into `… `. */
function treePrefix(pen: Pen, segments: readonly string[], width: number, continuation: boolean): string {
	if (segments.length === 0) return "";
	const most = Math.max(1, Math.floor(Math.max(TREE_SEGMENT_WIDTH, width - 2) / TREE_SEGMENT_WIDTH));
	const omitted = segments.length > most ? (continuation ? "  " : "… ") : "";
	return pen.theme.fg("dim", `${omitted}${segments.slice(0, most).toReversed().join("")}`);
}

/** Fixed-width usage cells, so every entry's usage line shares one column layout. */
function metricColumns(metrics: AgentMetrics, age: string): string {
	const cells: [string, number][] = [
		[formatMetricDuration(metrics) ?? "—", 13],
		[`${formatNumber(metrics.requests)} req`, 8],
		[`${formatNumber(metrics.tools)} tools`, 9],
		[`${formatNumber(metrics.tokens)} tok`, 8],
		[age, 8],
	];
	const cost = formatCost(metrics.cost);
	return [
		cost.length >= 8 ? cost : cost.padEnd(8),
		...cells.map(([text, width]) => truncate(text, width).padStart(width)),
	].join(" ");
}

/** An entry's rows: identity (with role and model right-aligned when they fit), task, usage. */
function entryRows(
	pen: Pen,
	theme: Theme,
	entry: HubEntry,
	selected: boolean,
	hovered: boolean,
	view: HubAgentsView,
	width: number,
): string[] {
	const max = Math.max(1, width);
	const tree = view.viewMode === "tree";
	const cursor = selected ? theme.fg("accent", pen.glyph("nav.cursor")) : " ";
	const branch = tree ? treePrefix(pen, entry.branch, max, false) : "";
	const id = sanitizeDisplaySingleLine(entry.id);
	const styledId = theme.style("strong", selected ? theme.fg("accent", id) : agentColored(theme, entry.id, id));
	const fields = [`${cursor} ${branch}${statusGlyph(pen, entry.status)} ${styledId}`];
	if (entry.parent) fields.push(theme.fg("dim", `↳ ${sanitizeDisplaySingleLine(entry.parent)}`));
	if (entry.readOnly) fields.push(theme.fg("warning", "read-only"));
	if (entry.unread > 0) fields.push(theme.fg("warning", `⧉ ${entry.unread}`));
	const left = fields.join("  ");
	const right = modelLine(pen, entry.role, entry.model);
	const leftWidth = visibleWidth(left);
	const rightWidth = visibleWidth(right);
	const rows: string[] = [];
	if (rightWidth > 0 && leftWidth + 2 + rightWidth <= max)
		rows.push(left + spaces(max - leftWidth - rightWidth) + right);
	else rows.push(truncate(left, max));

	const detailIndent = Math.min(max - 1, 4 + visibleWidth(branch));
	const continuation = tree
		? `  ${treePrefix(pen, entry.continuation, max, true)}${entry.hasChildren ? theme.fg("dim", "│ ") : "  "}`
		: "";
	const railed = tree && visibleWidth(continuation) === detailIndent;
	const indent = railed ? continuation : spaces(detailIndent);
	const metadataIndent = tree
		? Math.min(Math.max(0, max - 1), TREE_DETAIL_BASE_INDENT + Math.max(0, view.treeMaxDepth) * TREE_SEGMENT_WIDTH)
		: detailIndent;
	const metadataPrefix = railed ? continuation + spaces(metadataIndent - detailIndent) : spaces(metadataIndent);
	const detailWidth = Math.max(1, max - detailIndent);
	if (entry.task) rows.push(`${indent}${theme.fg("muted", truncate(oneLine(entry.task, detailWidth), detailWidth))}`);
	const metadata = entry.metrics ? metricColumns(entry.metrics, entry.age) : `usage ${pen.sep} ${entry.age}`;
	rows.push(`${metadataPrefix}${theme.fg("dim", metadata)}`);
	if (!hovered) return rows;
	return rows.map(line => theme.bg("selectedBg", padTo(line, Math.max(max, visibleWidth(line)))));
}

/** Entries windowed around the selection within `budget` rows, with `… N more` where rows are cut. */
function rosterWindow(
	pen: Pen,
	view: HubAgentsView,
	hovered: string | null,
	width: number,
	budget: number,
): { lines: string[]; items: (string | undefined)[] } {
	const lines: string[] = [];
	const items: (string | undefined)[] = [];
	const cache = new Map<number, string[]>();
	const entries = view.entries;
	const at = (index: number): string[] => {
		let rows = cache.get(index);
		if (!rows) {
			const entry = entries.at(index);
			rows = entryRows(pen, pen.theme, entry, index === view.selected, entry.id === hovered, view, width);
			cache.set(index, rows);
		}
		return rows;
	};
	const append = (index: number, rows = at(index)): void => {
		for (const line of rows) {
			lines.push(line);
			items.push(entries.at(index).id);
		}
	};
	const selected = view.selected;
	let start = selected;
	let end = selected + 1;
	let used = at(selected).length;
	if (used > budget) {
		append(selected, at(selected).slice(0, budget));
		return { lines, items };
	}
	for (let grew = true; grew;) {
		grew = false;
		if (end < entries.length && used + at(end).length <= budget) {
			used += at(end).length;
			end++;
			grew = true;
		}
		if (start > 0 && used + at(start - 1).length <= budget) {
			start--;
			used += at(start).length;
			grew = true;
		}
	}
	// The overflow labels take rows: drop the farthest neighbours until both fit.
	for (
		let markers = Number(start > 0) + Number(end < entries.length);
		used + markers > budget && start < end;
		markers = Number(start > 0) + Number(end < entries.length)
	) {
		if (end - 1 > selected) {
			end--;
			used -= at(end).length;
		} else if (start < selected) {
			used -= at(start).length;
			start++;
		} else break;
	}
	const top = start > 0 && used < budget;
	const bottom = end < entries.length && used + Number(top) < budget;
	if (top) {
		lines.push(pen.theme.fg("dim", `… ${start} more`));
		items.push(undefined);
	}
	for (let index = start; index < end; index++) append(index);
	if (bottom) {
		lines.push(pen.theme.fg("dim", `… ${entries.length - end} more`));
		items.push(undefined);
	}
	return { lines, items };
}

function rosterPanel(
	pen: Pen,
	view: HubAgentsView,
	hovered: string | null,
	width: number,
	rows: number,
): { lines: string[]; items: (string | undefined)[] } {
	const { theme } = pen;
	const lines = summaryLines(pen, view, width);
	const items: (string | undefined)[] = lines.map(() => undefined);
	if (rows >= 8) {
		lines.push("");
		items.push(undefined);
	}
	const notice = view.notice ? [theme.fg("error", oneLine(view.notice, Math.max(10, width)))] : [];
	const budget = Math.max(0, rows - lines.length - notice.length);
	if (view.entries.length === 0) {
		const empty = view.loading
			? [`${statusGlyph(pen, "running")} ${theme.fg("accent", "Loading saved agents…")}`]
			: [
					`${theme.fg("muted", pen.glyph("status.shadowed"))} ${theme.style("strong", "No agents in this session")}`,
					theme.fg("dim", "Finished, parked, and killed subagents remain with the session that created them."),
					theme.fg("dim", "Resume that session with omp-dev --continue, or spawn a task here."),
				];
		for (const line of empty.slice(0, budget)) {
			lines.push(line);
			items.push(undefined);
		}
	} else if (budget > 0) {
		const window = rosterWindow(pen, view, hovered, width, budget);
		lines.push(...window.lines);
		items.push(...window.items);
	}
	for (const line of notice) {
		lines.push(line);
		items.push(undefined);
	}
	while (lines.length < rows) {
		lines.push("");
		items.push(undefined);
	}
	return { lines: lines.slice(0, rows), items: items.slice(0, rows) };
}

// ─── Inspector ──────────────────────────────────────────────────────────────

/** Child ids that fit `width`, the rest counted. */
function childIds(children: readonly string[], width: number): string {
	const max = Math.max(1, width);
	let text = "";
	for (let shown = 0; shown < children.length; shown++) {
		const id = oneLine(children[shown]!, max);
		const candidate = text ? `${text}, ${id}` : id;
		const remaining = children.length - shown - 1;
		if (visibleWidth(candidate + (remaining > 0 ? `, … +${remaining}` : "")) > max) {
			const first = text.length === 0;
			const omitted = children.length - shown - Number(first);
			return truncate(`${first ? id : text}${omitted > 0 ? `, … +${omitted}` : ""}`, max);
		}
		text = candidate;
	}
	return text;
}

function contextGauge(theme: Theme, tokens: number, window: number): string {
	const ratio = Math.max(0, Math.min(1, tokens / window));
	const filled = Math.round(ratio * 10);
	return `${theme.fg("accent", "━".repeat(filled))}${theme.fg("dim", "─".repeat(10 - filled))} ${formatNumber(tokens)}/${formatNumber(window)} ${Math.round(ratio * 100)}%`;
}

/** The inspector at `width` × `rows` scrolled by `scroll`, and how far it can scroll. */
function detailPanel(
	pen: Pen,
	detail: HubDetail | undefined,
	scroll: number,
	width: number,
	rows: number,
): { lines: string[]; max: number } {
	const { theme } = pen;
	if (!detail)
		return {
			lines: [theme.fg("dim", "Select an agent to inspect"), ...Array.from({ length: rows - 1 }, () => "")],
			max: 0,
		};
	const lines: string[] = [];
	const add = (line = ""): void => {
		lines.push(truncate(line, width));
	};
	const addWrapped = (text: string, most = 2): void => {
		for (const line of wrap(oneLine(text), Math.max(1, width)).slice(0, most)) add(line);
	};
	const section = (label: string, contentRows = 0): void => {
		if (lines.length > 0 && lines.length + 1 + contentRows < rows) add();
		add(theme.style("strong", theme.fg("accent", label)));
	};
	add(
		`${statusGlyph(pen, detail.status)} ${theme.style("strong", sanitizeDisplaySingleLine(detail.name || detail.id))}`,
	);
	if (detail.name && detail.name !== detail.id) add(theme.fg("dim", sanitizeDisplaySingleLine(detail.id)));
	const lifecycle = [detail.duration, `active ${detail.active}`].filter(Boolean).join(pen.sep);
	add(`${theme.fg(STATUS_COLOR[detail.status], detail.status)}${theme.fg("dim", `${pen.sep}${lifecycle}`)}`);
	const model = modelLine(pen, detail.role, detail.model);
	if (model) add(model);
	if (detail.task) {
		section("Task");
		addWrapped(detail.task);
	}
	if (detail.current) {
		section("Current");
		addWrapped(detail.current);
		if (detail.retry) add(theme.fg("warning", detail.retry));
	}
	section("Usage", 1);
	if (detail.metrics) {
		addWrapped(metricsText(detail.metrics, pen.sep), 3);
		if (detail.metrics.contextTokens !== undefined && detail.metrics.contextWindow)
			add(contextGauge(theme, detail.metrics.contextTokens, detail.metrics.contextWindow));
	} else add(theme.fg("dim", "usage —"));
	section("Lineage");
	const children = detail.children;
	add(
		`Spawned by ${sanitizeDisplaySingleLine(detail.parent)}${children.length > 0 ? ` · ${children.length} children` : ""}`,
	);
	if (children.length > 0) add(theme.fg("dim", childIds(children, width)));
	add(theme.fg("dim", `Registered ${detail.registered}`));
	section("Changes");
	add(theme.fg("dim", detail.readOnly ? "Read-only · 0 LoC" : "Shared workspace · per-agent LoC not attributable"));
	for (const artifact of detail.artifacts) addWrapped(artifact);
	if (lines.length < rows) add();
	if (lines.length < rows) add(theme.style("strong", theme.fg("accent", "Recent activity")));
	const budget = Math.max(0, rows - lines.length);
	const recent = budget > 0 ? detail.recent.slice(-budget) : [];
	if (recent.length === 0 && budget > 0) add(theme.fg("muted", "No response or tool activity yet"));
	for (const event of recent) {
		const prefix = `${theme.fg("dim", event.clock)} ${glyphText(pen, event.glyph)} ${theme.fg("muted", oneLine(event.title, width))} `;
		add(`${prefix}${oneLine(event.summary, Math.max(1, width - visibleWidth(prefix)))}`);
	}
	const max = Math.max(0, lines.length - rows);
	const offset = Math.min(scroll, max);
	const visible = lines.slice(offset, offset + rows);
	while (visible.length < rows) visible.push("");
	return { lines: visible, max };
}

// ─── Sections ───────────────────────────────────────────────────────────────

function keyHints(pen: Pen, view: HubAgentsView, narrowDetails: boolean, inner: number): string {
	const next = view.viewMode === "roster" ? "by parent" : "flat";
	const filter = view.filter.editing
		? `/${fieldText(view.filter)}  ·  `
		: view.filter.text
			? `/${view.filter.text}  ·  `
			: "";
	const ok = bindingGlyph("tui.select.confirm", "enter");
	const esc = bindingGlyph("tui.select.cancel", "escape");
	const pages = `${bindingGlyph("tui.select.pageUp", "pageUp")}/${bindingGlyph("tui.select.pageDown", "pageDown")}`;
	if (narrowDetails)
		return pen.theme.fg(
			"dim",
			`${filter}1:agents  2:activity  ⇥:roster  ${pages}:scroll  ${ok}:open  t:${next}  ${esc}:roster`,
		);
	if (inner < FULL_HINTS_WIDTH)
		return pen.theme.fg("dim", `${filter}j/k:select  ${ok}:open  t:${next}  ⇥:details  r/x:manage  ${esc}:close`);
	return pen.theme.fg(
		"dim",
		`${filter}1:agents  2:activity  j/k/wheel:select  ${pages}:details  ${ok}/click:open  t:${next}  r:revive  x:kill  ${esc}:close`,
	);
}

function paintAgents(node: UiNode, pen: Pen, view: HubAgentsView, width: number, height: number) {
	const hovered = hover(node)();
	const scroll = detailScroll(node)();
	const offset = scroll.agent === view.detail?.id ? scroll.offset : 0;
	const inspect = (detailWidth: number): string[] => {
		const panel = detailPanel(pen, view.detail, offset, detailWidth, contentRows);
		(node as MeasuredHub)[kDetailMax] = panel.max;
		return panel.lines;
	};
	const contentRows = Math.max(1, height - FRAME_ROWS);
	const inner = Math.max(1, width - 4);
	const splitAvailable = Math.max(0, width - SPLIT_CHROME);
	const split = width >= SPLIT_MIN_WIDTH && splitAvailable >= ROSTER_MIN_WIDTH + DETAIL_MIN_WIDTH;
	(node as MeasuredHub)[kSplit] = split;
	const box = pen.theme.symbols.box;
	const bar = border(pen, box.vertical);
	const hits: RowHit[] = [];
	const body: string[] = [];
	let top: string;
	let divider: string;
	if (split) {
		const left = Math.max(
			0,
			Math.min(splitAvailable - DETAIL_MIN_WIDTH, Math.max(ROSTER_MIN_WIDTH, Math.floor(width * ROSTER_RATIO))),
		);
		const right = Math.max(0, splitAvailable - left);
		const roster = rosterPanel(pen, view, hovered, left, contentRows);
		const detail = inspect(right);
		for (let index = 0; index < contentRows; index++) {
			body.push(
				`${bar} ${padTo(truncate(roster.lines[index] ?? "", left), left)} ${bar} ${padTo(truncate(detail[index] ?? "", right), right)} ${bar}`,
			);
		}
		roster.items.forEach((item, index) => {
			if (item !== undefined) hits.push({ row: 1 + index, col: 2, width: left, height: 1, item });
		});
		top = `${titledEdge(pen, "Agent Hub", left + 2)}${border(pen, `${box.teeDown}${box.horizontal.repeat(Math.max(0, right + 2))}${box.topRight}`)}`;
		divider = rule(pen, width, left);
	} else {
		const details = view.narrowDetails && view.detail !== undefined;
		if (details) {
			for (const line of inspect(inner)) body.push(frameRow(pen, line, width));
		} else {
			const roster = rosterPanel(pen, view, hovered, inner, contentRows);
			for (const line of roster.lines) body.push(frameRow(pen, line, width));
			roster.items.forEach((item, index) => {
				if (item !== undefined) hits.push({ row: 1 + index, col: 2, width: inner, height: 1, item });
			});
		}
		top = topBorder(pen, width, details ? `Agent Hub · ${view.detail!.id}` : "Agent Hub");
		divider = rule(pen, width);
	}
	const hints = keyHints(pen, view, !split && view.narrowDetails, inner);
	return { lines: [top, ...body, divider, frameRow(pen, hints, width), bottomBorder(pen, width)], hits };
}

function sectionTabs(pen: Pen, section: "agents" | "activity"): string {
	const { theme } = pen;
	const tab = (id: "agents" | "activity", label: string) =>
		section === id
			? theme.bg("selectedBg", theme.style("strong", theme.fg("accent", ` ${label} `)))
			: theme.fg("muted", ` ${label} `);
	return `${tab("agents", "1 Agents")}${pen.dimSep}${tab("activity", "2 Activity")}`;
}

function activityRow(pen: Pen, row: HubActivityLine, selected: boolean, width: number): string {
	const { theme } = pen;
	const cursor = selected ? theme.fg("accent", pen.glyph("nav.cursor")) : " ";
	const role = row.role ? `${theme.fg(row.role.color, row.role.text)} ` : "";
	const agent = oneLine(row.agent, Math.max(8, Math.min(18, Math.floor(width * 0.18))));
	const title = oneLine(row.title, width);
	const prefix = `${cursor} ${theme.fg("dim", row.clock)} ${glyphText(pen, row.glyph)} ${role}${theme.style("strong", agent)} ${theme.fg(row.response ? "success" : "muted", title)}`;
	const available = Math.max(1, width - visibleWidth(prefix) - visibleWidth(pen.sep));
	return `${prefix}${pen.dimSep}${oneLine(row.summary, available)}`;
}

function paintActivity(pen: Pen, view: HubActivityView, width: number, height: number) {
	const { theme } = pen;
	const inner = Math.max(1, width - 4);
	const contentRows = Math.max(1, height - FRAME_ROWS);
	const body = [sectionTabs(pen, "activity")];
	const search = view.search.editing
		? theme.fg("accent", `search: ${fieldText(view.search)}`)
		: view.search.text
			? `search: ${view.search.text}`
			: "search: —";
	body.push(theme.fg("dim", [view.scope, view.filter, view.follow ? "following" : "paused", search].join(pen.sep)));
	if (contentRows >= 8) body.push("");
	const hits: RowHit[] = [];
	const budget = Math.max(0, contentRows - body.length);
	const rows = view.rows;
	if (rows.length === 0 && budget > 0) {
		body.push(theme.fg("muted", view.search.text ? "No matching activity" : "No agent activity recorded yet"));
	} else if (budget > 0) {
		const selected = Math.min(view.selected, rows.length - 1);
		const start = view.follow
			? Math.max(0, rows.length - budget)
			: Math.max(0, Math.min(selected - Math.floor(budget / 2), rows.length - budget));
		const end = Math.min(rows.length, start + budget);
		if (start > 0) body.push(theme.fg("dim", `… ${start} earlier`));
		for (let index = start + Number(start > 0); index < end; index++) {
			hits.push({ row: 1 + body.length, col: 2, width: inner, height: 1, item: rows[index]!.id });
			body.push(activityRow(pen, rows[index]!, index === selected, inner));
		}
	}
	while (body.length < contentRows) body.push("");
	const lines = [
		topBorder(pen, width, "Agent Hub"),
		...body.slice(0, contentRows).map(line => frameRow(pen, line, width)),
	];
	lines.push(rule(pen, width));
	lines.push(
		frameRow(
			pen,
			theme.fg(
				"dim",
				`1:agents  j/k:select  ${bindingGlyph("tui.select.confirm", "enter")}:transcript  ␣:follow  f:filter  s:scope  /:search  ${bindingGlyph("tui.select.cancel", "escape")}:close`,
			),
			width,
		),
	);
	lines.push(bottomBorder(pen, width));
	return { lines, hits };
}

definePickerLook("omp.hub", (node, cx: PaintContext) => {
	const term = (node.props() as { term?: HubLookTerm }).term;
	const width = cx.width;
	if (!term?.hub || width < 1) return { rows: [] };
	const pen = penOf(cx.theme);
	const hub = term.hub;
	const height = Math.max(1, hub.height);
	const { lines, hits } =
		hub.section === "activity"
			? paintActivity(pen, hub.activity, width, height)
			: paintAgents(node, pen, hub.agents, width, height);
	const rows = fitFrame(lines, width, height);
	return { rows, hits: [sheetHit(node, width, rows.length), ...hits.map(hit => ({ ...hit, node }))] };
});

/** The hovered roster entry (terminal pointer state). */
function hover(node: UiNode) {
	return pickerState<string | null>(node, PICKER_HOVER, () => null);
}

/** The inspector's scroll: rows scrolled for the agent it was scrolled on (another agent starts at the top). */
function detailScroll(node: UiNode) {
	return pickerState<{ agent?: string; offset: number }>(node, "hub.detailScroll", () => ({ offset: 0 }));
}

/** How far the inspector scrolled as last painted (PgDn stops there). */
const kDetailMax = Symbol("hub.detailMax");

/** Whether the hub was last painted with the inspector beside the roster. */
const kSplit = Symbol("hub.split");

interface MeasuredHub extends UiNode {
	[kDetailMax]?: number;
	[kSplit]?: boolean;
}

/**
 * Whether the terminal last drew the hub with the inspector beside the
 * roster: Tab (swap in the inspector) and the keys closing it only act on a
 * narrow hub.
 */
export function hubPaintedSplit(node: UiNode): boolean {
	return (node as MeasuredHub)[kSplit] === true;
}

/** Forget the hovered entry: the selection moved by keys, the wheel or the program. */
export function clearHubHover(node: UiNode): void {
	hover(node).set(null);
}

/**
 * The hub's pointer: motion hovers an entry, the wheel moves the selection
 * (and drops the hover), a click on an agent selects and opens it (an
 * activity row: the first click selects, a second opens).
 */
defineRoleWidget("picker", "omp.hub", {
	/** PgUp/PgDn scroll the inspector by five rows (the screen leaves them to the terminal). */
	key(node, key) {
		if (key.kind === "release" || (key.id !== "pageUp" && key.id !== "pageDown")) return false;
		const term = (node.props() as { term?: HubLookTerm }).term;
		if (term?.hub.section !== "agents") return false;
		const agent = term.hub.agents.detail?.id;
		const scroll = detailScroll(node);
		const from = scroll().agent === agent ? scroll().offset : 0;
		const max = (node as MeasuredHub)[kDetailMax] ?? Number.POSITIVE_INFINITY;
		const step = key.id === "pageUp" ? -DETAIL_SCROLL_STEP : DETAIL_SCROLL_STEP;
		scroll.set({ agent, offset: Math.max(0, Math.min(max, from + step)) });
		return true;
	},
	mouse(node, mouse, _at, cx, hit) {
		if (mouse.action === "move") {
			hover(node).set(hit.item ?? null);
			return true;
		}
		if (mouse.action !== "press") return false;
		if (mouse.button === "wheel-up" || mouse.button === "wheel-down") {
			hover(node).set(null);
			const next = pickerStep(node, mouse.button === "wheel-up" ? -1 : 1, { wrap: false });
			if (next !== undefined) cx.emit({ type: "select", key: cx.keypath, item: next });
			return true;
		}
		if (mouse.button !== "left" || hit.item === undefined) return false;
		const term = (node.props() as { term?: HubLookTerm }).term;
		if (term?.hub.section === "agents") {
			hover(node).set(hit.item);
			cx.emit({ type: "activate", key: cx.keypath, item: hit.item });
			return true;
		}
		const selected = (node.props() as { selected?: string | null }).selected;
		cx.emit({ type: hit.item === selected ? "activate" : "select", key: cx.keypath, item: hit.item });
		return true;
	},
});
