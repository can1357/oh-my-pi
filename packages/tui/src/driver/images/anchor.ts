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

/** The cursor move up to an image's first row, at the start of its sequence. */
const ANCHOR = /\x1b7\x1b\[(\d+)A/;
/** A whole anchored image: the move, the image, the cursor restore. */
const ANCHORED_IMAGE = /\x1b7\x1b\[\d+A[\s\S]*?\x1b8/;

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
	const up = ANCHOR.exec(row);
	return up ? Number(up[1]) : 0;
}

/** `rows` reserved rows (an image whose pixels are not ready yet). */
export function reservedRows(rows: number): string[] {
	return Array.from({ length: Math.max(1, rows) }, () => RESERVED_ROW);
}

/**
 * Leave out the image (reserving its row instead) of every row of `rows` from `start` to `end` whose
 * image starts more than `reach` rows above `start`: only the `reach` screen rows above `start` are the
 * ones the image was laid out on (a viewport cut the rest away, or they scrolled off the screen), so it
 * would draw over other rows. In place. `onCut` receives the original row for resize deduplication.
 */
export function dropCutImages(
	rows: string[],
	start: number,
	end = rows.length,
	reach = 0,
	onCut?: (row: number, original: string) => void,
): void {
	for (let row = start; row < end; row++) {
		const anchor = ANCHOR.exec(rows[row]!);
		if (anchor && row - Number(anchor[1]) < start - reach) {
			const original = rows[row]!;
			const replacement = original.replace(ANCHORED_IMAGE, RESERVED_ROW);
			if (replacement !== original) {
				rows[row] = replacement;
				onCut?.(row, original);
			}
		}
	}
}
