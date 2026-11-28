/**
 * `editor` and `input`: an editable text field, as a terminal draws it.
 *
 * The text wraps by words to the painted width (a word wider than a row
 * breaks by graphemes; whitespace at a soft break is swallowed by the row it
 * ends). The caret is drawn over the character it sits on (inverse block or
 * underline) or, after the last character of a row, as a thin bar; the
 * selection (`anchor`…`cursor`, or the terminal-only `term.selection`) is
 * drawn inverse, a selected newline as one inverse blank. `decor` ranges take
 * their span styles, `ghost` text follows an end-of-text caret dimmed, the
 * placeholder fills an empty field flush right. `maxLines` (or a fixed
 * height) shows a window of rows around the caret.
 *
 * Rows come back unpadded; the hardware cursor is reported while the field
 * holds the focus. Chrome around the field (frames, gutters, status) belongs
 * to the screen's role painter, which paints the field through `cx.paint`.
 */
import { segmentGraphemes } from "@oh-my-pi/pi-utils/graphemes";
import type { TspEditorDecoration, TspSpan, TspText } from "@oh-my-pi/pi-wire";
import type { UiNode } from "../../node";
import { fgSgr } from "../../theme/color";
import type { Theme } from "../../theme/contract";
import { hyperlink } from "../../text/osc";
import { TAB_WIDTH, truncate, visibleWidth, widthEpoch } from "../../text/width";
import { widgetState } from "../widgets";
import { type Block, type Cell, definePainter, type PaintContext } from "../paint";

// ─── Graphemes ──────────────────────────────────────────────────────────────

/** One grapheme of a text: its UTF-16 offset, length and cells. */
export interface Grapheme {
	readonly at: number;
	readonly text: string;
	readonly width: number;
}

/** Cells a grapheme of editable text takes (a tab expands to `TAB_WIDTH`). */
export function graphemeWidth(text: string): number {
	if (text === "\t") return TAB_WIDTH;
	return visibleWidth(text);
}

/** The graphemes of `text[from, to)`. */
export function graphemes(text: string, from = 0, to = text.length): Grapheme[] {
	const out: Grapheme[] = [];
	if (to <= from) return out;
	for (const { segment, index } of segmentGraphemes(text.slice(from, to))) {
		out.push({ at: from + index, text: segment, width: graphemeWidth(segment) });
	}
	return out;
}

const WHITESPACE = /^\s+$/u;

/** Whether a grapheme is whitespace (wrapping and word motions break there). */
export function isWhitespace(text: string): boolean {
	return WHITESPACE.test(text);
}

// ─── Layout ─────────────────────────────────────────────────────────────────

/** One visual row of a wrapped text. Offsets are UTF-16 code units into the whole text. */
export interface EditorRow {
	/** First character of the row. */
	readonly start: number;
	/** End of the row's displayed text. */
	readonly textEnd: number;
	/** Where the next row starts: whitespace swallowed by a soft break lies in `[textEnd, end)`. */
	readonly end: number;
	/** Cells of the displayed text. */
	readonly width: number;
	/** Index of the logical line (`\n`-separated) the row belongs to. */
	readonly line: number;
	/** Whether the row ends its logical line. */
	readonly last: boolean;
}

interface Chunk {
	start: number;
	textEnd: number;
	end: number;
	width: number;
}

/** Word-wrap one logical line (no `\n`) to `width` cells; offsets relative to the line. */
function wrapLine(line: string, width: number): Chunk[] {
	const all = graphemes(line);
	let total = 0;
	for (const g of all) total += g.width;
	if (total <= width || width <= 0) return [{ start: 0, textEnd: line.length, end: line.length, width: total }];

	const chunks: Chunk[] = [];
	let start = 0;
	let rowWidth = 0;
	// End and width of the row's text up to its last non-blank grapheme.
	let wordEnd = 0;
	let wordWidth = 0;
	const close = (textEnd: number, textWidth: number, end: number): void => {
		chunks.push({ start, textEnd, end, width: textWidth });
		start = end;
		rowWidth = 0;
		wordEnd = end;
		wordWidth = 0;
	};

	let i = 0;
	while (i < all.length) {
		// One token: a run of blanks or of non-blanks.
		const blank = isWhitespace(all[i]!.text);
		let j = i;
		let tokenWidth = 0;
		while (j < all.length && isWhitespace(all[j]!.text) === blank) tokenWidth += all[j++]!.width;
		const tokenStart = all[i]!.at;
		const tokenEnd = j < all.length ? all[j]!.at : line.length;

		if (blank) {
			if (rowWidth + tokenWidth <= width) rowWidth += tokenWidth;
			// Blanks ending the line stay with its last row, past its text.
			else if (j >= all.length) {
				chunks.push({ start, textEnd: wordEnd, end: line.length, width: wordWidth });
				return chunks;
			}
			// Blanks that overflow end the row and vanish into the break.
			else close(wordEnd, wordWidth, tokenEnd);
		} else if (rowWidth + tokenWidth <= width) {
			rowWidth += tokenWidth;
			wordEnd = tokenEnd;
			wordWidth = rowWidth;
		} else if (tokenWidth <= width) {
			close(wordEnd, wordWidth, tokenStart);
			rowWidth = tokenWidth;
			wordEnd = tokenEnd;
			wordWidth = tokenWidth;
		} else {
			// A word wider than any row: fill what is left of this row, then break by graphemes.
			for (let k = i; k < j; k++) {
				const g = all[k]!;
				if (rowWidth + g.width > width && rowWidth > 0) {
					// Breaking before the word's first grapheme leaves the blanks before it to the break.
					if (k === i) close(wordEnd, wordWidth, g.at);
					else close(g.at, rowWidth, g.at);
				}
				rowWidth += g.width;
				wordEnd = g.at + g.text.length;
				wordWidth = rowWidth;
			}
		}
		i = j;
	}
	chunks.push({ start, textEnd: line.length, end: line.length, width: rowWidth });
	return chunks;
}

/** Lay `text` out in rows of `width` cells (see {@link EditorRow}). */
export function layoutText(text: string, width: number): EditorRow[] {
	return layoutLines(text, line => wrapLine(line, Math.max(1, width)));
}

/** Rows of `text`, each logical line wrapped by `wrap` (chunk offsets relative to the line). */
function layoutLines(text: string, wrap: (line: string) => readonly Chunk[]): EditorRow[] {
	const rows: EditorRow[] = [];
	let offset = 0;
	let line = 0;
	for (const lineText of text.split("\n")) {
		const chunks = wrap(lineText);
		for (let k = 0; k < chunks.length; k++) {
			const c = chunks[k]!;
			rows.push({
				start: offset + c.start,
				textEnd: offset + c.textEnd,
				end: offset + c.end,
				width: c.width,
				line,
				last: k === chunks.length - 1,
			});
		}
		offset += lineText.length + 1;
		line++;
	}
	return rows;
}

const kLayout = Symbol("pi-tui.editor.layout");

/** A field's last layout, and the wrapped chunks of each of its lines (reused by the next layout at that width). */
interface FieldLayout {
	readonly text: string;
	readonly width: number;
	/** The {@link widthEpoch} the lines were measured under. */
	readonly epoch: number;
	readonly rows: readonly EditorRow[];
	readonly lines: ReadonlyMap<string, readonly Chunk[]>;
}

interface LayoutHolder {
	[kLayout]?: FieldLayout;
}

/**
 * {@link layoutText} for a field, through its last layout: the same text at the same width is laid
 * out once (painting and key handling ask for it several times per keystroke), and an edit
 * re-wraps only the lines it changed.
 */
function layoutField(node: UiNode, text: string, width: number): readonly EditorRow[] {
	const holder = node as LayoutHolder;
	const epoch = widthEpoch();
	const last = holder[kLayout]?.epoch === epoch ? holder[kLayout] : undefined;
	if (last && last.width === width && last.text === text) return last.rows;
	const reuse = last?.width === width ? last.lines : undefined;
	const lines = new Map<string, readonly Chunk[]>();
	const wrapWidth = Math.max(1, width);
	const rows = layoutLines(text, line => {
		const chunks = lines.get(line) ?? reuse?.get(line) ?? wrapLine(line, wrapWidth);
		lines.set(line, chunks);
		return chunks;
	});
	holder[kLayout] = { text, width, epoch, rows, lines };
	return rows;
}

/** The row holding `offset` (a soft-break boundary belongs to the next row). */
export function rowOf(rows: readonly EditorRow[], offset: number): number {
	// Rows start in ascending order: the only row that can hold `offset` is the last one starting at or before it.
	let lo = 0;
	let hi = rows.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (rows[mid]!.start <= offset) lo = mid + 1;
		else hi = mid;
	}
	const row = rows[lo - 1];
	if (row && (offset < row.end || (offset === row.end && row.last))) return lo - 1;
	return Math.max(0, rows.length - 1);
}

/** Cells from the start of row `row` to `offset` (an offset in swallowed blanks sits at the text's end). */
export function columnOf(text: string, row: EditorRow, offset: number): number {
	const to = Math.min(Math.max(offset, row.start), row.textEnd);
	let cells = 0;
	for (const g of graphemes(text, row.start, to)) cells += g.width;
	return cells;
}

/** The caret's row and cell column for `offset`. */
export function caretCell(text: string, rows: readonly EditorRow[], offset: number): Cell {
	const row = rowOf(rows, offset);
	return { row, col: columnOf(text, rows[row]!, offset) };
}

/**
 * The offset in row `row` nearest the cell column `col` (left of a grapheme
 * the column falls inside). Past the text it is the text's end, except on a
 * row ending at a hard break, where it stays on the row's last grapheme.
 */
export function offsetAt(text: string, rows: readonly EditorRow[], row: number, col: number): number {
	const r = rows[Math.max(0, Math.min(rows.length - 1, row))]!;
	let cells = 0;
	let last = r.start;
	for (const g of graphemes(text, r.start, r.textEnd)) {
		if (cells + g.width > col) return g.at;
		cells += g.width;
		last = g.at;
	}
	if (!r.last && r.textEnd === r.end && r.textEnd > r.start) return last;
	return r.textEnd;
}

const kWrapWidth = Symbol("pi-tui.editor.wrap-width");

interface WrapWidthHolder {
	[kWrapWidth]?: number;
}

/**
 * The wrap width `node` was last painted at: what the terminal shows decides
 * which row the caret is on (up/down, history at the first row). Undefined
 * before the first paint.
 */
export function lastWrapWidth(node: UiNode): number | undefined {
	return (node as WrapWidthHolder)[kWrapWidth];
}

/** The rows of `node`'s text as it was last painted (one row per logical line before any paint). */
export function lastLayout(node: UiNode): readonly EditorRow[] {
	const text = (node.props() as EditorProps).text ?? "";
	return layoutField(node, text, lastWrapWidth(node) ?? Number.MAX_SAFE_INTEGER);
}

// ─── Props ──────────────────────────────────────────────────────────────────

/** A terminal-only styled range of an editor's text. */
export interface EditorTermRange {
	readonly from: number;
	readonly to: number;
	/** Span style tokens (as `decor`'s `s`). */
	readonly s?: string;
	/** A truecolor foreground (`#rrggbb`), over `s`. */
	readonly fg?: string;
	/**
	 * An animated truecolor foreground (`#rrggbb`, over `fg`): the color at terminal clock `now`
	 * (ms). The field repaints on every animation tick while a range has one; reduced motion
	 * draws `now` 0.
	 */
	readonly fgAt?: (now: number) => string;
	/** A link target (URI) the range opens, drawn as an OSC 8 hyperlink on a terminal that draws them. */
	readonly href?: string;
	/** Draw the range only whole: on a row holding all of it, the caret not drawn inside it (a cut token shows plain). */
	readonly whole?: boolean;
	/**
	 * Text drawn in the range's style in place of its characters, on a row holding all of it with
	 * the caret and selection outside it and room for the label; elsewhere its characters show.
	 * The row is not rewrapped, so it suits a range alone on its line (a header).
	 */
	readonly label?: string;
}

/** Terminal-only look facts of an `editor`/`input` node (its `term` prop). */
export type EditorTerm = {
	/** Ranges drawn instead of `decor` (when the terminal look differs from the native one). */
	readonly decor?: readonly EditorTermRange[];
	/** The caret over a character: inverse block (default), underline, or nothing (the hardware cursor alone). */
	readonly caret?: "block" | "underline" | "none";
	/** The caret after a row's last character: a bar glyph (default), an inverse blank, or nothing. */
	readonly caretEnd?: "bar" | "block" | "none";
	/** The placeholder the terminal shows instead of `placeholder`; null shows none. */
	readonly placeholder?: TspText | null;
	/** The selection drawn instead of `anchor`…`cursor`, as `[from, to)` (Vim's inclusive visual modes). */
	readonly selection?: { readonly from: number; readonly to: number } | null;
	/** Cells right of the wrap width an end-of-row caret may take (padding the chrome lends it). */
	readonly caretOverflow?: number;
	/** One cell (ANSI-styled) drawn in place of the end-of-row caret bar (push-to-talk's mic glyph). */
	readonly caretGlyph?: string;
};

/** What the painter reads from an `editor`/`input` node. */
export interface EditorProps {
	readonly text?: string;
	readonly cursor?: number;
	readonly anchor?: number | null;
	readonly decor?: readonly TspEditorDecoration[];
	readonly ghost?: string;
	readonly placeholder?: TspText;
	readonly prompt?: TspText;
	readonly mode?: string;
	readonly readonly?: boolean;
	readonly maxLines?: number;
	readonly term?: EditorTerm;
}

/** The caret offset of `props`, clamped into the text. */
export function caretOf(props: EditorProps): number {
	const text = props.text ?? "";
	return Math.max(0, Math.min(text.length, props.cursor ?? text.length));
}

// ─── Painting ───────────────────────────────────────────────────────────────

const BAR = "▏";
const INVERSE_ON = "\x1b[7m";
const INVERSE_OFF = "\x1b[27m";
const UNDERLINE_ON = "\x1b[4m";
const UNDERLINE_OFF = "\x1b[24m";
const MARK = "\u0000";

/** The opening and closing escapes `styled` wraps around its text (`styled` holds one {@link MARK}). */
function sgrPair(styled: string): [string, string] {
	const at = styled.indexOf(MARK);
	return at === -1 ? ["", ""] : [styled.slice(0, at), styled.slice(at + 1)];
}

function plainText(content: TspText | undefined): string {
	if (content === undefined) return "";
	if (typeof content === "string") return content;
	return (content as readonly TspSpan[]).map(span => span.t).join("");
}

function styledSpans(theme: Theme, content: TspText): string {
	if (typeof content === "string") return content;
	let out = "";
	for (const span of content as readonly TspSpan[]) out += span.s ? theme.style(span.s, span.t) : span.t;
	return out;
}

interface Style {
	readonly open: string;
	readonly close: string;
	readonly hidden: boolean;
	readonly whole: boolean;
	readonly from: number;
	readonly to: number;
	readonly label?: string;
}

function rangeStyles(theme: Theme, props: EditorProps, now: () => number, links: () => boolean): Style[] {
	const term = props.term;
	const depth = "depth" in theme && (theme.depth === "256" || theme.depth === "16") ? theme.depth : "truecolor";
	const out: Style[] = [];
	if (term?.decor) {
		// The clock is read only for animated ranges: a still draft never repaints on ticks.
		let at: number | undefined;
		for (const range of term.decor) {
			let [open, close] = range.s ? sgrPair(theme.style(range.s, MARK)) : ["", ""];
			const hidden = range.s !== undefined && theme.style(range.s, "x") === "";
			const fg = range.fgAt ? range.fgAt((at ??= now())) : range.fg;
			if (fg) {
				open = `${open}${fgSgr(fg, depth)}`;
				close = `${close}\x1b[39m`;
			}
			if (range.href && links()) {
				const [linkOpen, linkClose] = sgrPair(hyperlink(MARK, range.href));
				open = `${open}${linkOpen}`;
				close = `${linkClose}${close}`;
			}
			out.push({
				open,
				close,
				hidden,
				whole: range.whole === true,
				from: range.from,
				to: range.to,
				...(range.label !== undefined ? { label: range.label } : {}),
			});
		}
		return out;
	}
	for (const range of props.decor ?? []) {
		const hidden = theme.style(range.s, "x") === "";
		const [open, close] = sgrPair(theme.style(range.s, MARK));
		out.push({ open, close, hidden, whole: false, from: range.from, to: range.to });
	}
	return out;
}

/** How one grapheme is drawn. */
interface CellLook {
	style: Style | undefined;
	inverse: boolean;
	underline: boolean;
}

/** Paint one row's text (graphemes `[from, to)`) with styles, selection and caret looks. */
function paintRun(
	text: string,
	from: number,
	to: number,
	look: (g: Grapheme) => CellLook | null,
	base: readonly [string, string],
): { out: string; width: number } {
	let out = "";
	let width = 0;
	let current: CellLook | null = null;
	const open = (l: CellLook): void => {
		if (l.style) out += l.style.open;
		if (l.inverse) out += INVERSE_ON;
		if (l.underline) out += UNDERLINE_ON;
	};
	const shut = (l: CellLook): void => {
		if (l.underline) out += UNDERLINE_OFF;
		if (l.inverse) out += INVERSE_OFF;
		if (l.style) out += `${l.style.close}${base[0]}`;
	};
	const same = (a: CellLook, b: CellLook): boolean =>
		a.style === b.style && a.inverse === b.inverse && a.underline === b.underline;
	for (const g of graphemes(text, from, to)) {
		const l = look(g);
		if (l === null) continue;
		if (current === null || !same(current, l)) {
			if (current) shut(current);
			open(l);
			current = l;
		}
		out += g.text === "\t" ? " ".repeat(TAB_WIDTH) : g.text;
		width += g.width;
	}
	if (current) shut(current);
	return { out, width };
}

const PLAIN: CellLook = { style: undefined, inverse: false, underline: false };

/** A labeled range drawn as its label on a row, and the cells the label adds over the range's own. */
interface RowLabel {
	readonly style: Style;
	readonly label: string;
	readonly width: number;
	readonly grow: number;
}

/** The labeled `styles` drawn as their labels on `row` (see {@link EditorTermRange.label}); `caret` is -1 off the row. */
function rowLabels(
	text: string,
	styles: readonly Style[],
	row: EditorRow,
	caret: number,
	selection: { readonly from: number; readonly to: number } | null,
): RowLabel[] {
	const out: RowLabel[] = [];
	let end = row.start;
	for (const style of styles) {
		const { label, from, to } = style;
		if (label === undefined || from >= to || from < end || to > row.textEnd) continue;
		if (caret >= from && caret < to) continue;
		if (selection !== null && selection.from < to && selection.to > from) continue;
		let own = 0;
		for (const g of graphemes(text, from, to)) own += g.width;
		const width = visibleWidth(label);
		out.push({ style, label, width, grow: width - own });
		end = to;
	}
	return out;
}

/** Paint `row` (see {@link paintRun}) with each of `labels` drawn in place of its range. */
function paintRow(
	text: string,
	row: EditorRow,
	labels: readonly RowLabel[],
	look: (g: Grapheme) => CellLook | null,
	base: readonly [string, string],
): { out: string; width: number } {
	let out = "";
	let width = 0;
	let at = row.start;
	for (const { style, label, width: cells } of labels) {
		const run = paintRun(text, at, style.from, look, base);
		out += `${run.out}${style.open}${label}${style.close}${base[0]}`;
		width += run.width + cells;
		at = style.to;
	}
	const run = paintRun(text, at, row.textEnd, look, base);
	return { out: out + run.out, width: width + run.width };
}

/**
 * Paint an editable field. With `wrap: false` (an `input`) the text stays on
 * one row as wide as it is; the caller scrolls it horizontally.
 */
export function paintField(node: UiNode, cx: PaintContext, options?: { wrap?: boolean }): Block {
	const props = node.props() as EditorProps;
	const theme = cx.theme;
	const term = props.term;
	const text = props.text ?? "";
	const caret = caretOf(props);
	const focused = cx.focused(node);
	const editable = props.readonly !== true;

	const promptText = props.prompt === undefined ? "" : styledSpans(theme, props.prompt);
	const promptWidth = Math.min(visibleWidth(promptText), Math.max(0, cx.width - 1));
	const overflow = Math.max(0, term?.caretOverflow ?? 0);
	const room = Math.max(1, cx.width - promptWidth);
	const wrapWidth = options?.wrap === false ? Number.MAX_SAFE_INTEGER : Math.max(1, room - overflow);
	(node as WrapWidthHolder)[kWrapWidth] = wrapWidth;

	const rows = layoutField(node, text, wrapWidth);
	const caretRow = rowOf(rows, caret);
	const base = sgrPair(theme.fgResolved("text", MARK)) as [string, string];
	const styles = rangeStyles(
		theme,
		props,
		() => (cx.reduceMotion ? 0 : cx.now()),
		() => cx.hyperlinks,
	);

	const selection =
		term?.selection !== undefined
			? term.selection
			: props.anchor !== undefined && props.anchor !== null && props.anchor !== caret
				? { from: Math.min(props.anchor, caret), to: Math.max(props.anchor, caret) }
				: null;
	const caretMid = editable ? (term?.caret ?? "block") : "none";
	const caretEnd = editable ? (term?.caretEnd ?? "bar") : "none";

	// Visible window: every row, or `maxLines`/the fixed height around the caret.
	const limit = Math.min(props.maxLines ?? Number.POSITIVE_INFINITY, cx.height ?? Number.POSITIVE_INFINITY);
	let top = 0;
	if (rows.length > limit) {
		const stored = widgetState(node).get("scroll")?.() as number | undefined;
		top = Math.max(0, Math.min(stored ?? 0, rows.length - limit));
		if (caretRow < top) top = caretRow;
		else if (caretRow >= top + limit) top = caretRow - limit + 1;
	}
	const bottom = Math.min(rows.length, top + (Number.isFinite(limit) ? limit : rows.length));

	const placeholder =
		text === "" ? (term?.placeholder !== undefined ? term.placeholder : (props.placeholder ?? null)) : null;

	const out: string[] = [];
	let cursor: Cell | undefined;
	for (let r = top; r < bottom; r++) {
		const row = rows[r]!;
		const hasCaret = r === caretRow;
		const caretOnText = hasCaret && caret < row.textEnd;
		const styleAt = (at: number): Style | undefined => {
			for (const style of styles) {
				if (at < style.from || at >= style.to) continue;
				// A whole-only range cut by the row's end or by the caret drawn inside it shows plain.
				if (style.whole && (style.from < row.start || style.to > row.textEnd)) continue;
				if (style.whole && hasCaret && caret >= style.from && caret < style.to) continue;
				return style;
			}
			return undefined;
		};
		const selected = (at: number): boolean => selection !== null && at >= selection.from && at < selection.to;
		const look = (g: Grapheme): CellLook | null => {
			const style = styleAt(g.at);
			if (style?.hidden) return null;
			const sel = selected(g.at);
			const onCaret = caretOnText && g.at <= caret && caret < g.at + g.text.length;
			if (!style && !sel && !onCaret) return PLAIN;
			return {
				style,
				inverse: sel || (onCaret && caretMid === "block"),
				underline: !sel && onCaret && caretMid === "underline",
			};
		};
		let labels = rowLabels(text, styles, row, hasCaret ? caret : -1, selection);
		let { out: body, width } = paintRow(text, row, labels, look, base);
		// A label the row has no room for (the end-of-row caret included) shows the range's own characters.
		if (
			labels.length > 0 &&
			options?.wrap !== false &&
			(width > wrapWidth || (hasCaret && !caretOnText && width + 1 > room))
		) {
			labels = [];
			({ out: body, width } = paintRun(text, row.start, row.textEnd, look, base));
		}
		let tail = "";
		// The newline ending a selected line shows as one inverse blank.
		if (row.last && selected(row.end) && row.end < text.length) {
			tail += `${INVERSE_ON} ${INVERSE_OFF}`;
			width += 1;
		}
		if (hasCaret && !caretOnText && caretEnd !== "none" && !(selection && selected(row.end))) {
			if (caretEnd === "block") {
				tail += `${INVERSE_ON} ${INVERSE_OFF}`;
				width += 1;
			} else if (width + 1 <= room || options?.wrap === false) {
				tail += term?.caretGlyph ?? BAR;
				width += 1;
			} else {
				// No cell left for the bar: the last grapheme carries the caret.
				const lastAt = graphemes(text, row.start, row.textEnd).at(-1)?.at;
				if (lastAt !== undefined) {
					({ out: body, width } = paintRow(
						text,
						row,
						labels,
						g => {
							const l = look(g);
							return l && g.at === lastAt ? { ...l, inverse: true } : l;
						},
						base,
					));
				}
			}
		}
		if (hasCaret && caret >= row.textEnd && r === rows.length - 1) {
			if (placeholder !== null && placeholder !== "") {
				const label = styledSpans(theme, placeholder);
				// An unwrapped field (`input`) lays out unbounded: right-align against the cells it shows.
				const fieldWidth = Math.min(wrapWidth, Math.max(1, room - overflow));
				const gap = fieldWidth - width - visibleWidth(plainText(placeholder));
				if (gap >= 1) {
					tail += `${" ".repeat(gap)}${label}${base[0]}`;
					width = fieldWidth;
				}
			} else if (props.ghost) {
				const ghost = truncate(props.ghost, Math.max(0, wrapWidth - width), "");
				if (ghost) {
					tail += `${theme.style("dim", ghost)}${base[0]}`;
					width += visibleWidth(ghost);
				}
			}
		}
		const lead = promptWidth === 0 ? "" : r === 0 ? truncate(promptText, promptWidth, "") : " ".repeat(promptWidth);
		out.push(`${lead}${base[0]}${body}${tail}${base[1]}`);
		if (hasCaret && focused) {
			let col = promptWidth + columnOf(text, row, caret);
			for (const { style, grow } of labels) if (style.to <= caret) col += grow;
			cursor = { row: r - top, col };
		}
	}
	return { rows: out, ...(cursor ? { cursor } : {}) };
}

definePainter("editor", (node, cx) => paintField(node, cx));
