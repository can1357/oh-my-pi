/**
 * GFM tables as box-drawn grids fitted to a width: columns take their natural
 * width when the table fits, else shrink toward their longest word (capped at
 * 30 cells) and wrap; below one cell per column the raw source is shown.
 * Text: a table row is one line, its cells joined by the column rule, each
 * cell's text a run on every row it wraps to; the grid lines are decoration.
 */
import {
	clipRenderedText,
	mapWrappedText,
	type RenderedTextRow,
	type RenderedTextSpan,
	withSpans,
} from "../../term/text-layout";
import { padTo, spaces, truncate, visibleWidth, wrap } from "../width";
import type { Tokens } from "./lexer";

/** Longest unbroken word a column insists on fitting. */
const MAX_WORD = 30;
/** Closes bold/italic/color at the end of every cell line so nothing leaks into the borders. */
const CELL_END = "\x1b[22m\x1b[23m\x1b[39m";

type Align = Tokens.TableCell["align"];

/** What the table needs from the document renderer. */
export interface TableEnvironment {
	/** Inline content of a header (`header`) or body cell. */
	cellText(cell: Tokens.TableCell, header: boolean): string;
	tableHeader(text: string): string;
	readonly box: {
		readonly topLeft: string;
		readonly topRight: string;
		readonly bottomLeft: string;
		readonly bottomRight: string;
		readonly horizontal: string;
		readonly vertical: string;
		readonly teeDown: string;
		readonly teeUp: string;
		readonly teeLeft: string;
		readonly teeRight: string;
		readonly cross: string;
	};
}

function longestWord(text: string): number {
	let longest = 0;
	for (const word of text.split(/\s+/)) if (word) longest = Math.max(longest, visibleWidth(word));
	return Math.min(longest, MAX_WORD);
}

function lineWidths(text: string): number[] {
	return text.split("\n").map(visibleWidth);
}

function cellLines(text: string, width: number, clamp = true): string[] {
	const cellWidth = Math.max(1, width);
	const lines = wrap(text, cellWidth);
	while (lines.length > 1 && lines.at(-1) === "") lines.pop();
	if (lines.length === 0) lines.push("");
	return lines.map(line => `${clamp && visibleWidth(line) > cellWidth ? truncate(line, cellWidth) : line}${CELL_END}`);
}

/** Whether every box character draws one cell: then each grid row is exactly as wide as its columns say. */
function narrowBox(box: TableEnvironment["box"]): boolean {
	for (const key in box) if (visibleWidth(box[key as keyof typeof box]) !== 1) return false;
	return true;
}

/**
 * The lines of a streaming row's open cell held to `height`: the last kept
 * line makes room for a `…` saying more is coming (or gives way to it).
 */
function heldLines(lines: readonly string[], height: number, width: number): string[] {
	const kept = lines.slice(0, height);
	const last = width > 1 ? (cellLines(kept[height - 1]!, width - 1, false)[0] ?? "") : "";
	kept[height - 1] = `${visibleWidth(last) < width ? last : ""}…`;
	return kept;
}

function aligned(text: string, width: number, align: Align): string {
	const gap = Math.max(0, width - visibleWidth(text));
	if (gap === 0) return text;
	if (align === "right") return spaces(gap) + text;
	if (align === "center") {
		const left = Math.floor(gap / 2);
		return spaces(left) + text + spaces(gap - left);
	}
	return text + spaces(gap);
}

/** Shrink columns to `available` cells: proportional to their longest word, then to what they can still grow. */
function fitColumns(natural: readonly number[], words: readonly number[], available: number): number[] {
	const count = natural.length;
	let min = [...words];
	let minTotal = min.reduce((a, b) => a + b, 0);
	if (minTotal > available) {
		min = Array.from({ length: count }, () => 1);
		const spare = available - count;
		if (spare > 0) {
			const weight = words.reduce((total, w) => total + Math.max(0, w - 1), 0);
			let given = 0;
			for (let i = 0; i < count; i++) {
				const grow = weight > 0 ? Math.floor((Math.max(0, words[i]! - 1) / weight) * spare) : 0;
				min[i]! += grow;
				given += grow;
			}
			for (let i = 0; given < spare && i < count; i++, given++) min[i]!++;
		}
		minTotal = min.reduce((a, b) => a + b, 0);
	}
	const potential = natural.reduce((total, w, i) => total + Math.max(0, w - min[i]!), 0);
	const extra = Math.max(0, available - minTotal);
	const widths = min.map((w, i) =>
		potential > 0 ? w + Math.floor((Math.max(0, natural[i]! - w) / potential) * extra) : w,
	);
	let remaining = available - widths.reduce((a, b) => a + b, 0);
	while (remaining > 0) {
		let grew = false;
		for (let i = 0; i < count && remaining > 0; i++) {
			if (widths[i]! < natural[i]!) {
				widths[i]!++;
				remaining--;
				grew = true;
			}
		}
		if (!grew) break;
	}
	return widths;
}

/**
 * Rows of `token` at `width`. `openCell` is the cell of the last row still
 * being written while streaming: it does not size its column (rows above
 * keep their layout) and its row keeps the height its finished cells need.
 * With `rowText`, each row's text is pushed onto it.
 */
export function renderTable(
	env: TableEnvironment,
	token: Tokens.Table,
	width: number,
	openCell = -1,
	rowText?: (RenderedTextRow | undefined)[],
): string[] {
	const count = token.header.length;
	if (count === 0) return [];
	const overhead = 3 * count + 1;
	const available = width - overhead;
	if (available < count) {
		const raw = token.raw.replace(/\n+$/, "");
		const rows = wrap(raw, width);
		if (rowText) rowText.push(...mapWrappedText(raw, rows));
		return rows;
	}

	const headerTexts = token.header.map(cell => env.cellText(cell, true));
	const bodyTexts = token.rows.map(row => row.map(cell => env.cellText(cell, false)));
	const natural = headerTexts.map(text => Math.max(0, ...lineWidths(text)));
	const words = headerTexts.map(text => Math.max(1, longestWord(text)));
	const lastRow = bodyTexts.length - 1;
	const growing = lastRow > 0 ? openCell : -1;
	for (const [index, row] of bodyTexts.entries()) {
		row.forEach((text, i) => {
			if (index === lastRow && i === growing) return;
			natural[i] = Math.max(natural[i] ?? 0, ...lineWidths(text));
			words[i] = Math.max(words[i] ?? 1, longestWord(text));
		});
	}
	const naturalTotal = natural.reduce((a, b) => a + b, 0) + overhead;
	const widths =
		naturalTotal <= width ? natural.map((w, i) => Math.max(w, words[i]!)) : fitColumns(natural, words, available);

	const { box } = env;
	const h = box.horizontal;
	const rule = (left: string, join: string, right: string): string =>
		`${left}${h}${widths.map(w => h.repeat(w)).join(`${h}${join}${h}`)}${h}${right}`;
	const aligns: Align[] = token.header.map((cell, i) => cell.align ?? token.align[i] ?? null);
	const base = rowText?.length ?? 0;
	const out: string[] = [rule(box.topLeft, box.teeDown, box.topRight)];
	rowText?.push(undefined);
	const pushRow = (
		texts: readonly string[],
		style: ((text: string) => string) | undefined,
		cells: readonly Tokens.TableCell[],
		open = -1,
	): void => {
		const lines = widths.map((w, i) => cellLines(texts[i] ?? "", w));
		let height = Math.max(...lines.map(l => l.length));
		if (open >= 0 && lines[open]) {
			height = Math.max(1, ...lines.filter((_, i) => i !== open).map(l => l.length));
			if (lines[open]!.length > height) lines[open] = heldLines(lines[open]!, height, widths[open]!);
		}
		const alignOf = (i: number): Align => cells[i]?.align ?? aligns[i] ?? null;
		for (let line = 0; line < height; line++) {
			const parts = widths.map((w, i) => {
				const text = aligned(lines[i]![line] ?? "", w, alignOf(i));
				return style ? style(text) : text;
			});
			out.push(`${box.vertical} ${parts.join(` ${box.vertical} `)} ${box.vertical}`);
		}
		if (rowText) pushRowText(rowText, texts, lines, height, widths, alignOf, box.vertical);
	};
	pushRow(headerTexts, env.tableHeader, token.header);
	const separator = rule(box.teeRight, box.cross, box.teeLeft);
	out.push(separator);
	rowText?.push(undefined);
	token.rows.forEach((row, index) => {
		pushRow(bodyTexts[index]!, undefined, row, index === lastRow ? growing : -1);
		if (index < token.rows.length - 1) {
			out.push(separator);
			rowText?.push(undefined);
		}
	});
	out.push(rule(box.bottomLeft, box.teeUp, box.bottomRight));
	rowText?.push(undefined);
	// Cell lines are cut to their column and padded to it, so with a narrow box every row is
	// `overhead` plus the column widths wide; only a grid wider than `width` needs measuring.
	let gridWidth = overhead;
	for (const w of widths) gridWidth += w;
	if (gridWidth <= width && narrowBox(box)) return out;
	return out.map((row, i) => {
		if (visibleWidth(row) <= width) return row;
		if (rowText) rowText[base + i] = clipRenderedText(rowText[base + i], width);
		return padTo(row, width);
	});
}

/**
 * The text of a table row drawn `height` rows tall from cell `lines` (as
 * `cellLines` cut them) of `texts` in columns `widths`: one line holding the
 * cells joined by ` │ `, each visible piece of a cell a run at its column.
 */
function pushRowText(
	text: (RenderedTextRow | undefined)[],
	texts: readonly string[],
	lines: readonly (readonly string[])[],
	height: number,
	widths: readonly number[],
	alignOf: (i: number) => Align,
	vertical: string,
): void {
	const sources = widths.map((_, i) => Bun.stripANSI(texts[i] ?? "").replaceAll("\n", " "));
	const starts: number[] = [];
	let joined = "";
	for (let i = 0; i < sources.length; i++) {
		if (i > 0) joined += ` ${vertical} `;
		starts.push(joined.length);
		joined += sources[i];
	}
	const line = { text: joined.trimEnd() };
	const offsets = widths.map(() => 0);
	for (let row = 0; row < height; row++) {
		const spans: RenderedTextSpan[] = [];
		let column = 2;
		for (let i = 0; i < widths.length; i++) {
			const drawn = lines[i]![row] ?? "";
			const plain = Bun.stripANSI(drawn).trimEnd();
			let content = plain.trimStart();
			const gap = Math.max(0, widths[i]! - visibleWidth(drawn));
			const align = alignOf(i);
			const left = align === "right" ? gap : align === "center" ? Math.floor(gap / 2) : 0;
			const lead = visibleWidth(plain.slice(0, plain.length - content.length));
			let at = content ? sources[i]!.indexOf(content, offsets[i]) : -1;
			// A piece cut to fit (or held while streaming) ends in an ellipsis the cell's text lacks.
			if (at < 0 && content.endsWith("…")) {
				content = content.slice(0, -1).trimEnd();
				at = content ? sources[i]!.indexOf(content, offsets[i]) : -1;
			}
			if (at >= 0) {
				offsets[i] = at + content.length;
				const start = Math.min(starts[i]! + at, line.text.length);
				spans.push({
					start,
					end: Math.min(starts[i]! + offsets[i]!, line.text.length),
					column: column + left + lead,
				});
			}
			column += widths[i]! + 3;
		}
		text.push(withSpans(line, spans));
	}
}
