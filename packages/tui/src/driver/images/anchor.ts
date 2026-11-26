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
import { hasGraphics } from "../output/ansi";

/** A reserved image row. */
export const RESERVED_ROW = "\x1b[0m";

/**
 * Whether `row` reserves space for an image (possibly indented) or carries a graphics
 * sequence. Row trimmers keep these rows so the image stays anchored to its first row.
 */
export function holdsImage(row: string): boolean {
	return row.trim() === RESERVED_ROW || hasGraphics(row);
}

/** `rows` rows drawing `sequence` from the first one. A single row is the bare sequence. */
export function anchoredRows(sequence: string, rows: number): string[] {
	const height = Math.max(1, rows);
	const out: string[] = Array.from({ length: height - 1 }, () => RESERVED_ROW);
	out.push(height === 1 ? sequence : `\x1b7\x1b[${height - 1}A${sequence}\x1b8`);
	return out;
}

/**
 * Rows an anchored image's draw row moves up over (its reserved rows, see
 * {@link anchoredRows}), however the rows were decorated (tinted, indented);
 * 0 for any other row. Row trimmers keep those rows with it, or drop them all.
 */
export function anchoredRise(row: string): number {
	if (!hasGraphics(row)) return 0;
	const up = /\x1b7\x1b\[(\d+)A/.exec(row);
	return up ? Number(up[1]) : 0;
}

/** `rows` reserved rows (an image whose pixels are not ready yet). */
export function reservedRows(rows: number): string[] {
	return Array.from({ length: Math.max(1, rows) }, () => RESERVED_ROW);
}
