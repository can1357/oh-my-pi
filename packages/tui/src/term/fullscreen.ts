/**
 * The fullscreen transcript: the `main` region scrolled inside the program on
 * the alternate screen, above the dock (see `TermBackendOptions.presentation`).
 *
 * Main blocks are stacked with the inline separators into one document. Only
 * the window keeps painted blocks; older heights are indexed in idle slices.
 * Two right-edge columns go to the marks lane and scrollbar. A window of
 * it fills the transcript area, whose last row is the indicator (new output
 * below, copy feedback). The window follows the tail, or holds a reading
 * anchor: a block and one of its rows. Output streaming below and blocks
 * changing above leave the anchored text in place. Reflow resolves the same
 * logical line and source offset until the reader moves again; a removed
 * block hands the anchor to a surviving neighbour.
 *
 * The pointer gestures over the transcript (wheel, scrollbar, marks, text
 * selection with edge autoscroll and copy on release) and the selection
 * highlight live here. Nothing here writes terminal history.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { MouseEvent } from "../driver/contract";
import { windowImageRows } from "../driver/images/clip";
import type { TranscriptScroller, TranscriptScrollState } from "../host";
import type { UiNode } from "../node";
import { type Accessor, type Signal, signal } from "../reactive";
import { tokens } from "../text/ansi";
import { padTo, sliceCells, sliceColumns, truncate } from "../text/width";
import type { Theme } from "../theme/contract";
import { underline } from "../theme/theme";
import type { ScrollMark, ScrollMarkKind, SelectionClipboardResult, TranscriptPointer } from "./backend";
import { type BlockPosition, FullscreenHistory, type HistoryLayout, type HistoryPaint } from "./fullscreen-history";
import type { Block, Cell, Hit } from "./paint";
import {
	type LaneMark,
	markCells,
	markGlyph,
	offsetForThumb,
	scrollbarGlyph,
	type ThumbRange,
	thumbRange,
} from "./scrollbar";
import { edgeScrollStep, type SelectionDocument, TranscriptSelection } from "./selection";
import { findTranscriptMatch, type TranscriptMatch } from "./transcript-search";
import { columnRanges, textModel } from "./transcript-text";
import { WheelScrollAccelerator } from "./wheel-scroll";

/** Right-edge columns (marks lane, scrollbar) beside the transcript on terminals wider than this. */
const EDGE_COLUMNS = 2;
/** Autoscroll tick while a selection drag rests at or past the window's edge, ms. */
const EDGE_SCROLL_MS = 50;
/** How long copy feedback stays on the indicator row, ms. */
const COPIED_MS = 1800;
const COPY_FAILED_MS = 4000;

/** A hit placed on a frame; `rows` bounds the frame rows it answers at (a transcript block cut by the window). */
export interface PlacedHit {
	readonly hit: Hit;
	readonly region: "main" | "dock" | "layer";
	readonly top: number;
	readonly left: number;
	readonly rows?: readonly [from: number, to: number];
}

/** What the fullscreen transcript needs from its backend. */
export interface FullscreenTranscriptOptions extends HistoryPaint {
	readonly theme: Accessor<Theme>;
	readonly marks?: Accessor<readonly ScrollMark[]>;
	readonly pointer?: Accessor<TranscriptPointer>;
	readonly copyOnRelease?: Accessor<boolean>;
	readonly copyText?: (text: string) => Promise<SelectionClipboardResult>;
	readonly copyShortcutLabel?: Accessor<string | undefined>;
	readonly activateTargets?: Accessor<boolean>;
	/** Pixel height of a terminal cell, as images were fitted with (the window crops images it cuts). */
	readonly cellHeight: () => number;
	/** Whether the presentation is fullscreen now (untracked); the scroller does nothing otherwise. */
	readonly active: () => boolean;
	/** Schedule a frame. */
	readonly requestRender: () => void;
}

/** The transcript part of a fullscreen frame. */
export interface TranscriptFrame {
	/** The transcript area's rows: the window (with its right-edge lanes), then the indicator row. */
	readonly rows: readonly string[];
	readonly hits: readonly PlacedHit[];
	readonly cursor: Cell | null;
}

/** A source offset, or a decoration the given number of rows before/after that text. */
interface ReadingPoint {
	readonly index: number;
	readonly text: string;
	readonly offset: number;
	readonly gap: number;
}

/** The reader chooses the point. Only its visual placement changes when the block repaints. */
interface Anchor {
	readonly node: UiNode;
	readonly origin: number;
	readonly point?: ReadingPoint;
	row: number;
}

/** What the last transcript frame showed, for the pointer. */
interface View {
	readonly layout: HistoryLayout;
	readonly metricsReady: boolean;
	readonly document: SelectionDocument;
	readonly offset: number;
	/** Window rows. */
	readonly body: number;
	/** Window rows the pointer reaches (the rest lie under covering dock rows). */
	readonly reach: number;
	/** Transcript area rows not under the dock. */
	readonly shown: number;
	readonly contentWidth: number;
	readonly lanes: boolean;
	readonly thumb: ThumbRange;
	readonly marks: ReadonlyMap<number, LaneMark>;
	/** Frame row of the indicator; -1 without one. */
	readonly indicator: number;
	/** The indicator shows the new-output notice (a click there resumes following). */
	readonly notice: boolean;
}

type Gesture =
	| { readonly kind: "thumb"; readonly grab: number }
	| { readonly kind: "select"; row: number; col: number };

const INLINE_STATE: TranscriptScrollState = {
	following: true,
	offset: 0,
	metricsReady: true,
	totalRows: 0,
	height: 0,
	unseen: false,
	highlight: false,
};

/** Sequences that end inverse video: a selection highlight turns it back on after each. */
const INVERSE_OFF = /\x1b\[(?:0|27)?m/g;

function readingAnchor(node: UiNode, block: Block, row: number): Anchor {
	const anchor = { node, origin: row, row };
	if (row < 0 || !block.rows.length) return anchor; // a separator has no source text
	const { rows, rowLine } = textModel(block);
	let at = row;
	while (at < rows.length && !rows[at]) at++;
	if (at === rows.length) {
		at = row - 1;
		while (at >= 0 && !rows[at]) at--;
		if (at < 0) return anchor; // no text to reflow, e.g. an image
	}
	const source = rows[at]!;
	return {
		...anchor,
		point: {
			index: rowLine[at]!,
			text: source.line.text,
			offset: at < row ? Infinity : source.start,
			gap: row - at,
		},
	};
}

function remapRow(anchor: Anchor, block: Block): number {
	const point = anchor.point;
	if (!point) return anchor.origin;
	const { lines, rows, rowLine, firstRow } = textModel(block);
	let index = point.index;
	// A narrow layout can omit a titled border, shifting the logical indices of its body.
	if (!lines[index]?.text.startsWith(point.text)) {
		let nearest = -1;
		for (let i = 0; i < lines.length; i++) {
			if (lines[i]!.text === point.text && (nearest < 0 || Math.abs(i - index) < Math.abs(nearest - index)))
				nearest = i;
		}
		if (nearest >= 0) index = nearest;
	}
	const first = firstRow[index];
	if (first === undefined) return anchor.origin;
	let mapped = first;
	let best = -1;
	// Table rows can show pieces of several cells as disjoint source ranges. A later piece of
	// the right-hand cell can be on an earlier visual row than the end of the left-hand cell.
	search: for (let r = first, end = firstRow[index + 1] ?? rows.length; r < end; r++) {
		if (rowLine[r] !== index) continue;
		if (point.offset === Infinity) {
			mapped = r; // decoration after the last row of this line
			continue;
		}
		const source = rows[r]!;
		for (const span of source.spans ?? [source]) {
			if (span.start <= point.offset && point.offset < span.end) {
				mapped = r;
				break search;
			}
			if (span.end <= point.offset && span.end > best) {
				best = span.end;
				mapped = r;
			}
		}
	}
	// Stay in the same decoration run if it shrank; do not back up into unrelated text.
	const direction = Math.sign(point.gap);
	for (let i = 0; i < Math.abs(point.gap); i++) {
		const next = mapped + direction;
		if (next < 0 || next >= rows.length || rows[next]) break;
		mapped = next;
	}
	return mapped;
}

const invert = (text: string): string => `\x1b[7m${text.replace(INVERSE_OFF, "$&\x1b[7m")}\x1b[27m`;

/** Mark the ink, not its escapes. A style change inside a match must not turn its highlight off. */
function markText(theme: Theme, text: string): string {
	if (!text.includes("\x1b")) return theme.bg("selectedBg", underline(text));
	let marked = "";
	for (const run of tokens(text)) marked += run.escape ? run.text : theme.bg("selectedBg", underline(run.text));
	return marked;
}

/** Style only the reported content columns, restoring the row's original styles on either side. */
function paintRanges(
	row: string,
	ranges: readonly (readonly [number, number])[],
	width: number,
	style: (text: string) => string,
): string {
	let out = row;
	for (let k = ranges.length - 1; k >= 0; k--) {
		const [start, end] = ranges[k]!;
		if (end <= start) continue;
		const selected = sliceCells(out, start, end - start).text;
		const head = sliceColumns(out, 0, start);
		const tail = sliceCells(out, end, Math.max(0, width - end)).text;
		out = `${head}${style(selected)}${tail}`;
	}
	return out;
}

/** See the module docs. */
export class FullscreenTranscript {
	readonly #options: FullscreenTranscriptOptions;
	readonly #history: FullscreenHistory;
	readonly #selection = new TranscriptSelection();
	readonly #wheel = new WheelScrollAccelerator();
	readonly #state: Signal<TranscriptScrollState> = signal(INLINE_STATE);
	#following = true;
	#unseen = false;
	#anchor: Anchor | undefined;
	/** The window's top as of the last frame or scroll (the tail while following). */
	#offset = 0;
	/** A downward gesture rejoins the tail if the real window (not the estimates) reaches it. */
	#followIfTail = false;
	/** The immutable coordinates and blocks the last frame actually showed, even under a layer. */
	#layout: HistoryLayout | undefined;
	#blocks: ReadonlyMap<UiNode, Block> = new Map();
	#metricsReady = false;
	#body = 0;
	#marks: readonly ScrollMark[] = [];
	/** Reuse mark coordinates on scroll or dock-only frames; current-mark highlighting still moves. */
	#markPositions:
		| {
				layout: HistoryLayout;
				marks: readonly ScrollMark[];
				placed: readonly { row: number; node: UiNode; kind: ScrollMarkKind }[];
		  }
		| undefined;
	/** The last frame showed the transcript (pointer gestures apply). */
	#view: View | undefined;
	#gesture: Gesture | undefined;
	#edgeTimer: Timer | undefined;
	/** An autoscroll tick moved the window: the next frame extends the selection drag over what it shows. */
	#extendOnFrame = false;
	#feedback: string | undefined;
	#feedbackTimer: Timer | undefined;
	/** Bumped by every new selection or drop: a copy finishing for an older one shows no feedback. */
	#generation = 0;
	#findGeneration = 0;
	#findMatch: TranscriptMatch | undefined;

	constructor(options: FullscreenTranscriptOptions) {
		this.#options = options;
		this.#history = new FullscreenHistory(options);
	}

	/** Reading controls (see {@link TranscriptScroller}). */
	readonly scroller: TranscriptScroller = {
		state: () => this.#state(),
		scrollBy: rows => this.#options.active() && this.#scrollBy(rows),
		page: direction => this.#options.active() && this.#page(direction),
		toTop: () => this.#options.active() && this.#scrollTo(0),
		toBottom: () => this.#options.active() && this.#follow(),
		seekMark: direction => this.#options.active() && this.#seekMark(direction),
		findText: (query, direction) => this.#findText(query, direction),
		clearFind: () => this.#clearFind(),
		copyHighlight: () => this.#options.active() && this.#selection.active && this.#copy(),
		dropHighlight: () => this.#options.active() && this.#drop(),
	};

	/** The presentation turned fullscreen: start at the tail. */
	enter(): void {
		this.#following = true;
		this.#unseen = false;
		this.#anchor = undefined;
		this.#followIfTail = false;
	}

	/** The presentation turned inline: the selection and every gesture end. */
	leave(): void {
		this.#selection.clear();
		this.#findMatch = undefined;
		this.hide();
		this.#clearFeedback();
		this.#generation++;
		this.#layout = undefined;
		this.#anchor = undefined;
		this.#marks = [];
		this.#markPositions = undefined;
		this.#blocks = new Map();
		this.#history.dispose();
	}

	/** This frame does not show the transcript (a fullscreen layer covers it): gestures end, the selection stays. */
	hide(): void {
		this.disablePointer();
		this.#history.pause();
	}

	/** A modal sheet took the pointer without hiding the transcript or its image placements. */
	disablePointer(): void {
		this.#view = undefined;
		this.#findGeneration++;
		this.#endGesture();
	}

	/** The backend stopped: timers end. */
	stop(): void {
		this.hide();
		this.#findMatch = undefined;
		this.#history.dispose();
		this.#blocks = new Map();
		this.#markPositions = undefined;
		this.#clearFeedback();
		this.#generation++;
	}

	/** Publish the reading state (outside frame tracking: observers may react). */
	publish(): void {
		const layout = this.#layout;
		const next: TranscriptScrollState =
			layout && this.#options.active()
				? {
						following: this.#following,
						offset: this.#offset,
						totalRows: layout.rows,
						metricsReady: this.#metricsReady,
						height: this.#body,
						unseen: this.#unseen,
						highlight: this.#selection.active,
					}
				: INLINE_STATE;
		const current = this.#state.peek();
		if (
			current.following !== next.following ||
			current.offset !== next.offset ||
			current.totalRows !== next.totalRows ||
			current.metricsReady !== next.metricsReady ||
			current.height !== next.height ||
			current.unseen !== next.unseen ||
			current.highlight !== next.highlight
		)
			this.#state.set(next);
	}

	/**
	 * Paint `main` into a transcript area of `area` rows by `width` columns, of
	 * which the top `shown` rows are not under the dock. `focused`: a main
	 * block's cursor may show.
	 */
	compose(main: readonly UiNode[], width: number, area: number, shown: number, focused: boolean): TranscriptFrame {
		const theme = this.#options.theme();
		const lanes = width > EDGE_COLUMNS;
		const contentWidth = lanes ? width - EDGE_COLUMNS : width;
		const indicator = area > 1 ? 1 : 0;
		const body = Math.max(0, area - indicator);
		const reach = Math.max(0, Math.min(body, shown));
		const previous = this.#layout;
		this.#history.begin(main, contentWidth, !this.#following);
		const offset = this.#window(previous, body);
		const layout = this.#history.layout;
		const blocks = this.#history.frameBlocks(offset, body);
		const document = this.#history.document(layout, blocks, offset, body);
		this.#layout = layout;
		this.#blocks = blocks;
		this.#body = body;
		const gesture = this.#gesture;
		if (this.#extendOnFrame && gesture?.kind === "select" && reach > 0) {
			this.#selection.drag(document, offset + Math.max(0, Math.min(gesture.row, reach - 1)), gesture.col);
		}
		this.#extendOnFrame = false;

		const content: string[] = [];
		const hits: PlacedHit[] = [];
		let cursor: Cell | null = null;
		const cellHeight = this.#options.cellHeight();
		const end = Math.min(layout.rows, offset + body);
		let row = offset;
		while (row < end) {
			const i = layout.at(row);
			const top = layout.top(i);
			const block = blocks.get(layout.nodes[i]!);
			if (!block) {
				// Only a separator is in view, or a cold run of empty blocks exhausted this frame's budget.
				const next = Math.min(end, layout.before(i + 1));
				for (; row < next; row++) content.push("");
				continue;
			}
			for (; row < top && row < end; row++) content.push("");
			if (row >= end) break;
			const from = row - top;
			const to = Math.min(block.rows.length, end - top);
			// An image the window cuts is cropped to the rows in view (SIXEL) or held back until whole.
			content.push(...windowImageRows(block.rows, from, to, cellHeight));
			row = top + to;
			const at = top - offset;
			for (const hit of block.hits ?? []) {
				if (hit.row + hit.height > from && hit.row < to)
					hits.push({ hit, region: "main", top: at, left: 0, rows: [0, reach] });
			}
			if (
				focused &&
				block.cursor &&
				block.cursor.row >= from &&
				block.cursor.row < to &&
				at + block.cursor.row < reach
			)
				cursor = { row: at + block.cursor.row, col: block.cursor.col };
		}
		while (content.length < body) content.push("");
		if (this.#findMatch) this.#paintFind(this.#findMatch, content, layout, blocks, offset, reach, theme);
		for (const highlight of this.#selection.highlight(document, offset, offset + body)) {
			const at = highlight.row - offset;
			content[at] = paintRanges(content[at]!, highlight.ranges, contentWidth, invert);
		}

		this.#history.finish(blocks);
		const metricsReady = this.#history.ready;
		this.#metricsReady = metricsReady;
		if (!metricsReady && this.#gesture?.kind === "thumb") this.#endGesture();
		const marks = this.#lane(layout, offset, body);
		const thumb = thumbRange(layout.rows, body, offset);
		const dragging = this.#gesture?.kind === "thumb";
		const rows: string[] = [];
		for (let r = 0; r < body; r++) {
			const text = content[r]!;
			if (!lanes) {
				rows.push(text);
				continue;
			}
			const reset = text.includes("\x1b[") ? "\x1b[0m" : "";
			const edge = metricsReady
				? `${markGlyph(theme, marks.get(r))}${scrollbarGlyph(theme, thumb, r, dragging)}`
				: "  ";
			rows.push(`${padTo(text, contentWidth)}${reset}${edge}`);
		}
		const notice = this.#feedback === undefined && !this.#following && this.#unseen;
		if (indicator) {
			const text = this.#feedback ?? (notice ? "New output below" : "");
			rows.push(text ? truncate(theme.fg("dim", ` ${text}`), width) : "");
		}
		this.#view = {
			layout,
			metricsReady,
			document,
			offset,
			body,
			reach,
			shown,
			contentWidth,
			lanes,
			thumb,
			marks,
			indicator: indicator ? body : -1,
			notice,
		};
		return { rows, hits, cursor };
	}

	/**
	 * A pointer report at frame row `row` on a transcript frame. `sheet`: the
	 * pointer is over a sheet, whose hits it keeps. `route` offers the report
	 * to the frame's hits and tells whether something took it. False leaves the
	 * report to hit routing.
	 */
	mouse(mouse: MouseEvent, row: number, sheet: boolean, route: () => boolean): boolean {
		const view = this.#view;
		if (!view) return false;
		const gesture = this.#gesture;
		const wheel = mouse.button === "wheel-up" ? -1 : mouse.button === "wheel-down" ? 1 : 0;
		if (wheel !== 0) {
			if (!gesture) {
				if (sheet) return false;
				// Dock widgets that scroll (a list) keep the wheel; elsewhere it scrolls the transcript.
				if (row >= view.shown && route()) return true;
			}
			// A selection dragged while the wheel turns extends over what the next frame shows.
			if (this.#scrollBy(wheel * this.#wheel.next(wheel, performance.now())) && gesture?.kind === "select")
				this.#extendOnFrame = true;
			return true;
		}
		if (mouse.button === "wheel-left" || mouse.button === "wheel-right") return false;
		if (gesture?.kind === "thumb") {
			if (mouse.action === "drag") {
				this.#scrollTo(
					offsetForThumb(row + (mouse.rowFraction ?? 0.5) - gesture.grab, view.layout.rows, view.body),
				);
				return true;
			}
			// A release, unheld motion or a fresh press ends the drag; the press then goes on.
			this.#endGesture();
			this.#options.requestRender();
			if (mouse.action !== "press") return true;
		} else if (gesture?.kind === "select") {
			if (mouse.action === "drag") {
				gesture.row = row;
				gesture.col = mouse.col;
				const at = this.#documentRow(view, row);
				if (at !== undefined) this.#selection.drag(view.document, at, mouse.col);
				this.#scheduleEdge();
				this.#options.requestRender();
				return true;
			}
			// Unheld motion means the release was lost; a fresh press ends the drag where it was.
			if (mouse.action === "press") this.#release(view, gesture.row, gesture.col);
			else {
				this.#release(view, row, mouse.col);
				return true;
			}
		}
		if (sheet) return false;
		if (mouse.action !== "press" || mouse.button !== "left") return false;
		if (row < view.reach) {
			if (view.lanes && mouse.col >= view.contentWidth) {
				if (!view.metricsReady) return true;
				if (mouse.col === view.contentWidth) {
					const mark = view.marks.get(row);
					if (mark) this.#toMark(mark);
				} else this.#pressScrollbar(view, row, mouse.rowFraction);
				return true;
			}
			if (this.#options.activateTargets?.() && route()) return true;
			// A transcript press that starts no selection is still ours: falling through would activate a disabled hit.
			if ((this.#options.pointer?.() ?? "select") !== "select" || mouse.mods.length > 0) return true;
			this.#generation++;
			this.#clearFeedback();
			if (this.#selection.press(view.document, view.offset + row, mouse.col))
				this.#gesture = { kind: "select", row, col: mouse.col };
			this.#options.requestRender();
			return true;
		}
		if (row === view.indicator && row < view.shown && view.notice) {
			this.#follow();
			return true;
		}
		return false;
	}

	/** Resolve the window's top for this frame: the tail, or the anchor's row; judges new output below. */
	#window(previous: HistoryLayout | undefined, body: number): number {
		const history = this.#history;
		let position: BlockPosition | undefined;
		let moved = false;
		if (!this.#following && this.#anchor) {
			const anchor = this.#anchor;
			let i = history.layout.index.get(anchor.node);
			if (i === undefined || !history.show(i).rows.length) {
				i = previous ? neighbour(previous, history, anchor.node) : undefined;
				moved = true;
			}
			if (i !== undefined) {
				const block = history.show(i);
				if (block.rows.length) {
					const current = moved ? (this.#anchor = readingAnchor(history.layout.nodes[i]!, block, 0)) : anchor;
					if (!moved && this.#blocks.get(current.node) !== block) current.row = remapRow(current, block);
					let row = current.row;
					if (row < 0) history.adjacent(i, -1); // its actual separator may follow a cold empty run
					row = Math.max(-history.layout.lead(i), Math.min(row, block.rows.length - 1));
					position = { i, row };
				}
			}
		}
		const atEnd = history.cover(position, body);
		const fits = history.ready && history.layout.rows <= body;
		const shrankToFit =
			fits &&
			previous?.width === history.layout.width &&
			this.#body === body &&
			this.#metricsReady &&
			previous.rows > body;
		if (position && ((this.#followIfTail && atEnd) || shrankToFit)) {
			position = undefined;
			history.cover(undefined, body);
		}
		this.#followIfTail = false;
		if (!position) {
			this.#following = true;
			this.#anchor = undefined;
			this.#unseen = false;
			this.#offset = Math.max(0, history.layout.rows - body);
		} else if (fits) {
			// A temporary wide/tall viewport can show everything. Do not silently rejoin the
			// tail and discard the reader's point when the terminal shrinks again.
			history.cover(undefined, body);
			this.#offset = 0;
			this.#unseen = false;
		} else {
			// Do not clamp a surviving reading anchor to an estimated bottom during indexing or reflow.
			this.#offset = history.layout.top(position.i) + position.row;
			if (!moved && previous?.width === history.layout.width && history.grew >= this.#offset + body)
				this.#unseen = true;
		}
		return this.#offset;
	}

	/**
	 * Marks placed on the lane; the one of the turn being read (holding the window's top, the last
	 * while following) is current.
	 */
	#lane(layout: HistoryLayout, offset: number, body: number): ReadonlyMap<number, LaneMark> {
		const marks = (this.#marks = this.#options.marks?.() ?? []);
		if (!this.#metricsReady || !marks.length) {
			this.#markPositions = undefined;
			return new Map();
		}
		if (this.#markPositions?.layout !== layout || this.#markPositions.marks !== marks) {
			const placed: { row: number; node: UiNode; kind: ScrollMarkKind }[] = [];
			for (const mark of marks) {
				const i = layout.index.get(mark.node);
				if (i !== undefined) placed.push({ row: layout.top(i), node: mark.node, kind: mark.kind });
			}
			placed.sort((a, b) => a.row - b.row);
			this.#markPositions = { layout, marks, placed };
		}
		const placed = this.#markPositions.placed;
		let current = this.#following ? placed.length - 1 : -1;
		if (!this.#following) while (current + 1 < placed.length && placed[current + 1]!.row <= offset) current++;
		return markCells(
			placed.map((mark, k): LaneMark => ({ ...mark, current: k === current })),
			layout.rows,
			body,
		);
	}

	#scrollBy(rows: number): boolean {
		const step = Math.trunc(rows);
		if (!Number.isFinite(step) || step === 0) return false;
		const frame = this.#layout;
		if (!frame?.rows || (this.#metricsReady && frame.rows <= this.#body)) return false;
		if (this.#following && (step > 0 || !this.#offset)) return false;
		const i = frame.at(this.#offset);
		if (i < 0) return false;
		const row = this.#offset - frame.top(i);
		const next = this.#history.walk({ i, row }, step);
		return next ? this.#move(next, step > 0) : this.#follow();
	}

	#page(direction: -1 | 1): boolean {
		return this.#scrollBy(direction * Math.max(1, this.#body - 1));
	}

	/** Move the window's top to document row `target`; reaching the tail resumes following. */
	#scrollTo(target: number): boolean {
		const frame = this.#layout;
		if (!frame || !frame.rows || !Number.isFinite(target)) return false;
		if (this.#metricsReady && frame.rows <= this.#body) return false;
		const next = Math.max(0, Math.round(target));
		if (next > 0 && next >= frame.rows - this.#body) return this.#follow();
		const i = frame.at(next);
		return i >= 0 && this.#move({ i, row: next - frame.top(i) }, next > this.#offset);
	}

	#toMark(mark: ScrollMark): boolean {
		const i = this.#history.layout.index.get(mark.node);
		return i !== undefined && this.#move({ i, row: 0 }, true);
	}

	#move(position: BlockPosition, towardTail: boolean): boolean {
		let { i, row } = position;
		const history = this.#history;
		if (!history.height(i)) {
			i = history.adjacent(i, 1);
			if (i < 0) return this.#follow();
			row = 0;
		}
		const layout = history.layout;
		const node = layout.nodes[i]!;
		const block = this.#blocks.get(node) ?? this.#options.measure(node, layout.width);
		row = Math.max(-layout.lead(i), Math.min(row, Math.max(0, block.rows.length - 1)));
		const offset = layout.top(i) + row;
		if (towardTail && history.ready && offset >= layout.rows - this.#body) return this.#follow();
		if (!this.#following && this.#anchor?.node === node && this.#offset === offset) return false;
		this.#anchor = readingAnchor(node, block, row);
		this.#following = false;
		this.#followIfTail = towardTail;
		this.#offset = offset;
		this.#layout = layout;
		this.#moved();
		return true;
	}

	#follow(): boolean {
		if (this.#following) return false;
		this.#following = true;
		this.#unseen = false;
		this.#anchor = undefined;
		const layout = this.#layout;
		if (layout) this.#offset = Math.max(0, layout.rows - this.#body);
		this.#moved();
		return true;
	}

	/** The previous mark above the window's top, or the next one below it. */
	#seekMark(direction: -1 | 1): boolean {
		const layout = this.#layout;
		if (!layout) return false;
		let target: ScrollMark | undefined;
		let distance = Infinity;
		// Node identity is already known before indexing. Do not require a scrollbar or visit any
		// intervening blocks to jump to a mark in a still-cold history.
		for (const mark of this.#marks) {
			const i = layout.index.get(mark.node);
			if (i === undefined) continue;
			const delta = direction * (layout.top(i) - this.#offset);
			if (delta > 0 && delta < distance) {
				target = mark;
				distance = delta;
			}
		}
		return target !== undefined && this.#toMark(target);
	}

	/** Drop a match but leave the reading anchor and the pointer selection alone. */
	#clearFind(): void {
		this.#findGeneration++;
		if (!this.#findMatch) return;
		this.#findMatch = undefined;
		this.#options.requestRender();
	}

	#readingMatch(layout: HistoryLayout, match: TranscriptMatch): boolean {
		const i = layout.index.get(match.node);
		if (i === undefined || (!this.#blocks.has(match.node) && this.#anchor?.node !== match.node)) return false;
		const row = layout.top(i) + match.row - this.#offset;
		return row >= 0 && row < (this.#view?.reach ?? 0);
	}

	async #findText(query: string, direction: -1 | 1): Promise<boolean> {
		if (this.#findMatch && this.#findMatch.query !== query) this.#clearFind();
		const generation = ++this.#findGeneration;
		const frame = this.#layout;
		if (!query || !frame || !this.#options.active() || !this.#view?.reach) return false;
		const repeat = this.#findMatch && this.#readingMatch(frame, this.#findMatch) ? this.#findMatch : undefined;
		const i = repeat ? frame.index.get(repeat.node)! : frame.at(this.#offset);
		if (i < 0) return false;
		// Idle height indexing can replace the coordinate tree between slices. Node order and width,
		// not its provisional heights, determine the scan. Never hold onto an old frame's paint map.
		const current = (): boolean =>
			generation === this.#findGeneration &&
			this.#options.active() &&
			!!this.#view?.reach &&
			frame.nodes === this.#layout?.nodes &&
			frame.width === this.#layout.width;
		const found = await findTranscriptMatch(
			frame.nodes,
			node => this.#blocks.get(node) ?? this.#options.measure(node, frame.width),
			{ i, row: this.#offset - frame.top(i) },
			repeat,
			query,
			direction,
			current,
		);
		if (!current()) return false;
		if (!found) {
			this.#clearFind();
			return false;
		}
		this.#findMatch = found;
		if (!this.#readingMatch(this.#layout!, found)) {
			const target = this.#history.layout.index.get(found.node)!;
			if (this.#move({ i: target, row: found.row }, this.#view!.reach === this.#body)) return true;
		}
		this.#options.requestRender();
		return true;
	}

	#paintFind(
		match: TranscriptMatch,
		content: string[],
		layout: HistoryLayout,
		blocks: ReadonlyMap<UiNode, Block>,
		offset: number,
		reach: number,
		theme: Theme,
	): void {
		const i = layout.index.get(match.node);
		if (i === undefined) {
			this.#findMatch = undefined;
			return;
		}
		const block = blocks.get(match.node);
		if (!block) return; // Never measure even a single offscreen block for a paint-only decoration.
		const model = textModel(block);
		if (!model.lines[match.index]?.text.startsWith(match.value, match.start)) {
			this.#findMatch = undefined;
			return;
		}
		const top = layout.top(i) - offset;
		const end = Math.min(reach - top, model.firstRow[match.index + 1] ?? model.rows.length);
		const style = (text: string): string => markText(theme, text);
		let first: number | undefined;
		for (let row = Math.max(-top, model.firstRow[match.index]!); row < end; row++) {
			if (model.rowLine[row] !== match.index) continue;
			const ranges = columnRanges(model, row, match.start, match.start + match.value.length);
			if (!ranges.length) continue;
			first ??= row;
			content[top + row] = paintRanges(content[top + row]!, ranges, layout.width, style);
		}
		// Reflow can put this source offset on a different row. Repeat from the visible match, even
		// when only its continuation remains on screen.
		if (first !== undefined && first !== match.row) this.#findMatch = { ...match, row: first };
	}

	#moved(): void {
		this.#findGeneration++; // An explicit scroll supersedes a search that is still scanning.
		this.#options.requestRender();
		this.publish();
	}

	/** A left press on the scrollbar column: grab the thumb, or page toward the press. */
	#pressScrollbar(view: View, row: number, fraction: number | undefined): void {
		const { thumb } = view;
		const position = row + (fraction ?? 0.5);
		const onThumb =
			fraction === undefined
				? row < thumb.end && row + 1 > thumb.start
				: position >= thumb.start && position < thumb.end;
		if (onThumb) {
			this.#gesture = {
				kind: "thumb",
				grab: Math.max(0, Math.min(thumb.end - thumb.start, position - thumb.start)),
			};
			this.#options.requestRender();
			return;
		}
		this.#page(position < thumb.start ? -1 : 1);
	}

	/** Document row under frame row `row`, held inside the rows the pointer reaches. */
	#documentRow(view: View, row: number): number | undefined {
		if (view.reach <= 0) return undefined;
		return view.offset + Math.max(0, Math.min(row, view.reach - 1));
	}

	#release(view: View, row: number, col: number): void {
		const at = this.#documentRow(view, row);
		if (at !== undefined) this.#selection.release(view.document, at, col);
		this.#endGesture();
		if (this.#selection.active && (this.#options.copyOnRelease?.() ?? true)) this.#copy();
		this.#options.requestRender();
	}

	#endGesture(): void {
		this.#gesture = undefined;
		clearTimeout(this.#edgeTimer);
		this.#edgeTimer = undefined;
		this.#extendOnFrame = false;
	}

	/** While a selection drag rests on the window's first row or below it, scroll a bounded step per tick. */
	#scheduleEdge(): void {
		if (this.#edgeTimer || this.#edgeStep() === 0) return;
		this.#edgeTimer = setTimeout(() => {
			this.#edgeTimer = undefined;
			const step = this.#edgeStep();
			if (step === 0 || !this.#scrollBy(step)) return;
			this.#extendOnFrame = true;
			this.#scheduleEdge();
		}, EDGE_SCROLL_MS);
		this.#edgeTimer.unref?.();
	}

	#edgeStep(): number {
		const gesture = this.#gesture;
		const view = this.#view;
		if (gesture?.kind !== "select" || !view || view.reach <= 0) return 0;
		return edgeScrollStep(gesture.row, view.reach > 2 ? 1 : 0, view.reach);
	}

	/** Start copying the selection; false when there is nothing to copy or no way to. */
	#copy(): boolean {
		const copy = this.#options.copyText;
		if (!copy || !this.#layout) return false;
		const text = this.#selection.text(this.#history.copyDocument(this.#blocks));
		if (!text) return false;
		const generation = ++this.#generation;
		let copying: Promise<SelectionClipboardResult>;
		try {
			copying = copy(text);
		} catch (error) {
			copying = Promise.reject(error);
		}
		copying
			.catch((error: unknown): SelectionClipboardResult => {
				logger.warn("pi-tui: copying the transcript selection failed", { error: String(error) });
				return "failed";
			})
			.then(result => {
				if (generation === this.#generation) this.#showFeedback(result);
			});
		return true;
	}

	#showFeedback(result: SelectionClipboardResult): void {
		const key = this.#options.copyShortcutLabel?.();
		this.#feedback =
			result === "success"
				? "Selection copied"
				: result === "unconfirmed-terminal"
					? "Sent to terminal clipboard (unconfirmed)"
					: key
						? `Copy failed - retry with ${key}`
						: "Copy failed";
		clearTimeout(this.#feedbackTimer);
		this.#feedbackTimer = setTimeout(
			() => {
				this.#feedbackTimer = undefined;
				this.#feedback = undefined;
				this.#options.requestRender();
			},
			result === "success" ? COPIED_MS : COPY_FAILED_MS,
		);
		this.#feedbackTimer.unref?.();
		this.#options.requestRender();
	}

	#clearFeedback(): boolean {
		clearTimeout(this.#feedbackTimer);
		this.#feedbackTimer = undefined;
		const had = this.#feedback !== undefined;
		this.#feedback = undefined;
		return had;
	}

	#drop(): boolean {
		const had = this.#selection.clear();
		if (this.#gesture?.kind === "select") this.#endGesture();
		this.#generation++;
		if (this.#clearFeedback() || had) {
			this.#options.requestRender();
			this.publish();
		}
		return had;
	}
}

/** The nearest node of `previous` around `gone` that `layout` still paints rows for, later ones first. */
function neighbour(previous: HistoryLayout, history: FullscreenHistory, gone: UiNode): number | undefined {
	const at = previous.index.get(gone);
	if (at === undefined) return undefined;
	for (const direction of [1, -1]) {
		for (let j = at + direction; j >= 0 && j < previous.nodes.length; j += direction) {
			const i = history.layout.index.get(previous.nodes[j]!);
			if (i !== undefined && history.height(i) > 0) return i;
		}
	}
	return undefined;
}
