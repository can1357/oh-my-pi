/**
 * What a `magic` edit shows its apply model of a file.
 *
 * Long files can start with an excerpt: the named lines, their blocks, and
 * some context, plus the file head and tail. Otherwise the whole file is
 * shown. A change names a line
 * by quoting it (a code span, or a line of its own), by an identifier, or by
 * number.
 *
 * @example
 * ```ts
 * // Non-runnable: `content` is a 2,000-line file.
 * fileViews(content, "In `drain()`, swap lines 812 and 813.");
 * // → [{ partial: true, text: "1\timport …\n⋮ lines 13-790 not shown\n791\t…" }, { partial: false, … }]
 * ```
 */

/** Numbered snapshot shown to the apply model, with inclusive zero-based ranges for excerpts. */
export type FileView = { text: string } & ({ partial: false } | { partial: true; shown: Span[] });

/** Lines shown around each named line, and kept from the head and tail of the file. */
const CONTEXT_LINES = 12;
/** Longest block shown under a named line that opens one. */
const MAX_BLOCK_LINES = 150;
/** A fragment found on more lines than this locates nothing by itself. */
const MAX_DISTINCT_HITS = 5;
/** A named line this close to another one's block belongs with it. */
const NEAR_LINES = 3;
/** Hits shown for a repeating fragment that has no other named line nearby. */
const REPEAT_SAMPLE = 3;
/** Files shorter than this are shown whole. */
const MIN_FILE_LINES = 200;
/** Share of the file an excerpt must leave out to be worth the lost context. */
const MIN_OMITTED_SHARE = 0.5;

const CODE_SPAN = /`([^`\n]+)`/g;
/** camelCase, snake_case and dotted names: words prose does not contain by accident. */
const IDENTIFIER =
	/[A-Za-z_$][\w$]*[a-z0-9][A-Z][\w$]*|[A-Za-z$][\w$]*_[\w$]+|[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+/g;
/** `line 12`, `lines 40-52`, `lines 23, 28 and 29`. */
const LINE_REFERENCE = /\blines?\s+(\d+(?:\s*(?:,|-|–|to|through|and)\s*\d+)*)/gi;
const LINE_SPAN = /(\d+)(?:\s*(?:-|–|to|through)\s*(\d+))?/g;
const ELISION = /\.{3}|…/;
const CLOSER = /^[\])}]/;
const OPENER = /[[({]\s*$/;

type Span = [from: number, to: number];

function squeeze(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

export function fileLines(content: string): string[] {
	const lines = content.split("\n");
	if (content.endsWith("\n")) lines.pop();
	return lines;
}

/** `lines[from..to]` behind their numbers; a line that opens a block ending within them shows the block's span, `12-30`. */
function numbered(lines: readonly string[], from: number, to: number): string[] {
	const out: string[] = [];
	for (let index = from; index <= to; index++) {
		const end = lines[index].trim() === "" ? index : blockEnd(lines, index, lines.length);
		// A block that runs past the shown stretch cannot be named by its span.
		out.push(`${index + 1}${end > index && end <= to ? `-${end + 1}` : ""}\t${lines[index]}`);
	}
	return out;
}

/** Text of `change` that may quote the file: code spans, whole lines, identifiers in prose. */
function namedFragments(change: string): string[] {
	const found = new Set<string>();
	const add = (text: string) => {
		// `interface Options { ... }` quotes the lines around what it elides.
		for (const part of text.split(ELISION)) {
			const fragment = squeeze(part);
			// `}` or `i` is on too many lines to name one.
			if (fragment.replace(/\W/g, "").length >= 3) found.add(fragment);
		}
	};
	// A quoted line on its own: fenced or indented code.
	for (const line of change.split("\n")) add(line);
	for (const [, span] of change.matchAll(CODE_SPAN)) {
		add(span);
		// `drain()` names `function drain(queue)` too.
		if (span.endsWith(")")) add(span.slice(0, span.indexOf("(") + 1));
	}
	for (const name of change.replace(CODE_SPAN, " ").matchAll(IDENTIFIER)) add(name[0]);
	return [...found];
}

/** 0-based line spans `change` gives by number. */
function numberedSpans(change: string, lineCount: number): Span[] {
	const spans: Span[] = [];
	for (const reference of change.matchAll(LINE_REFERENCE)) {
		for (const [, first, last = first] of reference[1].matchAll(LINE_SPAN)) {
			const from = Math.min(Number(first), Number(last));
			const to = Math.max(Number(first), Number(last));
			if (from >= 1 && from <= lineCount) spans.push([from - 1, Math.min(to, lineCount) - 1]);
		}
	}
	return spans;
}

/** Last line of the block `lines[start]` opens: its deeper-indented lines and their closer. */
export function blockEnd(lines: readonly string[], start: number, maxLines = MAX_BLOCK_LINES): number {
	const indentOf = (line: string) => line.length - line.trimStart().length;
	const indent = indentOf(lines[start]);
	const limit = Math.min(lines.length, start + maxLines);
	let end = start;
	for (let index = start + 1; index < limit; index++) {
		const line = lines[index];
		if (line.trim() === "") continue;
		const depth = indentOf(line);
		if (depth > indent) {
			end = index;
			continue;
		}
		if (depth < indent || end === start || !CLOSER.test(line.trimStart())) break;
		end = index;
		// `} else {` closes one block and opens the next.
		if (!OPENER.test(line)) break;
	}
	return end;
}

/** The lines of the file that `change` quotes or names, each with the block it opens. */
function namedSpans(lines: readonly string[], change: string): Span[] {
	const squeezed = lines.map(squeeze);
	const hits = namedFragments(change)
		.map(fragment => squeezed.flatMap((line, index) => (line.includes(fragment) ? [index] : [])))
		.filter(found => found.length > 0);
	const span = (line: number): Span => [line, blockEnd(lines, line)];
	if (hits.every(found => found.length <= MAX_DISTINCT_HITS)) return hits.flat().map(span);

	// Fragments with a hit on each line, and with a hit whose block reaches it.
	const on = lines.map((): number[] => []);
	const reaching = lines.map((): number[] => []);
	const reach = (line: number): Span => [
		Math.max(0, line - NEAR_LINES),
		Math.min(lines.length - 1, blockEnd(lines, line) + NEAR_LINES),
	];
	hits.forEach((found, fragment) => {
		for (const line of found) {
			on[line].push(fragment);
			const [from, to] = reach(line);
			for (let index = from; index <= to; index++) reaching[index].push(fragment);
		}
	});
	const spans: Span[] = [];
	hits.forEach((found, fragment) => {
		if (found.length <= MAX_DISTINCT_HITS) {
			spans.push(...found.map(span));
			return;
		}
		// A fragment that repeats names its copies in or beside the block of another named line.
		const other = (fragments: number[]) => fragments.some(id => id !== fragment);
		const together = found.filter(line => {
			if (other(reaching[line])) return true;
			const [from, to] = reach(line);
			return on.slice(from, to + 1).some(other);
		});
		spans.push(...(together.length > 0 ? together : found.slice(0, REPEAT_SAMPLE)).map(span));
	});
	return spans;
}

/** Numbered excerpt of `lines` for `change`; `undefined` when the change names nothing or too much of a file this short. */
function excerpt(lines: readonly string[], change: string): FileView | undefined {
	const last = lines.length - 1;
	if (lines.length < MIN_FILE_LINES) return undefined;
	const named = [...numberedSpans(change, lines.length), ...namedSpans(lines, change)];
	if (named.length === 0) return undefined;
	const spans = named.map(([from, to]): Span => [
		Math.max(0, from - CONTEXT_LINES),
		Math.min(last, to + CONTEXT_LINES),
	]);
	// The head and tail anchor changes placed by position: imports, a new last function.
	spans.push([0, CONTEXT_LINES - 1], [last - CONTEXT_LINES + 1, last]);
	spans.sort((a, b) => a[0] - b[0]);

	const shown: Span[] = [];
	for (const span of spans) {
		const previous = shown.at(-1);
		// A gap of one line costs as much to mark as to show.
		if (previous && span[0] <= previous[1] + 2) previous[1] = Math.max(previous[1], span[1]);
		else shown.push(span);
	}
	const shownCount = shown.reduce((count, [from, to]) => count + to - from + 1, 0);
	if (lines.length - shownCount < lines.length * MIN_OMITTED_SHARE) return undefined;

	const out: string[] = [];
	let next = 0;
	for (const [from, to] of shown) {
		if (from > next) out.push(`⋮ lines ${next + 1}-${from} not shown`);
		out.push(...numbered(lines, from, to));
		next = to + 1;
	}
	return { text: out.join("\n"), partial: true, shown };
}

/**
 * Views of `content` (LF text) to try in order for `change`: an excerpt of
 * the lines the change names, if an excerpt would omit at least half the file,
 * then the whole file. Views longer than `limit` characters are dropped:
 * the result is empty when the file is too long and the change names nothing
 * to show instead.
 */
export function fileViews(content: string, change: string, limit = Number.POSITIVE_INFINITY): FileView[] {
	const lines = fileLines(content);
	const views: FileView[] = [];
	const partial = excerpt(lines, change);
	if (partial !== undefined) views.push(partial);
	views.push({ text: numbered(lines, 0, lines.length - 1).join("\n"), partial: false });
	return views.filter(view => view.text.length <= limit);
}
