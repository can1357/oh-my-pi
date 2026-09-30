/**
 * LaTeX delimiter grammar for agent-authored Markdown: where does a math span
 * begin and end, in source offsets. Carries no rendering policy — what to do
 * with an unclosed opener, whether a body is typesettable, and how it is
 * displayed belong to the renderer (Unicode in the TUI, KaTeX in collab web).
 */

/** Opening delimiter. Each closer (`$`, `$$`, `\)`, `\]`) is as wide as its opener. */
export type MathOpener = "$" | "$$" | "\\(" | "\\[";

/** Opener of an own-line display block. */
export type MathBlockOpener = "$$" | "\\[";

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
const MATH_BLOCK_DOLLAR = / {0,3}\$\$[ \t]*\r?\n([\s\S]+?)\r?\n {0,3}\$\$[ \t]*(?:\r?\n|$)/y;
const MATH_BLOCK_BRACKET = / {0,3}\\\[[ \t]*\r?\n([\s\S]+?)\r?\n {0,3}\\\][ \t]*(?:\r?\n|$)/y;

/**
 * Leftmost offset at or after `from` where an opener could begin. A scan hint,
 * not a decision: whether that candidate is really math — escaped, currency,
 * unclosed — is decided by {@link mathSpanAt}.
 */
// Three indexOf scans instead of a `/\$|\\\(|\\\[/` alternation — marked calls
// this on the remaining source at every inline position, where the alternation
// showed up in CPU profiles (part of a ~4.3% start() tail).
export function mathStartIndex(source: string, from = 0): number | undefined {
	let best = source.indexOf("$", from);
	const paren = source.indexOf("\\(", from);
	if (paren !== -1 && (best === -1 || paren < best)) best = paren;
	const bracket = source.indexOf("\\[", from);
	if (bracket !== -1 && (best === -1 || bracket < best)) best = bracket;
	return best === -1 ? undefined : best;
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
	const closeAt = opener === "$" ? dollarCloserIndex(source, at) : closerIndex(source, opener, bodyStart);
	if (closeAt === -1) return undefined;
	const body = source.slice(bodyStart, closeAt);
	// `dollarCloserIndex` already rejects an all-space `$…$`; `$$ $$` needs the
	// same guard here, while `\(\)` and `\[\]` are unambiguous enough to keep.
	if (opener === "$$" && body.trim() === "") return undefined;
	return { opener, display: opener === "$$" || opener === "\\[", end: closeAt + opener.length, body };
}

/** The own-line display block starting at `from`, or `undefined`. */
export function mathBlockAt(source: string, from = 0): MathBlock | undefined {
	MATH_BLOCK_DOLLAR.lastIndex = from;
	MATH_BLOCK_BRACKET.lastIndex = from;
	return blockOf(MATH_BLOCK_DOLLAR.exec(source) ?? MATH_BLOCK_BRACKET.exec(source));
}

/** The block a match of the block grammar describes; a whitespace-only body is no block. */
function blockOf(match: RegExpExecArray | null): MathBlock | undefined {
	return match === null || match[1].trim() === "" ? undefined : { raw: match[0], body: match[1] };
}

// An own-line display opener line (`$$` or `\[` after up to 3 spaces), capturing
// the opener and the line's end: "" when it is the source's unterminated last line.
const MATH_BLOCK_OPENER_LINE_RE = / {0,3}(\$\$|\\\[)[ \t]*(\r?\n|$)/y;

/**
 * {@link mathBlockAt} for many offsets of one `source`. An own-line opener
 * whose closer line is missing means every later opener of the same kind
 * misses one too, since its search covers a suffix of that search. The scan
 * keeps that answer, so asking at every block start takes linear time instead
 * of a scan to the end of `source` per unclosed opener.
 */
export class MathBlockScan {
	readonly #source: string;
	// Offset of the first `$$` / `\[` opener line found with no closer line after it.
	#unclosedDollarFrom = Number.POSITIVE_INFINITY;
	#unclosedBracketFrom = Number.POSITIVE_INFINITY;

	constructor(source: string) {
		this.#source = source;
	}

	/** The own-line display block starting at `from`, or `undefined`. */
	at(from: number): MathBlock | undefined {
		MATH_BLOCK_OPENER_LINE_RE.lastIndex = from;
		const line = MATH_BLOCK_OPENER_LINE_RE.exec(this.#source);
		// An unterminated opener line opens no block.
		if (line === null || line[2] === "") return undefined;
		const dollar = line[1] === "$$";
		if (from >= (dollar ? this.#unclosedDollarFrom : this.#unclosedBracketFrom)) return undefined;
		const grammar = dollar ? MATH_BLOCK_DOLLAR : MATH_BLOCK_BRACKET;
		grammar.lastIndex = from;
		const match = grammar.exec(this.#source);
		if (match === null) {
			if (dollar) this.#unclosedDollarFrom = from;
			else this.#unclosedBracketFrom = from;
		}
		return blockOf(match);
	}
}

/**
 * The display opener alone on the line at `from` (up to 3 leading spaces,
 * trailing spaces or tabs; the source's last line may be unterminated), or
 * `undefined`.
 */
export function mathBlockOpenerAt(source: string, from = 0): MathBlockOpener | undefined {
	MATH_BLOCK_OPENER_LINE_RE.lastIndex = from;
	const line = MATH_BLOCK_OPENER_LINE_RE.exec(source);
	return line === null ? undefined : line[1] === "$$" ? "$$" : "\\[";
}

/**
 * Whether the own-line display block opened at `from` in `source` is closed,
 * or could still close once more text is appended: the text from `from`
 * onward is a streaming prefix whose real closer may not have arrived. A
 * closer on the unterminated last line has not arrived either, since the next
 * append may extend it into text (`$$ E = mc^2 $$`). With no opener line at
 * `from` it returns false before scanning, so a caller can ask at every block
 * start.
 */
export function mathBlockMayCloseAt(source: string, from = 0): boolean {
	MATH_BLOCK_OPENER_LINE_RE.lastIndex = from;
	const line = MATH_BLOCK_OPENER_LINE_RE.exec(source);
	if (line === null) return false;
	// The opener's own line is still being written.
	if (line[2] === "") return true;
	const grammar = line[1] === "$$" ? MATH_BLOCK_DOLLAR : MATH_BLOCK_BRACKET;
	grammar.lastIndex = from;
	const match = grammar.exec(source);
	// No closer line yet, or only on the last line, which is still being written.
	if (match === null || (from + match[0].length === source.length && !match[0].endsWith("\n"))) return true;
	return blockOf(match) !== undefined;
}

// A display closer alone on its line, captured; the last line counts unterminated.
const MATH_BLOCK_CLOSER_LINE_RE = /(?<=^|\n) {0,3}(\$\$|\\\])[ \t]*(?=\r?\n|$)/g;

/**
 * Whether a line of `source` from the line start `from` on holds the closer of
 * one of `openers` alone (up to 3 leading spaces, trailing spaces or tabs),
 * the unterminated last line included: a line at which a block that one of
 * them opened before `from` could close.
 */
export function hasMathBlockCloserLine(source: string, from: number, openers: readonly MathBlockOpener[]): boolean {
	if (openers.length === 0) return false;
	MATH_BLOCK_CLOSER_LINE_RE.lastIndex = from;
	for (
		let line = MATH_BLOCK_CLOSER_LINE_RE.exec(source);
		line !== null;
		line = MATH_BLOCK_CLOSER_LINE_RE.exec(source)
	) {
		if (openers.includes(line[1] === "$$" ? "$$" : "\\[")) return true;
	}
	return false;
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

/**
 * Offset of the `$` that closes an inline span opened at `open`, or -1. Pandoc's
 * anti-currency heuristics: the opener must not be followed by whitespace, the
 * closer must not be preceded by whitespace nor followed by a digit, `\$` is a
 * literal dollar, and the span may not cross a newline — so "$5 and $10" is
 * prose, not math.
 */
function dollarCloserIndex(source: string, open: number): number {
	const after = source[open + 1];
	if (after === undefined || after === " " || after === "\t" || after === "\n" || after === "$") return -1;
	for (let at = open + 1; at < source.length; at++) {
		const char = source[at];
		if (char === "\\") {
			at++;
			continue;
		}
		if (char === "\n") return -1;
		if (char !== "$") continue;
		const before = source[at - 1];
		if (before === " " || before === "\t") return -1;
		const next = source[at + 1];
		if (next !== undefined && next >= "0" && next <= "9") continue; // currency: keep scanning
		return source.slice(open + 1, at).trim().length > 0 ? at : -1;
	}
	return -1;
}
