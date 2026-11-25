/**
 * Rows for images drawn by one escape sequence at their top-left cell
 * (SIXEL, iTerm2, kitty without ids).
 *
 * The sequence rides on the image's last row: by the time that row is
 * written, the rows above exist on screen (and any scrolling they caused
 * has happened), so the row saves the cursor, moves up to the image's first
 * row, draws, and restores the cursor. The other rows are reserved: empty
 * but not blank (a reset), so nothing treats them as trimmable padding.
 */

/** A reserved image row. */
export const RESERVED_ROW = "\x1b[0m";

/** An image sequence: SIXEL (and any tmux-wrapped sequence) as DCS, a kitty placement as APC, iTerm2 as OSC 1337. */
const IMAGE_SEQUENCE = /\x1b(?:P|_G|\]1337;)/;

/**
 * Whether `row` is part of an image (reserved, or carrying its sequence): escape-only, yet not
 * blank. Row trimmers keep these rows, or the image loses its place on screen.
 */
export function holdsImage(row: string): boolean {
	return row === RESERVED_ROW || IMAGE_SEQUENCE.test(row);
}

/** `rows` rows drawing `sequence` from the first one. A single row is the bare sequence. */
export function anchoredRows(sequence: string, rows: number): string[] {
	const height = Math.max(1, rows);
	const out: string[] = Array.from({ length: height - 1 }, () => RESERVED_ROW);
	out.push(height === 1 ? sequence : `\x1b7\x1b[${height - 1}A${sequence}\x1b8`);
	return out;
}

/** `rows` reserved rows (an image whose pixels are not ready yet). */
export function reservedRows(rows: number): string[] {
	return Array.from({ length: Math.max(1, rows) }, () => RESERVED_ROW);
}
