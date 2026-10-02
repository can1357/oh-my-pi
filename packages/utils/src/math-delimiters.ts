/**
 * LaTeX delimiter grammar for agent-authored Markdown: where does a math span
 * begin and end, in source offsets. Carries no rendering policy — what to do
 * with an unclosed opener, whether a body is typesettable, and how it is
 * displayed belong to the renderer (Unicode in the TUI, KaTeX in collab web).
 */

/** Opening delimiter. Each closer (`$`, `$$`, `\)`, `\]`) is as wide as its opener. */
export type MathOpener = "$" | "$$" | "\\(" | "\\[";

/** A closed math span found in the source. */
export interface MathSpan {
	opener: MathOpener;
	/** True for the display forms `$$…$$` and `\[…\]`. */
	display: boolean;
	/** Offset one past the closing delimiter. */
	end: number;
	/** Source between the delimiters, verbatim. */
	body: string;
}

/** An own-line display block: opener and closer each alone on their line. */
export interface MathBlock {
	/** Both delimiter lines, the body, and the trailing newline. */
	raw: string;
	body: string;
}

// Display math blocks: opening `$$` / `\[` and closing `$$` / `\]` each alone on
// their own line (≤3 leading spaces). Matched at the block level — before
// paragraph/list parsing — so a multi-line equation (e.g. a matrix with `\\`
// row breaks) survives as one unit and blank lines inside the block don't split
// it. The own-line requirement leaves inline `$$…$$` inside prose to the span
// grammar below. `\r?\n` at each line boundary keeps the grammar CRLF-safe for
// direct callers; marked-fed renderers already normalize line endings first.
const MATH_BLOCK_DOLLAR = /^ {0,3}\$\$[ \t]*\r?\n([\s\S]+?)\r?\n {0,3}\$\$[ \t]*(?:\r?\n|$)/;
const MATH_BLOCK_BRACKET = /^ {0,3}\\\[[ \t]*\r?\n([\s\S]+?)\r?\n {0,3}\\\][ \t]*(?:\r?\n|$)/;

/**
 * Leftmost offset at or after `from` where an opener could begin. A scan hint,
 * not a decision: whether that candidate is really math — escaped, currency,
 * unclosed — is decided by {@link mathSpanAt}.
 */
// One forward pass that stops at the first candidate.
export function mathStartIndex(source: string, from = 0): number | undefined {
	for (let at = from; at < source.length; at++) {
		if (mathOpenerAt(source, at) !== undefined) return at;
	}
	return undefined;
}

/** Math opener at `at`, or `undefined` when no delimiter starts there. */
export function mathOpenerAt(source: string, at: number): MathOpener | undefined {
	const first = source.charCodeAt(at);
	if (first === 0x24 /* $ */) return source.charCodeAt(at + 1) === 0x24 ? "$$" : "$";
	if (first !== 0x5c /* \ */) return undefined;
	const second = source.charCodeAt(at + 1);
	if (second === 0x28 /* ( */) return "\\(";
	if (second === 0x5b /* [ */) return "\\[";
	return undefined;
}

/**
 * The span opened at `at`, or `undefined` when the run is not math — including
 * an opener the source escaped, so `\$x$` and `\\(x\)` are literal text.
 *
 * `from` bounds how far back the escape scan may look. Leave it at 0 when
 * reading raw source. Pass the offset your own walk resumed at if you have
 * already consumed the escapes behind it, as `renderMathInText` does: after it
 * emits the `\\` of `\\\(x\)`, the `\(` that follows is a real opener even
 * though a backslash precedes it.
 */
export function mathSpanAt(source: string, at: number, from = 0): MathSpan | undefined {
	const opener = mathOpenerAt(source, at);
	if (opener === undefined || escapedAt(source, at, from)) return undefined;
	const bodyStart = at + opener.length;
	return spanOf(
		source,
		opener,
		bodyStart,
		opener === "$" ? scanDollar(source, at).close : closerIndex(source, opener, bodyStart),
	);
}

/**
 * The math spans of one source, found as {@link mathSpanAt} finds them with the escape scan stopping at the opener
 * (the caller has consumed the escapes before it). A closer scan also answers for the openers of its kind that it
 * passed, which meet the same closer or none, so asking at every opener of a long run reads the run once.
 */
export class MathSpans {
	readonly #source: string;
	// The last `$` whose closer scan ran, where that scan stopped, and the `$` it closed at (-1 for none): a scan from
	// a `$` between the two reads what that scan read past it. When it closed, the last offset before its closer that
	// is not whitespace, which the body of a span needs.
	#dollarOpen = -1;
	#dollarStop = -1;
	#dollarClose = -1;
	#dollarSolid = -1;
	// Per opener other than `$`, the last body start whose closer search ran and the closer it found (-1 for none).
	readonly #searchedFrom: Record<Exclude<MathOpener, "$">, number> = {
		$$: Infinity,
		"\\(": Infinity,
		"\\[": Infinity,
	};
	readonly #closer: Record<Exclude<MathOpener, "$">, number> = { $$: -1, "\\(": -1, "\\[": -1 };

	constructor(source: string) {
		this.#source = source;
	}

	/** The span opened at `at` that ends by `end`, or `undefined`. */
	spanAt(at: number, end = this.#source.length): MathSpan | undefined {
		const source = this.#source;
		const opener = mathOpenerAt(source, at);
		if (opener === undefined) return undefined;
		const bodyStart = at + opener.length;
		const close = opener === "$" ? this.#dollarCloser(at) : this.#closerFrom(opener, bodyStart);
		if (close === -1 || close + opener.length > end) return undefined;
		return spanOf(source, opener, bodyStart, close);
	}

	/** The `$` closing the span that the `$` at `open` opens, or -1. */
	#dollarCloser(open: number): number {
		const source = this.#source;
		if (this.#dollarOpen < open && open < this.#dollarStop) {
			// That scan passed this `$` and went on from the offset after it, where this one's scan starts.
			if (this.#dollarClose === -1 || !dollarOpens(source, open)) return -1;
			return this.#dollarSolid > open ? this.#dollarClose : -1;
		}
		const { close, stop } = scanDollar(source, open);
		this.#dollarOpen = open;
		this.#dollarStop = stop;
		this.#dollarClose = close;
		if (close !== -1) {
			let solid = close - 1;
			while (WHITESPACE.test(source[solid]!)) solid--;
			this.#dollarSolid = solid;
		}
		return close;
	}

	/** The closer of `opener` at or after `bodyStart`, the start of its body, or -1. */
	#closerFrom(opener: Exclude<MathOpener, "$">, bodyStart: number): number {
		// A body start follows its opener's `$`, `(` or `[`, so the backslashes before a closer after it never reach
		// back past it: every later body start up to the closer found finds that same closer.
		const found = this.#closer[opener];
		if (this.#searchedFrom[opener] <= bodyStart && (found === -1 || bodyStart <= found)) return found;
		const close = closerIndex(this.#source, opener, bodyStart);
		this.#searchedFrom[opener] = bodyStart;
		this.#closer[opener] = close;
		return close;
	}
}

const spansByContext = new WeakMap<object, MathSpans>();

/**
 * The span opened at the start of `src`, with `end` counted from there, for a marked inline tokenizer: `src` is the
 * part of `context.source` before `context.end` that the tokenizer received, and the scans are remembered per
 * context, which marked keeps for one inline source and the link labels and emphasis inside it. Only a span that ends
 * by `context.end` counts. Inside a label or emphasis, `context.end` holds its closer (`]`, `*` or `_`), which is not
 * a digit, so a `$` right before it closes there as it would at the end of the text.
 */
export function mathSpanInContext(context: { source?: string; end?: number }, src: string): MathSpan | undefined {
	const source = context.source ?? src;
	const end = context.end ?? source.length;
	let spans = spansByContext.get(context);
	if (!spans) spansByContext.set(context, (spans = new MathSpans(source)));
	const at = end - src.length;
	const span = spans.spanAt(at, end);
	return span && { ...span, end: span.end - at };
}

function spanOf(source: string, opener: MathOpener, bodyStart: number, closeAt: number): MathSpan | undefined {
	if (closeAt === -1) return undefined;
	const body = source.slice(bodyStart, closeAt);
	// `scanDollar` already rejects an all-space `$…$`; `$$ $$` needs the
	// same guard here, while `\(\)` and `\[\]` are unambiguous enough to keep.
	if (opener === "$$" && body.trim() === "") return undefined;
	return { opener, display: opener === "$$" || opener === "\\[", end: closeAt + opener.length, body };
}

/** The own-line display block starting at offset 0, or `undefined`. */
export function mathBlockAt(source: string): MathBlock | undefined {
	const match = MATH_BLOCK_DOLLAR.exec(source) ?? MATH_BLOCK_BRACKET.exec(source);
	if (!match || match[1].trim() === "") return undefined;
	return { raw: match[0], body: match[1] };
}

/**
 * Offset of the `$$` / `\)` / `\]` that closes a span, or -1. In `\(a \\) b\)`
 * the `\\` is a TeX row break, so that `)` is body text and the span closes at
 * the final `\)`.
 */
function closerIndex(source: string, opener: MathOpener, from: number): number {
	// Dollar closers equal their openers; the bracket forms flip the bracket.
	const closer = opener === "\\(" ? "\\)" : opener === "\\[" ? "\\]" : opener;
	for (let at = source.indexOf(closer, from); at !== -1; at = source.indexOf(closer, at + 1)) {
		if (!escapedAt(source, at, from)) return at;
	}
	return -1;
}

/** An odd run of backslashes back to `from` escapes the delimiter at `index`. */
function escapedAt(source: string, index: number, from: number): boolean {
	let backslashes = 0;
	for (let at = index - 1; at >= from && source.charCodeAt(at) === 0x5c /* \ */; at--) backslashes++;
	return backslashes % 2 === 1;
}

/** What `trim` removes: a span's body needs something else. */
const WHITESPACE = /\s/;

/** Whether the `$` at `open` can open a span: it is followed by something other than a space, tab, line break or `$`. */
function dollarOpens(source: string, open: number): boolean {
	const after = source[open + 1];
	return !(after === undefined || after === " " || after === "\t" || after === "\n" || after === "$");
}

/**
 * Offset of the `$` that closes an inline span opened at `open`, or -1, and where
 * the scan stopped: at that `$`, or where it ruled a closer out. Pandoc's
 * anti-currency heuristics: the opener must not be followed by whitespace, the
 * closer must not be preceded by whitespace nor followed by a digit, `\$` is a
 * literal dollar, and the span may not cross a newline — so "$5 and $10" is
 * prose, not math.
 */
function scanDollar(source: string, open: number): { close: number; stop: number } {
	if (!dollarOpens(source, open)) return { close: -1, stop: open + 1 };
	for (let at = open + 1; at < source.length; at++) {
		const char = source[at];
		if (char === "\\") {
			at++;
			continue;
		}
		if (char === "\n") return { close: -1, stop: at };
		if (char !== "$") continue;
		const before = source[at - 1];
		if (before === " " || before === "\t") return { close: -1, stop: at };
		const next = source[at + 1];
		if (next !== undefined && next >= "0" && next <= "9") continue; // currency: keep scanning
		return { close: source.slice(open + 1, at).trim().length > 0 ? at : -1, stop: at };
	}
	return { close: -1, stop: source.length };
}
