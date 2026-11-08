/**
 * Row-move planning for paints a terminal may present half-applied.
 *
 * Without synchronized output (DEC 2026) a terminal can show any prefix of a
 * frame's bytes. Repainting a viewport whose content shifted row by row,
 * top-down, then exposes rows already rewritten above rows that have not moved
 * yet, and the seam shows the shifted rows twice. Moving the surviving rows
 * with delete-line/insert-line first keeps every intermediate screen a
 * coherent, shifted copy of the previous frame, and leaves only the rows that
 * really changed to rewrite.
 *
 * Rows are integer keys: {@link BLANK_ROW} for an empty row,
 * {@link UNKNOWN_ROW} for committed history the planner does not model (never
 * matched, never moved), and any other value for one distinct line.
 */

/** Key of an empty row. */
export const BLANK_ROW = 0;
/** Key of a row whose content is not modeled; it matches nothing. */
export const UNKNOWN_ROW = -1;

/** `count` rows starting at screen row `from` move to start at `to`; the rows they vacate turn blank. */
export interface RowMove {
	readonly from: number;
	readonly to: number;
	readonly count: number;
}

/**
 * The band move that turns the most rows of `screen` into `target`, or
 * `undefined` when no move saves a row rewrite. Only rows at or below `base`
 * are moved or vacated. An upward move never lands on row 0: it deletes lines
 * at its destination, and Terminal.app archives lines deleted from the top row
 * into scrollback.
 */
export function findRowMove(screen: readonly number[], target: readonly number[], base: number): RowMove | undefined {
	const height = screen.length;
	// hits[r]: rows above r already matching in place; blanks[r]: rows above r
	// whose target is blank (a vacated row then matches).
	const hits = new Int32Array(height + 1);
	const blanks = new Int32Array(height + 1);
	for (let r = 0; r < height; r++) {
		hits[r + 1] = hits[r]! + (target[r] !== UNKNOWN_ROW && screen[r] === target[r] ? 1 : 0);
		blanks[r + 1] = blanks[r]! + (target[r] === BLANK_ROW ? 1 : 0);
	}
	let best: RowMove | undefined;
	let bestGain = 0;
	// Nearer shifts first, so a tie keeps the smaller move.
	for (let distance = 1; distance < height - base; distance++) {
		for (let sign = 1; sign >= -1; sign -= 2) {
			const shift = sign * distance;
			const first = shift > 0 ? Math.max(base, 1) : base + distance;
			const last = shift > 0 ? height - distance : height;
			let start = -1;
			let content = false;
			for (let r = first; r <= last; r++) {
				if (r < last && target[r] !== UNKNOWN_ROW && screen[r + shift] === target[r]) {
					if (start < 0) start = r;
					if (target[r] !== BLANK_ROW) content = true;
					continue;
				}
				if (start >= 0 && content) {
					const count = r - start;
					// Rows the move rewrites: its destination plus the band it vacates.
					const vacatedStart = shift > 0 ? r : start + shift;
					const vacatedEnd = shift > 0 ? r + shift : start;
					const gain =
						count -
						(hits[r]! - hits[start]!) +
						(blanks[vacatedEnd]! - blanks[vacatedStart]!) -
						(hits[vacatedEnd]! - hits[vacatedStart]!);
					if (gain > bestGain) {
						best = { from: start + shift, to: start, count };
						bestGain = gain;
					}
				}
				start = -1;
				content = false;
			}
		}
	}
	return best;
}

/** Apply `move` to a screen model, as {@link rowMoveSequence} applies it to the terminal. */
export function applyRowMove(screen: number[], move: RowMove): void {
	const { from, to, count } = move;
	const band = screen.slice(from, from + count);
	if (from < to) screen.fill(BLANK_ROW, from, to);
	else screen.fill(BLANK_ROW, to + count, from + count);
	for (let i = 0; i < count; i++) screen[to + i] = band[i]!;
}

/**
 * Terminal bytes performing `move` on a `height`-row screen with default
 * margins: rows outside the band and its vacated rows keep their place. Lines
 * inserted or deleted take the current background, so callers reset SGR first.
 */
export function rowMoveSequence(move: RowMove, height: number): string {
	const { from, to, count } = move;
	if (to < from) {
		const shift = from - to;
		const up = `\x1b[${to + 1};1H\x1b[${shift}M`;
		return from + count < height ? `${up}\x1b[${to + count + 1};1H\x1b[${shift}L` : up;
	}
	const shift = to - from;
	const down = `\x1b[${from + 1};1H\x1b[${shift}L`;
	return to + count < height ? `\x1b[${from + count + 1};1H\x1b[${shift}M${down}` : down;
}
