/**
 * Where brackets, emphasis, code spans, autolinks and inline HTML close in inline Markdown. The indexes are built
 * over one root inline source, each on first use, and shared by every source lexed inside it (a link label, the text
 * of emphasis), so lexing nested sources builds no index of its own and keeps none alive per nesting level.
 */

export const PUNCTUATION = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;

/** Whether an odd run of backslashes right before `index` escapes the character there. */
export function escapedAt(src: string, index: number): boolean {
	let at = index - 1;
	while (at >= 0 && src.charCodeAt(at) === 0x5c /* \ */) at--;
	return (index - 1 - at) % 2 === 1;
}

export function canOpenDelimiter(src: string, index: number, width: number, marker: string, previous = "\n"): boolean {
	const before = index === 0 ? previous : src[index - 1]!;
	if (index === 0 && before === marker) return false;
	const after = src[index + width];
	if (after === undefined || /\s/.test(after)) return false;
	if (marker === "_" && /[\p{L}\p{N}]/u.test(before) && /[\p{L}\p{N}]/u.test(after)) return false;
	return true;
}

export function canCloseDelimiter(src: string, index: number, marker: string): boolean {
	const before = src[index - 1];
	const after = src[index + 1] ?? "\n";
	if (before === undefined || /\s/.test(before)) return false;
	if (marker === "_" && /[\p{L}\p{N}]/u.test(before) && /[\p{L}\p{N}]/u.test(after)) return false;
	return !PUNCTUATION.test(before) || /\s/.test(after) || PUNCTUATION.test(after);
}

/** Index of the first element of the ascending `values` at or above `target`. */
function lowerBound(values: readonly number[], target: number): number {
	let low = 0;
	let high = values.length;
	while (low < high) {
		const mid = (low + high) >>> 1;
		if (values[mid]! < target) low = mid + 1;
		else high = mid;
	}
	return low;
}

/** Closing-delimiter offsets by the depth before each, every list ascending. */
class ClosersByDepth {
	readonly #offsets = new Map<number, number[]>();

	/** Records a closer at `offset`, which lies past every closer recorded before it. */
	add(depth: number, offset: number): void {
		let offsets = this.#offsets.get(depth);
		if (!offsets) this.#offsets.set(depth, (offsets = []));
		offsets.push(offset);
	}

	/** The first closer at `depth` at or after `from`, or -1. */
	first(depth: number, from: number): number {
		const offsets = this.#offsets.get(depth);
		if (!offsets) return -1;
		const at = lowerBound(offsets, from);
		return at === offsets.length ? -1 : offsets[at]!;
	}
}

/**
 * Where a bracket opened in the root source closes. A search starts right after the opening bracket, and a bracket
 * never begins an escape, so the escape pairing from there is the pairing from the start of the root source. The
 * closer is then the first unescaped closing bracket at or after the start whose depth (openers minus closers
 * before it, from the start of the root source) equals the depth at the start.
 */
class BracketDepths {
	// The depth before each offset.
	readonly #depth: Int32Array;
	readonly #closers = new ClosersByDepth();
	// Every unescaped closing bracket, ascending.
	readonly #all: number[] = [];

	constructor(src: string, open: number, close: number) {
		const depth = new Int32Array(src.length + 1);
		let level = 0;
		for (let i = 0; i < src.length; i++) {
			depth[i] = level;
			const code = src.charCodeAt(i);
			if (code === 0x5c /* \ */) {
				depth[++i] = level;
			} else if (code === open) {
				level++;
			} else if (code === close) {
				this.#closers.add(level, i);
				this.#all.push(i);
				level--;
			}
		}
		depth[src.length] = level;
		this.#depth = depth;
	}

	/** The offset of the bracket closing the one just before `start`, or -1. */
	closeAfter(start: number): number {
		return this.#closers.first(this.#depth[start]!, start);
	}

	/** Whether an unescaped closing bracket lies at or after `from`, right after a bracket, and before `to`. */
	closesWithin(from: number, to: number): boolean {
		const at = lowerBound(this.#all, from);
		return at < this.#all.length && this.#all[at]! < to;
	}
}

/**
 * The delimiters the emphasis rule's closer walk visits for one marker and width in the root source, typed the way
 * the walk types them: a delimiter that can close is a closer, else one that can open is an opener. For width 1 they
 * are every unescaped marker. For width 2 they are marker pairs taken two at a time from the start of each run of
 * markers (after it when an odd run of backslashes escapes the start), which is where a walk that reaches the run
 * from before it enters. The closer for an opener is then the first closer after it whose depth (openers minus
 * closers before it) equals the depth where its walk begins, the first point where the walk's nesting count would
 * drop below zero.
 */
class EmphasisDelimiters {
	readonly #src: string;
	readonly #marker: string;
	readonly #width: number;
	// Delimiter offsets, ascending, and the depth before each.
	readonly #at: number[] = [];
	readonly #depth: number[] = [];
	readonly #closers = new ClosersByDepth();

	constructor(src: string, marker: string, width: number) {
		this.#src = src;
		this.#marker = marker;
		this.#width = width;
		let level = 0;
		for (let run = src.indexOf(marker); run !== -1;) {
			let end = run + 1;
			while (src[end] === marker) end++;
			for (let at = escapedAt(src, run) ? run + width : run; at + width <= end; at += width) {
				this.#at.push(at);
				this.#depth.push(level);
				if (canCloseDelimiter(src, at, marker)) {
					this.#closers.add(level, at);
					level--;
				} else if (canOpenDelimiter(src, at, width, marker)) {
					level++;
				}
			}
			run = src.indexOf(marker, end);
		}
	}

	/**
	 * Where the emphasis opened by the delimiter at `opener` closes in a source that ends at `end`, or -1 when the
	 * closer the walk meets first does not lie wholly before `end`. The walk reads nothing before its start. Past
	 * `end` it reads only for the source's last delimiter, which cannot open there and closes as it would at the end
	 * of the source: the sources inline lexing nests end right before a marker or "]", and the closing test reads
	 * either punctuation there like the end.
	 */
	closeFor(opener: number, end: number): number {
		const src = this.#src;
		const marker = this.#marker;
		const width = this.#width;
		const walk = opener + width;
		// A pair right after a width-2 opener has markers on both sides, so the walk takes it as the closer.
		if (width === 2 && src[walk] === marker && src[walk + 1] === marker) return walk + width <= end ? walk : -1;
		const next = lowerBound(this.#at, walk);
		if (next === this.#at.length) return -1;
		const close = this.#closers.first(this.#depth[next]!, this.#at[next]!);
		return close !== -1 && close + width <= end ? close : -1;
	}
}

/**
 * The runs of backticks in the root source, for the code span rule. A span opened by `width` backticks closes at the
 * first `width` backticks after its opening run that no backslash escapes: the start of a later run of at least
 * `width`, or, in a run whose first backtick a backslash escapes, the backticks from its `width`th on, since the
 * search for a closer goes on `width` past an escaped one.
 */
class CodeRuns {
	// Per run, in order: where it starts and ends, and whether a backslash escapes it.
	readonly #starts: number[] = [];
	readonly #ends: number[] = [];
	readonly #escaped: boolean[] = [];
	// A segment tree over the runs of the widest closer each run holds: its length, or half of it when escaped.
	readonly #widest: Int32Array;
	readonly #leaves: number;

	constructor(src: string) {
		const widths: number[] = [];
		for (let at = src.indexOf("`"); at !== -1;) {
			let end = at + 1;
			while (src.charCodeAt(end) === 0x60 /* ` */) end++;
			const escaped = escapedAt(src, at);
			this.#starts.push(at);
			this.#ends.push(end);
			this.#escaped.push(escaped);
			widths.push(escaped ? (end - at) >> 1 : end - at);
			at = src.indexOf("`", end);
		}
		let leaves = 1;
		while (leaves < widths.length) leaves <<= 1;
		const widest = new Int32Array(2 * leaves);
		for (let run = 0; run < widths.length; run++) widest[leaves + run] = widths[run]!;
		for (let node = leaves - 1; node >= 1; node--) widest[node] = Math.max(widest[2 * node]!, widest[2 * node + 1]!);
		this.#widest = widest;
		this.#leaves = leaves;
	}

	/** Where the run of backticks holding the backtick at `at` ends. */
	endOf(at: number): number {
		return this.#ends[lowerBound(this.#starts, at + 1) - 1]!;
	}

	/** Where the closer of a code span opened by `width` backticks that end at `from` starts, or -1. */
	closerAfter(from: number, width: number): number {
		const run = this.#firstHolding(lowerBound(this.#starts, from), width);
		return run === -1 ? -1 : this.#starts[run]! + (this.#escaped[run] ? width : 0);
	}

	/** The first run at or after `first` that holds a closer of `width` backticks, or -1. */
	#firstHolding(first: number, width: number): number {
		if (first >= this.#starts.length) return -1;
		const widest = this.#widest;
		const leaves = this.#leaves;
		let node = leaves + first;
		if (widest[node]! >= width) return first;
		// Up to the nearest subtree on the right that holds one, then down to its first run that does.
		for (;;) {
			if (node === 1) return -1;
			if ((node & 1) === 0 && widest[node + 1]! >= width) break;
			node >>= 1;
		}
		node++;
		while (node < leaves) node = widest[2 * node]! >= width ? 2 * node : 2 * node + 1;
		return node - leaves;
	}
}

/** The closer indexes of one root inline source, each built on first use. */
export class CloserIndexes {
	readonly #src: string;
	#square: BracketDepths | undefined;
	#round: BracketDepths | undefined;
	readonly #emphasis = new Map<string, EmphasisDelimiters>();
	#tagEnds: Int32Array | undefined;
	#commentEnds: number[] | undefined;
	#escapes: number[] | undefined;
	#codeRuns: CodeRuns | undefined;
	// The first " " and the first ">" at or after the offset each was last searched from.
	#space = -1;
	#angle = -1;

	constructor(src: string) {
		this.#src = src;
	}

	get square(): BracketDepths {
		return (this.#square ??= new BracketDepths(this.#src, 0x5b /* [ */, 0x5d /* ] */));
	}

	get round(): BracketDepths {
		return (this.#round ??= new BracketDepths(this.#src, 0x28 /* ( */, 0x29 /* ) */));
	}

	emphasis(marker: string, width: number): EmphasisDelimiters {
		const key = marker.repeat(width);
		let delimiters = this.#emphasis.get(key);
		if (!delimiters) this.#emphasis.set(key, (delimiters = new EmphasisDelimiters(this.#src, marker, width)));
		return delimiters;
	}

	/**
	 * For each offset, where the HTML rule's scan for a tag's end from there stops: the first ">" outside quotes,
	 * where a quote runs to the next quote of its kind, or -1 at the end of the source.
	 */
	get tagEnds(): Int32Array {
		if (this.#tagEnds) return this.#tagEnds;
		const src = this.#src;
		const ends = new Int32Array(src.length + 1);
		ends[src.length] = -1;
		let nextDouble = -1;
		let nextSingle = -1;
		for (let at = src.length - 1; at >= 0; at--) {
			const code = src.charCodeAt(at);
			if (code === 0x3e /* > */) {
				ends[at] = at;
			} else if (code === 0x22 /* " */) {
				ends[at] = nextDouble === -1 ? -1 : ends[nextDouble + 1]!;
				nextDouble = at;
			} else if (code === 0x27 /* ' */) {
				ends[at] = nextSingle === -1 ? -1 : ends[nextSingle + 1]!;
				nextSingle = at;
			} else {
				ends[at] = ends[at + 1]!;
			}
		}
		return (this.#tagEnds = ends);
	}

	/** Every offset where "-->" starts, ascending. */
	get commentEnds(): number[] {
		if (this.#commentEnds) return this.#commentEnds;
		const src = this.#src;
		const ends: number[] = [];
		for (let at = src.indexOf("-->"); at !== -1; at = src.indexOf("-->", at + 1)) ends.push(at);
		return (this.#commentEnds = ends);
	}

	get codeRuns(): CodeRuns {
		return (this.#codeRuns ??= new CodeRuns(this.#src));
	}

	/**
	 * The first " " or ">" at or after `from`, or `Infinity`. Asked at offsets that never decrease, as the lexer's
	 * position does, so each search starts past the last one's answer.
	 */
	spaceOrAngleFrom(from: number): number {
		const src = this.#src;
		if (this.#space < from) {
			const at = src.indexOf(" ", from);
			this.#space = at === -1 ? Infinity : at;
		}
		if (this.#angle < from) {
			const at = src.indexOf(">", from);
			this.#angle = at === -1 ? Infinity : at;
		}
		return Math.min(this.#space, this.#angle);
	}

	/** Every offset of a backslash before ASCII punctuation, ascending: where unescaping drops a backslash. */
	get escapes(): number[] {
		if (this.#escapes) return this.#escapes;
		const src = this.#src;
		const escapes: number[] = [];
		for (let at = src.indexOf("\\"); at !== -1; at = src.indexOf("\\", at + 1)) {
			if (PUNCTUATION.test(src[at + 1] ?? "")) escapes.push(at);
		}
		return (this.#escapes = escapes);
	}
}

/**
 * The link, emphasis, code span, autolink and inline HTML rules' closer lookups for one inline source, which is the
 * root source of `indexes` or a part of it that ends at `end`. Offsets are relative to `rest`, a suffix of the
 * source. A closer the root source places at or past `end` does not exist in the source.
 */
export class InlineClosers {
	readonly #indexes: CloserIndexes;
	/** Where the source ends in the root source. */
	readonly end: number;

	constructor(indexes: CloserIndexes, end: number) {
		this.#indexes = indexes;
		this.end = end;
	}

	/** The closers of a part of `rest` that ends at `end`, lexed as its own source. */
	nested(rest: string, end: number): InlineClosers {
		return new InlineClosers(this.#indexes, this.end - rest.length + end);
	}

	/** Where the "[" just before `start` closes, or -1. */
	closeSquare(rest: string, start: number): number {
		return this.#close(this.#indexes.square, rest, start);
	}

	/** Where the "(" just before `start` closes, or -1. */
	closeRound(rest: string, start: number): number {
		return this.#close(this.#indexes.round, rest, start);
	}

	/** Whether `rest.slice(from, to)`, which starts right after a "[", holds an unescaped "]". */
	squareCloserWithin(rest: string, from: number, to: number): boolean {
		const pos = this.end - rest.length;
		return this.#indexes.square.closesWithin(pos + from, pos + to);
	}

	/** Whether `rest.slice(from, to)` holds a backslash before ASCII punctuation, which unescaping drops. */
	escapeWithin(rest: string, from: number, to: number): boolean {
		const pos = this.end - rest.length;
		const escapes = this.#indexes.escapes;
		const at = lowerBound(escapes, pos + from);
		return at < escapes.length && escapes[at]! + 1 < pos + to;
	}

	/** Where the emphasis opened by the `width` markers at the start of `rest` closes, or -1. */
	closeEmphasis(rest: string, marker: string, width: number): number {
		const pos = this.end - rest.length;
		const close = this.#indexes.emphasis(marker, width).closeFor(pos, this.end);
		return close === -1 ? -1 : close - pos;
	}

	/** How many backticks start `rest`, which starts with one. */
	codeOpenerWidth(rest: string): number {
		const pos = this.end - rest.length;
		return Math.min(this.#indexes.codeRuns.endOf(pos), this.end) - pos;
	}

	/** Where the code span opened by the `width` backticks at the start of `rest` closes, or -1. */
	closeCode(rest: string, width: number): number {
		const pos = this.end - rest.length;
		const close = this.#indexes.codeRuns.closerAfter(pos + width, width);
		return close === -1 || close + width > this.end ? -1 : close - pos;
	}

	/**
	 * Where the URL autolink opened at the start of `rest` ends, its scheme ending at `from`: the first " " or ">"
	 * after the scheme if it is a ">" with text before it, or -1. One past the end of `rest` reads as no ">".
	 */
	closeUrlAutolink(rest: string, from: number): number {
		const pos = this.end - rest.length;
		const close = this.#indexes.spaceOrAngleFrom(pos + from) - pos;
		return close > from && rest.charCodeAt(close) === 0x3e /* > */ ? close : -1;
	}

	/** Where the HTML tag opened by the "<" at the start of `rest` ends: the first ">" after it outside quotes, or -1. */
	closeTag(rest: string): number {
		const pos = this.end - rest.length;
		const close = this.#indexes.tagEnds[pos + 1]!;
		return close === -1 || close >= this.end ? -1 : close - pos;
	}

	/** Where the first "-->" after the "<!--" at the start of `rest` starts, or -1. */
	closeComment(rest: string): number {
		const pos = this.end - rest.length;
		const ends = this.#indexes.commentEnds;
		const at = lowerBound(ends, pos + 4);
		return at === ends.length || ends[at]! + 3 > this.end ? -1 : ends[at]! - pos;
	}

	#close(depths: BracketDepths, rest: string, start: number): number {
		const pos = this.end - rest.length;
		const close = depths.closeAfter(pos + start);
		return close === -1 || close >= this.end ? -1 : close - pos;
	}
}
