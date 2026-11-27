/** Mouse gestures owned by the fullscreen transcript, never by the inline or native renderers. */
import type { MouseEvent } from "../driver/contract";
import { withImageGutter } from "../driver/images/viewport";
import { coveredCells } from "../driver/output/ansi";
import type { UiNode } from "../node";
import type { Theme } from "../theme/contract";
import type { SelectionMotion } from "./backend";
import { plainTranscriptText, styleTranscriptCells, transcriptLine } from "./transcript-cells";
import type { TranscriptDocument } from "./transcript-document";
import { TranscriptWheel } from "./transcript-wheel";

interface PointerWindow {
	readonly doc: TranscriptDocument;
	readonly top: number;
	readonly width: number;
	readonly rows: number;
	/** Actual visible document rows, excluding padding, indicator and dock. */
	readonly content: number;
	readonly scrollbar: boolean;
}

interface PointerHost {
	available(): boolean;
	document(): TranscriptDocument;
	scroll(delta: number): void;
	scrollTo(offset: number): void;
	now(): number;
	wheelLines(): number;
	copyOnSelect(): boolean;
	copy?: (text: string) => void;
}

/** A span on a painted block row, independent of the window and of any nodes inserted above it. */
interface Span {
	node: UiNode;
	row: number;
	text: string;
	start: number;
	end: number;
}

type Unit = "cell" | "word" | "row";
interface Pointer {
	row: number;
	col: number;
}
let words: Intl.Segmenter | undefined;
// pi follows iTerm's path-like word joiners. Keep Intl word boundaries between adjacent scripts.
const JOINERS = "/-+\\~_.";

function wordAt(text: string, offset: number): [number, number] {
	let start = 0;
	let end = 0;
	let previousWord = false;
	let previousJoiner = false;
	words ??= new Intl.Segmenter(undefined, { granularity: "word" });
	for (const part of words.segment(text)) {
		const joiner = part.segment.length === 1 && JOINERS.includes(part.segment);
		const word = !!part.isWordLike || joiner;
		if (!(previousWord && word && (previousJoiner || joiner))) {
			if (end > offset) break;
			start = part.index;
		}
		end = part.index + part.segment.length;
		previousWord = word;
		previousJoiner = joiner;
	}
	return [start, end];
}

function spanAt(view: PointerWindow, pointer: Pointer, unit: Unit): Span | undefined {
	if (view.content === 0) return undefined;
	const row = view.top + Math.max(0, Math.min(view.content - 1, pointer.row));
	const entry = view.doc.at(row);
	if (!entry) return undefined;
	const { text, cells } = transcriptLine(view.doc.line(row));
	const last = cells.at(-1);
	const width = last ? last.col + last.width : 0;
	const col = Math.max(0, Math.min(view.width - 1, pointer.col));
	const hit = cells.find(cell => cell.col + cell.width > col);
	let start = hit?.col ?? width;
	let end = hit ? start + hit.width : width;
	if (unit === "row") {
		start = 0;
		end = width;
	} else if (unit === "word" && hit) {
		const [first, after] = wordAt(text, hit.start);
		const left = cells.find(cell => cell.end > first);
		const right = cells.findLast(cell => cell.start < after);
		if (left && right) {
			start = left.col;
			end = right.col + right.width;
		}
	}
	return { node: entry.node, row: row - entry.top - entry.lead, text, start, end };
}

function sameSpan(a: Span, b: Span): boolean {
	return a.node === b.node && a.row === b.row && a.start === b.start && a.end === b.end && a.text === b.text;
}

/** Document row of an endpoint. Never copy unrelated text after a block is removed or reflowed. */
function resolve(doc: TranscriptDocument, span: Span): number | undefined {
	const entry = doc.entry(span.node);
	if (!entry || span.row < -entry.lead) return undefined;
	const row = entry.top + entry.lead + span.row;
	if (doc.at(row) !== entry || !plainTranscriptText(doc.line(row)).startsWith(span.text)) return undefined;
	return row;
}

interface Bounds {
	first: number;
	start: number;
	last: number;
	end: number;
}

function thumb(view: PointerWindow): { start: number; size: number; travel: number; max: number } {
	const max = view.doc.rows - view.rows;
	// Leave at least one travel cell when a track of two or more rows overflows.
	const size = Math.max(1, Math.min(view.rows - 1, Math.round((view.rows * view.rows) / view.doc.rows)));
	const travel = view.rows - size;
	return { start: Math.round((view.top / max) * travel), size, travel, max };
}

const inverse = (text: string): string => `\x1b[7m${text}\x1b[27m`;

export class TranscriptPointer {
	readonly #wheel = new TranscriptWheel();
	#view?: PointerWindow;
	#origin?: Span;
	#focus?: Span;
	#unit: Unit = "cell";
	#active = false;
	#press?: Pointer;
	#lastClick?: { word: Span; time: number; count: number };
	#grab?: number;
	#thumbRow = 0;
	#preferredColumn: number | undefined;
	#edge?: Pointer;
	#timer?: Timer;

	constructor(readonly host: PointerHost) {}

	update(view: PointerWindow, rows: string[], theme: Theme): void {
		const previous = this.#view;
		if (previous && previous.width !== view.width) this.reset();
		this.#view = view;
		if (!view.scrollbar) this.#grab = undefined;
		if (this.#edge && previous?.top !== view.top) this.#extend(this.#edge);
		const bounds = this.#bounds();
		if (bounds) {
			for (
				let row = Math.max(bounds.first, view.top);
				row <= Math.min(bounds.last, view.top + view.content - 1);
				row++
			) {
				const y = row - view.top;
				rows[y] = styleTranscriptCells(
					rows[y]!,
					row === bounds.first ? bounds.start : 0,
					row === bounds.last ? bounds.end : view.width,
					inverse,
				);
			}
		}
		if (!view.scrollbar) return;
		const { start, size } = thumb(view);
		const track = theme.fg("dim", "│");
		const handle = theme.fg(this.#grab === undefined ? "muted" : "accent", this.#grab === undefined ? "┃" : "█");
		for (let y = 0; y < view.rows; y++) {
			// Padding a continuation row would overwrite cells occupied by the scaled heading above.
			if (coveredCells(rows, y) > 0) continue;
			rows[y] = withImageGutter(rows[y]!, view.width, y >= start && y < start + size ? handle : track);
		}
	}

	reset(): void {
		this.#stopEdge();
		this.#wheel.reset();
		this.#origin = this.#focus = this.#press = this.#grab = this.#lastClick = undefined;
		this.#active = false;
		this.#preferredColumn = undefined;
	}

	/** Losing focus or mouse reporting cannot leave a drag waiting for a release that will never come. */
	blur(): boolean {
		const changed = (!!this.#press && this.#active) || this.#grab !== undefined;
		if (this.#press || this.#grab !== undefined) this.reset();
		this.#lastClick = undefined;
		this.#wheel.reset();
		return changed;
	}

	#bounds(doc = this.#view?.doc): Bounds | undefined {
		if (!doc || !this.#origin || !this.#focus) return undefined;
		const a = resolve(doc, this.#origin);
		const b = resolve(doc, this.#focus);
		if (a === undefined || b === undefined) {
			this.reset();
			return undefined;
		}
		if (!this.#active) return undefined;
		const bounds =
			a < b || (a === b && this.#origin.start <= this.#focus.start)
				? { first: a, start: this.#origin.start, last: b, end: this.#focus.end }
				: { first: b, start: this.#focus.start, last: a, end: this.#origin.end };
		return bounds.first !== bounds.last || bounds.start < bounds.end ? bounds : undefined;
	}

	copy(): boolean {
		if (!this.#active || !this.host.copy || !this.host.available()) return false;
		const doc = this.host.document();
		const bounds = this.#bounds(doc);
		if (!bounds) return false;
		const lines: string[] = [];
		for (let row = bounds.first; row <= bounds.last; row++) {
			const raw = doc.line(row);
			if (row !== bounds.first && row !== bounds.last) {
				lines.push(plainTranscriptText(raw).trimEnd());
				continue;
			}
			const { text, cells } = transcriptLine(raw);
			const left =
				row === bounds.first ? (cells.find(cell => cell.col + cell.width > bounds.start)?.start ?? text.length) : 0;
			const right = row === bounds.last ? (cells.findLast(cell => cell.col < bounds.end)?.end ?? 0) : text.length;
			lines.push(text.slice(left, right).trimEnd());
		}
		const text = lines.join("\n");
		if (!text) return false;
		this.host.copy(text);
		return true;
	}

	/** Keyboard selection moves the active end, never the fixed anchor (even after crossing it). */
	adjust(motion: SelectionMotion): boolean {
		if (!this.#active || !this.host.available()) return false;
		const doc = this.host.document();
		if (!this.#bounds(doc)) return false;
		if (motion === "clear") {
			this.reset();
			return true;
		}
		this.#stopEdge();
		this.#press = this.#lastClick = undefined;
		const view = this.#view!;
		const origin = this.#origin!;
		const focus = this.#focus!;
		const a = resolve(doc, origin)!;
		let row = resolve(doc, focus)!;
		const reversed = row < a || (row === a && focus.start < origin.start);
		const anchor = reversed ? origin.end : origin.start;
		let caret = reversed ? focus.start : focus.end;
		let line = transcriptLine(doc.line(row));
		const tail = line.cells.at(-1);
		const end = tail ? tail.col + tail.width : 0;
		if (motion === "up" || motion === "down") {
			this.#preferredColumn ??= caret;
			const next = Math.min(doc.rows - 1, Math.max(0, row + (motion === "up" ? -1 : 1)));
			if (next === row) return true;
			row = next;
			line = transcriptLine(doc.line(row));
			const last = line.cells.at(-1);
			const target = line.cells.find(cell => cell.col + cell.width > this.#preferredColumn!);
			caret = target?.col ?? (last ? last.col + last.width : 0);
		} else {
			this.#preferredColumn = undefined;
			if (motion === "line-start") caret = 0;
			else if (motion === "line-end") caret = end;
			else if (motion === "left") {
				if (caret > 0) caret = line.cells.findLast(cell => cell.col < caret)?.col ?? 0;
				else if (row > 0) {
					line = transcriptLine(doc.line(--row));
					const last = line.cells.at(-1);
					caret = last ? last.col + last.width : 0;
				}
			} else if (caret < end) {
				const next = line.cells.find(cell => cell.col + cell.width > caret)!;
				caret = next.col + next.width;
			} else if (row + 1 < doc.rows) {
				line = transcriptLine(doc.line(++row));
				caret = 0;
			}
		}
		this.#origin = { ...origin, start: anchor, end: anchor };
		const entry = doc.at(row)!;
		this.#focus = { node: entry.node, row: row - entry.top - entry.lead, text: line.text, start: caret, end: caret };
		this.#active = row !== a || anchor !== caret;
		if (row < view.top) this.host.scrollTo(row);
		else if (row >= view.top + view.content)
			this.host.scrollTo(Math.min(doc.rows - view.rows, Math.max(0, row - view.rows + 2)));
		return true;
	}

	#extend(pointer: Pointer): void {
		if (!this.#view || !this.#press) return;
		const target = spanAt(this.#view, pointer, this.#unit);
		if (!target) return;
		this.#focus = target;
		this.#active = this.#unit !== "cell" || !sameSpan(this.#origin!, target) || pointer.col !== this.#press.col;
	}

	#stopEdge(): void {
		clearInterval(this.#timer);
		this.#timer = this.#edge = undefined;
	}

	#autoScroll(pointer: Pointer): void {
		const view = this.#view!;
		if (!view.content || (pointer.row > 0 && pointer.row < view.content - 1)) {
			this.#stopEdge();
			return;
		}
		this.#edge = pointer;
		if (this.#timer) return;
		this.#timer = setInterval(() => {
			const current = this.#view;
			if (!this.host.available() || !current || !this.#edge) {
				this.blur();
				return;
			}
			const next = current.top + (this.#edge.row <= 0 ? -1 : 1);
			if (next < 0 || next > current.doc.rows - current.rows) this.#stopEdge();
			else this.host.scrollTo(next);
		}, 50);
		this.#timer.unref();
	}

	#scrollThumb(row: number): void {
		const { travel, max } = thumb(this.#view!);
		if (travel > 0) this.host.scrollTo(Math.round((Math.min(travel, Math.max(0, row - this.#grab!)) * max) / travel));
	}

	/** Continue the existing press before hit-testing the current pointer location. */
	capture(mouse: MouseEvent, row: number): boolean {
		if (!this.#view || (!this.#press && this.#grab === undefined)) return false;
		if (mouse.action === "press" && !mouse.button.startsWith("wheel-")) {
			this.reset(); // A new press without a release supersedes the previous gesture.
			return false;
		}
		if ((mouse.button !== "left" && mouse.button !== "none") || mouse.action === "press") return false;
		if (mouse.action === "move" && mouse.button === "none") {
			this.blur(); // All-motion report after a lost release.
			return false;
		}
		if (this.#grab !== undefined) {
			if (row !== this.#thumbRow) {
				this.#thumbRow = row;
				this.#scrollThumb(row);
			}
			if (mouse.action === "release") this.#grab = undefined;
			return true;
		}
		const pointer = { row, col: mouse.col };
		this.#extend(pointer);
		if (mouse.action === "release") {
			this.#stopEdge();
			this.#press = undefined;
			if (this.host.copyOnSelect()) this.copy();
		} else {
			this.#lastClick = undefined;
			this.#autoScroll(pointer);
		}
		return true;
	}

	/** A report not consumed by a widget or layer. Only unmodified left presses start a drag. */
	input(mouse: MouseEvent, row: number): void {
		const view = this.#view;
		if (!view || mouse.action !== "press") return;
		if (mouse.button === "wheel-up" || mouse.button === "wheel-down") {
			const direction = mouse.button === "wheel-up" ? -1 : 1;
			const lines = this.#wheel.lines(direction, this.host.now(), this.host.wheelLines());
			this.host.scroll(direction * lines * (mouse.mods.includes("alt") ? 5 : 1));
			return;
		}
		if (mouse.button !== "left" || mouse.mods.length) return;
		if (view.scrollbar && mouse.col === view.width && row >= 0 && row < view.rows) {
			this.reset();
			const { start, size } = thumb(view);
			const grabbed = row >= start && row < start + size;
			this.#grab = grabbed ? row - start : Math.floor(size / 2);
			this.#thumbRow = row;
			if (!grabbed) this.#scrollThumb(row);
			return;
		}
		// The indicator is an explicit jump to the live tail, not selectable transcript text.
		if (!view.scrollbar && view.rows > 1 && view.top + view.rows < view.doc.rows && row === view.rows - 1) {
			this.reset();
			this.host.scrollTo(view.doc.rows - view.rows);
			return;
		}
		if (row < 0 || row >= view.content || mouse.col < 0 || mouse.col >= view.width) {
			this.reset();
			return;
		}
		this.#preferredColumn = undefined;
		const pointer = { row, col: mouse.col };
		const word = spanAt(view, pointer, "word");
		if (!word) return;
		const previous = this.#lastClick;
		const time = this.host.now();
		const count =
			previous && time - previous.time <= 500 && sameSpan(previous.word, word) ? (previous.count % 3) + 1 : 1;
		this.#lastClick = { word, time, count };
		this.#unit = count === 2 ? "word" : count === 3 ? "row" : "cell";
		this.#origin = this.#focus = this.#unit === "word" ? word : spanAt(view, pointer, this.#unit);
		this.#press = pointer;
		this.#active = count > 1;
	}
}
