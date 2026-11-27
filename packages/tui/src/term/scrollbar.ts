/**
 * The fullscreen transcript's right edge: a marks lane (one tick per mark,
 * colored by its kind) beside a one-column scrollbar whose thumb moves in
 * eighths of a cell.
 *
 * Pure geometry and glyphs; term/fullscreen.ts draws them and maps clicks.
 */
import type { UiNode } from "../node";
import type { Theme } from "../theme/contract";
import type { ScrollMarkKind } from "./backend";

/** Thumb steps per cell. */
const EIGHTHS = 8;
const TRACK = "│";
const THUMB = "█";
/** Lower block elements by eighths filled from the bottom: index 1 is `▁`, 8 the full block. */
const LOWER_BLOCKS = " ▁▂▃▄▅▆▇█";
const MARK = "╶";
/** The mark of the turn being read. */
const CURRENT_MARK = "╺";

const MARK_COLORS: Readonly<Record<ScrollMarkKind, string>> = {
	running: "muted",
	success: "success",
	warning: "warning",
	error: "error",
};

/** Which kind a lane cell shows when several marks share it. */
const SEVERITY: Readonly<Record<ScrollMarkKind, number>> = { success: 0, running: 1, warning: 2, error: 3 };

/** The thumb's extent in track cells (multiples of 1/8): the whole track when everything fits. */
export interface ThumbRange {
	readonly start: number;
	readonly end: number;
}

// Independently implemented eighth-cell geometry and lower-block inversion:
// Textual scrollbar.py (MIT), and joshka/ratatui tui-widgets tui-scrollbar.
// https://github.com/Textualize/textual/blob/06dbeef4bb70fb718236aa418ed658ef4667a126/src/textual/scrollbar.py#L128-L185
// https://github.com/ratatui/tui-widgets/blob/b4e904b98ff02a800907f7a894054c3f49afff2d/tui-scrollbar/src/metrics.rs#L1-L38
/** The thumb of a `height`-cell track over `total` rows, `offset` of them scrolled past. */
export function thumbRange(total: number, height: number, offset: number): ThumbRange {
	if (height <= 0) return { start: 0, end: 0 };
	if (total <= height) return { start: 0, end: height };
	const track = EIGHTHS * height;
	const size = Math.max(EIGHTHS, Math.min(Math.floor((track * height) / total), track));
	const max = total - height;
	const position = Math.floor((Math.max(0, Math.min(offset, max)) * (track - size)) / max);
	return { start: position / EIGHTHS, end: (position + size) / EIGHTHS };
}

/** The scroll offset that puts the thumb's top `start` cells down the track (a drag). */
export function offsetForThumb(start: number, total: number, height: number): number {
	const thumb = thumbRange(total, height, 0);
	const travel = height - (thumb.end - thumb.start);
	if (travel <= 0) return 0;
	return Math.round((Math.max(0, Math.min(start, travel)) / travel) * (total - height));
}

/** A mark as the lane draws it. */
export interface LaneMark {
	/** Document row of the marked node (its first row). */
	readonly row: number;
	readonly node: UiNode;
	readonly kind: ScrollMarkKind;
	/** The turn being read: drawn heavier. */
	readonly current: boolean;
}

/**
 * Marks by lane cell: rows map one to one while everything fits, else spread
 * over the track. Marks sharing a cell keep the earliest one's place, the most
 * severe kind, and the current flag of any of them.
 */
export function markCells(marks: readonly LaneMark[], total: number, height: number): Map<number, LaneMark> {
	const cells = new Map<number, LaneMark>();
	if (height <= 0) return cells;
	for (const mark of marks) {
		const cell = total <= height ? mark.row : Math.round((mark.row / Math.max(1, total - 1)) * (height - 1));
		if (cell < 0 || cell >= height) continue;
		const previous = cells.get(cell);
		if (!previous) {
			cells.set(cell, mark);
			continue;
		}
		cells.set(cell, {
			row: previous.row,
			node: previous.node,
			kind: SEVERITY[mark.kind] > SEVERITY[previous.kind] ? mark.kind : previous.kind,
			current: previous.current || mark.current,
		});
	}
	return cells;
}

/** The marks lane glyph of a cell (a blank without a mark). */
export function markGlyph(theme: Theme, mark: LaneMark | undefined): string {
	if (!mark) return " ";
	return theme.fg(MARK_COLORS[mark.kind], mark.current ? CURRENT_MARK : MARK);
}

/**
 * The scrollbar glyph of track cell `row`: the track, the thumb, or one of its
 * edges in eighths. The top edge fills the cell's lower part (a lower block);
 * the bottom edge fills its upper part, drawn as the complementary lower block
 * in inverse video. `dragging` draws the thumb in its active color.
 */
export function scrollbarGlyph(theme: Theme, thumb: ThumbRange, row: number, dragging: boolean): string {
	const covered = Math.max(0, Math.min(row + 1, thumb.end) - Math.max(row, thumb.start));
	if (covered <= 0) return theme.fg("dim", TRACK);
	const color = dragging ? "accent" : "muted";
	if (covered >= 1) return theme.fg(color, THUMB);
	const eighths = Math.round(covered * EIGHTHS);
	if (thumb.start > row) return theme.fg(color, LOWER_BLOCKS[eighths]!);
	return theme.fg(color, `\x1b[7m${LOWER_BLOCKS[EIGHTHS - eighths]!}\x1b[27m`);
}
