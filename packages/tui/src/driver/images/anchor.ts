/**
 * Rows for images drawn by one escape sequence at their top-left cell
 * (SIXEL, iTerm2, kitty without ids).
 *
 * The sequence rides on the image's last row: by the time that row is
 * written, the rows above exist on screen (and any scrolling they caused
 * has happened), so the row saves the cursor, moves up to the image's first
 * row, draws, and restores the cursor. The other rows are reserved: empty
 * but not blank (a reset), so nothing treats them as trimmable padding.
 *
 * The image must fit on the screen: the cursor stops at the top row, so a
 * taller image would be drawn from there and scroll the terminal under the
 * frame. `TerminalImages` fits SIXEL and iTerm2 images within the screen's rows.
 * The rows above the last one must also be the image's own: a viewport that
 * cuts a block's head away leaves the image out ({@link dropCutImages}).
 */
import { hasGraphics } from "../output/ansi";

/** A reserved image row. */
export const RESERVED_ROW = "\x1b[0m";

/** Every whole anchored image of a row (the move, the image, the cursor restore), with its move's row count. */
const ANCHORED_IMAGES = /\x1b7\x1b\[(\d+)A[\s\S]*?\x1b8/g;

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
 * `rows` rows of `columns` blank cells; the last one, after its blanks, steps back over them and
 * draws `sequence` from the first row (cursor saved and restored, also for a single row, since
 * drawing moves the cursor), then steps forward again. The rows are as wide as they look, so other
 * text may share them (a thumbnail between a card's borders), and the blanks clear what was drawn
 * there before, which shows through the image's transparent pixels.
 */
export function anchoredCellRows(sequence: string, columns: number, rows: number): string[] {
	const height = Math.max(1, rows);
	const blank = " ".repeat(columns);
	const draw = height === 1 ? `\x1b7${sequence}\x1b8` : `\x1b7\x1b[${height - 1}A${sequence}\x1b8`;
	const out: string[] = Array.from({ length: height - 1 }, () => blank);
	out.push(`${blank}\x1b[${columns}D${draw}\x1b[${columns}C`);
	return out;
}

/** `rows` reserved rows (an image whose pixels are not ready yet). */
export function reservedRows(rows: number): string[] {
	return Array.from({ length: Math.max(1, rows) }, () => RESERVED_ROW);
}

/**
 * Leave out the image (reserving its row instead) of every row of `rows` from `start` to `end` whose
 * image starts more than `reach` rows above `start`: only the `reach` screen rows above `start` are the
 * ones the image was laid out on (a viewport cut the rest away, or they scrolled off the screen), so it
 * would draw over other rows. In place.
 */
export function dropCutImages(rows: string[], start: number, end = rows.length, reach = 0): void {
	for (let row = start; row < end; row++) {
		rows[row] = rows[row]!.replace(ANCHORED_IMAGES, (image, above: string) =>
			row - Number(above) < start - reach ? RESERVED_ROW : image,
		);
	}
}
