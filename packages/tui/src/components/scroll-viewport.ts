import { getSegmenter, sliceWithWidth, visibleWidth } from "../utils";

const segmenter = getSegmenter();

export type ViewportAlignment = "nearest" | "start" | "center" | "end";

export interface ViewportRange {
	/** First visible logical row. */
	start: number;
	/** Exclusive end of the visible logical rows. */
	end: number;
}

export interface ScrollbarThumbRange {
	/** First local viewport row occupied by the thumb. */
	start: number;
	/** Exclusive end of the thumb. */
	end: number;
}

export interface CursorColumnWindow {
	/** Visible source slice. */
	text: string;
	/** First visible terminal column in the source. */
	startColumn: number;
	/** UTF-16 index of the cursor within {@link text}. */
	cursorIndex: number;
}

function boundedInteger(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

/** Maximum legal row offset for a bounded viewport. */
export function maxScrollOffset(totalRows: number, viewportRows: number): number {
	return Math.max(0, boundedInteger(totalRows) - boundedInteger(viewportRows));
}

/** Clamp a row offset to the bounds of a viewport. */
export function clampScrollOffset(offset: number, totalRows: number, viewportRows: number): number {
	const safeOffset = Number.isFinite(offset) ? Math.trunc(offset) : 0;
	return Math.max(0, Math.min(safeOffset, maxScrollOffset(totalRows, viewportRows)));
}

/** Logical half-open row range visible at an offset. */
export function viewportRange(totalRows: number, viewportRows: number, offset: number): ViewportRange {
	const total = boundedInteger(totalRows);
	const height = boundedInteger(viewportRows);
	const start = clampScrollOffset(offset, total, height);
	return { start, end: Math.min(total, start + height) };
}

/** Whether the logical row set is taller than its viewport. */
export function viewportOverflows(totalRows: number, viewportRows: number): boolean {
	return boundedInteger(totalRows) > boundedInteger(viewportRows);
}

/**
 * Offset that keeps `row` visible, optionally aligning it to a viewport edge
 * or center. `nearest` preserves the current offset while the row is visible.
 */
export function scrollOffsetForRow(
	currentOffset: number,
	row: number,
	totalRows: number,
	viewportRows: number,
	alignment: ViewportAlignment = "nearest",
): number {
	const total = boundedInteger(totalRows);
	const height = boundedInteger(viewportRows);
	if (total === 0 || height === 0) return 0;

	const selected = Math.max(0, Math.min(boundedInteger(row), total - 1));
	const current = clampScrollOffset(currentOffset, total, height);
	let next: number;
	switch (alignment) {
		case "start":
			next = selected;
			break;
		case "center":
			next = selected - Math.floor(height / 2);
			break;
		case "end":
			next = selected - height + 1;
			break;
		case "nearest":
			if (selected < current) next = selected;
			else if (selected >= current + height) next = selected - height + 1;
			else next = current;
			break;
	}
	return clampScrollOffset(next, total, height);
}

/** Selection-centered logical row window. */
export function centeredViewportRange(selectedRow: number, totalRows: number, viewportRows: number): ViewportRange {
	const start = scrollOffsetForRow(0, selectedRow, totalRows, viewportRows, "center");
	return viewportRange(totalRows, viewportRows, start);
}

/**
 * Scrollbar thumb geometry shared by standalone viewports and embedded border
 * renderers. The returned rows are local to the viewport.
 */
export function scrollbarThumbRange(
	viewportRows: number,
	totalRows: number,
	scrollOffset: number,
): ScrollbarThumbRange {
	const height = boundedInteger(viewportRows);
	const total = boundedInteger(totalRows);
	if (height === 0) return { start: 0, end: 0 };
	if (total <= height) return { start: 0, end: height };

	const size = Math.max(1, Math.min(Math.floor((height * height) / total), height));
	const travel = height - size;
	const maxOffset = maxScrollOffset(total, height);
	const offset = clampScrollOffset(scrollOffset, total, height);
	const start = maxOffset === 0 ? 0 : Math.round((offset / maxOffset) * travel);
	return { start, end: start + size };
}

/**
 * Horizontally window a single rendered line around its cursor. Grapheme width
 * is respected, including a wide cursor cell at the right edge.
 */
export function cursorColumnWindow(text: string, cursorIndex: number, width: number): CursorColumnWindow {
	const safeWidth = boundedInteger(width);
	const cursor = Number.isFinite(cursorIndex) ? Math.max(0, Math.min(Math.trunc(cursorIndex), text.length)) : 0;
	if (safeWidth === 0) return { text: "", startColumn: 0, cursorIndex: 0 };

	const totalColumns = visibleWidth(text);
	const cursorColumns = visibleWidth(text.slice(0, cursor));
	const cursorSegment = segmenter.segment(text.slice(cursor))[Symbol.iterator]().next().value?.segment ?? " ";
	const cursorWidth = visibleWidth(cursorSegment);
	const maxStart = Math.max(0, totalColumns - safeWidth);
	let startColumn = 0;
	if (totalColumns > safeWidth) {
		startColumn = Math.max(0, Math.min(maxStart, cursorColumns - Math.floor(safeWidth / 2)));
		const maxCursorColumn = Math.max(0, safeWidth - cursorWidth);
		const relativeCursorColumn = cursorColumns - startColumn;
		if (relativeCursorColumn > maxCursorColumn) {
			startColumn = Math.max(0, Math.min(maxStart, cursorColumns - maxCursorColumn));
		}
	}

	const visibleText = sliceWithWidth(text, startColumn, safeWidth, true).text;
	const prefix = sliceWithWidth(text, startColumn, Math.max(0, cursorColumns - startColumn), true).text;
	return {
		text: visibleText,
		startColumn,
		cursorIndex: Math.max(0, Math.min(prefix.length, visibleText.length)),
	};
}
