/**
 * The escape sequences the frame writer emits, and row normalization.
 *
 * Rows reach the screen width-fitted (never wider than the screen, so with
 * autowrap off nothing wraps or scrolls by accident), stripped of trailing
 * unstyled default-background spaces (so `drawRow` clears to EOL with EL0
 * instead of writing trailing spaces into the terminal cell buffer), and
 * closed (SGR reset, open OSC 8 hyperlink closed), so every row can be
 * rewritten on its own.
 */
import { SgrState, sgrParams, tokens } from "../../text/ansi";
import { textSizedRows } from "../../text/osc";
import { replaceTabs, truncate, visibleWidth } from "../../text/width";

export const CSI = "\x1b[";
/** Begin / end synchronized update (DEC 2026). */
export const SYNC_BEGIN = "\x1b[?2026h";
export const SYNC_END = "\x1b[?2026l";
export const AUTOWRAP_OFF = "\x1b[?7l";
export const AUTOWRAP_ON = "\x1b[?7h";
export const CURSOR_SHOW = "\x1b[?25h";
export const CURSOR_HIDE = "\x1b[?25l";
export const ALT_ENTER = "\x1b[?1049h";
export const ALT_LEAVE = "\x1b[?1049l";
/** Erase from the cursor to the end of the line. */
export const ERASE_LINE_RIGHT = "\x1b[K";
/** Erase from the start of the line through the cursor. */
export const ERASE_LINE_LEFT = "\x1b[1K";
/** Erase the whole line. */
export const ERASE_LINE = "\x1b[2K";
/** Erase from the cursor to the end of the screen. */
export const ERASE_DOWN = "\x1b[J";
/** Home, clear the screen, then clear scrollback (ED2 first: preserved-clear terminals push the screen into scrollback). */
export const CLEAR_ALL = "\x1b[H\x1b[2J\x1b[3J";
export const SGR_RESET = "\x1b[0m";
const HYPERLINK_CLOSE = "\x1b]8;;\x1b\\";

export const up = (n: number): string => (n > 0 ? `${CSI}${n === 1 ? "" : n}A` : "");
export const down = (n: number): string => (n > 0 ? `${CSI}${n === 1 ? "" : n}B` : "");
export const right = (n: number): string => (n > 0 ? `${CSI}${n === 1 ? "" : n}C` : "");
/** Cursor to 0-based column `col` of the current row. */
export const column = (col: number): string => `${CSI}${col + 1}G`;
/** Cursor to 0-based (`row`, `col`). */
export const position = (row: number, col: number): string => `${CSI}${row + 1};${col + 1}H`;
/** Delete `n` lines at the cursor row (rows below move up, blanks enter at the bottom). */
export const deleteLines = (n: number): string => (n > 0 ? `${CSI}${n === 1 ? "" : n}M` : "");
/** Insert `n` blank lines at the cursor row (rows below move down, the bottom ones fall off). */
export const insertLines = (n: number): string => (n > 0 ? `${CSI}${n === 1 ? "" : n}L` : "");

/** Sequences that draw graphics or sized text: rows carrying them are rewritten in place, never shifted. */
const GRAPHICS = /\x1b_G|\x1bP|\x1b\]1337;|\x1b\]66;/;

/** Whether `row` carries an image placement, SIXEL/iTerm2 data or OSC 66 sized text. */
export function hasGraphics(row: string): boolean {
	return row.includes("\x1b") && GRAPHICS.test(row);
}

const LINE_BREAKS = /[\r\n]/g;
const TRAILING_SPACES = / +$/;

/**
 * Strip trailing ASCII spaces that carry no visible cell styling (default background,
 * no inverse, underline, strikethrough, overline, or open OSC 8 hyperlink).
 * Rows containing only such spaces collapse to `""`, while escape-only rows with no
 * spaces (such as `RESERVED_ROW` for anchored images) are preserved verbatim.
 */
export function stripTrailingBlankSpaces(text: string): string {
	if (text.length === 0) return text;
	if (!text.includes("\x1b")) {
		return text.charCodeAt(text.length - 1) === 0x20 ? text.replace(TRAILING_SPACES, "") : text;
	}
	const sgr = new SgrState();
	let inLink = false;
	let hasVisible = false;
	let trailingSpaces = false;
	let sawUnstyledSpace = false;
	let cleanEnd = 0;
	let offset = 0;
	for (const token of tokens(text)) {
		const end = offset + token.text.length;
		if (token.escape) {
			const params = sgrParams(token.text);
			if (params !== undefined) {
				sgr.apply(params);
				if (hasVisible && !trailingSpaces) cleanEnd = end;
			} else if (token.text.startsWith("\x1b]8;")) {
				const payload = token.text.slice(2);
				const secondSemi = payload.indexOf(";", 2);
				const uri = secondSemi >= 0 ? payload.slice(secondSemi + 1).replace(/(?:\x07|\x1b\\)$/, "") : "";
				inLink = uri.length > 0;
				if (hasVisible && !trailingSpaces) cleanEnd = end;
			} else if (
				token.text.startsWith("\x1b]66;") ||
				token.text.startsWith("\x1b]1337;") ||
				token.text.startsWith("\x1b_") ||
				token.text.startsWith("\x1bP")
			) {
				// OSC 66 sized text, iTerm2 inline images, Kitty APC graphics, and SIXEL/tmux DCS draw visible cells.
				hasVisible = true;
				trailingSpaces = false;
				cleanEnd = end;
			} else if (hasVisible && !trailingSpaces) {
				cleanEnd = end;
			}
			offset = end;
			continue;
		}
		if (sgr.paintsBlank || inLink) {
			hasVisible = true;
			trailingSpaces = false;
			cleanEnd = end;
		} else {
			let lastNonSpace = token.text.length - 1;
			while (lastNonSpace >= 0 && token.text.charCodeAt(lastNonSpace) === 0x20) lastNonSpace--;
			if (lastNonSpace < 0) {
				trailingSpaces = true;
				sawUnstyledSpace = true;
			} else {
				hasVisible = true;
				if (lastNonSpace === token.text.length - 1) {
					trailingSpaces = false;
					cleanEnd = end;
				} else {
					trailingSpaces = true;
					sawUnstyledSpace = true;
					cleanEnd = offset + lastNonSpace + 1;
				}
			}
		}
		offset = end;
	}
	if (!hasVisible) return sawUnstyledSpace ? "" : text;
	return trailingSpaces ? text.slice(0, cleanEnd) : text;
}

/**
 * `row` as the writer puts it on screen: tabs expanded, line breaks dropped,
 * cut to `width` cells, trailing unstyled spaces stripped, styles and
 * hyperlinks closed at its end.
 */
export function normalizeRow(row: string, width: number): string {
	let text = replaceTabs(row);
	if (text.includes("\n") || text.includes("\r")) text = text.replace(LINE_BREAKS, "");
	if (visibleWidth(text) > width) text = truncate(text, width, "");
	text = stripTrailingBlankSpaces(text);
	if (!text.includes("\x1b")) return text;
	if (text.includes("\x1b[") && !text.endsWith(SGR_RESET)) text += SGR_RESET;
	if (text.lastIndexOf("\x1b]8;") > text.lastIndexOf(HYPERLINK_CLOSE)) text += HYPERLINK_CLOSE;
	return text;
}

/**
 * Bytes that draw normalized `row` from column 0 of the cursor row and
 * erase what an older, wider row left after it. A row filling the width
 * needs no erase (with autowrap off the cursor rests on the last cell,
 * which an erase would clear). A graphics row is erased before it is drawn:
 * its image covers cells past the cursor (an anchored image ends with the
 * cursor restored to the start of its last row), and an erase after it
 * would clear them.
 */
export function drawRow(row: string, width: number, covered = 0): string {
	// Under a scaled glyph a whitespace-only row (a container's indent) is a spacer: drawing spaces would erase it.
	if (row === "" || (covered > 0 && Bun.stripANSI(row).trim() === "")) {
		// A multicell (OSC 66) glyph from a row above spans these cells: erasing any of them erases the glyph.
		if (covered >= width) return "\r";
		if (covered > 0) return `\r${SGR_RESET}${right(covered)}${ERASE_LINE_RIGHT}`;
		return `\r${ERASE_LINE}`;
	}
	if (hasGraphics(row)) return `\r${ERASE_LINE}${row}`;
	return visibleWidth(row) >= width ? `\r${row}` : `\r${row}${ERASE_LINE_RIGHT}`;
}

/**
 * Cells of row `k` of `rows` covered by an OSC 66 scaled span on a row above
 * (the covering row's width), 0 when none reaches it.
 */
export function coveredCells(rows: readonly string[], k: number): number {
	for (let j = k - 1; j >= 0 && k - j < 8; j--) {
		const row = rows[j]!;
		if (!row.includes("\x1b]66;") || textSizedRows(row) <= k - j) continue;
		// Up to the end of the last scaled span: trailing padding after it covers nothing.
		const start = row.lastIndexOf("\x1b]66;");
		const st = row.indexOf("\x1b\\", start);
		const bel = row.indexOf("\x07", start);
		const end = st < 0 ? (bel < 0 ? row.length : bel + 1) : bel >= 0 && bel < st ? bel + 1 : st + 2;
		return visibleWidth(row.slice(0, end));
	}
	return 0;
}

/** Screen rows `row` takes once a terminal rewraps it at `columns`. */
export function reflowHeight(row: string, columns: number): number {
	const width = visibleWidth(Bun.stripANSI(row).trimEnd());
	return Math.max(1, Math.ceil(width / Math.max(1, columns)));
}
