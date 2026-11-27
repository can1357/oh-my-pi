/**
 * The shaping cuts: runs of lines the agent has already seen, and windows of the lines Spotlight ranks highest within
 * a character budget. A window says why it showed or hid each line ({@link SpotlightReason}) and what it spent, for the result's
 * trace.
 */
import { reasonShows, type SpotlightReason } from "../../tools/details/spotlight";
import { MARKER, norm, pairKey } from "./lines";
import type { SourcePeak } from "./view";
import type { Seen } from "./state";

/** Lines inside runs of already-seen lines ({@link witnessedRuns}), and the first line of each run. */
export interface Witnessed {
	mask: boolean[];
	/** Back to back runs are two passages of the context: each collapses to a marker of its own. */
	starts: boolean[];
}

/**
 * Runs of ≥ `run` already-seen lines in the order the context holds them: each line came right after the one before
 * it in one text there (short lines inside a run count only so), and a run starts and ends on a seen line. A line
 * dropped, moved or changed between two passages splits them. A line `keep` marks never counts as seen and ends any
 * run it is in.
 */
export function witnessedRuns(lines: readonly string[], seen: Seen, run: number, keep?: readonly boolean[]): Witnessed {
	const mask = Array.from({ length: lines.length }, () => false);
	const starts = Array.from({ length: lines.length }, () => false);
	const keys = lines.map(norm);
	const open = (i: number) => !keep?.[i] && !MARKER.test(lines[i]);
	for (let i = 0; i < lines.length;) {
		if (!open(i) || !seen.lines.has(keys[i])) {
			i++;
			continue;
		}
		let last = i;
		let count = 1;
		// A pair names two lines of the context, so a line it reaches is seen or short.
		for (let j = i + 1; j < lines.length && open(j) && seen.pairs.has(pairKey(keys[j - 1], keys[j])); j++) {
			if (!seen.lines.has(keys[j])) continue;
			count++;
			last = j;
		}
		if (count >= run) {
			mask.fill(true, i, last + 1);
			starts[i] = true;
		}
		i = last + 1;
	}
	return { mask, starts };
}

/** Knobs of the valve window ({@link frameLines}). */
export interface WindowKnobs {
	budget: number;
	/** Lines shown on each side of a chosen line. */
	ctx: number;
	/** First and last lines always shown. */
	head: number;
	tail: number;
	/** Lines that may be chosen on their score (default: every open line); the frame and neighbours still show. */
	pick?: readonly boolean[];
	/** Peaks ranked in the original file, paired with their enclosing signature rows in this view. */
	source?: readonly SourcePeak[];
	/** Absent for unscored or uniform results, whose ordinary selection is final. */
	passages?: {
		peaks: readonly number[];
		named(line: number): boolean;
		/** Only unstructured results may spend extra space from the preview's savings. */
		previewChars?: number;
	};
}

/**
 * Which lines a window shows and why: `s` head, tail and markers, `a` chosen on its score, `c` a neighbour of a
 * chosen line or a lone gap filled, `b` hidden by the budget (`r`: already seen, never chosen). `used` is the
 * characters the window counted against its budget, `last` its last line chosen on score and what that cost.
 */
export interface Window {
	why: SpotlightReason[];
	budget: number;
	used: number;
	last?: { item: number; chars: number };
}

/** The density part shown in traces; the independent peak reserve uses the inspector's unsmoothed heat. */
export const DENSITY_PARTS = ["Spotlight ÷ length^¼"];

/** Ascending source-score order shared by peak selection and window density. */
export function scoreOrder(scores: readonly (number | null)[]): number[] {
	return [...scores.keys()].sort((a, b) => (scores[a] ?? 0) - (scores[b] ?? 0));
}

/** Density for the lexical window and its ascending score order, reused to find peaks without a second sort. */
export function rankLines(lines: readonly string[], scores: readonly (number | null)[]) {
	const order = scoreOrder(scores);
	const density = Array.from<number>({ length: lines.length });
	const denominator = Math.max(1, lines.length - 1);
	for (const [place, i] of order.entries()) {
		density[i] = lines[i].trim() ? place / denominator / (lines[i].length + 1) ** 0.25 : -1;
	}
	return { density, order };
}

/** One gap marker's cost, roughly. */
const FRAME_MARKER = 40;
/** A line of brackets and separators alone (`{`, `};`, `)`), after any read prefix (`12|`, `12:`): no context. */
const BARE = /^\s*(?:\d+(?:#\w+)?[|:])?\s*[{}()[\];,]+\s*$/;

/** Context around a line, looking through a brace to the signature it belongs to. */
function neighborhood(lines: readonly string[], i: number, reach = 1): [number, number] {
	if (!reach) return [i, i];
	let lo = Math.max(0, i - reach);
	let hi = Math.min(lines.length - 1, i + reach);
	while (lo > 0 && BARE.test(lines[lo])) lo--;
	while (hi + 1 < lines.length && BARE.test(lines[hi])) hi++;
	return [lo, hi];
}

/** Price of the visible text plus one marker per contiguous omission. */
function footprint(width: readonly number[], why: readonly SpotlightReason[]): number {
	let chars = 0;
	for (let i = 0; i < why.length; i++) {
		if (reasonShows(why[i])) chars += width[i] + 1;
		else if (i === 0 || reasonShows(why[i - 1])) chars += FRAME_MARKER;
	}
	return chars;
}

/**
 * The valve's frame within `budget`. `width[i]` is line i's shown size; lines with `skip` set (already seen) are never
 * chosen. The first and last open lines first, then best-first by `scores` with neighbours.
 */
export function frameLines(
	width: readonly number[],
	lines: readonly string[],
	skip: readonly boolean[],
	scores: readonly number[],
	k: WindowKnobs,
): Window {
	const n = lines.length;
	const why = Array.from({ length: n }, (_, i): SpotlightReason => (skip[i] ? "r" : "b"));
	const open = [...lines.keys()].filter(i => !skip[i]);
	let used = 0;
	let last: Window["last"];
	const take = (i: number, reason: SpotlightReason) => {
		if (why[i] !== "b") return;
		why[i] = reason;
		used += width[i] + 1;
	};
	for (const i of open.slice(0, k.head)) take(i, "s");
	for (const i of open.slice(-k.tail)) take(i, "s");
	const order = open
		.filter(i => why[i] === "b" && lines[i].trim() && k.pick?.[i] !== false)
		.sort((a, b) => scores[b] - scores[a] || a - b);
	for (const i of order) {
		if (why[i] !== "b") continue;
		let [lo, hi] = neighborhood(lines, i, k.ctx);
		let cost = FRAME_MARKER;
		for (let j = lo; j <= hi; j++) if (why[j] === "b") cost += width[j] + 1;
		if (used + cost > k.budget) {
			cost = width[i] + 1 + FRAME_MARKER;
			if (used + cost > k.budget) continue;
			lo = hi = i;
		}
		for (let j = lo; j <= hi; j++) take(j, j === i ? "a" : "c");
		used += FRAME_MARKER;
		last = { item: i, chars: cost };
		if (used >= k.budget) break;
	}
	fillSmallGaps(width, why);
	const compact: Window = { why, used, last, budget: k.budget };
	let chosen = compact;
	if (k.passages?.peaks.length) {
		const { peaks, named, previewChars } = k.passages;
		if (previewChars !== undefined && coverHotPassages(compact, lines, width, peaks, previewChars)) return compact;
		chosen = exchangePassages(compact, lines, width, scores, peaks, named);
	}
	if (k.source?.length) chosen = sourcePassages(chosen, lines, width, scores, k.source, k.passages?.peaks);
	if (chosen !== compact) {
		for (let i = 0; i < n; i++) if (skip[i] && chosen.why[i] === "b") chosen.why[i] = "r";
	}
	return chosen;
}

/**
 * The outline already paid for a skeleton. Exchange its visible text for source-ranked passages, buying the
 * center, its immediate neighbours and its enclosing declaration as one unit. Shared rows are charged once.
 */
function sourcePassages(
	compact: Window,
	lines: readonly string[],
	width: readonly number[],
	priority: readonly number[],
	peaks: readonly SourcePeak[],
	viewPeaks?: readonly number[],
): Window {
	const prior = compact.why;
	const n = prior.length;
	const bounds = (i: number): [number, number] => [Math.max(0, i - 1), Math.min(n - 1, i + 1)];
	const complete = (p: SourcePeak) => {
		const [lo, hi] = bounds(p.line);
		for (let i = lo; i <= hi; i++) if (prior[i] === "b") return false;
		for (let i = p.head; i <= p.headEnd; i++) if (!reasonShows(prior[i])) return false;
		return true;
	};
	if (peaks.every(complete)) return compact;

	const owner = new Map(peaks.map(p => [p.line, p]));
	const why = prior.map((r): SpotlightReason => (r === "r" ? "r" : "b"));
	let last: Window["last"];
	let used = FRAME_MARKER;
	let limit = compact.budget;
	// Price new rows and the change in the number of hidden runs, regardless of insertion order.
	const pending = new Map<number, SpotlightReason>();
	const offer = (lo: number, hi: number, center: number, source?: readonly SpotlightReason[]) => {
		pending.clear();
		// A source peak may also be restored as an incumbent seed: its qualifier is not optional there either.
		if (owner.has(center)) {
			const [before, after] = bounds(center);
			for (let j = before; j <= after; j++) if (why[j] === "b") pending.set(j, "c");
		}
		for (let i = lo; i <= hi; i++) {
			if (why[i] === "r" || (source && !reasonShows(source[i]))) continue;
			if (why[i] === "b") pending.set(i, source?.[i] ?? (i === center ? "a" : "c"));
		}
		// A neighbour may itself belong to a different declaration, or a signature may itself have scored hot.
		for (const i of pending.keys()) {
			const p = owner.get(i);
			if (p)
				for (let j = p.head; j <= p.headEnd; j++) {
					if (!reasonShows(why[j]) && !pending.has(j)) pending.set(j, "s");
				}
		}
		let cost = 0;
		for (const i of pending.keys()) {
			const left = i === 0 || reasonShows(why[i - 1]) || pending.has(i - 1);
			const right = i + 1 === n || reasonShows(why[i + 1]);
			cost += width[i] + 1 + (left === right ? (left ? -FRAME_MARKER : FRAME_MARKER) : 0);
		}
		if (used + cost > limit) return false;
		for (const [i, reason] of pending) why[i] = reason;
		if (pending.get(center) === "a") last = { item: center, chars: Math.max(width[center] + 1, cost) };
		used += cost;
		return true;
	};
	let visibleChars = 0;
	let gaps = 0;
	const retained: number[] = [];
	for (let i = 0; i < n; i++) {
		if (!reasonShows(prior[i])) {
			if (!i || reasonShows(prior[i - 1])) gaps++;
			continue;
		}
		visibleChars += width[i] + 1;
		retained.push(i);
		if (prior[i] === "s" || priority[i] >= 20) offer(i, i, i, prior);
	}
	// Fragmented source snippets need more gap markers. Pay those from the previous window's text allowance.
	limit = Math.max(used, Math.min(limit, visibleChars + gaps * (FRAME_MARKER / 2)));
	for (const p of peaks) if (complete(p)) offer(...bounds(p.line), p.line, prior);
	const bids: { line: number; price: number }[] = [];
	const bid = (line: number, head: number, headEnd: number) => {
		const [lo, hi] = bounds(line);
		let price = 0;
		for (let j = head; j <= headEnd; j++) if (!reasonShows(why[j])) price += width[j] + 1;
		for (let j = lo; j <= hi; j++) if ((j < head || j > headEnd) && why[j] === "b") price += width[j] + 1;
		if (price) bids.push({ line, price: bids.length ? price : 0 });
	};
	for (const p of peaks) bid(p.line, p.head, p.headEnd);
	for (const i of viewPeaks ?? []) if (!owner.has(i)) bid(i, i, i);
	for (const { line } of bids.sort((a, b) => a.price - b.price)) offer(...bounds(line), line);
	retained.sort((a, b) => Number(prior[b] === "a") - Number(prior[a] === "a") || priority[b] - priority[a]);
	for (const i of retained) {
		if (why[i] !== "b") continue;
		if (
			(MARKER.test(lines[i]) || prior[i] === "c") &&
			!(i > 0 && reasonShows(why[i - 1])) &&
			!(i + 1 < n && reasonShows(why[i + 1]))
		)
			continue;
		if (!offer(...neighborhood(lines, i, prior[i] === "a" ? 1 : 0), i, prior)) offer(i, i, i, prior);
	}
	return { why, last, used, budget: compact.budget };
}

/**
 * Complete missing peak passages by trading out ordinary text, not by growing the window. Keep the prior frame,
 * visible targets and already-shown context of visible peaks. At most half the priced window pays for new text;
 * any leftover space goes back to the compact selection, not unrelated new lines.
 */
function exchangePassages(
	initial: Window,
	lines: readonly string[],
	width: readonly number[],
	scores: readonly number[],
	peaks: readonly number[],
	named: (line: number) => boolean,
): Window {
	const prior = initial.why;
	const n = lines.length;
	const why = prior.map((reason): SpotlightReason => (reason === "r" ? "r" : "b"));
	const restore = (lo: number, hi: number) => {
		for (let j = lo; j <= hi; j++) if (reasonShows(prior[j])) why[j] = prior[j];
	};
	const retained: number[] = [];
	for (let i = 0; i < n; i++) {
		if (!reasonShows(prior[i])) continue;
		retained.push(i);
		if (named(i)) {
			why[i] = prior[i];
			if (prior[i] === "a") restore(...neighborhood(lines, i));
		} else if (prior[i] === "s") why[i] = "s";
	}
	const bids: { line: number; lo: number; hi: number; priority: number }[] = [];
	for (const line of peaks) {
		const [lo, hi] = neighborhood(lines, line);
		if (reasonShows(prior[line])) restore(lo, hi);
		let missing = 0;
		for (let j = lo; j <= hi; j++) if (prior[j] === "b") missing += width[j] + 1;
		// Give the highest-ranked missing passage first refusal; then prefer cheap completions, breaking ties by rank.
		if (missing) bids.push({ line, lo, hi, priority: bids.length ? missing : 0 });
	}
	if (!bids.length) return initial;
	const limit = Math.min(footprint(width, prior), initial.budget);
	let used = footprint(width, why);
	if (used >= limit) return initial;

	// Price just the new rows and the marker delta: splitting an omission adds one, closing one refunds it.
	const marginal = (lo: number, hi: number, source?: readonly SpotlightReason[]) => {
		let cost = 0;
		let previous = -2;
		for (let j = lo; j <= hi; j++) {
			if (why[j] !== "b" || (source && !reasonShows(source[j]))) continue;
			const left = j === 0 || previous === j - 1 || reasonShows(why[j - 1]);
			const right = j === n - 1 || reasonShows(why[j + 1]);
			cost += width[j] + 1 + (left === right ? (left ? -FRAME_MARKER : FRAME_MARKER) : 0);
			previous = j;
		}
		return cost;
	};
	let newChars = 0;
	let last = initial.last;
	for (const { line, lo, hi } of bids.sort((a, b) => a.priority - b.priority)) {
		let fresh = 0;
		for (let j = lo; j <= hi; j++) if (why[j] === "b" && prior[j] === "b") fresh += width[j] + 1;
		if (!fresh || newChars + fresh > limit / 2) continue;
		const cost = marginal(lo, hi);
		if (used + cost > limit) continue;
		newChars += fresh;
		used += cost;
		if (why[line] === "b") last = { item: line, chars: Math.max(width[line] + 1, cost) };
		for (let j = lo; j <= hi; j++) {
			if (why[j] === "b") why[j] = reasonShows(prior[j]) ? prior[j] : j === line ? "a" : "c";
		}
	}
	if (!newChars) return initial;
	retained.sort((a, b) => Number(prior[b] === "a") - Number(prior[a] === "a") || scores[b] - scores[a]);
	for (const i of retained) {
		if (reasonShows(why[i])) continue;
		// A context line whose whole passage is gone need not start a new island.
		if (prior[i] === "c" && !(i > 0 && reasonShows(why[i - 1])) && !(i + 1 < n && reasonShows(why[i + 1]))) continue;
		let [lo, hi] = neighborhood(lines, i, prior[i] === "a" ? 1 : 0);
		let cost = marginal(lo, hi, prior);
		if (used + cost > limit) {
			lo = hi = i;
			cost = marginal(i, i, prior);
			if (used + cost > limit) continue;
		}
		restore(lo, hi);
		used += cost;
	}
	return { why, used, budget: initial.budget, last: last && why[last.item] === "a" ? last : undefined };
}

/** Rendered width at which a missed peak justifies checking the larger allowance. */
const MIN_PEAK_WIDTH = 4 * FRAME_MARKER;
/** Delimiters may supply context; they do not qualify as independent evidence. */
const SEPARATOR = /^(?:```[\w-]*|[{}()[\];,.*|:=+\-•…`\s]*)$/;

/** An island containing nothing but gap decoration can be merged into the surrounding omission. */
const DECORATION = /^(?:\.{3}|…|- •|---)?$/;

/** Fold a shown island containing only dividers into its surrounding gap, after structural context is complete. */
export function foldDividers(window: Window, lines: readonly string[]): void {
	for (let i = 0; i < lines.length;) {
		if (!reasonShows(window.why[i])) {
			i++;
			continue;
		}
		let j = i;
		let empty = true;
		while (j < lines.length && reasonShows(window.why[j])) {
			if (empty && (window.why[j] === "s" || !DECORATION.test(lines[j].trim()))) empty = false;
			j++;
		}
		if (empty) {
			window.why.fill("b", i, j);
			if (window.last && window.last.item >= i && window.last.item < j) delete window.last;
		}
		i = j;
	}
}

/** Scorable, unseen content in the inspector's highest heat bucket; equal scores share a percentile. */
export function peakLines(
	lines: readonly string[],
	skip: readonly boolean[] | undefined,
	spot: readonly (number | null)[],
	order: readonly number[],
): number[] {
	const scored = order.filter(i => spot[i] !== null);
	const peaks: number[] = [];
	for (let end = scored.length; end > 0;) {
		let a = end - 1;
		while (a > 0 && spot[scored[a - 1]] === spot[scored[end - 1]]) a--;
		const rank = scored.length === 1 ? 1 : (a + end - 1) / (2 * (scored.length - 1));
		if (Math.round(9 * rank) !== 9) break;
		for (let j = a; j < end; j++) {
			const i = scored[j];
			if (skip?.[i] || MARKER.test(lines[i]) || SEPARATOR.test(norm(lines[i]))) continue;
			peaks.push(i);
		}
		end = a;
	}
	return peaks;
}

/** Try to cover every peak without evictions under the bounded large-preview allowance; leave no partial expansion. */
function coverHotPassages(
	window: Window,
	lines: readonly string[],
	width: readonly number[],
	peaks: readonly number[],
	previewChars: number,
): boolean {
	if (!peaks.some(i => window.why[i] === "b" && width[i] >= MIN_PEAK_WIDTH)) return false;
	const ceiling = Math.min(2 * window.budget, Math.floor(previewChars / 6));
	let used = footprint(width, window.why);
	if (ceiling <= used) return false;
	const added: number[] = [];
	let last = window.last;
	for (const i of peaks) {
		const [lo, hi] = neighborhood(lines, i);
		let cost = 0;
		for (let j = lo; j <= hi; j++) if (window.why[j] === "b") cost += width[j] + 1;
		if (!cost) continue;
		if (lo && !reasonShows(window.why[lo - 1])) cost += FRAME_MARKER;
		if (used + cost > ceiling) {
			for (const j of added) window.why[j] = "b";
			return false;
		}
		if (window.why[i] === "b") last = { item: i, chars: cost };
		for (let j = lo; j <= hi; j++) {
			if (window.why[j] !== "b") continue;
			added.push(j);
			window.why[j] = j === i ? "a" : "c";
		}
		used += cost;
	}
	window.used = used;
	window.last = last;
	window.budget = Math.max(window.budget, used);
	return true;
}

/**
 * Shows each hidden run of one line, or of two lines with at most two markers' worth of text, between shown lines
 * (`c`): such a run costs about what its marker does. A gap and an already-seen fragment are runs of their own; runs
 * again after later steps (commit headers) split runs into fragments.
 */
export function fillSmallGaps(width: readonly number[], why: (SpotlightReason | undefined)[]): void {
	const shows = (i: number) => {
		const reason = why[i];
		return reason === undefined || reasonShows(reason);
	};
	const n = why.length;
	for (let i = 1; i < n - 1; i++) {
		if (shows(i) || !shows(i - 1)) continue;
		const seen = why[i] === "r";
		let j = i;
		while (j < n && j - i < 2 && !shows(j) && (why[j] === "r") === seen) j++;
		if (j >= n || !shows(j)) continue;
		let chars = 0;
		for (let g = i; g < j; g++) chars += width[g] + 1;
		if (j - i > 1 && chars > FRAME_MARKER * 2) continue;
		for (let g = i; g < j; g++) why[g] = "c";
	}
}

/** A Markdown-style heading line (`# dir/`, `## file.ts`, `### Section`) and its level. */
const HEADING = /^(#{1,6}) \S/;
const TABLE_RULE = /^\|(?:\s*:?---+:?\s*\|)+$/;

/**
 * Shows the headings and pipe-table column names for kept lines, as structure (`s`): `grep` and `glob` group their lines under
 * `# dir/` and `## file` headings, and a Markdown result its paragraphs under sections, so a line shown without them
 * names nothing. Blank lines pull no heading. Only lines hidden by rank or budget (`b`) are shown; `undefined` counts
 * as shown.
 */
export function keepHeadings(lines: readonly string[], why: (SpotlightReason | undefined)[]): void {
	const shows = (i: number) => {
		const reason = why[i];
		return reason === undefined || reasonShows(reason);
	};
	// The headings open above the current line, outermost first.
	const open: { line: number; level: number }[] = [];
	let table = -1;
	for (let i = 0; i < lines.length; i++) {
		const heading = HEADING.exec(lines[i]);
		const row = lines[i].trim();
		if (!row.startsWith("|")) table = -1;
		else if (i && TABLE_RULE.test(row) && lines[i - 1].trimStart().startsWith("|")) table = i - 1;
		else if (table >= 0 && shows(i)) {
			if (why[table] === "b") why[table] = "s";
			if (why[table + 1] === "b") why[table + 1] = "s";
		}
		if (heading) {
			const level = heading[1].length;
			while (open.length && open[open.length - 1].level >= level) open.pop();
		}
		if (shows(i) && lines[i].trim()) {
			for (const h of open) if (why[h.line] === "b") why[h.line] = "s";
		}
		if (heading) open.push({ line: i, level: heading[1].length });
	}
}

/** A `git log` commit's first line, the header lines under it, and its `--stat` total. */
export const COMMIT = /^commit [0-9a-f]{7,40}\b/;
const COMMIT_HEADER = /^(?:Merge|Author|AuthorDate|Commit|CommitDate|Date):/;
const STAT_TOTAL = /^ \d+ files? changed\b/;

/**
 * Shows, as structure (`s`), the record of the commit every shown line of `git log` output sits under: its header
 * (`commit`, `Merge:`, `Author:`, `Date:` lines), subject, and `--stat` total. A stat line, message or lone `Date:`
 * shown without them names no commit. Lines hidden by rank or budget (`b`) and as already seen (`r`) are shown: a
 * header an earlier result showed is far from the lines it names here. Output without commit lines is left as it is.
 */
export function keepCommitHeaders(lines: readonly string[], why: (SpotlightReason | undefined)[]): void {
	const shows = (i: number) => {
		const reason = why[i];
		return reason === undefined || reasonShows(reason);
	};
	const open = (i: number) => {
		if (why[i] === "b" || why[i] === "r") why[i] = "s";
	};
	let header = -1;
	let pulled = -1;
	for (let i = 0; i < lines.length; i++) {
		if (COMMIT.test(lines[i])) {
			header = i;
			continue;
		}
		if (header < 0 || header === pulled || !lines[i].trim() || !shows(i)) continue;
		let h = header;
		for (; h === header || COMMIT_HEADER.test(lines[h] ?? ""); h++) open(h);
		while (h < lines.length && !lines[h].trim()) h++;
		if (h < lines.length && !COMMIT.test(lines[h])) open(h);
		for (let end = h + 1; end < lines.length && !COMMIT.test(lines[end]); end++) {
			if (!STAT_TOTAL.test(lines[end])) continue;
			open(end);
			break;
		}
		pulled = header;
	}
}

/** A line with its numbers blanked: lines of one shape say the same thing with other counts. */
export function lineShape(line: string): string {
	return line.replace(/\d+/g, "N");
}

/**
 * Fewest open lines; the share of them the uniform shapes must cover together; the most shapes, each holding at least
 * its share of the lines, for output to read as uniform.
 */
const UNIFORM_LINES = 50;
const UNIFORM_SHARE = 0.95;
const UNIFORM_SHAPES = 3;
const UNIFORM_SHAPE_SHARE = 0.05;

/**
 * Output that repeats one to {@link UNIFORM_SHAPES} line shapes (`sync batch N: wrote N rows … ok`; table rows
 * whose status is `ok`, `shipped` or `packed`): the shapes, most common first; which open lines inside the run (from
 * the first line of a shape to the last) have none of them; and which open lines lie outside it (a table's header, a
 * closing summary). Undefined unless at least {@link UNIFORM_LINES} non-blank open lines exist and the shapes cover
 * {@link UNIFORM_SHARE} of them; blank lines and markers neither count nor differ.
 */
export function uniformShape(
	lines: readonly string[],
	skip: readonly boolean[],
): { shapes: string[]; differs: boolean[]; edges: boolean[] } | undefined {
	const counted = (i: number) => !skip[i] && lines[i].trim() !== "" && !MARKER.test(lines[i]);
	const count = new Map<string, number>();
	let open = 0;
	for (let i = 0; i < lines.length; i++) {
		if (!counted(i)) continue;
		open++;
		const shape = lineShape(lines[i]);
		count.set(shape, (count.get(shape) ?? 0) + 1);
	}
	if (open < UNIFORM_LINES) return undefined;
	const shapes: string[] = [];
	let covered = 0;
	for (const [shape, n] of [...count].sort((a, b) => b[1] - a[1])) {
		if (covered >= open * UNIFORM_SHARE || shapes.length === UNIFORM_SHAPES || n < open * UNIFORM_SHAPE_SHARE) break;
		shapes.push(shape);
		covered += n;
	}
	if (covered < open * UNIFORM_SHARE) return undefined;
	const kept = new Set(shapes);
	const shaped = lines.map((l, i) => counted(i) && kept.has(lineShape(l)));
	const from = shaped.indexOf(true);
	const to = shaped.lastIndexOf(true);
	return {
		shapes,
		differs: lines.map((_, i) => counted(i) && !shaped[i] && i > from && i < to),
		edges: lines.map((_, i) => counted(i) && (i < from || i > to)),
	};
}

/** Unified diff text (`git diff`, a `.patch` read back): a hunk header and a file header. */
export function isDiff(lines: readonly string[]): boolean {
	return lines.some(l => /^@@ -\d/.test(l)) && lines.some(l => /^(?:diff --git |\+\+\+ |--- a\/)/.test(l));
}

/**
 * A picture or matrix: at least 10 non-blank lines, 60% of them of one length (±1, at least 8), drawn from at most
 * 16 distinct non-space characters. Any line subset of one is meaningless.
 */
export function isGrid(lines: readonly string[]): boolean {
	const rows = lines.filter(l => l.trim());
	if (rows.length < 10) return false;
	const count = new Map<number, number>();
	for (const l of rows) count.set(l.length, (count.get(l.length) ?? 0) + 1);
	let mode = 0;
	let best = 0;
	for (const [len, n] of count) {
		const near = n + (count.get(len - 1) ?? 0) + (count.get(len + 1) ?? 0);
		if (near > best) {
			best = near;
			mode = len;
		}
	}
	if (best < rows.length * 0.6 || mode < 8) return false;
	const chars = new Set<string>();
	for (const l of rows) if (Math.abs(l.length - mode) <= 1) for (const ch of l) if (ch !== " ") chars.add(ch);
	return chars.size <= 16;
}
