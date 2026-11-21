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

const URL_AUTOLINK_SCHEME = /<(?:https?:\/\/|ftp:\/\/)/iy;
const ADDRESS_AUTOLINK = /<[^ <>@]+@[^ <>@]+>/y;
const TAG_START = /<\/?[A-Za-z][A-Za-z0-9-]*(?:\s|\/?>)/y;
const LINK_DESTINATION = /^(<[^>]*>|\S+?)(?:\s+(?:"([\s\S]*)"|'([\s\S]*)'|\(([\s\S]*)\)))?$/;

/**
 * The destination (group 1) and title (group 2, 3 or 4 by its quotes) of an inline link whose parentheses hold
 * `inside`, or `null` when they hold no destination and title.
 */
export function matchDestination(inside: string): RegExpExecArray | null {
	return LINK_DESTINATION.exec(inside.trim());
}

/** Where a match of the sticky `pattern` at `at` ends, or -1. */
function matchEndAt(pattern: RegExp, src: string, at: number): number {
	pattern.lastIndex = at;
	return pattern.test(src) ? pattern.lastIndex : -1;
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

/** Ascending, disjoint parts of the root source, the `i`th from `starts[i]` up to `ends[i]`. */
class Spans {
	readonly starts: number[] = [];
	readonly ends: number[] = [];

	/** Records the part from `start` up to `end`, which lies past every part recorded before it. */
	add(start: number, end: number): void {
		this.starts.push(start);
		this.ends.push(end);
	}

	/** Where the part holding `at` ends, or -1 when none holds it. */
	endAt(at: number): number {
		const span = lowerBound(this.starts, at + 1) - 1;
		return span >= 0 && at < this.ends[span]! ? this.ends[span]! : -1;
	}
}

/** The first " " or ">" at or after an offset, asked at offsets that never decrease: each search starts past the last. */
class SpaceOrAngle {
	readonly #src: string;
	#space = -1;
	#angle = -1;

	constructor(src: string) {
		this.#src = src;
	}

	/** The first " " or ">" at or after `from`, or `Infinity`. */
	from(from: number): number {
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
}

/**
 * Where a bracket opened in the root source closes. A search starts right after the opening bracket, and a bracket
 * never begins an escape, so the escape pairing from there is the pairing from the start of the root source. The
 * closer is then the first unescaped closing bracket at or after the start whose depth (openers minus closers
 * before it, from the start of the root source) equals the depth at the start. Brackets inside `skipped` count as
 * neither.
 */
class BracketDepths {
	// The depth before each offset.
	readonly #depth: Int32Array;
	readonly #closers = new ClosersByDepth();
	// Every unescaped closing bracket outside `skipped`, ascending.
	readonly #all: number[] = [];

	constructor(src: string, open: number, close: number, skipped?: Spans) {
		const depth = new Int32Array(src.length + 1);
		let level = 0;
		let span = 0;
		let skipFrom = skipped?.starts[0] ?? Infinity;
		for (let i = 0; i < src.length; i++) {
			if (i === skipFrom) {
				// A skipped part never starts right after an escaping backslash: each starts at "`", "<" or "(", which
				// that backslash would have escaped.
				const end = skipped!.ends[span]!;
				depth.fill(level, i, end);
				i = end - 1;
				skipFrom = skipped!.starts[++span] ?? Infinity;
				continue;
			}
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
 * are every unescaped marker outside `skipped`. For width 2 they are marker pairs taken two at a time from the start
 * of each run of markers outside `skipped` (after it when an odd run of backslashes escapes the start), which is where
 * a walk that reaches the run from before it enters. The closer for an opener is then the first closer after it whose
 * depth (openers minus closers before it) equals the depth where its walk begins, the first point where the walk's
 * nesting count would drop below zero.
 */
class EmphasisDelimiters {
	readonly #src: string;
	readonly #marker: string;
	readonly #width: number;
	// Delimiter offsets, ascending, and the depth before each.
	readonly #at: number[] = [];
	readonly #depth: number[] = [];
	readonly #closers = new ClosersByDepth();

	constructor(src: string, marker: string, width: number, skipped: Spans) {
		this.#src = src;
		this.#marker = marker;
		this.#width = width;
		let level = 0;
		for (let run = src.indexOf(marker); run !== -1;) {
			// No skipped part starts or ends with a marker, so a run lies wholly inside one or outside all.
			const skippedTo = skipped.endAt(run);
			if (skippedTo !== -1) {
				run = src.indexOf(marker, skippedTo);
				continue;
			}
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
 * next run of exactly `width` backticks: a run of any other length is no closer, and the one that closes is the first
 * run of that width at or after the opener. Backslash escapes do not apply inside a code span, so a backslash just
 * before that closing backtick is content and still closes the span.
 */
class CodeRuns {
	// Per run, in order: where it starts and ends; the starts are the binary search `endOf` and `startsStringAt` need.
	readonly #starts: number[] = [];
	readonly #ends: number[] = [];
	// Run starts by width, each list ascending: a closer must have the opener's exact width, so finding one is a
	// binary search in the list for that width and no scan of the runs between.
	readonly #byWidth = new Map<number, number[]>();

	constructor(src: string) {
		for (let at = src.indexOf("`"); at !== -1;) {
			let end = at + 1;
			while (src.charCodeAt(end) === 0x60 /* ` */) end++;
			this.#starts.push(at);
			this.#ends.push(end);
			const width = end - at;
			const starts = this.#byWidth.get(width);
			if (starts === undefined) this.#byWidth.set(width, [at]);
			else starts.push(at);
			at = src.indexOf("`", end);
		}
	}

	/** Where the run of backticks holding the backtick at `at` ends. */
	endOf(at: number): number {
		return this.#ends[lowerBound(this.#starts, at + 1) - 1]!;
	}

	/**
	 * Whether a backtick string starts at `at` for a scan that walked to `at`: a string is a whole run, so it starts at
	 * the run's first backtick and nowhere else. A retry deeper inside a run is not a string, which keeps a run whose
	 * opener found no closer from opening a narrower span one backtick later. A position a tokenizer's raw resumed at,
	 * or the suffix an escape token left behind, is not a walked position — `codeOpenerWidth` admits those on its own,
	 * because it is told the scan resumed there rather than inferring it from the source text.
	 */
	startsStringAt(at: number): boolean {
		const run = lowerBound(this.#starts, at + 1) - 1;
		return this.#starts[run] === at;
	}

	/** Where the closer of a code span opened by `width` backticks that end at `from` starts, or -1. */
	closerAfter(from: number, width: number): number {
		const starts = this.#byWidth.get(width);
		if (starts === undefined) return -1;
		const run = lowerBound(starts, from);
		return run < starts.length ? starts[run]! : -1;
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
	#consumed: Spans | undefined;
	// The lexer's own cursor: its position never moves back, and the walk for `consumed` keeps one of its own.
	readonly #spaceOrAngle: SpaceOrAngle;

	constructor(src: string) {
		this.#src = src;
		this.#spaceOrAngle = new SpaceOrAngle(src);
	}

	/** The link label brackets; those a code span, an autolink, inline HTML or a link destination holds are none. */
	get square(): BracketDepths {
		return (this.#square ??= new BracketDepths(this.#src, 0x5b /* [ */, 0x5d /* ] */, this.consumed));
	}

	get round(): BracketDepths {
		return (this.#round ??= new BracketDepths(this.#src, 0x28 /* ( */, 0x29 /* ) */));
	}

	/** The emphasis delimiters; those a code span, an autolink, inline HTML or a link destination holds are none. */
	emphasis(marker: string, width: number): EmphasisDelimiters {
		const key = marker.repeat(width);
		let delimiters = this.#emphasis.get(key);
		if (!delimiters) {
			delimiters = new EmphasisDelimiters(this.#src, marker, width, this.consumed);
			this.#emphasis.set(key, delimiters);
		}
		return delimiters;
	}

	/**
	 * The parts of the root source that code spans, autolinks, inline HTML and inline links' parenthesized destinations
	 * and titles take, which take precedence over emphasis and link labels: a marker or bracket inside one neither opens
	 * nor closes, so `*a `*` b*` is one emphasis around a code span and `[a `]` b](u)` one link. One walk finds them
	 * where the lexer's rules match them, past escapes and each part it found. A "]" that closes an open "[" right
	 * before "(" takes the parenthesized part when it holds a destination and title, as the link rule does.
	 */
	get consumed(): Spans {
		if (this.#consumed) return this.#consumed;
		const src = this.#src;
		const spans = new Spans();
		const runs = this.codeRuns;
		const spaceOrAngle = new SpaceOrAngle(src);
		const special = /[\\`<[\]]/g;
		let openBrackets = 0;
		for (let match = special.exec(src); match; match = special.exec(src)) {
			const at = match.index;
			let end = at + 1;
			switch (src.charCodeAt(at)) {
				case 0x5c /* \ */:
					if (PUNCTUATION.test(src[at + 1] ?? "")) end = at + 2;
					break;
				case 0x60 /* ` */: {
					// The backticks left after an escaped first one open a span as a whole run does.
					const opener = runs.endOf(at);
					const close = runs.closerAfter(opener, opener - at);
					if (close === -1) {
						end = opener;
					} else {
						end = close + opener - at;
						spans.add(at, end);
					}
					break;
				}
				case 0x3c /* < */: {
					const autolink = this.autolinkEnd(at, src.length, spaceOrAngle);
					const close = autolink === -1 ? this.htmlEnd(at, src.length) : autolink;
					if (close !== -1) {
						end = close;
						spans.add(at, end);
					}
					break;
				}
				case 0x5b /* [ */:
					openBrackets++;
					break;
				case 0x5d /* ] */: {
					if (openBrackets === 0) break;
					openBrackets--;
					if (src.charCodeAt(at + 1) !== 0x28 /* ( */) break;
					const close = this.round.closeAfter(at + 2);
					if (close !== -1 && matchDestination(src.slice(at + 2, close))) {
						end = close + 1;
						spans.add(at + 1, end);
					}
				}
			}
			special.lastIndex = end;
		}
		return (this.#consumed = spans);
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
	 * Where the autolink opened by the "<" at `at` ends, one past its ">", in a source that ends at `end`, or -1. A URL
	 * runs from its scheme to the first " " or ">", which must be a ">" with text before it; an address holds no " ",
	 * "<", ">" or second "@". An address that matches after a scheme ends where the URL does, so only the URL is tried
	 * there. `spaceOrAngle` is asked at offsets that never decrease, as the lexer's position does.
	 */
	autolinkEnd(at: number, end: number, spaceOrAngle = this.#spaceOrAngle): number {
		const src = this.#src;
		const scheme = matchEndAt(URL_AUTOLINK_SCHEME, src, at);
		if (scheme === -1) {
			const address = matchEndAt(ADDRESS_AUTOLINK, src, at);
			return address <= end ? address : -1;
		}
		const close = spaceOrAngle.from(scheme);
		return close > scheme && close < end && src.charCodeAt(close) === 0x3e /* > */ ? close + 1 : -1;
	}

	/**
	 * Where the inline HTML opened by the "<" at `at` ends, one past its last character, in a source that ends at
	 * `end`, or -1: a comment ends at the first "-->" after "<!--", a tag at its first ">" outside quotes.
	 */
	htmlEnd(at: number, end: number): number {
		const src = this.#src;
		if (src.startsWith("<!--", at)) {
			const ends = this.commentEnds;
			const close = ends[lowerBound(ends, at + 4)];
			return close === undefined || close + 3 > end ? -1 : close + 3;
		}
		const name = matchEndAt(TAG_START, src, at);
		if (name === -1 || name > end) return -1;
		const close = this.tagEnds[at + 1]!;
		return close === -1 || close >= end ? -1 : close + 1;
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

	/**
	 * How many backticks start `rest`, which starts with one, or 0 where no code span opens because no backtick string
	 * starts there: the opener is a whole string, so the rest of a run whose opener found no closer is text, while the
	 * backticks left after a backslash escaped the run's first one do open a span. `resumed` says the scan resumed at
	 * `rest` after a tokenizer consumed a raw that ended here, where the backticks are a string wherever they sit.
	 */
	codeOpenerWidth(rest: string, resumed = false): number {
		const pos = this.end - rest.length;
		const runs = this.#indexes.codeRuns;
		if (!resumed && !runs.startsStringAt(pos)) return 0;
		return Math.min(runs.endOf(pos), this.end) - pos;
	}

	/** Where the code span opened by the `width` backticks at the start of `rest` closes, or -1. */
	closeCode(rest: string, width: number): number {
		const pos = this.end - rest.length;
		const close = this.#indexes.codeRuns.closerAfter(pos + width, width);
		return close === -1 || close + width > this.end ? -1 : close - pos;
	}

	/** How long the autolink at the start of `rest` is, or -1 where none starts. */
	autolinkLength(rest: string): number {
		const pos = this.end - rest.length;
		const end = this.#indexes.autolinkEnd(pos, this.end);
		return end === -1 ? -1 : end - pos;
	}

	/** How long the inline HTML (a tag or a comment) at the start of `rest` is, or -1 where none starts. */
	htmlLength(rest: string): number {
		const pos = this.end - rest.length;
		const end = this.#indexes.htmlEnd(pos, this.end);
		return end === -1 ? -1 : end - pos;
	}

	/**
	 * The first unescaped `delimiter` in `rest` at or after `from` that no code span, autolink, inline HTML or link
	 * destination holds, or -1.
	 */
	findDelimiter(rest: string, delimiter: string, from: number): number {
		const pos = this.end - rest.length;
		const consumed = this.#indexes.consumed;
		let at = rest.indexOf(delimiter, from);
		while (at !== -1) {
			const skippedTo = consumed.endAt(pos + at);
			if (skippedTo !== -1) at = rest.indexOf(delimiter, skippedTo - pos);
			else if (escapedAt(rest, at)) at = rest.indexOf(delimiter, at + delimiter.length);
			else return at;
		}
		return -1;
	}

	#close(depths: BracketDepths, rest: string, start: number): number {
		const pos = this.end - rest.length;
		const close = depths.closeAfter(pos + start);
		return close === -1 || close >= this.end ? -1 : close - pos;
	}
}
