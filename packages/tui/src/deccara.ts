/**
 * DECCARA rectangular-SGR background-fill optimizer.
 *
 * Kitty extends VT510 DECCARA ("Change Attributes in Rectangular Area") to all
 * SGR attributes, including background color, so a solid background panel can be
 * painted as a single rectangle escape instead of a full-width run of
 * background-styled spaces on every row (see kitty `docs/deccara.rst`):
 *
 *   <ESC>[2*x                 DECSACE: select rectangle change extent
 *   <ESC>[Pt;Pl;Pb;Pr;<sgr>$r DECCARA: apply <sgr> to rows Pt..Pb, cols Pl..Pr
 *   <ESC>[*x                  DECSACE: restore default extent
 *
 * Coordinates are 1-based and inclusive. This module is a pure, renderer-level
 * planner: it consumes the *final* ANSI strings the renderer would otherwise
 * write, strips the trailing background-padded spaces it can prove are safe to
 * drop, and returns the rectangles to emit in their place. It never mutates
 * component output and never decides which rows are scrollback-bound — those
 * concerns belong to the caller in `tui.ts`.
 */
import { visibleWidth } from "./utils";

/** Reset every attribute (SGR 0). Mirrors `tui.ts`'s per-line terminator. */
const SEGMENT_RESET = "\x1b[0m";

/** DECSACE — select the rectangle change extent so DECCARA fills a rectangle. */
export const DECSACE_RECT = "\x1b[2*x";
/** DECSACE — restore the default (stream) change extent. */
export const DECSACE_DEFAULT = "\x1b[*x";

/**
 * Byte cost of the per-frame DECSACE wrapper ({@link DECSACE_RECT} +
 * {@link DECSACE_DEFAULT}) that brackets every rectangle batch. Charged once per
 * frame: a plan is emitted only when the trailing-space bytes it removes exceed
 * the rectangles' own bytes by more than this, so the optimizer never inflates.
 */
const DECSACE_WRAPPER_BYTES = DECSACE_RECT.length + DECSACE_DEFAULT.length;

/**
 * Encode a single DECCARA rectangle. `top`/`bottom` are 1-based inclusive screen
 * rows, `left`/`right` 1-based inclusive columns, `sgr` the raw SGR parameter
 * list to apply (e.g. `48;2;10;20;30`, `48;5;4`, `41`).
 */
export function encodeDeccara(top: number, left: number, bottom: number, right: number, sgr: string): string {
	return `\x1b[${top};${left};${bottom};${right};${sgr}$r`;
}

/** Sentinel for a background form this optimizer refuses to reason about. */
const BAIL = Symbol("deccara-bail");
type BgState = string | null;

/**
 * Fold one SGR parameter list into the active background-color parameter string.
 * Returns the new background (`null` = default/no background) or {@link BAIL}
 * when the sequence contains a background form this optimizer will not reason
 * about (colon-form extended color, malformed params). Foreground and style
 * parameters are skipped; only background state is tracked.
 */
function nextBackground(bg: BgState, params: string): BgState | typeof BAIL {
	// CSI m with no parameters is SGR 0 (reset everything).
	if (params.length === 0) return null;
	const tokens = params.split(";");
	let result: BgState = bg;
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		// An empty parameter defaults to 0 (reset), matching terminal behavior.
		const n = token.length === 0 ? 0 : Number(token);
		if (!Number.isInteger(n)) return BAIL;
		if (n === 0 || n === 49) {
			result = null;
			continue;
		}
		if ((n >= 40 && n <= 47) || (n >= 100 && n <= 107)) {
			result = token;
			continue;
		}
		if (n === 48) {
			const mode = tokens[i + 1];
			if (mode === "5") {
				const idx = tokens[i + 2];
				if (idx === undefined) return BAIL;
				result = `48;5;${idx}`;
				i += 2;
				continue;
			}
			if (mode === "2") {
				const r = tokens[i + 2];
				const g = tokens[i + 3];
				const b = tokens[i + 4];
				if (r === undefined || g === undefined || b === undefined) return BAIL;
				result = `48;2;${r};${g};${b}`;
				i += 4;
				continue;
			}
			// Colon-form (`48:2:...`) collapses to a single non-integer token and is
			// rejected above; anything else following 48 is unexpected — bail.
			return BAIL;
		}
		if (n === 38) {
			// Foreground extended color: skip its sub-parameters, leave bg alone.
			const mode = tokens[i + 1];
			if (mode === "5") {
				i += 2;
				continue;
			}
			if (mode === "2") {
				i += 4;
				continue;
			}
			return BAIL;
		}
		// Every other parameter (foreground 30-39/90-97, styles) leaves bg alone.
	}
	return result;
}

/** Where to cut a fillable line and the background to paint over the remainder. */
export interface BgFillAnalysis {
	/** Byte index where droppable trailing background padding begins (0 = whole line). */
	cut: number;
	/** 0-based column where the trailing padding begins (DECCARA left = leftCol + 1). */
	leftCol: number;
	/** SGR parameter list of the background covering the trailing region. */
	bg: string;
}

/**
 * Decide whether `line` (a final, width-fit, reset-terminated ANSI string) is a
 * full-width background fill whose trailing padding can be replaced by a DECCARA
 * rectangle. Returns `null` unless it can *prove* the dropped bytes are literal
 * trailing spaces under a single, constant, non-default background span (or the
 * entire row is background-styled spaces).
 *
 * Conservative by construction: any OSC sequence (hyperlinks/images), any
 * non-SGR CSI, a partial row, an inconsistent or default trailing background, or
 * a malformed escape all yield `null` so the caller keeps the exact original.
 */
export function analyzeBgFillLine(line: string, width: number): BgFillAnalysis | null {
	if (width <= 0 || line.length === 0) return null;
	let i = 0;
	let col = 0;
	let bg: BgState = null;
	// Byte index / column immediately after the last non-space printable glyph.
	let nonSpaceEndByte = 0;
	let nonSpaceEndCol = 0;
	// Background covering the current trailing run of spaces, and whether that
	// trailing run has started. `null` is a real "default background" value, so
	// it cannot double as the uninitialized sentinel.
	let trailBg: BgState = null;
	let trailStarted = false;
	let trailConsistent = true;

	while (i < line.length) {
		if (line.charCodeAt(i) === 0x1b) {
			// Only CSI SGR (`\x1b[ ... m`) is tolerated. OSC, APC, and any other
			// CSI mean styled hyperlinks/images/cursor markers — refuse to touch.
			if (line.charCodeAt(i + 1) !== 0x5b) return null;
			let j = i + 2;
			while (j < line.length) {
				const c = line.charCodeAt(j);
				if (c >= 0x40 && c <= 0x7e) break;
				j++;
			}
			if (j >= line.length) return null; // unterminated CSI
			if (line.charCodeAt(j) !== 0x6d) return null; // non-SGR CSI (final byte != 'm')
			const next = nextBackground(bg, line.slice(i + 2, j));
			if (next === BAIL) return null;
			bg = next;
			i = j + 1;
			continue;
		}

		// Printable run up to the next escape.
		let j = i;
		while (j < line.length && line.charCodeAt(j) !== 0x1b) j++;
		const text = line.slice(i, j);
		let nonSpaceLen = text.length;
		while (nonSpaceLen > 0 && text.charCodeAt(nonSpaceLen - 1) === 0x20) nonSpaceLen--;

		if (nonSpaceLen > 0) {
			// Run carries a non-space glyph: the trailing region restarts after it.
			const nonSpaceWidth = visibleWidth(text.slice(0, nonSpaceLen));
			nonSpaceEndByte = i + nonSpaceLen;
			nonSpaceEndCol = col + nonSpaceWidth;
			// Spaces after the last non-space glyph in this same printable run sit
			// under the current bg. If there are none, the trailing region has not
			// started yet; a later SGR can still begin a uniform fill safely.
			if (nonSpaceLen < text.length) {
				trailBg = bg;
				trailStarted = true;
			} else {
				trailBg = null;
				trailStarted = false;
			}
			trailConsistent = true;
		} else if (text.length > 0) {
			// Whole run is spaces: it extends the trailing region. Track bg drift.
			if (!trailStarted) {
				trailBg = bg;
				trailStarted = true;
			} else if (bg !== trailBg) {
				trailConsistent = false;
			}
		}
		col += visibleWidth(text);
		i = j;
	}

	if (col !== width) return null; // not a full-width fill
	if (nonSpaceEndCol >= width) return null; // no trailing padding to drop
	if (!trailStarted || trailBg === null || !trailConsistent) return null; // default/mixed bg — nothing safe to paint
	return { cut: nonSpaceEndByte, leftCol: nonSpaceEndCol, bg: trailBg };
}

interface FillCandidate {
	left: number;
	right: number;
	bg: string;
	short: string;
	origLen: number;
}

/** Per-frame plan: the (possibly shortened) row strings and the DECCARA batch. */
export interface DeccaraPlan {
	/** Row strings to write, parallel to the input. Optimized rows are shortened. */
	texts: string[];
	/** DECSACE-wrapped rectangle batch to emit after the rows, or `""` if none. */
	sequence: string;
}

/**
 * Plan DECCARA rectangles for a contiguous block of visible rows.
 *
 * `lines[k]` is the final ANSI string for screen row `firstScreenRow + k`
 * (0-based). For each fillable row the trailing background padding is removed
 * (the row's cells are cleared/erased by the caller, then repainted by the
 * rectangle), and vertically adjacent rows with an identical left/right/bg span
 * coalesce into one rectangle. Rectangles are emitted only when they save more
 * bytes than they cost, so the result never exceeds the original byte count.
 */
export function planDeccaraFills(lines: string[], width: number, firstScreenRow = 0): DeccaraPlan {
	const n = lines.length;
	// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
	const texts: string[] = new Array(n);
	// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
	const candidates: (FillCandidate | null)[] = new Array(n);

	for (let k = 0; k < n; k++) {
		const line = lines[k];
		texts[k] = line;
		const analysis = analyzeBgFillLine(line, width);
		if (!analysis) {
			candidates[k] = null;
			continue;
		}
		// Cut at the last non-space glyph and re-close attributes. An all-space row
		// (cut 0) needs no styled text at all — the caller's erase plus the
		// rectangle paint it. A content row keeps its prefix and a fresh reset so
		// the inline background never bleeds past the row.
		const short = analysis.cut === 0 ? "" : line.slice(0, analysis.cut) + SEGMENT_RESET;
		candidates[k] = { left: analysis.leftCol + 1, right: width, bg: analysis.bg, short, origLen: line.length };
	}

	// Collect coalesced groups whose rectangle at least pays for its own bytes.
	// The DECSACE wrapper is a single per-frame cost, so it is charged once below
	// rather than amortized into each group (which would over-reject lone rows).
	interface Group {
		start: number;
		end: number;
		rect: string;
	}
	const groups: Group[] = [];
	let removedTotal = 0;
	let rectBytesTotal = 0;
	let k = 0;
	while (k < n) {
		const head = candidates[k];
		if (!head) {
			k++;
			continue;
		}
		// Extend the group over adjacent rows sharing the same fill span.
		let end = k;
		while (end + 1 < n) {
			const next = candidates[end + 1];
			if (!next || next.left !== head.left || next.right !== head.right || next.bg !== head.bg) break;
			end++;
		}
		const rect = encodeDeccara(firstScreenRow + k + 1, head.left, firstScreenRow + end + 1, head.right, head.bg);
		let removed = 0;
		for (let r = k; r <= end; r++) {
			const c = candidates[r];
			if (c) removed += c.origLen - c.short.length;
		}
		if (removed > rect.length) {
			groups.push({ start: k, end, rect });
			removedTotal += removed;
			rectBytesTotal += rect.length;
		}
		k = end + 1;
	}

	// Emit nothing unless the batch beats the original by more than the wrapper.
	if (groups.length === 0 || removedTotal - rectBytesTotal <= DECSACE_WRAPPER_BYTES) {
		return { texts, sequence: "" };
	}
	let sequence = DECSACE_RECT;
	for (const group of groups) {
		for (let r = group.start; r <= group.end; r++) {
			const c = candidates[r];
			if (c) texts[r] = c.short;
		}
		sequence += group.rect;
	}
	sequence += DECSACE_DEFAULT;
	return { texts, sequence };
}
