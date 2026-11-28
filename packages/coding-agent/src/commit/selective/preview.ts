/**
 * How `diff()` prints a patch.
 *
 * Tool output cuts every printed line at `tools.outputMaxColumns` bytes, wherever its change sits,
 * and two long lines that differ in a few words are hard to tell apart by eye. A long line edited
 * in place therefore prints once, as a `!` row: its changes in `git diff --word-diff` marks
 * (`[-removed-]`, `{+added+}`) with the unchanged text next to them, `…` standing for the rest.
 * Everything else prints as the patch has it.
 */
import { changedRegions } from "./attribution";

/** A changed line longer than this prints as a word row. Up to here no line reaches the default column cap. */
const WIDE_LINE = 240;
/** Unchanged characters a word row keeps on each side of a change. */
const WORD_CONTEXT = 40;
/**
 * Word comparisons one preview may spend aligning lines, about 0.2 s. Lines with nothing in
 * common cost the product of their word counts, so a rewritten minified file prints as the patch
 * has it instead of stalling the preview.
 */
const MAX_WORD_WORK = 2 ** 24;
const WORD_MARKS = ["[-", "-]", "{+", "+}"];
const NO_EOL_MARKER = "\\ No newline at end of file";
/** Hunk header as `formatTextPatch` prints it; the groups are the old and new line counts. */
const HUNK = /^@@ -\d+,(\d+) \+\d+,(\d+) @@$/;
let wordSegmenter: Intl.Segmenter | undefined;

/** `line` as words, spaces, and punctuation, with where each starts and where the line ends. */
function splitWords(line: string): { words: string[]; starts: number[] } {
	const words: string[] = [];
	const starts: number[] = [];
	wordSegmenter ??= new Intl.Segmenter("en", { granularity: "word" });
	for (const { segment, index } of wordSegmenter.segment(line)) {
		words.push(segment);
		starts.push(index);
	}
	starts.push(line.length);
	return { words, starts };
}

/** Characters `removed` and `added` take in a row once marked. */
function markedLength(removed: string, added: string): number {
	return (removed ? removed.length + 4 : 0) + (added ? added.length + 4 : 0);
}

/** Unchanged `text` cut to its first `left` and last `right` characters, `…` standing for the rest. */
function cutKept(text: string, left: number, right: number): string {
	let head = left;
	let tail = text.length - right;
	if (tail - head < 2) return text;
	// Never cut a surrogate pair in half.
	if ((text.charCodeAt(head - 1) & 0xfc00) === 0xd800) head--;
	if ((text.charCodeAt(tail) & 0xfc00) === 0xdc00) tail++;
	return `${text.slice(0, head)}…${text.slice(tail)}`;
}

/**
 * `!` row for `before` edited into `after`: every change marked, between the unchanged text next
 * to it. `null` when the pair reads better as two lines: no row fits `columns` bytes (0 = no
 * limit), the row would be longer than the longer line, text of the lines would read as a mark,
 * or `budget` cannot pay for aligning them.
 */
function wordRow(before: string, after: string, columns: number, budget: { work: number }): string | null {
	const old = splitWords(before);
	const now = splitWords(after);
	// Only the words between what both lines start and end with need aligning.
	const shorter = Math.min(old.words.length, now.words.length);
	let head = 0;
	while (head < shorter && old.words[head] === now.words[head]) head++;
	let tail = 0;
	while (tail < shorter - head && old.words[old.words.length - 1 - tail] === now.words[now.words.length - 1 - tail]) {
		tail++;
	}
	const oldMiddle = old.words.slice(head, old.words.length - tail);
	const newMiddle = now.words.slice(head, now.words.length - tail);
	const worst = oldMiddle.length * newMiddle.length;
	if (worst > budget.work) return null;
	const regions = changedRegions(oldMiddle, newMiddle);
	// Similar lines align in about as many steps as they have words, times the words that changed.
	let changed = 0;
	for (const region of regions) changed += region.i2 - region.i1 + region.j2 - region.j1;
	budget.work -= Math.min(worst, (oldMiddle.length + newMiddle.length) * changed);

	// `kept[n]` is the unchanged text before `changes[n]`; the last one ends the line.
	const kept: string[] = [];
	const changes: Array<[removed: string, added: string]> = [];
	let cursor = 0;
	for (const region of regions) {
		const oldStart = old.starts[head + region.i1];
		const gap = before.slice(cursor, oldStart);
		const removed = before.slice(oldStart, old.starts[head + region.i2]);
		const added = after.slice(now.starts[head + region.j1], now.starts[head + region.j2]);
		cursor = oldStart + removed.length;
		const last = changes.at(-1);
		// Two changes a few characters apart read better as one: merge them when that does not lengthen the row.
		if (
			last &&
			markedLength(last[0] + gap + removed, last[1] + gap + added) <=
				markedLength(last[0], last[1]) + gap.length + markedLength(removed, added)
		) {
			last[0] += gap + removed;
			last[1] += gap + added;
		} else {
			kept.push(gap);
			changes.push([removed, added]);
		}
	}
	kept.push(before.slice(cursor));

	const longer = Math.max(before.length, after.length);
	let marked = 1;
	for (const [removed, added] of changes) marked += markedLength(removed, added);
	// Nothing to mark, or the marked changes alone outgrow the line.
	if (changes.length === 0 || marked > longer) return null;
	const removals = changes.filter(([removed]) => removed).length;
	const additions = changes.filter(([, added]) => added).length;
	const marks = [removals, removals, additions, additions];
	// Unchanged text gives way until the row fits.
	for (let context = WORD_CONTEXT; ; context >>= 1) {
		let row = "!";
		changes.forEach(([removed, added], n) => {
			row += cutKept(kept[n], n > 0 ? context : 0, context);
			if (removed) row += `[-${removed}-]`;
			if (added) row += `{+${added}+}`;
		});
		row += cutKept(kept[changes.length], context, 0);
		if (
			row.length <= longer &&
			(columns <= 0 || Buffer.byteLength(row) <= columns) &&
			// Text of the lines that reads as a mark would make the row ambiguous.
			WORD_MARKS.every((mark, n) => row.split(mark).length - 1 === marks[n])
		) {
			return row;
		}
		if (context === 0) return null;
	}
}

/**
 * `patch` (unified, as `formatTextPatch` prints it) as `diff()` shows it to a reader whose tool
 * cuts printed lines at `columns` bytes (0 = never): a line longer than `WIDE_LINE` edited in
 * place prints as one {@link wordRow} where that reads better than its two lines. Returns `patch`
 * itself when no line does.
 */
export function formatPatchPreview(patch: string, columns: number): string {
	const lines = patch.split("\n");
	const view: string[] = [];
	const budget = { work: MAX_WORD_WORK };
	let folded = false;
	let index = 0;
	while (index < lines.length) {
		const hunk = HUNK.exec(lines[index]);
		view.push(lines[index++]);
		if (!hunk) continue;
		let oldLeft = Number(hunk[1]);
		let newLeft = Number(hunk[2]);
		while (oldLeft > 0 || newLeft > 0) {
			const start = index;
			if (lines[index]?.startsWith(" ")) {
				index++;
				oldLeft--;
				newLeft--;
				if (lines[index] === NO_EOL_MARKER) index++;
				for (let n = start; n < index; n++) view.push(lines[n]);
				continue;
			}
			// A changed block: its removed lines, then its added lines.
			while (oldLeft > 0 && lines[index]?.startsWith("-")) {
				index++;
				oldLeft--;
			}
			const removedEnd = index;
			const oldNoEol = lines[index] === NO_EOL_MARKER;
			if (oldNoEol) index++;
			const addedStart = index;
			while (newLeft > 0 && lines[index]?.startsWith("+")) {
				index++;
				newLeft--;
			}
			const addedEnd = index;
			const newNoEol = lines[index] === NO_EOL_MARKER;
			if (newNoEol) index++;
			// Not a hunk body as `formatTextPatch` prints it: show the patch as it is.
			if (index === start) return patch;
			// Only a block that replaces each line with one line pairs them up.
			const count = removedEnd - start === addedEnd - addedStart ? removedEnd - start : 0;
			// Pairs of the block printed so far.
			let shown = 0;
			for (let n = 0; n < count; n++) {
				// Each line holds its sign.
				if (lines[start + n].length <= WIDE_LINE + 1 && lines[addedStart + n].length <= WIDE_LINE + 1) continue;
				// A row stands for both lines, so both must end the same way.
				const unterminated = n === count - 1 && oldNoEol;
				if (unterminated !== (n === count - 1 && newNoEol)) continue;
				const row = wordRow(lines[start + n].slice(1), lines[addedStart + n].slice(1), columns, budget);
				if (row === null) continue;
				// Pairs without a row stay grouped as the patch has them: removed, then added.
				for (let m = shown; m < n; m++) view.push(lines[start + m]);
				for (let m = shown; m < n; m++) view.push(lines[addedStart + m]);
				view.push(row);
				if (unterminated) view.push(NO_EOL_MARKER);
				shown = n + 1;
				folded = true;
			}
			if (shown === 0) {
				for (let n = start; n < index; n++) view.push(lines[n]);
			} else if (shown < count) {
				for (let m = shown; m < count; m++) view.push(lines[start + m]);
				if (oldNoEol) view.push(NO_EOL_MARKER);
				for (let m = shown; m < count; m++) view.push(lines[addedStart + m]);
				if (newNoEol) view.push(NO_EOL_MARKER);
			}
		}
	}
	return folded ? view.join("\n") : patch;
}
