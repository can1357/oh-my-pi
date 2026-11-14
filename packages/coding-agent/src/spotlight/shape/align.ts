/**
 * Where shaped lines came from: each line of a shaped (or scored) text matched to the line of the original it is,
 * so per-line scores and the kept/hidden split can be reported over the original's own lines.
 */

/** A line the line cap shortened (`<first 280 chars> …[+N chars: line K]`): it stands for the original line it starts. */
const CAPPED = / …\[\+[\d,]+ chars: line \d+\]$/;
/** How far past the last match a capped line's original is looked for. */
const CAP_SCAN = 4_096;

/** Each distinct line of `base` and its indexes, ascending. */
export function lineIndex(base: readonly string[]): Map<string, number[]> {
	const index = new Map<string, number[]>();
	base.forEach((line, i) => {
		const hits = index.get(line);
		if (hits) hits.push(i);
		else index.set(line, [i]);
	});
	return index;
}

/** The first of the ascending `hits` at or after `from`, or -1. */
function firstFrom(hits: readonly number[], from: number): number {
	let lo = 0;
	let hi = hits.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (hits[mid] < from) lo = mid + 1;
		else hi = mid;
	}
	return lo < hits.length ? hits[lo] : -1;
}

/**
 * The first index at or after `from` of the `base` line that `line` is: equal to it, or capped from it. -1 for none.
 * `index` is {@link lineIndex} of `base`.
 */
export function matchLine(base: readonly string[], index: Map<string, number[]>, line: string, from: number): number {
	const hits = index.get(line);
	const at = hits ? firstFrom(hits, from) : -1;
	if (at >= 0) return at;
	const capped = CAPPED.exec(line);
	if (!capped) return -1;
	const head = line.slice(0, capped.index);
	const end = Math.min(base.length, from + CAP_SCAN);
	for (let j = from; j < end; j++) if (base[j].length > head.length && base[j].startsWith(head)) return j;
	return -1;
}

/**
 * The index in `base` of each of `lines`, matched in order (each match after the previous one), or null for a line
 * that is none of them (a marker, a note, a rewritten line). Shaping only drops and replaces runs of lines, so the
 * nearest equal line after the last match is the one a kept line was copied from.
 */
export function alignLines(
	base: readonly string[],
	lines: readonly string[],
	index: Map<string, number[]> = lineIndex(base),
): (number | null)[] {
	const out = Array.from<number | null>({ length: lines.length }).fill(null);
	let cursor = 0;
	for (let i = 0; i < lines.length; i++) {
		const at = matchLine(base, index, lines[i], cursor);
		if (at < 0) continue;
		out[i] = at;
		cursor = at + 1;
	}
	return out;
}
