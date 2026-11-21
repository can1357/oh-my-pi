/**
 * The shaping cuts: runs of lines the agent has already seen, and windows of the lines Spotlight ranks highest within
 * a character budget. A window says why it showed or hid each line ({@link SpotlightReason}) and what it spent, for the result's
 * trace.
 */
import { reasonShows, type SpotlightReason } from "@oh-my-pi/pi-tui/chat/spotlight";
import { MARKER, norm, pairKey } from "./lines";
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
}

/**
 * Which lines a window shows and why: `s` head, tail and markers, `a` chosen on its score, `c` a neighbour of a
 * chosen line or a lone gap filled, `b` hidden by the budget (`r`: already seen, never chosen). `used` is the
 * characters the window counted against its budget, `last` its last line chosen on score and what that cost.
 */
export interface Window {
	why: SpotlightReason[];
	used: number;
	last?: { item: number; chars: number };
}

/** The density part shown in traces; the independent peak reserve uses the inspector's unsmoothed heat. */
export const DENSITY_PARTS = ["Spotlight ÷ length^¼"];

/** Density for the lexical window and its ascending score order, reused to find peaks without a second sort. */
export function rankLines(lines: readonly string[], scores: readonly (number | null)[]) {
	const order = [...lines.keys()].sort((a, b) => (scores[a] ?? 0) - (scores[b] ?? 0));
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
	const show = Array.from({ length: n }, () => false);
	const open = [...lines.keys()].filter(i => !skip[i]);
	let used = 0;
	let last: Window["last"];
	const take = (i: number, reason: SpotlightReason) => {
		if (!show[i] && !skip[i]) {
			show[i] = true;
			why[i] = reason;
			used += width[i] + 1;
		}
	};
	for (const i of open.slice(0, k.head)) take(i, "s");
	for (const i of open.slice(-k.tail)) take(i, "s");
	const order = open
		.filter(i => !show[i] && lines[i].trim() && k.pick?.[i] !== false)
		.sort((a, b) => scores[b] - scores[a] || a - b);
	for (const i of order) {
		if (show[i]) continue;
		const span: number[] = [];
		let add = 0;
		// A lone `{` or `}` says nothing: the neighbour is the line past it (a C signature above its brace).
		let lo = Math.max(0, i - k.ctx);
		let hi = Math.min(n - 1, i + k.ctx);
		if (k.ctx) {
			while (lo > 0 && BARE.test(lines[lo])) lo--;
			while (hi < n - 1 && BARE.test(lines[hi])) hi++;
		}
		for (let j = lo; j <= hi; j++) {
			if (show[j] || skip[j]) continue;
			span.push(j);
			add += width[j] + 1;
		}
		if (used + add + FRAME_MARKER > k.budget) {
			if (used + width[i] + 1 + FRAME_MARKER <= k.budget) {
				take(i, "a");
				used += FRAME_MARKER;
				last = { item: i, chars: width[i] + 1 + FRAME_MARKER };
			}
			continue;
		}
		for (const j of span) take(j, j === i ? "a" : "c");
		used += FRAME_MARKER;
		last = { item: i, chars: add + FRAME_MARKER };
		if (used >= k.budget) break;
	}
	fillSmallGaps(width, why);
	return { why, used, last };
}

/** Delimiters may supply context; they do not qualify as independent evidence. */
const MIN_PEAK_WIDTH = 4 * FRAME_MARKER;
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

/**
 * Add missed hot passages to a scored window, without evicting its evidence. The expanded allowance is used only
 * when it fits the whole peak set and stays within one sixth of the unshaped preview. Otherwise only the prefix
 * fitting the ordinary budget survives. Returns the allowance actually required for tracing.
 */
export function coverHotPassages(
	window: Window,
	lines: readonly string[],
	width: readonly number[],
	skip: readonly boolean[],
	spot: readonly (number | null)[],
	order: readonly number[],
	budget: number,
	previewChars: number,
): number {
	const scored = order.filter(i => spot[i] !== null);
	const peaks: number[] = [];
	let missed = false;
	for (let end = scored.length; end > 0;) {
		let a = end - 1;
		while (a > 0 && spot[scored[a - 1]] === spot[scored[end - 1]]) a--;
		const rank = scored.length === 1 ? 1 : (a + end - 1) / (2 * (scored.length - 1));
		if (Math.round(9 * rank) !== 9) break;
		for (let j = a; j < end; j++) {
			const i = scored[j];
			if (skip[i] || SEPARATOR.test(norm(lines[i]))) continue;
			peaks.push(i);
			if (window.why[i] === "b" && width[i] >= MIN_PEAK_WIDTH) missed = true;
		}
		end = a;
	}
	if (!missed) return budget;
	let used = 0;
	for (let i = 0; i < lines.length; i++) {
		if (reasonShows(window.why[i])) used += width[i] + 1;
		else if (!i || reasonShows(window.why[i - 1])) used += FRAME_MARKER;
	}
	// Only buy extra space if it covers *all* the outstanding evidence; otherwise use the ordinary window's slack.
	const ceiling = Math.min(2 * budget, Math.floor(previewChars / 6));
	if (ceiling <= used) return budget;
	const added: number[] = [];
	let affordable = 0;
	let affordableUsed = used;
	let affordableLast = window.last;
	for (const i of peaks) {
		let lo = Math.max(0, i - 1),
			hi = Math.min(lines.length - 1, i + 1);
		while (lo > 0 && BARE.test(lines[lo])) lo--;
		while (hi + 1 < lines.length && BARE.test(lines[hi])) hi++;
		let cost = 0;
		for (let j = lo; j <= hi; j++) if (window.why[j] === "b") cost += width[j] + 1;
		if (!cost) continue;
		if (lo && !reasonShows(window.why[lo - 1])) cost += FRAME_MARKER;
		if (used + cost > ceiling) {
			for (let n = affordable; n < added.length; n++) window.why[added[n]] = "b";
			used = affordableUsed;
			window.last = affordableLast;
			break;
		}
		if (window.why[i] === "b") window.last = { item: i, chars: cost };
		for (let j = lo; j <= hi; j++) {
			if (window.why[j] !== "b") continue;
			added.push(j);
			window.why[j] = j === i ? "a" : "c";
		}
		used += cost;
		if (used <= budget) {
			affordable = added.length;
			affordableUsed = used;
			affordableLast = window.last;
		}
	}
	window.used = used;
	return Math.max(budget, used);
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
