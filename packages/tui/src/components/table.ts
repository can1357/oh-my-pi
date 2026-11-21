import type { TspTableColumn, TspText } from "@oh-my-pi/pi-wire";
import { compactText, styleSpans } from "../native/spans";
import { node } from "../native/describe";
import type { DescribeContext, NativeNode } from "../native/node";
import type { Component } from "../tui";
import {
	Ellipsis,
	finiteWidth,
	getWidthConfigEpoch,
	replaceTabs,
	singleLine,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "../utils";

/** One table cell. Styling is applied after alignment so padding shares the cell style. */
export interface TableCell {
	readonly text: string;
	readonly style?: (text: string) => string;
}

/**
 * Explicit sizing and overflow policy for a table column. Overflow: `allow` keeps the
 * column at its width and lets text spill; `truncate` shrinks and cuts it with an ellipsis;
 * `wrap` shrinks and word-wraps it over extra lines ({@link renderTableRowLines} only; a
 * single-line {@link renderTableRow} truncates it).
 */
export interface TableColumn {
	readonly width: number;
	readonly minWidth?: number;
	readonly align: "left" | "right";
	readonly overflow: "allow" | "truncate" | "wrap";
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

/**
 * Fit column widths into `maxWidth`. Lower priorities give way first; within one priority,
 * `wrap` columns (which lose nothing) shrink before `truncate` columns, which shrink rightmost first.
 */
function fitWidths(columns: readonly TableColumn[], maxWidth: number, gapWidth: number): number[] {
	const widths = columns.map(column => finiteWidth(column.width));
	let overflow = widths.reduce((sum, width) => sum + width, 0) + Math.max(0, columns.length - 1) * gapWidth - maxWidth;
	if (overflow <= 0) return widths;

	const minimums = columns.map((column, index) => Math.min(widths[index]!, finiteWidth(column.minWidth ?? 1)));
	const priorities = [...new Set(columns.map(column => column.priority ?? 0))].sort((a, b) => a - b);
	for (const priority of priorities) {
		if (overflow <= 0) break;
		const ranked = columns.flatMap((column, index) => ((column.priority ?? 0) === priority ? [index] : []));
		const wrapping = ranked.filter(index => columns[index]!.overflow === "wrap");
		overflow = shrinkEvenly(widths, minimums, wrapping, overflow);
		for (const index of ranked.filter(index => columns[index]!.overflow === "truncate").reverse()) {
			if (overflow <= 0) break;
			const shrink = Math.min(overflow, widths[index]! - minimums[index]!);
			widths[index] = widths[index]! - shrink;
			overflow -= shrink;
		}
	}
	return widths;
}

/**
 * Shrink the widest of `indices` first, level by level, so wrapped columns end up balanced
 * instead of one collapsing to its minimum. Returns the overflow left over.
 */
function shrinkEvenly(
	widths: number[],
	minimums: readonly number[],
	indices: readonly number[],
	overflow: number,
): number {
	while (overflow > 0) {
		const open = indices.filter(index => widths[index]! > minimums[index]!);
		if (open.length === 0) break;
		const top = Math.max(...open.map(index => widths[index]!));
		const widest = open.filter(index => widths[index] === top);
		const level = Math.max(
			...open.map(index => widths[index]!).filter(width => width < top),
			...widest.map(index => minimums[index]!),
		);
		const step = Math.min(top - level, Math.ceil(overflow / widest.length));
		for (const index of widest.reverse()) {
			const cut = Math.min(step, overflow);
			widths[index] = widths[index]! - cut;
			overflow -= cut;
			if (overflow <= 0) break;
		}
	}
	return overflow;
}

/** Column widths and separators one row lays out over. */
interface RowLayout {
	readonly indent: string;
	readonly gap: string;
	readonly columns: readonly TableColumn[];
	readonly widths: readonly number[];
}

function layoutRow(
	count: number,
	columns: readonly TableColumn[],
	maxWidth: number | undefined,
	options: TableOptions,
): RowLayout {
	const indent = singleLine(options.indent ?? "");
	const active = columns.slice(0, count);
	const gap = singleLine(options.gap ?? " ");
	const widthBudget = maxWidth === undefined ? Number.MAX_SAFE_INTEGER : finiteWidth(maxWidth);
	const contentBudget = Math.max(0, widthBudget - visibleWidth(indent));
	const widths =
		options.fit === false
			? active.map(column => finiteWidth(column.width))
			: fitWidths(active, contentBudget, visibleWidth(gap));
	return { indent, gap, columns: active, widths };
}

/** One line of `cell` padded to `width`; text wider than a non-`allow` column is truncated. */
function alignCell(text: string, cell: TableCell, column: TableColumn, width: number): string {
	const visible = visibleWidth(text);
	const fitted = visible > width && column.overflow !== "allow" ? truncateToWidth(text, width) : text;
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
	if (count === 0) return singleLine(options.indent ?? "");
	const { indent, gap, columns: active, widths } = layoutRow(count, columns, maxWidth, options);
	const rendered = cells
		.slice(0, count)
		.map((cell, index) => alignCell(singleLine(cell.text), cell, active[index]!, widths[index]!));
	return `${indent}${rendered.join(gap)}`;
}

/**
 * Render one row over as many lines as its tallest `wrap` cell needs: `wrap` cells word-wrap
 * inside their fitted width and keep hard line breaks; other cells sit on the first line.
 */
export function renderTableRowLines(
	cells: readonly TableCell[],
	columns: readonly TableColumn[],
	maxWidth?: number,
	options: TableOptions = {},
): string[] {
	const count = Math.min(cells.length, columns.length);
	if (count === 0) return [singleLine(options.indent ?? "")];
	const { indent, gap, columns: active, widths } = layoutRow(count, columns, maxWidth, options);
	const stacks = cells.slice(0, count).map((cell, index) => {
		if (active[index]!.overflow !== "wrap") return [singleLine(cell.text)];
		const width = Math.max(1, widths[index]!);
		return replaceTabs(cell.text)
			.split(/\r\n?|\n/)
			.flatMap(line => {
				const wrapped = wrapTextWithAnsi(line, width);
				return wrapped.length > 0 ? wrapped : [""];
			});
	});
	const height = Math.max(...stacks.map(stack => stack.length));
	return Array.from({ length: height }, (_, line) => {
		const rendered = stacks.map((stack, index) =>
			alignCell(stack[line] ?? "", cells[index]!, active[index]!, widths[index]!),
		);
		return `${indent}${rendered.join(gap)}`;
	});
}

/** Bounded table component for structured rows with replaceable data and stable unchanged-render arrays. */
export class Table implements Component {
	#rows: readonly (readonly TableCell[])[];
	readonly #columns: readonly TableColumn[];
	readonly #options: TableOptions;
	#cache: { width: number; epoch: number; lines: readonly string[] } | undefined;
	#native: NativeNode | undefined;

	constructor(rows: readonly (readonly TableCell[])[], columns: readonly TableColumn[], options: TableOptions = {}) {
		this.#rows = rows;
		this.#columns = columns;
		this.#options = options;
	}

	setRows(rows: readonly (readonly TableCell[])[]): boolean {
		if (this.#rows === rows) return false;
		this.#rows = rows;
		this.#cache = undefined;
		this.#native = undefined;
		return true;
	}

	invalidate(): void {
		this.#cache = undefined;
		this.#native = undefined;
	}

	releaseRenderCaches(): void {
		this.#cache = undefined;
	}

	/**
	 * A native `table`. Column priorities carry over unchanged (lower gives
	 * way first); truncating columns truncate at the end, the rest keep
	 * their content. Widths are the terminal's.
	 */
	describe(_cx: DescribeContext): NativeNode {
		if (this.#native) return this.#native;
		const columns = this.#columns;
		const cols: TspTableColumn[] = columns.map((column, index) => ({
			id: `c${index}`,
			align: column.align === "right" ? "end" : "start",
			truncate: column.overflow === "truncate" ? "end" : undefined,
			priority: column.priority ?? 0,
		}));
		const rows = this.#rows.map((row, rowIndex) => {
			const cells: Record<string, TspText> = {};
			const count = Math.min(row.length, columns.length);
			for (let index = 0; index < count; index++) {
				const cell = row[index]!;
				cells[`c${index}`] = compactText(styleSpans(singleLine(cell.text), cell.style ?? columns[index]!.style));
			}
			return { id: `r${rowIndex}`, cells };
		});
		this.#native = node("table", { cols, rows });
		return this.#native;
	}

	render(width: number): readonly string[] {
		const renderWidth = finiteWidth(width);
		const epoch = getWidthConfigEpoch();
		if (this.#cache?.width === renderWidth && this.#cache.epoch === epoch) return this.#cache.lines;
		const lines = this.#rows.flatMap(row =>
			renderTableRowLines(row, this.#columns, renderWidth, this.#options).map(line =>
				truncateToWidth(line, renderWidth, Ellipsis.Omit),
			),
		);
		this.#cache = { width: renderWidth, epoch, lines };
		return lines;
	}
}
