/**
 * Logical text of painted rows: which characters of which source line each
 * row shows, before visual wrapping and without chrome.
 *
 * Painters attach it to their block as a lazy thunk (`Block.text`, built with
 * {@link lazyText}), so nothing is computed until a consumer (transcript
 * selection, a reading anchor) asks. A row's entry names the logical line it
 * draws (shared by every row that line wraps into), the UTF-16 range of that
 * line it shows and the block column it starts at; `undefined` marks a
 * decoration row (a border, a rule, padding, an image). A painter that cannot
 * report leaves `text` absent and its rows copy literally.
 */
import { RESERVED_ROW } from "../driver/images/anchor";
import { KITTY_PLACEHOLDER } from "../driver/images/kitty";
import { untrack } from "../reactive";
import { sliceCells, visibleWidth } from "../text/width";
import type { Block } from "./paint";

/** One logical line a painter drew, before visual wrapping; shared by every row it wraps into. */
export interface RenderedTextLine {
	readonly text: string;
}

export interface RenderedTextSpan {
	readonly start: number;
	readonly end: number;
	readonly column: number;
}

/**
 * A painted row's content: `line.text.slice(start, end)` drawn from block
 * column `column`; `spans` lists every run when they are disjoint (list
 * prefix beside quote chrome, table cells).
 */
export interface RenderedTextRow extends RenderedTextSpan {
	readonly line: RenderedTextLine;
	readonly spans?: readonly RenderedTextSpan[];
}

/** Aligned with `Block.rows`; `undefined` marks a decoration row (border, rule, padding, image). */
export type RenderedText = readonly (RenderedTextRow | undefined)[];

/** Whether a painted row carries an inline image (or reserves an image's cells). */
function isImageRow(row: string): boolean {
	if (row === RESERVED_ROW || row.includes(KITTY_PLACEHOLDER)) return true;
	for (let index = row.indexOf("\x1b"); index >= 0; index = row.indexOf("\x1b", index + 1)) {
		const next = row.charCodeAt(index + 1);
		// Kitty graphics APC.
		if (next === 0x5f && row.charCodeAt(index + 2) === 0x47) return true;
		// iTerm2 inline file.
		if (next === 0x5d && row.startsWith("1337;File=", index + 2)) return true;
		// SIXEL: DCS, numeric parameters, then `q`.
		if (next === 0x50) {
			let cursor = index + 2;
			let code = row.charCodeAt(cursor);
			while ((code >= 0x30 && code <= 0x39) || code === 0x3b) code = row.charCodeAt(++cursor);
			if (code === 0x71) return true;
		}
	}
	return false;
}

/** A row read literally: image rows are decoration, anything else is its stripped text at column 0. */
export function literalRenderedText(row: string): RenderedTextRow | undefined {
	if (isImageRow(row)) return undefined;
	const text = Bun.stripANSI(row).trimEnd();
	return { line: { text }, start: 0, end: text.length, column: 0 };
}

// Literal readings of blocks without a usable `text`, so repeated reads share line identities.
const literalTexts = new WeakMap<Block, RenderedText>();

/**
 * The logical text of every row of `block`: its own report, else its rows
 * read literally (as is a report that does not describe every row).
 */
export function blockText(block: Block): RenderedText {
	const own = block.text?.();
	if (own && own.length === block.rows.length) return own;
	let text = literalTexts.get(block);
	if (!text) {
		text = block.rows.map(literalRenderedText);
		literalTexts.set(block, text);
	}
	return text;
}

const DECORATION_ROW: RenderedText = Object.freeze([undefined]);
const oneDecorationRow = (): RenderedText => DECORATION_ROW;

/** `Block.text` of `rows` decoration rows (borders, rules, images). */
export function decorationText(rows: number): () => RenderedText {
	return rows === 1 ? oneDecorationRow : lazyText(() => Array.from({ length: rows }, () => undefined));
}

/**
 * The text of `shown`, one row cut from the single line `source` (equal when
 * it fits): the run it shows (an ellipsis it ends in excluded) of a line cut
 * to that run, at column 0.
 */
export function shownText(source: string, shown: string): RenderedTextRow | undefined {
	return sliceRenderedText(mapWrappedText(source, [shown]), 0, 1)[0];
}

/**
 * A memoized thunk for `Block.text`: `compute` runs once, on the first call,
 * outside any reactive tracking (a consumer may ask from inside its own
 * computation; producers read only what they captured while painting).
 */
export function lazyText(compute: () => RenderedText): () => RenderedText {
	let text: RenderedText | undefined;
	return () => {
		text ??= untrack(compute);
		return text;
	};
}

/** `row` drawn `columns` further right (spans included). */
export function offsetRenderedText(row: RenderedTextRow | undefined, columns: number): RenderedTextRow | undefined {
	if (!row || columns === 0) return row;
	return {
		line: row.line,
		start: row.start,
		end: row.end,
		column: row.column + columns,
		...(row.spans ? { spans: row.spans.map(span => ({ ...span, column: span.column + columns })) } : {}),
	};
}

/** `row` cut to the cells left of column `limit` (what a row cut at that width still shows). */
export function clipRenderedText(row: RenderedTextRow | undefined, limit: number): RenderedTextRow | undefined {
	if (!row) return undefined;
	const spans: RenderedTextSpan[] = [];
	let changed = false;
	for (const span of row.spans ?? [row]) {
		if (span.column >= limit && span.end > span.start) {
			changed = true;
			continue;
		}
		const shown = row.line.text.slice(span.start, span.end);
		const room = limit - span.column;
		const kept = visibleWidth(shown) <= room ? shown.length : sliceCells(shown, 0, room).text.length;
		if (kept < shown.length) changed = true;
		spans.push(kept === shown.length ? span : { start: span.start, end: span.start + kept, column: span.column });
	}
	if (!changed) return row;
	return withSpans(row.line, spans);
}

/** A row of `line` showing `spans` (the first one anchors it); a row showing none keeps its line with no runs. */
export function withSpans(line: RenderedTextLine, spans: readonly RenderedTextSpan[]): RenderedTextRow {
	const first = spans[0];
	if (!first) return { line, start: 0, end: 0, column: 0, spans: [] };
	return spans.length === 1
		? { line, start: first.start, end: first.end, column: first.column }
		: { line, start: first.start, end: first.end, column: first.column, spans };
}

/** The range of `line` the rows of `text` show: lowest run start and highest run end. */
function shownRange(text: RenderedText, line: RenderedTextLine): { low: number; high: number } {
	let low = line.text.length;
	let high = 0;
	for (const row of text) {
		if (row?.line !== line) continue;
		for (const span of row.spans ?? [row]) {
			low = Math.min(low, span.start);
			high = Math.max(high, span.end);
		}
	}
	return { low: Math.min(low, high), high };
}

/**
 * Rows `[from, to)` of `text` (what a clamp keeps) showing only what they
 * paint: the first line loses the head it shows on dropped rows above, the
 * last line the tail its kept rows do not show (dropped rows below, or a cut
 * row), so copying them never yields text that is no longer painted.
 */
export function sliceRenderedText(text: RenderedText, from: number, to: number): RenderedText {
	const kept = text.slice(from, to);
	const first = kept.find(row => row !== undefined)?.line;
	const last = kept.findLast(row => row !== undefined)?.line;
	if (!first || !last) return kept;
	const cuts = new Map<RenderedTextLine, { line: RenderedTextLine; shift: number }>();
	const cut = (line: RenderedTextLine, start: number, end: number): void => {
		if (start > 0 || end < line.text.length)
			cuts.set(line, { line: { text: line.text.slice(start, end) }, shift: start });
	};
	const head = text.slice(0, from).some(row => row?.line === first);
	if (first === last) {
		const range = shownRange(kept, first);
		cut(first, head ? range.low : 0, range.high);
	} else {
		if (head) cut(first, shownRange(kept, first).low, first.text.length);
		cut(last, 0, shownRange(kept, last).high);
	}
	if (cuts.size === 0) return kept;
	return kept.map(row => {
		const moved = row && cuts.get(row.line);
		if (!row || !moved) return row;
		const spans = (row.spans ?? [row]).map(span => ({
			start: span.start - moved.shift,
			end: span.end - moved.shift,
			column: span.column,
		}));
		return withSpans(moved.line, spans);
	});
}

/** Lines past the current one a row of {@link mapWrappedText} is looked for in. */
const MAX_LOOKAHEAD = 64;

/**
 * Map rows a wrapper produced from `text` (one or more `\n`-separated logical
 * lines) back to it: each row shows the next run of its line, found in order.
 * Whitespace the wrapper elided at a break stays in the logical text, so
 * pass the wrapper's real input (after tab expansion), not a source it was
 * derived from. A row cut with an ellipsis maps the run before it. A row
 * that matches nothing (a transformed run) reads literally without losing
 * the place of the rows after it.
 */
export function mapWrappedText(text: string, rows: readonly string[]): RenderedText {
	const lines: RenderedTextLine[] = Bun.stripANSI(text)
		.split("\n")
		.map(line => ({ text: line.trimEnd() }));
	let lineIndex = 0;
	let offset = 0;
	// Rows come from the lines in order, each line giving at least one: a row is found on its own
	// line or one just after. The bound keeps rows that match nothing from rescanning the rest.
	/** The first line from the current one holding `content` after what is already shown. */
	const locate = (content: string): { index: number; start: number } | undefined => {
		for (let index = lineIndex, end = Math.min(lines.length, lineIndex + MAX_LOOKAHEAD); index < end; index++) {
			const start = lines[index]!.text.indexOf(content, index === lineIndex ? offset : 0);
			if (start >= 0) return { index, start };
		}
		return undefined;
	};
	return rows.map(row => {
		if (isImageRow(row)) return undefined;
		const plain = Bun.stripANSI(row).trimEnd();
		let content = plain.trimStart();
		const column = content ? visibleWidth(plain.slice(0, plain.length - content.length)) : 0;
		if (!content) {
			// A blank row is a blank line: the next one not yet shown.
			for (let index = lineIndex, end = Math.min(lines.length, lineIndex + MAX_LOOKAHEAD); index < end; index++) {
				const line = lines[index]!;
				if (line.text.length > 0) continue;
				lineIndex = index + 1;
				offset = 0;
				return { line, start: 0, end: 0, column: 0 };
			}
			return literalRenderedText(row);
		}
		let found = locate(content);
		// `truncate` ends a cut row in `…` (or `...`).
		const ellipsis = found ? 0 : content.endsWith("…") ? 1 : content.endsWith("...") ? 3 : 0;
		if (ellipsis > 0) {
			content = content.slice(0, -ellipsis).trimEnd();
			// A row cut down to its ellipsis shows none of the current line.
			found = content ? locate(content) : lineIndex < lines.length ? { index: lineIndex, start: offset } : undefined;
		}
		if (!found) return literalRenderedText(row);
		lineIndex = found.index;
		offset = found.start + content.length;
		return { line: lines[found.index]!, start: found.start, end: offset, column };
	});
}
