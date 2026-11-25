/**
 * `/context` in the terminal: a box titled `Context · <model>` (or the open
 * category), the usage summary, the body, a rule and the key hints. The
 * Overview draws an occupancy map (one glyph per slice of the window, dim
 * when a slice is partly filled) beside the scrolling legend; a category
 * lists its entry previews with a bar beside the selected one; an entry shows
 * its metadata and content, scrolled. Short terminals keep the top border,
 * the hints and the bottom border, in that priority.
 */
import { type Block, defineRolePainter, EMPTY_BLOCK } from "@oh-my-pi/pi-tui/term/paint";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { padTo, truncate, visibleWidth, wrap } from "@oh-my-pi/pi-tui/text/width";
import {
	CONTEXT_PRESENTATION,
	type ContextPresentationId,
	type ContextViewerModel,
	entryBodyRuns,
	entryHeaderSpans,
	entryMetadata,
	entryPreview,
	groupHeaderSpans,
	type OverviewRow,
	previewHintSpans,
	previewRows,
	type Run,
} from "../../overlays/panels/context-viewer";
import { bindingGlyph, boxRows, selectNavGlyphs, termOf } from "./common";

const MAP_MIN_WIDTH = 52;
const MAP_GAP_MIN_WIDTH = 72;
const MAP_MAX_CELLS = 16;
const LEGEND_MIN_WIDTH = 32;
const MAP_LEGEND_GAP = 3;

function styled(theme: Theme, runs: readonly { t: string; s?: string }[]): string {
	let out = "";
	for (const run of runs) out += run.s ? theme.style(run.s, run.t) : run.t;
	return out;
}

/** `lines` in a `height`-row window from `offset`, a scrollbar in the last column when they overflow. */
function scrolled(theme: Theme, lines: readonly string[], offset: number, height: number, width: number): string[] {
	const out: string[] = [];
	if (lines.length <= height) {
		for (let i = 0; i < height; i++) out.push(truncate(lines[i] ?? "", width, ""));
		return out;
	}
	const max = lines.length - height;
	const start = Math.max(0, Math.min(offset, max));
	const thumb = Math.max(1, Math.floor((height * height) / lines.length));
	const at = Math.round((start / max) * (height - thumb));
	for (let i = 0; i < height; i++) {
		const bar = i >= at && i < at + thumb ? "█" : "│";
		out.push(`${padTo(truncate(lines[start + i] ?? "", width - 1, ""), width - 1)}${bar}`);
	}
	return out;
}

/** The smallest move of `offset` that shows `start..end` (its start when taller than the window). */
function reveal(offset: number, start: number, end: number, height: number): number {
	if (end - start > height) return start;
	if (start < offset) return start;
	if (end > offset + height) return end - height;
	return offset;
}

function legendLine(theme: Theme, row: OverviewRow, selected: boolean, width: number): string {
	const presentation = CONTEXT_PRESENTATION[row.id];
	const glyph = theme.fg(presentation.color, theme.symbols.symbol(presentation.symbol));
	const cursorGlyph = theme.symbols.symbol("nav.cursor");
	const cursor = selected ? theme.fg("accent", cursorGlyph) : " ".repeat(visibleWidth(cursorGlyph));
	const prefix = `${cursor} ${row.child ? "  " : ""}${glyph} `;
	const suffix = ` ${theme.fg(selected ? presentation.color : "text", row.tokenColumn)}${theme.fg(selected ? presentation.color : "dim", row.shareColumn)}`;
	const budget = Math.max(0, width - visibleWidth(prefix) - visibleWidth(suffix));
	const label = truncate(row.label.replace(/\n/g, " "), budget);
	const name = selected ? theme.fg(presentation.color, theme.style("strong", label)) : label;
	return truncate(`${prefix}${name}${" ".repeat(Math.max(0, budget - visibleWidth(label)))}${suffix}`, width);
}

interface MapGeometry {
	readonly columns: number;
	readonly rows: number;
	readonly gap: string;
	readonly width: number;
}

function mapGeometry(width: number, height: number): MapGeometry | undefined {
	if (width < MAP_MIN_WIDTH || height < 2) return undefined;
	const gap = width >= MAP_GAP_MIN_WIDTH ? " " : "";
	const columns = Math.min(
		MAP_MAX_CELLS,
		Math.floor((width - LEGEND_MIN_WIDTH - MAP_LEGEND_GAP + gap.length) / (1 + gap.length)),
	);
	if (columns < 1) return undefined;
	return { columns, rows: Math.min(MAP_MAX_CELLS, height), gap, width: columns * (1 + gap.length) - gap.length };
}

/** Map cells in window order (categories, free, buffer); each takes the segment covering most of it, full at 70%. */
function mapCells(model: ContextViewerModel, geometry: MapGeometry): { id: ContextPresentationId; full: boolean }[] {
	const window = model.data.breakdown.contextWindow;
	const segments: { id: ContextPresentationId; tokens: number }[] = [
		...model.data.categories.map(category => ({ id: category.id, tokens: model.drawable!.get(category) ?? 0 })),
		{ id: "free", tokens: model.data.breakdown.freeTokens },
		{ id: "buffer", tokens: model.data.breakdown.autoCompactBufferTokens },
	];
	const count = geometry.columns * geometry.rows;
	const perCell = window / count;
	const ranges: { id: ContextPresentationId; start: number; end: number }[] = [];
	let cursor = 0;
	for (const segment of segments) {
		if (!Number.isFinite(segment.tokens) || segment.tokens <= 0) continue;
		const end = Math.min(window, cursor + segment.tokens);
		if (end > cursor) ranges.push({ id: segment.id, start: cursor, end });
		cursor = end;
		if (cursor >= window) break;
	}
	const cells: { id: ContextPresentationId; full: boolean }[] = [];
	let first = 0;
	for (let index = 0; index < count; index++) {
		const start = index * perCell;
		const end = (index + 1) * perCell;
		while (first < ranges.length && ranges[first]!.end <= start) first++;
		let winner: ContextPresentationId | undefined;
		let overlap = 0;
		for (let part = first; part < ranges.length && ranges[part]!.start < end; part++) {
			const range = ranges[part]!;
			const covered = Math.min(end, range.end) - Math.max(start, range.start);
			if (covered > overlap) {
				overlap = covered;
				winner = range.id;
			}
		}
		if (winner !== undefined) cells.push({ id: winner, full: overlap / perCell >= 0.7 });
	}
	return cells;
}

function overviewBody(theme: Theme, model: ContextViewerModel, width: number, height: number): string[] {
	const map = model.drawable ? mapGeometry(width, height) : undefined;
	const listWidth = map ? width - map.width - MAP_LEGEND_GAP : width;
	const legend = model.rows.map(row =>
		legendLine(theme, row, row.key === model.overviewKey, Math.max(0, listWidth - 1)),
	);
	for (const note of model.notes) legend.push(...wrap(theme.fg("dim", note), Math.max(1, listWidth - 1)));
	const selected = model.rows.findIndex(row => row.key === model.overviewKey);
	model.overviewOffset = reveal(model.overviewOffset, Math.max(0, selected), Math.max(0, selected) + 1, height);
	const shown = scrolled(theme, legend, model.overviewOffset, height, listWidth);
	if (!map) return shown;
	const cells = mapCells(model, map);
	const lines: string[] = [];
	for (let row = 0; row < height; row++) {
		const rowCells = row < map.rows ? cells.slice(row * map.columns, (row + 1) * map.columns) : [];
		const grid = rowCells
			.map(cell => {
				const presentation = CONTEXT_PRESENTATION[cell.id];
				const painted = theme.fg(presentation.color, theme.symbols.symbol(presentation.symbol));
				return cell.full ? painted : `\x1b[2m${painted}\x1b[22m`;
			})
			.join(map.gap);
		lines.push(
			`${grid}${" ".repeat(Math.max(0, map.width - visibleWidth(grid)) + MAP_LEGEND_GAP)}${shown[row] ?? ""}`,
		);
	}
	return lines;
}

function categoryBody(theme: Theme, model: ContextViewerModel, width: number, height: number): string[] {
	const category = model.category!;
	const contentWidth = Math.max(1, width - 2);
	const lines: string[] = [];
	const ranges: { start: number; end: number; complete: boolean }[] = [];
	const groups = new Set<string>();
	for (const entry of category.entries) {
		const start = lines.length;
		const group = entry.thinkingGroup;
		const indent = group ? "  " : "";
		if (group && !groups.has(group.id)) {
			groups.add(group.id);
			lines.push(truncate(styled(theme, groupHeaderSpans(group, category.id)), Math.max(1, contentWidth - 1)));
		}
		const entryWidth = Math.max(1, contentWidth - 1 - indent.length);
		lines.push(`${indent}${truncate(styled(theme, entryHeaderSpans(entry, category.id)), entryWidth)}`);
		const preview = entryPreview(entry, { width: entryWidth, rows: previewRows(entry, height), sourceWidth: width });
		for (const line of preview.lines) lines.push(`${indent}${styled(theme, line as Run[])}`);
		if (!preview.complete) lines.push(styled(theme, previewHintSpans()));
		ranges.push({ start, end: lines.length, complete: preview.complete });
		lines.push("");
	}
	const selected = category.entries.findIndex(entry => entry.id === model.entryId);
	const range = ranges[selected];
	if (range) model.previewOffset = reveal(model.previewOffset, range.start, range.end, height);
	const shown = scrolled(theme, lines, model.previewOffset, height, contentWidth);
	const offset = lines.length <= height ? 0 : Math.min(model.previewOffset, lines.length - height);
	return shown.map((line, index) => {
		const at = offset + index;
		const inRange = range !== undefined && at >= range.start && at < range.end;
		const shownLine =
			inRange && !range!.complete && at === range!.end - 1
				? truncate(styled(theme, previewHintSpans(bindingGlyph("tui.select.confirm", "enter"))), contentWidth - 1)
				: line;
		return `${inRange ? theme.fg("accent", "┃ ") : "  "}${shownLine}`;
	});
}

function entryBody(theme: Theme, model: ContextViewerModel, width: number, height: number): string[] {
	const entry = model.entry!;
	const contentWidth = Math.max(1, width - 1);
	const body = styled(theme, entryBodyRuns(entry));
	const lines = [
		truncate(styled(theme, entryHeaderSpans(entry, model.category!.id)), contentWidth),
		...entryMetadata(entry, true).flatMap(line => wrap(theme.fg("dim", line), contentWidth)),
		...body.split("\n").flatMap(line => (line ? wrap(line, contentWidth) : [""])),
	];
	model.entryOffset = Math.max(0, Math.min(model.entryOffset, Math.max(0, lines.length - height)));
	return scrolled(theme, lines, model.entryOffset, height, width);
}

function hints(model: ContextViewerModel): string {
	const state = model.state;
	const canOpen =
		state === "overview"
			? !!model.rows.find(row => row.key === model.overviewKey)?.category
			: state === "category" && model.selectedEntry() !== undefined;
	const movement = state === "overview" ? "select/scroll" : state === "category" ? "select" : "scroll";
	return [
		`${selectNavGlyphs()} ${movement}`,
		state === "entry" &&
			`${bindingGlyph("tui.select.pageUp", "pageUp")}/${bindingGlyph("tui.select.pageDown", "pageDown")} page`,
		canOpen && `${bindingGlyph("tui.select.confirm", "enter")} open`,
		`${bindingGlyph("tui.select.cancel", "escape")} ${state === "overview" ? "close" : "back"}`,
	]
		.filter(Boolean)
		.join(" · ");
}

defineRolePainter("col", "omp.context", (node, cx): Block => {
	const theme = cx.theme;
	const model = termOf<{ model: ContextViewerModel }>(node).model;
	if (!model || cx.width < 6) return EMPTY_BLOCK;
	const width = cx.width - 4;
	const terminalRows = Math.max(1, model.terminalRows());
	const summary = model.summary();
	const height = model.bodyRows();
	const body =
		model.state === "overview"
			? overviewBody(theme, model, width, height)
			: model.state === "category"
				? categoryBody(theme, model, width, height)
				: entryBody(theme, model, width, height);
	const title =
		model.state === "overview" ? `Context · ${model.modelLabel}` : model.category!.label.replace(/\n/g, " ");
	const content = [
		...summary.map(line => truncate(theme.fg("dim", line), width)),
		...body.slice(0, height),
		"\u0000",
		truncate(theme.fg("dim", hints(model)), width),
	];
	const rows = boxRows(theme, title, content, cx.width);
	const box = theme.symbols.box;
	const ruleAt = rows.findIndex(row => row.includes("\u0000"));
	rows[ruleAt] = theme.fg("border", `${box.teeRight}${box.horizontal.repeat(cx.width - 2)}${box.teeLeft}`);
	if (terminalRows >= 4) return { rows };
	if (terminalRows === 3) return { rows: [rows[0]!, rows.at(-2)!, rows.at(-1)!] };
	return { rows: terminalRows === 2 ? [rows[0]!, rows.at(-1)!] : [rows.at(-1)!] };
});
