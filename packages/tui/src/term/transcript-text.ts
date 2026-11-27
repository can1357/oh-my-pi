/** Logical line and cell coordinates shared by fullscreen transcript reading tools. */
import { visibleWidth } from "../text/width";
import type { Block } from "./paint";
import { blockText, type RenderedText, type RenderedTextLine, type RenderedTextSpan } from "./text-layout";

export const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** One grapheme painted on a row, with UTF-16 offsets into its logical line. */
interface TextCell {
	readonly col: number;
	readonly width: number;
	readonly start: number;
	readonly end: number;
}

export interface TextModel {
	readonly rows: RenderedText;
	/** Logical lines in block order. */
	readonly lines: readonly RenderedTextLine[];
	/** Logical line indices per line identity (a cached line may be painted more than once). */
	readonly byLine: ReadonlyMap<RenderedTextLine, readonly number[]>;
	/** First block row of each logical line. */
	readonly firstRow: readonly number[];
	/** Logical line index per block row; undefined for decoration rows. */
	readonly rowLine: readonly (number | undefined)[];
	/** Painted cells per block row, computed on first use. */
	readonly cells: (readonly TextCell[] | undefined)[];
}

const models = new WeakMap<Block, TextModel>();

export function textModel(block: Block): TextModel {
	const cached = models.get(block);
	if (cached) return cached;
	const rows = blockText(block);
	const lines: RenderedTextLine[] = [];
	const byLine = new Map<RenderedTextLine, number[]>();
	const firstRow: number[] = [];
	const rowLine: (number | undefined)[] = [];
	let current: RenderedTextLine | undefined;
	const covered: RenderedTextSpan[] = [];
	let high = 0;
	for (const row of rows) {
		if (!row) {
			rowLine.push(undefined);
			continue;
		}
		const spans = row.spans ?? [row];
		// A cached child drawn twice starts a new occurrence. Normal soft wraps advance past
		// `high` and don't have to revisit any of the preceding rows of a long paragraph.
		const continues =
			current === row.line &&
			row.line.text !== "" &&
			!spans.some(
				span =>
					span.end > span.start &&
					span.start < high &&
					covered.some(old => span.start < old.end && old.start < span.end),
			);
		if (!continues) {
			current = row.line;
			covered.length = 0;
			high = 0;
			const index = lines.length;
			lines.push(row.line);
			firstRow.push(rowLine.length);
			const indices = byLine.get(row.line);
			if (indices) indices.push(index);
			else byLine.set(row.line, [index]);
		}
		for (const span of spans) {
			if (span.end <= span.start) continue;
			covered.push(span);
			high = Math.max(high, span.end);
		}
		rowLine.push(lines.length - 1);
	}
	const model: TextModel = { rows, lines, byLine, firstRow, rowLine, cells: [] };
	models.set(block, model);
	return model;
}

/** Graphemes a text row paints, left to right per span. */
export function rowCells(model: TextModel, index: number): readonly TextCell[] {
	const cached = model.cells[index];
	if (cached) return cached;
	const cells: TextCell[] = [];
	const row = model.rows[index];
	if (row) {
		for (const span of row.spans ?? [row]) {
			let col = span.column;
			for (const { segment, index: at } of graphemes.segment(row.line.text.slice(span.start, span.end))) {
				const width = visibleWidth(segment);
				const start = span.start + at;
				cells.push({ col, width, start, end: start + segment.length });
				col += width;
			}
		}
	}
	model.cells[index] = cells;
	return cells;
}

/** Columns on one row intersecting UTF-16 offsets [start, end) of its logical line, never chrome. */
export function columnRanges(model: TextModel, row: number, start: number, end: number): [number, number][] {
	const ranges: [number, number][] = [];
	for (const cell of rowCells(model, row)) {
		if (cell.end <= start || cell.start >= end) continue;
		const previous = ranges.at(-1);
		if (previous?.[1] === cell.col) previous[1] = cell.col + cell.width;
		else ranges.push([cell.col, cell.col + cell.width]);
	}
	return ranges;
}
