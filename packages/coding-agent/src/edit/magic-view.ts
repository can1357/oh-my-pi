/**
 * Initial file view shown to a `magic` edit's apply model on turn 1.
 *
 * Short files are shown whole. Long files start with an excerpt of the lines
 * the change names (plus their enclosing blocks, context, head, and tail) when
 * that omits at least half the file; the apply model can inspect any omitted
 * stretch on demand via `read` and `search`.
 */

/** Numbered snapshot shown to the apply model on turn 1. */
export interface FileView {
	text: string;
	totalLines: number;
	partial: boolean;
}

/** Lines shown around each named line, and kept from the head and tail of the file. */
const CONTEXT_LINES = 12;
/** Head/tail lines shown when a huge file exceeds the context budget and the change names nothing. */
const FALLBACK_HEAD_LINES = 40;
const FALLBACK_TAIL_LINES = 20;
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
/** Gaps this short are shown instead of marked omitted. */
const MIN_OMITTED_GAP = 8;

const CODE_SPAN = /`([^`\n]+)`/g;
/** camelCase, snake_case, dotted, and `::`-qualified names: words prose does not contain by accident. */
const IDENTIFIER =
	/[A-Za-z_$][\w$]*[a-z0-9][A-Z][\w$]*|[A-Za-z$][\w$]*_[\w$]+|[A-Za-z_$][\w$]*(?:(?:\.|::)[A-Za-z_$][\w$]*)+/g;
/** `line 12`, `lines 40-52`, `ln 88`, `lines 23, 28 and 29`. */
const LINE_REFERENCE = /\b(?:lines?|lns?)\s+(\d+(?:\s*(?:,|-|–|to|through|and)\s*\d+)*)/gi;
const LINE_SPAN = /(\d+)(?:\s*(?:-|–|to|through)\s*(\d+))?/g;
const ELISION = /\.{3}|…/;
const CLOSER = /^[\])}]/;
const OPENER = /[[({]\s*$/;
const QUALIFIED_SCOPE = /^(?:[A-Za-z_$][\w$]*::)+([A-Za-z_$][\w$]*)$/;
const QUALIFIED_TYPE_MEMBER = /^[A-Z][\w$]*\.([A-Za-z_$][\w$]*)$/;
const DISTINCTIVE_MEMBER = /[a-z0-9][A-Z]|_|^[A-Z][A-Z0-9_]+$/;

type Span = [from: number, to: number];

function squeeze(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** Split LF file text into lines, dropping the sentinel empty element after a trailing newline. */
export function fileLines(content: string): string[] {
	const lines = content.split("\n");
	if (content.endsWith("\n")) lines.pop();
	return lines;
}

/**
 * `lines[from..to]` rendered as `N│text`, where `N` is the 1-based line number.
 * `offset` is added to every number, so a view sliced out of a larger file keeps
 * the source line numbers of the file it came from.
 */
export function numberedLines(
	lines: readonly string[],
	from: number,
	to: number,
	limit = Infinity,
	offset = 0,
): string[] {
	const out: string[] = [];
	for (let index = from; index <= to; index++) {
		const prefix = `${index + offset + 1}│`;
		const line = lines[index];
		const remaining = limit - prefix.length;
		if (line.length > remaining) {
			// Always make progress on one oversized line; the prefix is not a copyable anchor for the whole line.
			if (out.length === 0 && remaining > 1) out.push(`${prefix}${line.slice(0, remaining - 1)}…`);
			break;
		}
		out.push(prefix + line);
		limit -= prefix.length + line.length + 1;
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
	const addQualified = (name: string) => {
		const trimmed = name.trim().replace(/\(.*$/, "");
		const match = QUALIFIED_SCOPE.exec(trimmed) ?? QUALIFIED_TYPE_MEMBER.exec(trimmed);
		if (match === null) return;
		const member = match[1];
		add(`${member}(`);
		if (DISTINCTIVE_MEMBER.test(member)) add(member);
	};
	// A quoted line on its own: fenced or indented code.
	for (const line of change.split("\n")) add(line);
	for (const [, span] of change.matchAll(CODE_SPAN)) {
		add(span);
		addQualified(span);
		// `drain()` names `function drain(queue)` too.
		if (span.endsWith(")")) add(span.slice(0, span.indexOf("(") + 1));
	}
	for (const name of change.replace(CODE_SPAN, " ").matchAll(IDENTIFIER)) {
		add(name[0]);
		addQualified(name[0]);
	}
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
function blockEnd(lines: readonly string[], start: number, maxLines = MAX_BLOCK_LINES): number {
	const trimmedStart = lines[start].trim();
	// Blank lines and pure closing lines never open a block.
	if (trimmedStart === "" || (CLOSER.test(trimmedStart) && !OPENER.test(trimmedStart))) return start;
	const indentOf = (line: string) => line.length - line.trimStart().length;
	const indent = indentOf(lines[start]);
	const limit = Math.min(lines.length, start + maxLines);
	let end = start;
	for (let index = start + 1; index < limit; index++) {
		const line = lines[index];
		const trimmed = line.trim();
		if (trimmed === "") continue;
		const depth = indentOf(line);
		if (depth > indent) {
			end = index;
			continue;
		}
		if (depth < indent || end === start) break;
		// A bare `{` opens the body of a multi-line header.
		if (trimmed === "{" && !lines[end].trimEnd().endsWith(";")) {
			end = index;
			continue;
		}
		if (!CLOSER.test(trimmed)) break;
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

function renderExcerpt(lines: readonly string[], shown: Span[]): FileView {
	const out: string[] = [];
	let next = 0;
	for (const [from, to] of shown) {
		if (from > next) out.push(`⋮ lines ${next + 1}-${from} not shown`);
		out.push(...numberedLines(lines, from, to));
		next = to + 1;
	}
	if (next < lines.length) out.push(`⋮ lines ${next + 1}-${lines.length} not shown`);
	return { text: out.join("\n"), totalLines: lines.length, partial: true };
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
		// Small gaps cost as much to mark as to show.
		if (previous && span[0] <= previous[1] + MIN_OMITTED_GAP + 1) previous[1] = Math.max(previous[1], span[1]);
		else shown.push(span);
	}
	const shownCount = shown.reduce((count, [from, to]) => count + to - from + 1, 0);
	if (lines.length - shownCount < lines.length * MIN_OMITTED_SHARE) return undefined;

	return renderExcerpt(lines, shown);
}

/**
 * Views of `content` (LF text) to try in order for `change`: an excerpt of
 * the lines the change names (when it omits at least half the file), then the
 * whole file. If the file exceeds `limit` and no named excerpt fits, falls back
 * to a compact head+tail preview so the apply model can navigate via `search`
 * and `read`.
 */
export function fileViews(content: string, change: string, limit = Number.POSITIVE_INFINITY): FileView[] {
	const lines = fileLines(content);
	if (lines.length === 0) return [{ text: "", totalLines: 0, partial: false }];
	const views: FileView[] = [];
	const partial = excerpt(lines, change);
	if (partial !== undefined && partial.text.length <= limit) views.push(partial);
	if (content.length <= limit) {
		const text = numberedLines(lines, 0, lines.length - 1).join("\n");
		if (text.length <= limit) {
			views.push({ text, totalLines: lines.length, partial: false });
		}
	}
	if (views.length === 0) {
		const head = numberedLines(lines, 0, Math.min(lines.length, FALLBACK_HEAD_LINES) - 1, limit / 2).join("\n");
		const tail = numberedLines(
			lines,
			Math.max(FALLBACK_HEAD_LINES, lines.length - FALLBACK_TAIL_LINES),
			lines.length - 1,
			limit / 2,
		).join("\n");
		const text = [head, "⋮ Open more of the file with read or search.", tail].filter(Boolean).join("\n");
		views.push({ text: text.length <= limit ? text : "", totalLines: lines.length, partial: true });
	}
	return views;
}
