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

interface SpaceStyleState {
	bg: boolean;
	inverse: boolean;
	underline: boolean;
	strike: boolean;
	overline: boolean;
	link: boolean;
}

function isSpaceVisible(state: SpaceStyleState): boolean {
	return state.bg || state.inverse || state.underline || state.strike || state.overline || state.link;
}

function applySpaceSgr(state: SpaceStyleState, body: string): void {
	const params = body === "" ? ["0"] : body.split(";");
	for (let i = 0; i < params.length; i++) {
		const param = params[i]!;
		if (param.includes(":")) {
			const sub = param.split(":");
			const code = Number(sub[0]);
			if (code === 4) state.underline = Number(sub[1] ?? 1) !== 0;
			else if (code === 48) state.bg = true;
			continue;
		}
		const code = param === "" ? 0 : Number(param);
		if (code === 38 || code === 48 || code === 58) {
			if (code === 48) state.bg = true;
			const mode = Number(params[i + 1]);
			if (mode === 5) i += 2;
			else if (mode === 2) i += 4;
			else if (i + 1 < params.length) i += 1;
			continue;
		}
		switch (code) {
			case 0:
				state.bg = false;
				state.inverse = false;
				state.underline = false;
				state.strike = false;
				state.overline = false;
				break;
			case 4:
			case 21:
				state.underline = true;
				break;
			case 7:
				state.inverse = true;
				break;
			case 9:
				state.strike = true;
				break;
			case 24:
				state.underline = false;
				break;
			case 27:
				state.inverse = false;
				break;
			case 29:
				state.strike = false;
				break;
			case 49:
				state.bg = false;
				break;
			case 53:
				state.overline = true;
				break;
			case 55:
				state.overline = false;
				break;
			default:
				if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) state.bg = true;
		}
	}
}

/**
 * Strip trailing ASCII spaces that carry no visible cell styling (default background,
 * no inverse, underline, strikethrough, overline, or open OSC 8 hyperlink).
 * Rows containing only such spaces collapse to `""`.
 */
export function stripTrailingBlankSpaces(text: string): string {
	if (text.length === 0) return text;
	if (!text.includes("\x1b")) {
		return text.charCodeAt(text.length - 1) === 0x20 ? text.replace(TRAILING_SPACES, "") : text;
	}
	const state: SpaceStyleState = {
		bg: false,
		inverse: false,
		underline: false,
		strike: false,
		overline: false,
		link: false,
	};
	let hasVisible = false;
	let trailingSpaces = false;
	let cleanEnd = 0;
	let i = 0;
	const len = text.length;
	while (i < len) {
		const ch = text.charCodeAt(i);
		if (ch === 0x1b) {
			const next = i + 1 < len ? text.charCodeAt(i + 1) : -1;
			if (next === 0x5b) {
				// CSI: ESC [ params final
				let j = i + 2;
				while (j < len && (text.charCodeAt(j) < 0x40 || text.charCodeAt(j) > 0x7e)) j++;
				const end = j < len ? j + 1 : len;
				if (j < len && text.charCodeAt(j) === 0x6d) {
					// SGR (...m)
					applySpaceSgr(state, text.slice(i + 2, j));
				}
				if (hasVisible && !trailingSpaces) cleanEnd = end;
				i = end;
				continue;
			}
			if (next === 0x5d) {
				// OSC: ESC ] ... (BEL | ST)
				let j = i + 2;
				while (j < len) {
					const c = text.charCodeAt(j);
					if (c === 0x07) {
						j += 1;
						break;
					}
					if (c === 0x1b && j + 1 < len && text.charCodeAt(j + 1) === 0x5c) {
						j += 2;
						break;
					}
					j++;
				}
				const payload = text.slice(i + 2, j);
				if (payload.startsWith("8;")) {
					const secondSemi = payload.indexOf(";", 2);
					const uri = secondSemi >= 0 ? payload.slice(secondSemi + 1).replace(/(?:\x07|\x1b\\)$/, "") : "";
					state.link = uri.length > 0;
					if (hasVisible && !trailingSpaces) cleanEnd = j;
				} else if (payload.startsWith("66;") || payload.startsWith("1337;")) {
					// OSC 66 sized text and iTerm2 inline images draw visible cells.
					hasVisible = true;
					trailingSpaces = false;
					cleanEnd = j;
				} else if (hasVisible && !trailingSpaces) {
					cleanEnd = j;
				}
				i = j;
				continue;
			}
			if (next === 0x5f || next === 0x50) {
				// APC (Kitty graphics) or DCS (SIXEL): ESC (_|P) ... ST
				const st = text.indexOf("\x1b\\", i + 2);
				const end = st < 0 ? len : st + 2;
				hasVisible = true;
				trailingSpaces = false;
				cleanEnd = end;
				i = end;
				continue;
			}
			// Other 2-byte ESC sequence.
			const end = Math.min(len, i + 2);
			if (hasVisible && !trailingSpaces) cleanEnd = end;
			i = end;
			continue;
		}
		if (ch === 0x20 && !isSpaceVisible(state)) {
			trailingSpaces = true;
			i++;
			continue;
		}
		hasVisible = true;
		trailingSpaces = false;
		i++;
		cleanEnd = i;
	}
	if (!hasVisible) return "";
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
 * which an erase would clear).
 */
export function drawRow(row: string, width: number, covered = 0): string {
	// Under a scaled glyph a whitespace-only row (a container's indent) is a spacer: drawing spaces would erase it.
	if (row === "" || (covered > 0 && Bun.stripANSI(row).trim() === "")) {
		// A multicell (OSC 66) glyph from a row above spans these cells: erasing any of them erases the glyph.
		if (covered >= width) return "\r";
		if (covered > 0) return `\r${SGR_RESET}${right(covered)}${ERASE_LINE_RIGHT}`;
		return `\r${ERASE_LINE}`;
	}
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
