/**
 * Overview model: usage attribution, legend rows, and the occupancy map. Legend and
 * map rows have an ANSI form (`render`) and a native form (`describe`); keep the twins visually identical.
 */
import { formatNumber } from "@oh-my-pi/pi-utils";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import type { ContextBreakdown } from "../status-line/context-usage";
import { type ContextMapCell, planContextMap } from "../chrome/context-map";
import { CONTEXT_PRESENTATION, type ContextPresentationId } from "../chrome/context-presentation";
import { item, node, span, text } from "../native/describe";
import type { NativeNode } from "../native/node";
import { theme } from "../theme/theme";
import type { ThemeColor } from "../theme";
import { truncateToWidth, visibleWidth } from "../utils";
import {
	type ContextViewCategory,
	type ContextViewData,
	contextCategoryDescriptor,
} from "../chrome/context-view-model";
import { safeLine, safeText } from "./context-viewer-format";

/** The map is hidden below this body width. */
const MAP_MIN_WIDTH = 52;
/** Map cells are separated by a space from this body width. */
const MAP_GAP_MIN_WIDTH = 72;
/** Maximum map columns and rows. */
const MAP_MAX_CELLS = 16;
/** Width reserved for the legend beside the map. */
const LEGEND_MIN_WIDTH = 32;
/** Columns between the map and the legend. */
export const MAP_LEGEND_GAP = 3;

export interface OverviewRow {
	readonly key: string;
	readonly id: ContextPresentationId;
	readonly label: string;
	/** Attributed usage; undefined when the weights cannot scale current usage. */
	readonly tokens: number | undefined;
	/** Category opened on confirm; undefined rows are listed but not selectable. */
	readonly category?: ContextViewCategory;
	readonly child?: boolean;
	/** Right-aligned token column. */
	readonly tokenColumn: string;
	/** Right-aligned share column, including its leading separator. */
	readonly shareColumn: string;
}

export interface MapGeometry {
	readonly columns: number;
	readonly rows: number;
	readonly cellWidth: number;
	readonly gap: string;
	readonly width: number;
}

/** Largest-remainder split of `total` by `weights`; undefined when the weights cannot scale. */
function allocateTokens(weights: readonly number[], total: number): number[] | undefined {
	const sum = weights.reduce((value, weight) => value + weight, 0);
	if (!(sum > 0) || !Number.isFinite(sum)) return;
	const shares = weights.map((weight, index) => {
		const exact = (total * weight) / sum;
		return { index, tokens: Math.floor(exact), remainder: exact - Math.floor(exact) };
	});
	const remaining = total - shares.reduce((value, share) => value + share.tokens, 0);
	const ranked = [...shares].sort((a, b) => b.remainder - a.remainder || a.index - b.index);
	for (let index = 0; index < remaining; index++) ranked[index]!.tokens++;
	return shares.map(share => share.tokens);
}

/**
 * Attribute current usage to categories by weight, then each category's share to its children.
 * Attributed values are not entry sums: entries keep their unscaled content/replay estimates.
 * Undefined when the top-level weights cannot scale; unscalable children stay unattributed.
 */
export function allocateUsage(
	categories: readonly ContextViewCategory[],
	usage: number,
): Map<ContextViewCategory, number> | undefined {
	const allocation = new Map<ContextViewCategory, number>();
	const allocate = (siblings: readonly ContextViewCategory[], total: number): boolean => {
		const shares = allocateTokens(
			siblings.map(category => category.tokens),
			total,
		);
		if (!shares) return false;
		for (const [index, category] of siblings.entries()) {
			allocation.set(category, shares[index]!);
			if (category.children) allocate(category.children, shares[index]!);
		}
		return true;
	};
	return allocate(categories, usage) ? allocation : undefined;
}

/** Overview row label for a category: its Overview-specific label when the weight differs from its content. */
export function overviewLabel(category: ContextViewCategory): string {
	return contextCategoryDescriptor(category.id).overviewLabel ?? category.label;
}

function formatShare(tokens: number, window: number): string {
	if (window <= 0) return "—";
	const percent = (tokens / window) * 100;
	return percent > 0 && percent < 0.05 ? "<0.1%" : `${percent.toFixed(1)}%`;
}

/** Category and child rows, then buffer and free space, with aligned token and share columns. */
export function buildOverviewRows(
	data: ContextViewData,
	allocation: ReadonlyMap<ContextViewCategory, number> | undefined,
): OverviewRow[] {
	const rows: Omit<OverviewRow, "tokenColumn" | "shareColumn">[] = [];
	for (const category of data.categories) {
		const openable = contextCategoryDescriptor(category.id).openable !== false;
		rows.push({
			key: category.id,
			id: category.id,
			label: overviewLabel(category),
			tokens: allocation?.get(category),
			// Empty categories have nothing to open.
			category: openable && category.entries.length > 0 ? category : undefined,
		});
		for (const child of category.children ?? [])
			rows.push({
				key: child.key!,
				id: category.id,
				label: child.label,
				tokens: allocation?.get(child),
				category: openable ? child : undefined,
				child: true,
			});
	}
	rows.push(
		{ key: "buffer", id: "buffer", label: "Auto-Compact Buffer", tokens: data.breakdown.autoCompactBufferTokens },
		{ key: "free", id: "free", label: "Free Space", tokens: data.breakdown.freeTokens },
	);
	const tokenWidth = Math.max(...rows.map(row => (row.tokens === undefined ? 1 : formatNumber(row.tokens).length)));
	const shareWidth = Math.max(
		...rows.map(row => (row.tokens === undefined ? 1 : formatShare(row.tokens, data.breakdown.contextWindow).length)),
	);
	return rows.map(row => ({
		...row,
		tokenColumn: row.tokens === undefined ? "—" : formatNumber(row.tokens).padStart(tokenWidth),
		shareColumn:
			row.tokens === undefined
				? ""
				: `  ${formatShare(row.tokens, data.breakdown.contextWindow).padStart(shareWidth)}`,
	}));
}

/** ANSI legend row: cursor, swatch, label padded to `width`, token and share columns. */
export function legendLine(row: OverviewRow, selected: boolean, width: number): string {
	const presentation = CONTEXT_PRESENTATION[row.id];
	const glyph = theme.styledSymbol(presentation.symbol, presentation.color);
	const cursor = selected ? theme.fg("accent", theme.nav.cursor) : " ".repeat(visibleWidth(theme.nav.cursor));
	const prefix = `${cursor} ${row.child ? "  " : ""}${glyph} `;
	const suffix = ` ${theme.fg(selected ? presentation.color : "text", row.tokenColumn)}${theme.fg(selected ? presentation.color : "dim", row.shareColumn)}`;
	const budget = Math.max(0, width - visibleWidth(prefix) - visibleWidth(suffix));
	const label = truncateToWidth(safeLine(row.label), budget);
	const name = selected ? theme.fg(presentation.color, theme.bold(label)) : label;
	return truncateToWidth(`${prefix}${name}${" ".repeat(Math.max(0, budget - visibleWidth(label)))}${suffix}`, width);
}

/** Native legend item; `meterGlyphs` swaps map glyphs for the meter's bar glyphs. */
export function legendItem(row: OverviewRow, selected: boolean, meterGlyphs: boolean, window: number): NativeNode {
	const presentation = CONTEXT_PRESENTATION[row.id];
	const glyph = meterGlyphs
		? row.id === "buffer"
			? "▨"
			: row.id === "free"
				? "□"
				: "■"
		: theme.symbol(presentation.symbol);
	const usage = row.tokens === undefined ? "—" : `${formatNumber(row.tokens)} · ${formatShare(row.tokens, window)}`;
	return item(row.key, {
		label: [
			span(`${row.child ? "  " : ""}${glyph} `, presentation.color),
			span(safeText(row.label), selected ? `${presentation.color} strong` : undefined),
		],
		value: selected ? [span(usage, presentation.color)] : usage,
	});
}

/** Map size beside a legend in a `width` × `height` body; undefined when either would not fit. */
export function mapGeometry(width: number, height: number): MapGeometry | undefined {
	if (width < MAP_MIN_WIDTH || height < 2) return;
	const gap = width >= MAP_GAP_MIN_WIDTH ? " " : "";
	const cellWidth = Math.max(
		1,
		...Object.values(CONTEXT_PRESENTATION).map(presentation => visibleWidth(theme.symbol(presentation.symbol))),
	);
	const columns = Math.min(
		MAP_MAX_CELLS,
		Math.floor((width - LEGEND_MIN_WIDTH - MAP_LEGEND_GAP + gap.length) / (cellWidth + gap.length)),
	);
	if (columns < 1) return;
	const rows = Math.min(MAP_MAX_CELLS, height);
	return { columns, rows, cellWidth, gap, width: columns * (cellWidth + gap.length) - gap.length };
}

/** Map cells per row, in window order: categories, free space, then buffer. */
export function planMapRows(
	data: ContextViewData,
	allocation: ReadonlyMap<ContextViewCategory, number>,
	geometry: MapGeometry,
): ContextMapCell<ContextPresentationId>[][] {
	const cells = planContextMap<ContextPresentationId>(
		[
			...data.categories.map(category => ({ id: category.id, tokens: allocation.get(category) ?? 0 })),
			{ id: "free", tokens: data.breakdown.freeTokens },
			{ id: "buffer", tokens: data.breakdown.autoCompactBufferTokens },
		],
		data.breakdown.contextWindow,
		geometry.columns,
		geometry.rows,
	);
	return Array.from({ length: geometry.rows }, (_, row) =>
		cells.slice(row * geometry.columns, (row + 1) * geometry.columns),
	);
}

/** ANSI map row; partially filled cells are dim. */
export function mapRowLine(cells: readonly ContextMapCell<ContextPresentationId>[], geometry: MapGeometry): string {
	return cells
		.map(cell => {
			const presentation = CONTEXT_PRESENTATION[cell.id];
			const glyph = theme.symbol(presentation.symbol);
			const painted = theme.fg(presentation.color, glyph);
			return `${cell.full ? painted : `\x1b[2m${painted}\x1b[22m`}${" ".repeat(Math.max(0, geometry.cellWidth - visibleWidth(glyph)))}`;
		})
		.join(geometry.gap);
}

/** Native map row; partially filled cells are dim. */
export function mapRowSpans(cells: readonly ContextMapCell<ContextPresentationId>[], geometry: MapGeometry): TspSpan[] {
	return cells.map(cell => {
		const presentation = CONTEXT_PRESENTATION[cell.id];
		const glyph = theme.symbol(presentation.symbol);
		return span(
			`${glyph}${" ".repeat(Math.max(0, geometry.cellWidth - visibleWidth(glyph)))}${geometry.gap}`,
			`${presentation.color}${cell.full ? "" : " dim"}`,
		);
	});
}

function percentString(part: number, whole: number, fractionDigits = 1): string {
	if (whole <= 0) return "0%";
	const pct = (part / whole) * 100;
	if (pct > 0 && pct < 0.05) return "<0.1%";
	return `${pct.toFixed(fractionDigits)}%`;
}

/** Snapcompact savings lines of the Overview; empty when no snapcompact setting is on. */
export function contextSnapcompactLines(breakdown: ContextBreakdown): string[] {
	const snap = breakdown.snapcompact;
	if (!snap) return [];
	if (!snap.visionCapable) return ["Snapcompact: inactive (model has no image input)"];
	const lines = ["Snapcompact (estimated wire savings)"];
	if (snap.systemPrompt) {
		const sp = snap.systemPrompt;
		const scope = sp.scope === "agents-md" ? "AGENTS.md" : "all";
		if (sp.applied) {
			const frames = `${sp.frames} frame${sp.frames === 1 ? "" : "s"}`;
			lines.push(
				`  System prompt (${scope}): saves ~${formatNumber(sp.savedTokens)} (${formatNumber(sp.textTokens)} text → ${frames} ≈ ${formatNumber(sp.imageTokens)})`,
			);
		} else {
			const reason =
				sp.reason === "budget"
					? "image budget exhausted"
					: sp.reason === "empty"
						? "nothing to image"
						: "frames would not save tokens";
			lines.push(`  System prompt (${scope}): stays text (${reason})`);
		}
	}
	if (snap.toolResults) {
		const tr = snap.toolResults;
		lines.push(
			tr.swapped > 0
				? `  Tool results: saves ~${formatNumber(tr.savedTokens)} (${tr.swapped}/${tr.total} imaged, ${formatNumber(tr.textTokens)} text → ${tr.frames} frames ≈ ${formatNumber(tr.imageTokens)})`
				: `  Tool results: none imaged (${tr.total} in history)`,
		);
	}
	if (snap.savedTokens > 0) {
		lines.push(
			`  Next request: ~${formatNumber(Math.max(0, breakdown.usedTokens - snap.savedTokens))} tokens on the wire`,
		);
	}
	return lines;
}

interface ContextMeterData extends Pick<
	ContextBreakdown,
	"contextWindow" | "usedTokens" | "freeTokens" | "autoCompactBufferTokens" | "thresholdTokens"
> {
	categories: readonly { label: string; tokens: number; color: ThemeColor }[];
}

/** Stacked meter parts in grid order: the categories, free space as the empty track, then the hatched buffer. */
function contextMeterParts(
	breakdown: ContextMeterData,
): { value: number; token?: string; label?: string; hatch?: boolean }[] {
	const window = breakdown.contextWindow;
	const parts: { value: number; token?: string; label?: string; hatch?: boolean }[] = breakdown.categories
		.filter(category => category.tokens > 0)
		.map(category => ({
			value: category.tokens / window,
			token: category.color,
			label: `${category.label} · ${formatNumber(category.tokens)} tokens (${percentString(category.tokens, window)})`,
		}));
	parts.push({
		value: breakdown.freeTokens / window,
		token: "track",
		label: `Free space · ${formatNumber(breakdown.freeTokens)} tokens (${percentString(breakdown.freeTokens, window)})`,
	});
	if (breakdown.autoCompactBufferTokens > 0) {
		parts.push({
			value: breakdown.autoCompactBufferTokens / window,
			token: "warning",
			hatch: true,
			label: `Autocompact buffer · ${formatNumber(breakdown.autoCompactBufferTokens)} tokens (${percentString(breakdown.autoCompactBufferTokens, window)})`,
		});
	}
	return parts;
}

/** Shared usage and compaction labels for ANSI and native context views. */
export function contextUsageSummary(
	breakdown: Pick<ContextBreakdown, "contextWindow" | "usedTokens" | "freeTokens" | "thresholdTokens">,
) {
	const { contextWindow: window, usedTokens, freeTokens, thresholdTokens } = breakdown;
	const room =
		thresholdTokens === undefined
			? `${formatNumber(freeTokens)} free`
			: usedTokens >= thresholdTokens
				? `Past auto-compaction at ${percentString(thresholdTokens, window, 0)}`
				: `${formatNumber(thresholdTokens - usedTokens)} left before auto-compaction at ${percentString(thresholdTokens, window, 0)}`;
	return {
		used: formatNumber(usedTokens),
		detail: ` of ${formatNumber(window)} tokens · ${percentString(usedTokens, window, 0)}`,
		room,
	};
}

/** Native usage summary and stacked bar; callers provide the category list. */
export function describeContextMeter(breakdown: ContextMeterData): [NativeNode, NativeNode] {
	const { contextWindow: window, usedTokens, thresholdTokens } = breakdown;
	const parts = contextMeterParts(breakdown);
	const used = Math.min(1, usedTokens / window);
	const labels = contextUsageSummary(breakdown);
	const summary = node(
		"row",
		{ role: "omp.context.summary", align: "baseline", wrap: true },
		[
			text([span(labels.used, "strong"), span(labels.detail, "dim")], {
				role: "omp.context.used",
				grow: 1,
				wrap: "none",
			}),
			text(labels.room, { role: "omp.context.room", wrap: "none" }),
		],
		"summary",
	);
	const marks =
		thresholdTokens !== undefined
			? [
					{
						at: thresholdTokens / window,
						tone: "warning" as const,
						title: `Auto-compaction at ${percentString(thresholdTokens, window, 0)} · ${formatNumber(thresholdTokens)} tokens`,
					},
				]
			: undefined;
	const bar = node(
		"meter",
		{ value: used, style: "bar", size: "lg", parts, ...(marks ? { marks } : {}), aria: "Context usage by category" },
		undefined,
		"bar",
	);
	return [summary, bar];
}
