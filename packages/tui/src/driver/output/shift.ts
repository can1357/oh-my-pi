/**
 * Row moves for terminals without synchronized output.
 *
 * Such a terminal may show any prefix of a frame's bytes, so a frame whose
 * rows moved must not repaint through them (a row would show beside its
 * stale copy). Instead the rows that survive are shifted into place with
 * DL/IL, and only rows that still differ are rewritten: every intermediate
 * screen is the previous one shifted, never a duplicate.
 */

/** One step on a screen region (rows relative to the region top). */
export type ShiftStep =
	/** Delete `count` lines at `row` (rows below move up, blanks enter at the bottom). */
	| { readonly kind: "delete"; readonly row: number; readonly count: number }
	/** Insert `count` blank lines at `row` (rows below move down, the bottom ones fall off). */
	| { readonly kind: "insert"; readonly row: number; readonly count: number }
	/** Blank `row`: a stale copy of a row about to be written elsewhere. */
	| { readonly kind: "clear"; readonly row: number }
	/** Write the target row. */
	| { readonly kind: "write"; readonly row: number };

/** Matched (current index, target index) pairs: a longest common subsequence of the non-blank rows. */
function matchRows(current: readonly string[], target: readonly string[]): [number, number][] {
	const n = current.length;
	const m = target.length;
	// LCS lengths of current[i..] and target[j..], flattened at i * (m + 1) + j.
	const lengths = new Uint16Array((n + 1) * (m + 1));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			lengths[i * (m + 1) + j] =
				current[i] !== "" && current[i] === target[j]
					? lengths[(i + 1) * (m + 1) + j + 1]! + 1
					: Math.max(lengths[(i + 1) * (m + 1) + j]!, lengths[i * (m + 1) + j + 1]!);
		}
	}
	const pairs: [number, number][] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (current[i] !== "" && current[i] === target[j]) {
			pairs.push([i, j]);
			i++;
			j++;
		} else if (lengths[(i + 1) * (m + 1) + j]! >= lengths[i * (m + 1) + j + 1]!) i++;
		else j++;
	}
	return pairs;
}

/**
 * Plan the steps from `current` to `target` (equal lengths: the region's
 * rows from its top to the screen bottom). With `topIsScreenTop` no line is
 * ever deleted at region row 0: some terminals (Terminal.app) archive a
 * line deleted on the screen's first row into scrollback; a row that must
 * move up to row 0 is deleted from below it and rewritten there instead.
 */
export function planShift(current: readonly string[], target: readonly string[], topIsScreenTop: boolean): ShiftStep[] {
	const length = target.length;
	// Simulated region: indexes into `current`, -1 for a blank row.
	const sim: number[] = current.map((_, index) => index);
	const steps: ShiftStep[] = [];
	const fill = (): void => {
		while (sim.length < length) sim.push(-1);
	};
	for (const [from, to] of matchRows(current, target)) {
		const at = sim.indexOf(from);
		if (at < 0) continue; // pushed off the bottom by an earlier insert
		if (at > to && to === 0 && topIsScreenTop) {
			// Delete rows 1..at (the row itself included); row 0 is rewritten below.
			sim.splice(1, at);
			fill();
			steps.push({ kind: "delete", row: 1, count: at });
		} else if (at > to) {
			sim.splice(to, at - to);
			fill();
			steps.push({ kind: "delete", row: to, count: at - to });
		} else if (at < to) {
			sim.splice(at, 0, ...Array.from({ length: to - at }, () => -1));
			sim.length = length;
			steps.push({ kind: "insert", row: at, count: to - at });
		}
	}
	const shown = (row: number): string => (sim[row]! < 0 ? "" : current[sim[row]!]!);
	for (let row = 0; row < length; row++) {
		const text = target[row]!;
		if (shown(row) === text) continue;
		// A stale copy of this text further down goes first, so it never shows twice.
		for (let other = row + 1; other < length && text !== ""; other++) {
			if (shown(other) === text && target[other] !== text) {
				steps.push({ kind: "clear", row: other });
				sim[other] = -1;
			}
		}
		steps.push({ kind: "write", row });
	}
	return steps;
}
