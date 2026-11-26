/**
 * The shared cell model of styled terminal text: width, slicing, truncation,
 * padding and wrapping.
 *
 * Widths follow UAX#11 with ambiguous-width characters narrow, plus the
 * corrections terminals need: escape sequences are zero-width (SGR, OSC 8,
 * APC and DCS graphics, tmux passthrough), a tab is `TAB_WIDTH` cells, an
 * OSC 66 text-sizing span is its declared width times its scale, and Hangul
 * Compatibility Jamo follow the runtime profile (`setJamoWidth`). Slicing,
 * truncation and wrapping run on the native width engine; `visibleWidth`
 * measures in JS and stays in exact parity with it.
 */
import {
	Ellipsis,
	setHangulCompatJamoWidthOverride,
	sliceWithWidth,
	truncateToWidth,
	visibleWidth as nativeVisibleWidth,
	wrapTextWithAnsi,
} from "@oh-my-pi/pi-natives";
import { DEFAULT_TAB_WIDTH } from "@oh-my-pi/pi-utils";
import { escapeLength, SgrState, stripEscapes, tokens } from "./ansi";

/** Cells one tab occupies. */
export const TAB_WIDTH = DEFAULT_TAB_WIDTH;

const TAB_SPACES = " ".repeat(TAB_WIDTH);
const RESET = "\x1b[0m";

// ─── Hangul Compatibility Jamo profile ──────────────────────────────────────

/**
 * How wide the terminal draws Hangul Compatibility Jamo (U+3131–U+318E):
 * the platform default, plain Unicode width, or a probed 1 or 2 cells.
 */
export type JamoWidth = "platform" | "unicode" | 1 | 2;

const JAMO = /[\u3131-\u318e]/;
const JAMO_FILLER = 0x3164;

let jamoProfile: JamoWidth = "platform";
let widthConfig = 0;
/** Cells of a visible jamo and of the filler under the current profile (read from the native engine). */
let jamoCells = 0;
let fillerCells = 0;

function syncJamo(): void {
	// Wire encoding: 0 = platform default, 1 = narrow, 2 = wide, 3 = unicode.
	setHangulCompatJamoWidthOverride(jamoProfile === "unicode" ? 3 : jamoProfile === "platform" ? 0 : jamoProfile);
	jamoCells = nativeVisibleWidth("\u3141", TAB_WIDTH);
	fillerCells = nativeVisibleWidth("\u3164", TAB_WIDTH);
}
syncJamo();

/** The active jamo profile. */
export function jamoWidth(): JamoWidth {
	return jamoProfile;
}

/** Switch the jamo profile (for measuring and the native engine); true when it changed. */
export function setJamoWidth(width: JamoWidth): boolean {
	if (width === jamoProfile) return false;
	jamoProfile = width;
	widthConfig++;
	syncJamo();
	return true;
}

/**
 * Bumped whenever a width-affecting setting changes: caches of measured
 * widths stamp it and drop entries from an older configuration.
 */
export function widthEpoch(): number {
	return widthConfig;
}

// ─── Measuring ──────────────────────────────────────────────────────────────

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
const OSC66 = "\x1b]66;";

/** Cells of an OSC 66 span: its `w=` (else its payload's width) times its `s=` scale. */
function sizedWidth(span: string): number {
	const body = span.slice(OSC66.length, span.endsWith("\x07") ? -1 : -2);
	const split = body.indexOf(";");
	if (split < 0) return 0;
	let scale = 1;
	let declared: number | undefined;
	for (const field of body.slice(0, split).split(":")) {
		if (field.startsWith("s=")) scale = Number(field.slice(2)) || 1;
		else if (field.startsWith("w=")) declared = Number(field.slice(2));
	}
	const payload = body.slice(split + 1);
	return scale * (declared !== undefined && Number.isFinite(declared) ? declared : visibleWidth(payload));
}

/** Cells `text` occupies on a terminal row. */
export function visibleWidth(text: string): number {
	if (PRINTABLE_ASCII.test(text)) return text.length;
	// Most styled rows are printable ASCII between complete escape sequences (prose, code): one
	// cell per character. Anything else (wide or combining text, tabs, controls, OSC 66 spans,
	// incomplete escapes) is measured in full.
	let width = 0;
	let start = 0;
	for (let i = text.indexOf("\x1b"); i !== -1; i = text.indexOf("\x1b", i)) {
		const length = text.startsWith(OSC66, i) ? 0 : escapeLength(text, i);
		if (length === 0) return measureWidth(text);
		if (i > start) {
			const run = text.slice(start, i);
			if (!PRINTABLE_ASCII.test(run)) return measureWidth(text);
			width += run.length;
		}
		i += length;
		start = i;
	}
	if (start === 0) return measureWidth(text);
	const run = text.slice(start);
	if (!PRINTABLE_ASCII.test(run)) return measureWidth(text);
	return width + run.length;
}

function measureWidth(text: string): number {
	let measured = text;
	let sized = 0;
	if (text.includes("\x1b")) {
		// `Bun.stringWidth` misreads string escapes (APC/DCS payloads count as
		// text, OSC 66 payloads vanish): drop every complete escape and add
		// OSC 66 spans back by their metadata.
		measured = "";
		let start = 0;
		for (let i = text.indexOf("\x1b"); i !== -1; i = text.indexOf("\x1b", i)) {
			const length = escapeLength(text, i);
			if (length === 0) {
				i++;
				continue;
			}
			if (i > start) measured += text.slice(start, i);
			if (text.startsWith(OSC66, i)) sized += sizedWidth(text.slice(i, i + length));
			i += length;
			start = i;
		}
		if (start < text.length) measured += text.slice(start);
	}
	let width = Bun.stringWidth(measured, { countAnsiEscapeCodes: false, ambiguousIsNarrow: true }) + sized;
	if (measured.includes("\t")) {
		for (let i = measured.indexOf("\t"); i !== -1; i = measured.indexOf("\t", i + 1)) width += TAB_WIDTH;
	}
	if (JAMO.test(measured)) {
		// `Bun.stringWidth` draws every compatibility jamo (the filler included) wide.
		for (let i = 0; i < measured.length; i++) {
			const code = measured.charCodeAt(i);
			if (code < 0x3131 || code > 0x318e) continue;
			width += (code === JAMO_FILLER ? fillerCells : jamoCells) - 2;
		}
	}
	return width;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** One grapheme, or one escape sequence, of styled text. */
export interface Piece {
	readonly text: string;
	/** Cells; 0 for escape sequences, the declared width for an OSC 66 span. */
	readonly width: number;
	readonly escape: boolean;
}

/** Split styled text into escape sequences (OSC 66 spans whole, sized) and graphemes. */
export function pieces(text: string): Piece[] {
	const out: Piece[] = [];
	for (const token of tokens(text)) {
		if (token.escape) {
			const sized = token.text.startsWith(OSC66);
			out.push({ text: token.text, width: sized ? sizedWidth(token.text) : 0, escape: !sized });
			continue;
		}
		for (const { segment } of segmenter.segment(token.text)) {
			out.push({ text: segment, width: visibleWidth(segment), escape: false });
		}
	}
	return out;
}

// ─── Slicing ────────────────────────────────────────────────────────────────

/** A column slice of styled text. */
export interface Slice {
	readonly text: string;
	/** Cells the slice occupies. */
	readonly width: number;
}

/**
 * `length` cells of `text` from column `start`, keeping the escape sequences
 * in effect there. `strict` drops a wide grapheme straddling either edge;
 * otherwise it is kept whole. OSC 66 spans are kept whole or cut to plain text.
 */
export function sliceCells(text: string, start: number, length: number, strict = true): Slice {
	if (length <= 0) return { text: "", width: 0 };
	return sliceWithWidth(text, Math.max(0, start), length, strict, TAB_WIDTH);
}

/** The columns `[start, end)` of styled text; styles left open are reset. */
export function sliceColumns(text: string, start: number, end: number): string {
	const slice = sliceCells(text, start, end - start).text;
	return slice.includes("\x1b[") && !new SgrState().feed(slice).plain ? `${slice}${RESET}` : slice;
}

// ─── Truncation ─────────────────────────────────────────────────────────────

function nativeEllipsis(ellipsis: string): Ellipsis | undefined {
	if (ellipsis === "…") return Ellipsis.Unicode;
	if (ellipsis === "...") return Ellipsis.Ascii;
	if (ellipsis === "") return Ellipsis.Omit;
	return undefined;
}

/**
 * The native engine resets every attribute before its ellipsis, which on a
 * tinted row also drops the background under the ellipsis and the padding:
 * re-open the background there.
 */
function keepBackground(text: string, cut: string, ellipsis: string): string {
	if (cut.startsWith(text) || !text.includes("\x1b[")) return cut;
	const marker = `${RESET}${ellipsis}`;
	const at = cut.lastIndexOf(marker);
	if (at < 0) return cut;
	const tail = cut.slice(at + marker.length);
	if ((ellipsis === "" && tail === "") || !/^ *$/.test(tail)) return cut;
	const head = cut.slice(0, at);
	const background = new SgrState().feed(head).background;
	return background === undefined ? cut : `${head}${RESET}${background}${ellipsis}${tail}\x1b[49m`;
}

/**
 * `text` cut to at most `width` cells, ending in `ellipsis` when cut (the
 * ellipsis counts toward the width; `""` omits it). Styles are reset before
 * the ellipsis, the row background is kept. `pad` fills to exactly `width`.
 */
export function truncate(text: string, width: number, ellipsis = "…", pad = false): string {
	const cells = Math.max(0, Math.trunc(width));
	// No UTF-16 unit is wider than 3 cells; OSC 66 spans are sized by metadata.
	if (!pad && text.length * 3 <= cells && !text.includes(OSC66)) return text;
	const kind = nativeEllipsis(ellipsis);
	if (kind !== undefined) return keepBackground(text, truncateToWidth(text, cells, kind, pad, TAB_WIDTH), ellipsis);
	// A custom ellipsis: cut without one, then append it.
	const textWidth = visibleWidth(text);
	if (textWidth <= cells) return pad ? `${text}${spaces(cells - textWidth)}` : text;
	const ellipsisWidth = visibleWidth(ellipsis);
	if (ellipsisWidth > cells) return pad ? spaces(cells) : "";
	const head = truncateToWidth(text, cells - ellipsisWidth, Ellipsis.Omit, false, TAB_WIDTH);
	const out = `${head}${ellipsis}`;
	return pad ? `${out}${spaces(cells - visibleWidth(out))}` : out;
}

/** `text` cut to at most `width` cells keeping its end, led by `ellipsis` when cut. */
export function truncateStart(text: string, width: number, ellipsis = "…"): string {
	const cells = Math.max(0, Math.trunc(width));
	const textWidth = visibleWidth(text);
	if (textWidth <= cells) return text;
	const ellipsisWidth = visibleWidth(ellipsis);
	if (ellipsisWidth > cells) return "";
	const keep = cells - ellipsisWidth;
	return `${ellipsis}${sliceCells(text, textWidth - keep, keep).text}`;
}

/** `text` cut to at most `width` cells keeping both ends around `ellipsis` (the end gets the odd cell). */
export function truncateMiddle(text: string, width: number, ellipsis = "…"): string {
	const cells = Math.max(0, Math.trunc(width));
	const textWidth = visibleWidth(text);
	if (textWidth <= cells) return text;
	const ellipsisWidth = visibleWidth(ellipsis);
	if (ellipsisWidth > cells) return "";
	const tailWidth = Math.ceil((cells - ellipsisWidth) / 2);
	const headWidth = cells - ellipsisWidth - tailWidth;
	const head = sliceColumns(text, 0, headWidth);
	return `${head}${ellipsis}${sliceCells(text, textWidth - tailWidth, tailWidth).text}`;
}

// ─── Padding and alignment ──────────────────────────────────────────────────

/** Runs of spaces by length, built on first use (rows pad to the terminal width over and over). */
const SPACE_RUNS: string[] = [""];
const MAX_SPACE_RUN = 512;

/** `count` spaces. */
export function spaces(count: number): string {
	if (count <= 0) return "";
	if (count > MAX_SPACE_RUN) return " ".repeat(count);
	return (SPACE_RUNS[count] ??= " ".repeat(count));
}

/** `text` padded with spaces to exactly `width` cells (cut first when wider). */
export function padTo(text: string, width: number): string {
	const textWidth = visibleWidth(text);
	if (textWidth === width) return text;
	return textWidth < width ? `${text}${spaces(width - textWidth)}` : truncate(text, width, "", true);
}

/** `text` placed in a field of `width` cells (cut with an ellipsis when wider). */
export function align(text: string, width: number, alignment: "left" | "center" | "right"): string {
	const textWidth = visibleWidth(text);
	if (textWidth >= width) return truncate(text, width);
	const free = width - textWidth;
	const left = alignment === "left" ? 0 : alignment === "right" ? free : Math.floor(free / 2);
	return `${spaces(left)}${text}${spaces(free - left)}`;
}

/** Tabs replaced by `TAB_WIDTH` spaces (terminal rows never carry raw tabs). */
export function replaceTabs(text: string): string {
	return text.includes("\t") ? text.replaceAll("\t", TAB_SPACES) : text;
}

// ─── Wrapping ───────────────────────────────────────────────────────────────

/**
 * Wrap styled text to `width` cells per row: by words, breaking between CJK
 * ideographs, hard-breaking words longer than a row. `\n` ends a row. Styles
 * open at a break are closed at the row end and re-opened at the next row's
 * start: underline, strikethrough and inverse video, which would otherwise paint
 * the row's padding. Colors stay open and carry into the padding.
 */
export function wrap(text: string, width: number): string[] {
	if (width <= 0) return [];
	return wrapTextWithAnsi(text, width, TAB_WIDTH);
}

/**
 * Hard-wrap styled text at exactly `width` columns, keeping every space and
 * never splitting a grapheme (one wider than `width` gets a row of its own).
 * An empty line stays one empty row.
 */
export function wrapChars(text: string, width: number): string[] {
	if (width <= 0) return [];
	const rows: string[] = [];
	for (const line of text.split("\n")) {
		const lineWidth = visibleWidth(line);
		if (lineWidth === 0) {
			rows.push(line);
			continue;
		}
		for (let column = 0; column < lineWidth;) {
			let slice = sliceCells(line, column, width, true);
			if (slice.width === 0) slice = sliceCells(line, column, width, false);
			rows.push(slice.text);
			column += Math.max(1, slice.width);
		}
	}
	return rows;
}

/** Leading spaces and tabs of styled text, in cells. */
function indentWidth(text: string): number {
	const plain = stripEscapes(text);
	let cells = 0;
	for (const char of plain) {
		if (char === " ") cells++;
		else if (char === "\t") cells += TAB_WIDTH;
		else break;
	}
	return cells;
}

/**
 * Wrap with a hanging indent: continuation rows line up under the first row's
 * text after its first `hang` cells (default: the line's own leading
 * whitespace). A hang wider than half the row falls back to `wrap`.
 */
export function wrapHanging(text: string, width: number, hang?: number): string[] {
	if (width <= 0) return [];
	const rows: string[] = [];
	for (const line of text.split("\n")) {
		const indent = hang ?? indentWidth(line);
		const lineWidth = indent > 0 ? visibleWidth(line) : 0;
		if (indent <= 0 || indent * 2 > width || lineWidth <= width) {
			rows.push(...wrap(line, width));
			continue;
		}
		const prefix = sliceCells(line, 0, indent, false);
		const body = sliceCells(line, prefix.width, lineWidth - prefix.width, false).text;
		rows.push(...wrapBeside(prefix.text, body, width));
	}
	return rows;
}

/**
 * `content` wrapped beside `prefix`: the first row starts with `prefix`, the
 * others with `continuation` (default: blank cells as wide as `prefix`).
 * Content gets the width the prefix leaves (at least one cell).
 */
export function wrapBeside(prefix: string, content: string, width: number, continuation?: string): string[] {
	const prefixWidth = visibleWidth(prefix);
	const next = continuation ?? spaces(prefixWidth);
	const rows = wrap(content, Math.max(1, width - Math.max(prefixWidth, visibleWidth(next))));
	if (rows.length === 0) return [prefix];
	return rows.map((row, index) => `${index === 0 ? prefix : next}${row}`);
}
