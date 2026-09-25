import type { Component } from "../tui";
import { Ellipsis, getWidthConfigEpoch, replaceTabs, truncateToWidth, visibleWidth } from "../utils";

/** One table cell. Styling is applied after alignment so padding shares the cell style. */
export interface TableCell {
	readonly text: string;
	readonly style?: (text: string) => string;
}

/** Explicit sizing and overflow policy for a table column. */
export interface TableColumn {
	readonly width: number;
	readonly minWidth?: number;
	readonly align: "left" | "right";
	readonly overflow: "allow" | "truncate";
	/** Lower-priority columns shrink before higher-priority columns. */
	readonly priority?: number;
	readonly style?: (text: string) => string;
}

/** Row-layout options shared by table functions and the component. */
export interface TableOptions {
	readonly gap?: string;
	readonly indent?: string;
	readonly fit?: boolean;
}

function finiteWidth(width: number, fallback = 0): number {
	return Number.isFinite(width) ? Math.max(0, Math.trunc(width)) : fallback;
}

function singleLine(text: string): string {
	return replaceTabs(text).replace(/[\r\n]+/g, " ");
}

function fitWidths(columns: readonly TableColumn[], maxWidth: number, gapWidth: number): number[] {
	const widths = columns.map(column => finiteWidth(column.width));
	let overflow = widths.reduce((sum, width) => sum + width, 0) + Math.max(0, columns.length - 1) * gapWidth - maxWidth;
	if (overflow <= 0) return widths;

	const order = columns
		.map((column, index) => ({ index, priority: column.priority ?? 0 }))
		.sort((a, b) => a.priority - b.priority || b.index - a.index);
	for (const { index } of order) {
		if (overflow <= 0) break;
		const column = columns[index]!;
		if (column.overflow !== "truncate") continue;
		const minimum = Math.min(widths[index]!, finiteWidth(column.minWidth ?? 1));
		const shrink = Math.min(overflow, widths[index]! - minimum);
		widths[index] = widths[index]! - shrink;
		overflow -= shrink;
	}
	return widths;
}

function alignCell(cell: TableCell, column: TableColumn, width: number): string {
	const text = singleLine(cell.text);
	const visible = visibleWidth(text);
	const fitted = visible > width && column.overflow === "truncate" ? truncateToWidth(text, width) : text;
	const fittedWidth = visibleWidth(fitted);
	const padding = " ".repeat(Math.max(0, width - fittedWidth));
	const aligned = column.align === "right" ? `${padding}${fitted}` : `${fitted}${padding}`;
	const style = cell.style ?? column.style;
	return style ? style(aligned) : aligned;
}

/** Render one ANSI-aware fixed-column row. */
export function renderTableRow(
	cells: readonly TableCell[],
	columns: readonly TableColumn[],
	maxWidth?: number,
	options: TableOptions = {},
): string {
	const count = Math.min(cells.length, columns.length);
	const indent = singleLine(options.indent ?? "");
	if (count === 0) return indent;
	const activeColumns = columns.slice(0, count);
	const gap = singleLine(options.gap ?? " ");
	const widthBudget = maxWidth === undefined ? Number.MAX_SAFE_INTEGER : finiteWidth(maxWidth);
	const contentBudget = Math.max(0, widthBudget - visibleWidth(indent));
	const widths =
		options.fit === false
			? activeColumns.map(column => finiteWidth(column.width))
			: fitWidths(activeColumns, contentBudget, visibleWidth(gap));
	const rendered = cells.slice(0, count).map((cell, index) => alignCell(cell, activeColumns[index]!, widths[index]!));
	return `${indent}${rendered.join(gap)}`;
}

/** Bounded table component for structured rows with replaceable data and stable unchanged-render arrays. */
export class Table implements Component {
	#rows: readonly (readonly TableCell[])[];
	readonly #columns: readonly TableColumn[];
	readonly #options: TableOptions;
	#cache: { width: number; epoch: number; lines: readonly string[] } | undefined;

	constructor(rows: readonly (readonly TableCell[])[], columns: readonly TableColumn[], options: TableOptions = {}) {
		this.#rows = rows;
		this.#columns = columns;
		this.#options = options;
	}

	setRows(rows: readonly (readonly TableCell[])[]): boolean {
		if (this.#rows === rows) return false;
		this.#rows = rows;
		this.#cache = undefined;
		return true;
	}

	invalidate(): void {
		this.#cache = undefined;
	}

	render(width: number): readonly string[] {
		const renderWidth = finiteWidth(width);
		const epoch = getWidthConfigEpoch();
		if (this.#cache?.width === renderWidth && this.#cache.epoch === epoch) return this.#cache.lines;
		const lines = this.#rows.map(row =>
			truncateToWidth(
				singleLine(renderTableRow(row, this.#columns, renderWidth, this.#options)),
				renderWidth,
				Ellipsis.Omit,
			),
		);
		this.#cache = { width: renderWidth, epoch, lines };
		return lines;
	}
}
