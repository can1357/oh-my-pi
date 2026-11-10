/**
 * Splits a rendered form body into pages of a fixed row budget.
 *
 * The body arrives as atoms: unbreakable row runs (an option with its wrapped
 * label, a text field with its input, one line of a paragraph). Each atom ranks
 * how good a page break before it is; a page ends at the break that best
 * trades rank against the rows it leaves empty ({@link breakScore}), so a
 * section boundary wins unless it strands most of the page, and a break
 * never lands before a {@link BreakRank.Never} atom (a heading's first line,
 * a block's widow) unless nothing else fits.
 */

/** How good a page break before an atom is. */
export const enum BreakRank {
	/** Keep with the previous atom (the line after a heading, an error after its field). */
	Never = 0,
	/** Inside a block: between options of a group, lines of a paragraph. */
	Inside = 1,
	/** Between blocks of one section. */
	Block = 2,
	/** Between sections. */
	Section = 3,
}

/** One unbreakable run of body rows. */
export interface PageAtom {
	lines: readonly string[];
	/** Blank rows before this atom; dropped when the atom starts a page. */
	gap: number;
	breakRank: BreakRank;
	/** Title repeated atop a page that starts at this atom (`Database (cont.)`); costs one row. */
	continuation?: string;
}

/** Atoms `[start, end)` of one page. */
export interface Page {
	start: number;
	end: number;
}

/** Rows a page uses when it holds atoms `[start, end)`. */
export function pageHeight(atoms: readonly PageAtom[], start: number, end: number): number {
	let used = atoms[start]?.continuation !== undefined ? 1 : 0;
	for (let index = start; index < end; index++) {
		const atom = atoms[index]!;
		used += (index === start ? 0 : atom.gap) + atom.lines.length;
	}
	return used;
}

/**
 * Pack atoms into pages of at most `rows` rows. An atom taller than a page
 * gets a page of its own (the caller clips it). Always returns at least one page.
 */
export function paginate(atoms: readonly PageAtom[], rows: number): Page[] {
	const budget = Math.max(1, rows);
	const pages: Page[] = [];
	let start = 0;
	while (start < atoms.length) {
		// Greedy fill: the first atom always fits, however tall.
		let end = start + 1;
		while (end < atoms.length && pageHeight(atoms, start, end + 1) <= budget) end++;
		if (end < atoms.length) end = bestBreak(atoms, start, end, budget);
		pages.push({ start, end });
		start = end;
	}
	if (pages.length === 0) pages.push({ start: 0, end: 0 });
	return pages;
}

/**
 * Worth of ending a page with `used` of `budget` rows at a break of `rank`:
 * the rank's bonus minus the fraction left empty. A section break beats a
 * full page while it leaves under half the page empty; a block break, under a quarter.
 */
function breakScore(rank: BreakRank, used: number, budget: number): number {
	const bonus = rank === BreakRank.Section ? 0.5 : rank === BreakRank.Block ? 0.25 : 0;
	return bonus - (budget - used) / budget;
}

/**
 * Pick the break in `(start, end]` for a page that greedily filled up to `end`:
 * the allowed break with the best {@link breakScore} (latest on ties), else
 * `end` itself when every candidate is {@link BreakRank.Never}.
 */
function bestBreak(atoms: readonly PageAtom[], start: number, end: number, budget: number): number {
	let best = end;
	let bestScore = Number.NEGATIVE_INFINITY;
	for (let candidate = end; candidate > start; candidate--) {
		const rank = atoms[candidate]!.breakRank;
		if (rank === BreakRank.Never) continue;
		const score = breakScore(rank, pageHeight(atoms, start, candidate), budget);
		if (score > bestScore) {
			best = candidate;
			bestScore = score;
		}
	}
	return best;
}
