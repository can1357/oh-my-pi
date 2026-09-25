/**
 * Transcript scroll mode: the live conversation, scrolled by omp itself.
 *
 * A terminal never lets a program move its native scrollback, so scroll mode
 * borrows the alternate screen — which has no scrollback, leaving this view's
 * scrollbar the only live one — and paints the Composer's own components
 * there: the welcome header and every transcript block as one scrollable
 * column, with the editor and status chrome pinned below. Nothing is copied or
 * rebuilt; closing drops back to the untouched normal screen.
 *
 * Prompt hops seat the viewport on the OSC 133 prompt marks user bubbles
 * already emit, so "a prompt" means exactly what a terminal's own
 * jump-to-prompt would stop on.
 *
 * The view owns the pointer: terminals report the mouse for the whole screen
 * or not at all, so a draggable scrollbar means native selection is gone.
 * Dragging the scrollbar column seeks; dragging anywhere else in the body
 * selects text here (double click: word, triple: line) and copies it on
 * release, clearing the highlight as the terminal would.
 */
import type { Component } from "../tui";
import { isKeyRelease, matchesKey } from "../keys";
import { parseSgrMouse, type SgrMouseEvent } from "../mouse";
import { ScrollView } from "../components/scroll-view";
import { stripPromptZones } from "../chat/transcript-outline";
import { theme } from "../theme/theme";
import { BG_RESET, bgAnsi } from "../theme/color";
import { getTerminalSelectionBackground } from "../terminal-capabilities";
import { Ellipsis, sliceWithWidth } from "../utils";

const PROMPT_MARK = "\x1b]133;A";
const WHEEL_ROWS = 3;
/** Body rows kept visible however tall the pinned input band grows. */
const MIN_BODY_ROWS = 3;
const SGR_RESET = "\x1b[0m";
/** Double-click window, matching common desktop defaults. */
const MULTI_CLICK_MS = 500;
/**
 * Characters that end a double-click word. Whitespace, quotes, brackets and
 * list punctuation only — paths, URLs, flags and identifiers stay whole.
 */
const WORD_DELIMITERS = new Set("\"'`()[]{}<>,;|│");

export interface TranscriptScrollSource {
	/** Every scrollable row — header then transcript — at `width`. */
	renderBody(width: number): readonly string[];
	/** Live chrome pinned below the body (editor, status). */
	renderChrome(width: number): readonly string[];
	/** Current terminal geometry; read on input so keys before the first frame still move. */
	size(): { columns: number; rows: number };
	requestRender(): void;
	/** Place selected text on the clipboard. */
	copy(text: string): void;
	/** Leave scroll mode; `passthrough` is a key the view did not own, for the editor. */
	close(passthrough: string | undefined): void;
}

/** A cell in body coordinates: absolute body row, content column. */
interface Cell {
	row: number;
	col: number;
}

/** Inclusive cell range in reading order. */
interface Span {
	start: Cell;
	end: Cell;
}

/** Selection granularity: single click drags by cell, double by word, triple by line. */
type SelectUnit = "char" | "word" | "line";

type Drag = { kind: "scrollbar" } | { kind: "select"; unit: SelectUnit; anchor: Span };

export class TranscriptScrollView implements Component {
	readonly #source: TranscriptScrollSource;
	readonly #view = new ScrollView([], { height: 0, scrollbar: "always", ellipsis: Ellipsis.Omit });
	/** Absolute body row of each prompt's first row, ascending. */
	#promptRows: number[] = [];
	/** Body rows as painted, before any selection highlight. */
	#body: readonly string[] = [];
	#chrome: readonly string[] = [];
	#height = 0;
	#width = -1;
	#seated = false;
	#drag: Drag | undefined;
	/** Selected cells while the button is held; release copies and clears it. */
	#selection: Span | undefined;
	#clicks: { at: number; cell: Cell; count: number } | undefined;

	constructor(source: TranscriptScrollSource) {
		this.#source = source;
	}

	/** Seat on the tail, then take one hop — what the opening Ctrl+Up/Down meant. */
	open(delta: -1 | 1): void {
		this.#layout(this.#source.size().columns);
		this.#view.scrollToBottom();
		this.#seated = true;
		this.hop(delta);
	}

	handleInput(data: string): void {
		if (isKeyRelease(data)) return;
		if (data.startsWith("\x1b[<")) {
			const event = parseSgrMouse(data);
			if (event) this.#handleMouse(event);
			return;
		}
		if (matchesKey(data, "ctrl+up")) return this.hop(-1);
		if (matchesKey(data, "ctrl+down")) return this.hop(1);
		if (matchesKey(data, "escape")) return this.#source.close(undefined);
		if (matchesKey(data, "pageDown") || matchesKey(data, "end")) {
			// Moving down from the live tail returns to it.
			if (this.#atBottom()) return this.#source.close(undefined);
		}
		this.#relayout();
		const before = this.#view.getScrollOffset();
		if (this.#view.handleScrollKey(data)) {
			if (this.#view.getScrollOffset() !== before) this.#source.requestRender();
			return;
		}
		this.#source.close(data);
	}

	/**
	 * Seat the nearest prompt above/below the viewport top. Above the first
	 * prompt the header is next, so the welcome box stays reachable; below the
	 * last prompt the live tail is next, and one more hop returns to it.
	 */
	hop(delta: -1 | 1): void {
		this.#relayout();
		const top = this.#view.getScrollOffset();
		const max = this.#view.getMaxScrollOffset();
		let target: number | undefined;
		if (delta < 0) {
			target = this.#promptRows.findLast(row => row < top) ?? (top > 0 ? 0 : undefined);
		} else {
			target = this.#promptRows.find(row => row > top && row <= max) ?? (top < max ? max : undefined);
			if (target === undefined) return this.#source.close(undefined);
		}
		if (target === undefined) return;
		this.#view.setScrollOffset(target);
		this.#source.requestRender();
	}

	render(width: number): readonly string[] {
		this.#layout(width);
		if (!this.#seated) {
			this.#view.scrollToBottom();
			this.#seated = true;
		}
		return [...this.#view.render(width), ...this.#chrome];
	}

	invalidate(): void {
		this.#view.invalidate();
	}

	dispose(): void {
		this.#view.dispose();
	}

	// ========================================================================
	// Pointer
	// ========================================================================

	#handleMouse(event: SgrMouseEvent): void {
		if (event.wheel !== null) {
			this.#scrollBy(event.wheel * WHEEL_ROWS);
			return;
		}
		this.#relayout();
		const inBody = event.row < this.#height;
		if (event.leftClick) {
			const hadSelection = this.#selection !== undefined;
			this.#selection = undefined;
			this.#drag = undefined;
			if (inBody && event.col >= this.#width - 1) {
				this.#clicks = undefined;
				this.#drag = { kind: "scrollbar" };
				this.#seekScrollbar(event.row);
			} else if (inBody) {
				const cell = this.#cellAt(event);
				const unit = this.#clickUnit(cell);
				if (unit === "char") {
					this.#drag = { kind: "select", unit, anchor: { start: cell, end: cell } };
				} else {
					// Double/triple click selects the word/line under the pointer at
					// once; a drag from here extends by whole units.
					const span = this.#unitSpan(cell, unit);
					this.#drag = { kind: "select", unit, anchor: span };
					this.#selection = span;
					this.#source.requestRender();
					return;
				}
			} else {
				this.#clicks = undefined;
			}
			if (hadSelection) this.#source.requestRender();
			return;
		}
		const drag = this.#drag;
		if (!drag) return;
		if (event.release) {
			this.#drag = undefined;
			// Release copies, and the highlight clears the moment it does — the
			// terminal's own copy timing.
			if (drag.kind === "select" && this.#selection) {
				this.#copySelection();
				this.#selection = undefined;
				this.#source.requestRender();
			}
			return;
		}
		// Left-button drag (motion bit set, no button bits); hover motion ends above.
		if (!event.motion || (event.button & 3) !== 0) return;
		if (drag.kind === "scrollbar") {
			this.#seekScrollbar(event.row);
			return;
		}
		// Dragging onto the top row or into the chrome scrolls the selection along.
		if (event.row <= 0) this.#view.scroll(-1);
		else if (!inBody) this.#view.scroll(1);
		const head = this.#unitSpan(this.#cellAt(event), drag.unit);
		const forward = compareCells(head.end, drag.anchor.start) >= 0;
		const selection = forward
			? { start: drag.anchor.start, end: maxCell(drag.anchor.end, head.end) }
			: { start: head.start, end: drag.anchor.end };
		// A plain click that never moved off its cell selects nothing, as in a terminal.
		const moved = drag.unit !== "char" || compareCells(selection.start, selection.end) !== 0;
		this.#selection = moved ? selection : undefined;
		this.#source.requestRender();
	}

	/** Click count at `cell`: repeats within the double-click window on the same spot step char → word → line. */
	#clickUnit(cell: Cell): SelectUnit {
		const now = performance.now();
		const last = this.#clicks;
		const repeat =
			last !== undefined &&
			now - last.at <= MULTI_CLICK_MS &&
			last.cell.row === cell.row &&
			Math.abs(last.cell.col - cell.col) <= 1;
		const count = repeat ? (last.count % 3) + 1 : 1;
		this.#clicks = { at: now, cell, count };
		return count === 1 ? "char" : count === 2 ? "word" : "line";
	}

	/** Inclusive span of the unit under `cell`. */
	#unitSpan(cell: Cell, unit: SelectUnit): Span {
		if (unit === "char") return { start: cell, end: cell };
		if (unit === "line") return { start: { row: cell.row, col: 0 }, end: { row: cell.row, col: this.#width - 2 } };
		const [from, to] = wordColumns(Bun.stripANSI(this.#body[cell.row] ?? ""), cell.col);
		return { start: { row: cell.row, col: from }, end: { row: cell.row, col: Math.max(from, to - 1) } };
	}

	#copySelection(): void {
		if (!this.#selection) return;
		const text = this.#selectedText(this.#selection);
		if (text.length > 0) this.#source.copy(text);
	}

	/** Proportional seek: the top track row shows the first row, the bottom one the tail. */
	#seekScrollbar(screenRow: number): void {
		const span = Math.max(1, this.#height - 1);
		const row = Math.min(Math.max(0, screenRow), span);
		const offset = Math.round((row / span) * this.#view.getMaxScrollOffset());
		if (offset === this.#view.getScrollOffset()) return;
		this.#view.setScrollOffset(offset);
		this.#source.requestRender();
	}

	/** Body cell under a pointer, clamped into the visible body and content columns. */
	#cellAt(event: SgrMouseEvent): Cell {
		const row = Math.min(Math.max(0, event.row), Math.max(0, this.#height - 1));
		const col = Math.min(Math.max(0, event.col), Math.max(0, this.#width - 2));
		return { row: this.#view.getScrollOffset() + row, col };
	}

	/** Plain text of the selection, one line per body row, trailing blanks trimmed. */
	#selectedText(selection: Span): string {
		const { start, end } = selection;
		const lines: string[] = [];
		for (let row = start.row; row <= end.row && row < this.#body.length; row++) {
			const [from, to] = columnsOn(row, start, end, this.#width);
			const plain = Bun.stripANSI(this.#body[row]!);
			lines.push(sliceWithWidth(plain, from, to - from).text.trimEnd());
		}
		return lines.join("\n");
	}

	/** Paint the selection the way the user's terminal paints its own. */
	#highlight(rows: readonly string[]): readonly string[] {
		const selection = this.#selection;
		if (!selection) return rows;
		const { start, end } = selection;
		const painted = rows.slice();
		for (let row = start.row; row <= end.row && row < painted.length; row++) {
			const line = painted[row]!;
			const [from, to] = columnsOn(row, start, end, this.#width);
			const selected = sliceWithWidth(Bun.stripANSI(line), from, to - from).text;
			if (selected.length === 0) continue;
			const head = sliceWithWidth(line, 0, from).text;
			const tail = sliceWithWidth(line, to, Math.max(0, this.#width - to)).text;
			painted[row] = `${head}${SGR_RESET}${paintSelection(selected)}${tail}`;
		}
		return painted;
	}

	// ========================================================================
	// Layout
	// ========================================================================

	#atBottom(): boolean {
		return this.#view.getScrollOffset() >= this.#view.getMaxScrollOffset();
	}

	#scrollBy(rows: number): void {
		this.#relayout();
		const before = this.#view.getScrollOffset();
		this.#view.scroll(rows);
		if (this.#view.getScrollOffset() !== before) this.#source.requestRender();
	}

	/** Refresh geometry at the last painted width (live width before the first frame). */
	#relayout(): void {
		this.#layout(this.#width < 0 ? this.#source.size().columns : this.#width);
	}

	/** Re-render body and chrome at `width`, keeping the prompt at the top in place across a rewrap. */
	#layout(width: number): void {
		const safeWidth = Math.max(1, width);
		const rewrap = this.#width !== safeWidth;
		const anchor = rewrap && this.#seated ? this.#promptIndexAtTop() : undefined;
		// A rewrap moves every cell, so a selection would point at other text.
		if (rewrap) {
			this.#selection = undefined;
			this.#drag = undefined;
		}
		// The scrollbar owns the last column.
		const raw = this.#source.renderBody(Math.max(1, safeWidth - 1));
		const promptRows: number[] = [];
		for (let row = 0; row < raw.length; row++) {
			if (raw[row]!.includes(PROMPT_MARK)) promptRows.push(row);
		}
		this.#promptRows = promptRows;
		this.#body = stripPromptZones(raw);
		// A tall draft never squeezes the body away: the pinned band keeps its
		// bottom rows (status line, editor tail) and leaves MIN_BODY_ROWS.
		const rows = this.#source.size().rows;
		const chrome = this.#source.renderChrome(safeWidth);
		const chromeCap = Math.max(0, rows - MIN_BODY_ROWS);
		this.#chrome = chrome.length > chromeCap ? chrome.slice(chrome.length - chromeCap) : chrome;
		this.#height = Math.max(1, rows - this.#chrome.length);
		this.#view.setLines(this.#highlight(this.#body));
		this.#view.setHeight(this.#height);
		if (anchor !== undefined) this.#view.setScrollOffset(promptRows[anchor] ?? this.#view.getScrollOffset());
		this.#width = safeWidth;
	}

	/** Index of the prompt the viewport top sits exactly on, if any. */
	#promptIndexAtTop(): number | undefined {
		const index = this.#promptRows.indexOf(this.#view.getScrollOffset());
		return index === -1 ? undefined : index;
	}
}

/**
 * Selected text in the terminal's own selection color when it reported one
 * (OSC 17). Otherwise it uses omp's `selectedBg`: multiplexers such as herdr
 * never forward the OSC 17 reply, and reverse video would paint a bright block
 * there instead of the muted highlight the terminal draws everywhere else.
 */
function paintSelection(text: string): string {
	const background = getTerminalSelectionBackground();
	if (background === undefined) return theme.bg("selectedBg", text);
	return `${bgAnsi(background, theme.getColorMode())}${text}${BG_RESET}`;
}

function compareCells(a: Cell, b: Cell): number {
	return a.row === b.row ? a.col - b.col : a.row - b.row;
}

function maxCell(a: Cell, b: Cell): Cell {
	return compareCells(a, b) >= 0 ? a : b;
}

/**
 * Column span `[from, to)` of the word covering `col` in a plain row. A click
 * on whitespace or a delimiter selects just that cell's run of the same kind.
 */
function wordColumns(plain: string, col: number): [number, number] {
	const cells: { start: number; end: number; word: boolean }[] = [];
	let column = 0;
	for (const { segment } of GRAPHEMES.segment(plain)) {
		const width = Bun.stringWidth(segment);
		if (width === 0) continue;
		cells.push({ start: column, end: column + width, word: !/\s/.test(segment) && !WORD_DELIMITERS.has(segment) });
		column += width;
	}
	const hit = cells.findIndex(cell => col >= cell.start && col < cell.end);
	if (hit === -1) return [col, col + 1];
	if (!cells[hit]!.word) return [cells[hit]!.start, cells[hit]!.end];
	let first = hit;
	let last = hit;
	while (first > 0 && cells[first - 1]!.word) first--;
	while (last < cells.length - 1 && cells[last + 1]!.word) last++;
	return [cells[first]!.start, cells[last]!.end];
}

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Selected column span `[from, to)` on one body row of a reading-order selection. */
function columnsOn(row: number, start: Cell, end: Cell, width: number): [number, number] {
	const from = row === start.row ? start.col : 0;
	const to = row === end.row ? end.col + 1 : Math.max(from, width);
	return [from, to];
}
