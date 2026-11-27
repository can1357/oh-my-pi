/**
 * Transcript text selection: a pure model over painted transcript blocks.
 *
 * Endpoints anchor to block text, not to screen cells: a node, one of its
 * logical lines (`RenderedTextLine`, see term/text-layout.ts) and a UTF-16
 * offset into that line's text. Highlighting and copying resolve the anchors
 * against the blocks as currently painted, so a selection survives scrolling,
 * streaming and re-layout at another width while the same nodes still paint
 * the same lines (by identity, or by equal text at the same logical index once
 * a repaint replaced the line objects).
 *
 * No terminal I/O, timers or painting happen here: the backend feeds pointer
 * positions in document rows and content columns, and asks for highlight
 * ranges and the selected text.
 */
import type { UiNode } from "../node";
import type { Block } from "./paint";
import type { RenderedTextLine } from "./text-layout";
import { columnRanges, graphemes, rowCells, type TextModel, textModel } from "./transcript-text";

/** The transcript as the selection sees it: main nodes stacked into document rows. */
export interface SelectionDocument {
	/** Main nodes in document order. */
	readonly nodes: readonly UiNode[];
	/** Total document rows. */
	readonly rows: number;
	/** The node's block, painted at the content width (cached paint). */
	block(node: UiNode): Block;
	/** Document row of the node's first row; undefined when the node is absent. */
	top(node: UiNode): number | undefined;
	/** The node and block row painted at a document row; undefined for a separator row. */
	at(row: number): { readonly node: UiNode; readonly row: number } | undefined;
}

/** What a drag extends by: the press's unit (single, double, triple click). */
export type SelectionUnit = "char" | "word" | "line";

/** Selected content columns of one document row; ranges are `[start, end)`. */
export interface SelectionHighlight {
	readonly row: number;
	readonly ranges: readonly (readonly [start: number, end: number])[];
}

/** A selection endpoint, anchored to block text. */
interface Anchor {
	readonly node: UiNode;
	readonly line: RenderedTextLine;
	/** Logical line index in the node's block when anchored. */
	readonly index: number;
	/** The line's text when anchored. */
	readonly text: string;
	readonly offset: number;
}

/** An anchor resolved against the current paint. */
interface Position {
	readonly node: UiNode;
	readonly top: number;
	readonly model: TextModel;
	readonly index: number;
	readonly offset: number;
}

/** A pointer resolved to text: the node's line and the offsets the cell covers. */
interface TextHit {
	readonly node: UiNode;
	readonly top: number;
	readonly model: TextModel;
	readonly index: number;
	readonly start: number;
	readonly end: number;
}

interface SelectionState {
	unit: SelectionUnit;
	/** The unit the press selected; the selection always covers it. */
	originStart: Anchor;
	originEnd: Anchor;
	start: Anchor;
	end: Anchor;
}

const DEFAULT_MULTI_CLICK_MS = 400;
const MAX_EDGE_SCROLL_STEP = 3;
const WORD_CHAR = /^[\p{L}\p{N}\p{M}_]+$/u;

function compare(a: { top: number; index: number }, aOffset: number, b: Position): number {
	return a.top - b.top || a.index - b.index || aOffset - b.offset;
}

/** The run of graphemes at a hit: a word (letters, digits, `_`), else a run of one repeated character. */
function wordAt(text: string, start: number, end: number): [number, number] {
	const parts = [...graphemes.segment(text)];
	if (parts.length === 0) return [start, end];
	// Past the end of a row the hit is empty: take the grapheme before it.
	const found =
		start < end
			? parts.findIndex(part => part.index + part.segment.length > start)
			: parts.findLastIndex(part => part.index < start);
	const at = found < 0 ? (start < end ? parts.length - 1 : 0) : found;
	const pivot = parts[at]!.segment;
	const word = WORD_CHAR.test(pivot);
	let first = at;
	let last = at;
	while (first > 0 && (word ? WORD_CHAR.test(parts[first - 1]!.segment) : parts[first - 1]!.segment === pivot))
		first--;
	while (
		last + 1 < parts.length &&
		(word ? WORD_CHAR.test(parts[last + 1]!.segment) : parts[last + 1]!.segment === pivot)
	)
		last++;
	const tail = parts[last]!;
	return [parts[first]!.index, tail.index + tail.segment.length];
}

function expand(hit: TextHit, unit: SelectionUnit): [number, number] {
	if (unit === "line") return [0, hit.model.lines[hit.index]!.text.length];
	if (unit === "word") return wordAt(hit.model.lines[hit.index]!.text, hit.start, hit.end);
	return [hit.start, hit.end];
}

function anchor(target: { node: UiNode; model: TextModel; index: number }, offset: number): Anchor {
	const line = target.model.lines[target.index]!;
	return { node: target.node, line, index: target.index, text: line.text, offset };
}

function resolve(doc: SelectionDocument, at: Anchor): Position | undefined {
	const top = doc.top(at.node);
	if (top === undefined) return undefined;
	const model = textModel(doc.block(at.node));
	let index: number | undefined;
	const same = model.byLine.get(at.line);
	if (same) {
		index = same[0]!;
		for (const candidate of same) if (Math.abs(candidate - at.index) < Math.abs(index - at.index)) index = candidate;
	} else {
		const line = model.lines[at.index];
		// A repaint replaced the line objects: the same logical line still has the text (or
		// extends it while streaming) at the same index.
		if (line?.text.startsWith(at.text)) index = at.index;
	}
	if (index === undefined) return undefined;
	return { node: at.node, top, model, index, offset: Math.min(at.offset, model.lines[index]!.text.length) };
}

/** Text under a document cell; undefined for separator, decoration and blank rows. */
function textRow(
	doc: SelectionDocument,
	row: number,
): { node: UiNode; top: number; model: TextModel; row: number } | undefined {
	if (row < 0 || row >= doc.rows) return undefined;
	const at = doc.at(row);
	if (!at) return undefined;
	const top = doc.top(at.node);
	if (top === undefined) return undefined;
	const model = textModel(doc.block(at.node));
	if (model.rowLine[at.row] === undefined || rowCells(model, at.row).length === 0) return undefined;
	return { node: at.node, top, model, row: at.row };
}

function hitCell(target: { node: UiNode; top: number; model: TextModel; row: number }, col: number): TextHit {
	const cells = rowCells(target.model, target.row);
	const index = target.model.rowLine[target.row]!;
	const cell = cells.find(cell => col < cell.col + cell.width);
	if (cell)
		return { node: target.node, top: target.top, model: target.model, index, start: cell.start, end: cell.end };
	// Past the row's text: the end of its text.
	const end = cells.reduce((max, cell) => Math.max(max, cell.end), 0);
	return { node: target.node, top: target.top, model: target.model, index, start: end, end };
}

/** Rows to autoscroll per tick while dragging at `pointerRow` outside [top, bottom); bounded magnitude, 0 inside. */
export function edgeScrollStep(pointerRow: number, top: number, bottom: number): number {
	if (pointerRow < top) return -Math.min(MAX_EDGE_SCROLL_STEP, top - pointerRow);
	if (pointerRow >= bottom) return Math.min(MAX_EDGE_SCROLL_STEP, pointerRow - bottom + 1);
	return 0;
}

/** Selection over a {@link SelectionDocument}: press, drag, release; then highlight and copy. */
export class TranscriptSelection {
	readonly #now: () => number;
	readonly #multiClickMs: number;
	#state: SelectionState | undefined;
	#dragging = false;
	#lastClick: { time: number; row: number; col: number; count: number } | undefined;

	constructor(options?: { readonly now?: () => number; readonly multiClickMs?: number }) {
		this.#now = options?.now ?? Date.now;
		this.#multiClickMs = options?.multiClickMs ?? DEFAULT_MULTI_CLICK_MS;
	}

	/** A non-empty selection exists. */
	get active(): boolean {
		const state = this.#state;
		if (!state) return false;
		const { start, end } = state;
		return (
			start.node !== end.node || start.line !== end.line || start.index !== end.index || start.offset !== end.offset
		);
	}

	get dragging(): boolean {
		return this.#dragging;
	}

	/** Start a selection at a document cell; false (and nothing started) when no text is there. */
	press(doc: SelectionDocument, row: number, col: number): boolean {
		this.#state = undefined;
		this.#dragging = false;
		const target = textRow(doc, row);
		if (!target) {
			this.#lastClick = undefined;
			return false;
		}
		const time = this.#now();
		const last = this.#lastClick;
		const count =
			last && last.row === row && last.col === col && time - last.time <= this.#multiClickMs
				? (last.count % 3) + 1
				: 1;
		this.#lastClick = { time, row, col, count };
		const unit: SelectionUnit = count === 3 ? "line" : count === 2 ? "word" : "char";
		const hit = hitCell(target, col);
		const [start, end] = expand(hit, unit);
		const originStart = anchor(hit, start);
		const originEnd = anchor(hit, end);
		// A character press selects nothing until the pointer leaves the pressed cell; the drag then covers it.
		this.#state = {
			unit,
			originStart,
			originEnd,
			start: originStart,
			end: unit === "char" ? originStart : originEnd,
		};
		this.#dragging = true;
		return true;
	}

	/** Extend the selection to a document cell in the press's unit. */
	drag(doc: SelectionDocument, row: number, col: number): void {
		const state = this.#state;
		if (!state || !this.#dragging) return;
		this.#extend(doc, state, row, col);
	}

	/** Finish the drag at a document cell; a gap snaps to the nearest text. */
	release(doc: SelectionDocument, row: number, col: number): void {
		const state = this.#state;
		if (!state || !this.#dragging) return;
		this.#dragging = false;
		this.#extend(doc, state, row, col);
		if (this.#state && !this.active) this.#state = undefined;
	}

	/** Drop the selection; false when there was none. */
	clear(): boolean {
		const had = this.#state !== undefined;
		this.#state = undefined;
		this.#dragging = false;
		return had;
	}

	/** Clear when an endpoint's node is gone or no longer paints the anchored text. */
	validate(doc: SelectionDocument): void {
		this.#resolve(doc);
	}

	/** Selected content columns per document row in [from, to). */
	highlight(doc: SelectionDocument, from: number, to: number): readonly SelectionHighlight[] {
		const range = this.#resolve(doc);
		if (!range) return [];
		const [start, end] = range;
		const out: SelectionHighlight[] = [];
		const first = Math.max(from, start.top);
		const last = Math.min(to, doc.rows);
		for (let row = first; row < last; row++) {
			const at = doc.at(row);
			if (!at) continue;
			const top = doc.top(at.node);
			if (top === undefined || top < start.top) continue;
			if (top > end.top) break;
			const model =
				at.node === start.node ? start.model : at.node === end.node ? end.model : textModel(doc.block(at.node));
			const index = model.rowLine[at.row];
			if (index === undefined) continue;
			const position = { top, index };
			if (compare(position, model.lines[index]!.text.length, start) < 0 || compare(position, 0, end) > 0) continue;
			const lineStart = at.node === start.node && index === start.index ? start.offset : 0;
			const lineEnd = at.node === end.node && index === end.index ? end.offset : model.lines[index]!.text.length;
			const ranges = columnRanges(model, at.row, lineStart, lineEnd);
			if (ranges.length > 0) out.push({ row, ranges });
		}
		return out;
	}

	/** The selected logical lines joined with "\n", with a blank line where separator rows divide blocks; undefined when nothing is selected. */
	text(doc: SelectionDocument): string | undefined {
		const range = this.#resolve(doc);
		if (!range) return undefined;
		const [start, end] = range;
		if (compare(start, start.offset, end) >= 0) return undefined;
		const from = doc.nodes.indexOf(start.node);
		const to = doc.nodes.indexOf(end.node);
		if (from < 0 || to < 0) return undefined;
		let out = "";
		// Document row just past the last block that contributed a line.
		let previousEnd: number | undefined;
		for (let n = from; n <= to; n++) {
			const node = doc.nodes[n]!;
			const top = doc.top(node);
			if (top === undefined) continue;
			const model = node === start.node ? start.model : node === end.node ? end.model : textModel(doc.block(node));
			const firstLine = node === start.node ? start.index : 0;
			const lastLine = node === end.node ? end.index : model.lines.length - 1;
			if (firstLine > lastLine) continue;
			if (previousEnd !== undefined) {
				let separated = false;
				for (let row = previousEnd; row < top && !separated; row++) separated = doc.at(row) === undefined;
				out += separated ? "\n\n" : "\n";
			}
			for (let index = firstLine; index <= lastLine; index++) {
				const text = model.lines[index]!.text;
				const s = node === start.node && index === start.index ? start.offset : 0;
				const e = node === end.node && index === end.index ? end.offset : text.length;
				if (index > firstLine) out += "\n";
				out += text.slice(s, e);
			}
			previousEnd = top + model.rows.length;
		}
		return out;
	}

	/** Both endpoints against the current paint, in document order; clears when either is gone. */
	#resolve(doc: SelectionDocument): [Position, Position] | undefined {
		const state = this.#state;
		if (!state) return undefined;
		const start = resolve(doc, state.start);
		const end = resolve(doc, state.end);
		if (!start || !end) {
			this.clear();
			return undefined;
		}
		return compare(start, start.offset, end) <= 0 ? [start, end] : [end, start];
	}

	#extend(doc: SelectionDocument, state: SelectionState, row: number, col: number): void {
		const originStart = resolve(doc, state.originStart);
		const originEnd = resolve(doc, state.originEnd);
		if (!originStart || !originEnd) {
			this.clear();
			return;
		}
		const target = textRow(doc, row);
		const hit = target ? hitCell(target, col) : this.#nearest(doc, row, originStart);
		if (!hit) return;
		const [start, end] = expand(hit, state.unit);
		const order = compare(hit, start, originStart);
		if (order === 0 && state.unit === "char") {
			state.start = state.end = state.originStart;
		} else if (order < 0) {
			state.start = anchor(hit, start);
			state.end = state.originEnd;
		} else {
			state.start = state.originStart;
			state.end = anchor(hit, end);
		}
	}

	/**
	 * Text nearest a gap row: the end of the text above when the gap follows the
	 * origin (dragging down), otherwise the start of the text below.
	 */
	#nearest(doc: SelectionDocument, row: number, origin: Position): TextHit | undefined {
		let above: TextHit | undefined;
		for (let index = Math.min(row - 1, doc.rows - 1); index >= 0 && !above; index--) {
			const target = textRow(doc, index);
			if (target) above = hitCell(target, Number.POSITIVE_INFINITY);
		}
		if (above && compare(above, above.start, origin) >= 0) return above;
		for (let index = Math.max(row + 1, 0); index < doc.rows; index++) {
			const target = textRow(doc, index);
			if (target) return hitCell(target, Number.NEGATIVE_INFINITY);
		}
		return above;
	}
}
