/**
 * Tolerant JSON lexer shared by the final parser (`parseJsonWithRepair`), the
 * streaming partial builder (`parseStreamingJson`), and the incoming cursors
 * (`IncomingDoc`). {@link JsonLexerMode} selects how truncation and unescaped
 * inner double quotes are treated.
 *
 * The grammar is a forgiving superset of JSON covering malformations commonly
 * produced by language models:
 *
 * - single-quoted strings and unquoted object keys (JSON5);
 * - trailing / stray commas, and `//` + block comments;
 * - Python literals `True` / `False` / `None`, plus `0x` / `0b` numbers;
 * - raw control characters and invalid `\x` escapes inside strings (kept literally);
 * - unescaped quotes inside strings — a single quote only closes a string when
 *   followed by a value terminator, recovering apostrophes such as `'it's'`;
 *   the same recovery applies to double quotes in `streaming` mode only,
 *   everywhere else they close strictly;
 * - unquoted string values in value position — an unrecognized bareword such
 *   as `{"paths": packages/foo/*}` is recovered as a string up to the next
 *   `,` / `}` / `]` / newline.
 */

export const QUOTE = 0x22;
export const SQUOTE = 0x27;
export const BACKSLASH = 0x5c;
export const SLASH = 0x2f;
export const COLON = 0x3a;
export const COMMA = 0x2c;
export const LBRACE = 0x7b;
export const RBRACE = 0x7d;
export const LBRACKET = 0x5b;
export const RBRACKET = 0x5d;
const U = 0x75;

/** Valid chars after `\` in a strict JSON escape: `" \ / b f n r t u`. */
export const VALID_ESCAPE_CHAR = new Uint8Array(128);
for (const ch of '"\\/bfnrtu') VALID_ESCAPE_CHAR[ch.charCodeAt(0)] = 1;

export function isHexDigit(cp: number): boolean {
	return (cp >= 0x30 && cp <= 0x39) || ((cp | 0x20) >= 0x61 && (cp | 0x20) <= 0x66);
}

/** JSON insignificant whitespace (RFC 8259 §2). */
export function isWhitespace(cp: number): boolean {
	return cp === 0x20 || cp === 0x09 || cp === 0x0a || cp === 0x0d;
}

function isIdentChar(cp: number): boolean {
	return (
		(cp >= 0x30 && cp <= 0x39) ||
		((cp | 0x20) >= 0x61 && (cp | 0x20) <= 0x7a) ||
		cp === 0x5f /* _ */ ||
		cp === 0x24 /* $ */
	);
}

/** First char of a numeric token: sign, dot, or digit. */
export function isNumberStart(cp: number): boolean {
	return cp === 0x2d /* - */ || cp === 0x2b /* + */ || cp === 0x2e /* . */ || (cp >= 0x30 && cp <= 0x39);
}

/** Chars that may continue a relaxed numeric token: digits, sign, dot, exponent, radix prefix, hex digits. */
function isNumberChar(cp: number): boolean {
	return (
		(cp >= 0x30 && cp <= 0x39) ||
		cp === 0x2d ||
		cp === 0x2b ||
		cp === 0x2e ||
		((cp | 0x20) >= 0x61 && (cp | 0x20) <= 0x66) ||
		(cp | 0x20) === 0x78 /* x */
	);
}

/** Keyword literals: standard JSON plus Python `True`/`False`/`None`. */
const KEYWORDS: readonly (readonly [string, boolean | null])[] = [
	["true", true],
	["false", false],
	["null", null],
	["True", true],
	["False", false],
	["None", null],
];

/**
 * JS-only atoms never recovered as bareword strings — a tool must not execute
 * with a non-finite or undefined argument masquerading as a string.
 */
const NON_RECOVERABLE_BAREWORDS: Record<string, true> = {
	NaN: true,
	Infinity: true,
	"-Infinity": true,
	"+Infinity": true,
	undefined: true,
};

/** Decode four hex digits at `pos`, or `-1` when fewer than four hex digits are available. */
function hex4(s: string, pos: number): number {
	if (pos + 4 > s.length) return -1;
	let value = 0;
	for (let k = pos; k < pos + 4; k++) {
		const cp = s.charCodeAt(k);
		if (!isHexDigit(cp)) return -1;
		value = (value << 4) | parseInt(s[k], 16);
	}
	return value;
}

/**
 * Index of the first char at or after `i` that is not whitespace or part of a
 * `//` line / `/* *\/` block comment. A lone `/` at the end of input is not a
 * comment and is left in place.
 */
function skipInsignificant(s: string, i: number): number {
	const n = s.length;
	for (;;) {
		while (i < n && isWhitespace(s.charCodeAt(i))) i++;
		if (i + 1 < n && s.charCodeAt(i) === SLASH) {
			const next = s.charCodeAt(i + 1);
			if (next === SLASH) {
				i += 2;
				while (i < n && s.charCodeAt(i) !== 0x0a) i++;
				continue;
			}
			if (next === 0x2a /* * */) {
				i += 2;
				while (i + 1 < n && !(s.charCodeAt(i) === 0x2a && s.charCodeAt(i + 1) === SLASH)) i++;
				i = Math.min(i + 2, n);
				continue;
			}
		}
		return i;
	}
}

/**
 * Grammar tolerance selected by the lexer's consumer.
 *
 * - `strict`: final parse — complete input required, double quotes close strictly.
 * - `streaming`: mid-stream snapshot — incomplete tokens tolerated and unescaped
 *   inner double quotes recovered for display.
 * - `incoming`: incremental typed pulls — incomplete tokens tolerated, but double
 *   quotes close strictly so pulled values match the final parse.
 */
export type JsonLexerMode = "strict" | "streaming" | "incoming";

/** Decoded state of a string token at the current streaming edge. */
export interface JsonStringProgress {
	/** Decoded content so far (complete when `complete` is true). */
	value: string;
	/**
	 * Length of the prefix of `value` whose meaning cannot change when more
	 * input arrives. Excludes a trailing split escape, a high surrogate whose
	 * low half may still follow, and everything from a quote whose close/inner
	 * reading is still undecidable at the buffer edge.
	 */
	stableLen: number;
	/** Whether the closing quote was consumed. */
	complete: boolean;
}

/** Reading of the lookahead past a candidate closing quote. */
const enum QuoteLook {
	/** A value terminator (or end of input) follows: the quote closes. */
	Closes,
	/** Ordinary content follows: the quote is literal (inner-quote recovery). */
	Inner,
	/** A lone `/` at the buffer edge may still grow into a comment and flip this quote from inner to closing. */
	Undecided,
}

/**
 * Cursor over the input with the tolerant token readers. `pos` is the current
 * offset; readers advance it. In `strict` mode a truncated or malformed token
 * throws `SyntaxError`; the lenient modes report progress or return
 * `undefined` so the caller can roll back.
 */
export class JsonLexer {
	pos: number;

	constructor(
		readonly src: string,
		readonly mode: JsonLexerMode,
		pos = 0,
	) {
		this.pos = pos;
	}

	get atEnd(): boolean {
		return this.pos >= this.src.length;
	}

	/** Char code at the cursor; `NaN` at end of input (so every comparison is false). */
	peek(): number {
		return this.src.charCodeAt(this.pos);
	}

	/** Skip whitespace plus `//` line and `/* *\/` block comments. */
	ws(): void {
		this.pos = skipInsignificant(this.src, this.pos);
	}

	/**
	 * Read a string starting at the opening `quote`, retaining the information
	 * an incremental consumer needs. Strict mode throws on an unterminated
	 * string; lenient modes consume to the end of input and report progress.
	 */
	string(quote: number): JsonStringProgress {
		const s = this.src;
		const n = s.length;
		let i = this.pos + 1; // skip opening quote
		let out = "";
		let runStart = i;
		let unstableFrom = -1;
		// Apostrophe / inner-quote recovery (a quote that isn't followed by a
		// value terminator is literal) is always safe for single quotes; for
		// double quotes it is streaming-only display leniency. Elsewhere double
		// quotes close on the first unescaped quote like standard JSON, so
		// malformed structure fails loudly instead of silently swallowing
		// commas/colons or sibling members.
		const lenient = quote === SQUOTE || this.mode === "streaming";
		while (i < n) {
			const cc = s.charCodeAt(i);
			if (cc !== BACKSLASH && cc !== quote) {
				i++;
				continue;
			}
			if (cc === quote) {
				const look = lenient ? this.#quoteLookahead(i + 1) : QuoteLook.Closes;
				if (look === QuoteLook.Closes) {
					out += s.slice(runStart, i);
					this.pos = i + 1;
					return { value: out, stableLen: out.length, complete: true };
				}
				if (look === QuoteLook.Undecided && unstableFrom < 0) unstableFrom = out.length + (i - runStart);
				i++;
				continue;
			}
			// Backslash escape.
			out += s.slice(runStart, i);
			const escapeStart = out.length;
			i++;
			if (i >= n) {
				if (unstableFrom < 0) unstableFrom = escapeStart;
				out += "\\";
				runStart = i;
				break;
			}
			const esc = s.charCodeAt(i);
			switch (esc) {
				case QUOTE:
					out += '"';
					break;
				case SQUOTE:
					out += "'";
					break;
				case BACKSLASH:
					out += "\\";
					break;
				case SLASH:
					out += "/";
					break;
				case 0x62:
					out += "\b";
					break;
				case 0x66:
					out += "\f";
					break;
				case 0x6e:
					out += "\n";
					break;
				case 0x72:
					out += "\r";
					break;
				case 0x74:
					out += "\t";
					break;
				case U: {
					const unit = hex4(s, i + 1);
					if (unit >= 0) {
						i += 4;
						out += String.fromCharCode(unit);
						// A high surrogate at the streaming edge may acquire its low
						// surrogate in the next fragment, so do not commit it yet.
						if (unit >= 0xd800 && unit < 0xdc00 && this.mode !== "strict" && i + 7 > n && unstableFrom < 0) {
							unstableFrom = escapeStart;
						}
					} else {
						if (i + 5 > n && this.mode !== "strict" && unstableFrom < 0) unstableFrom = escapeStart;
						out += "\\u"; // invalid \u — keep literal
					}
					break;
				}
				default:
					out += `\\${s[i]}`; // invalid escape — keep backslash literal
			}
			i++;
			runStart = i;
		}
		if (this.mode === "strict") throw new SyntaxError("Unterminated string");
		out += s.slice(runStart, n);
		this.pos = i;
		return { value: out, stableLen: unstableFrom < 0 ? out.length : unstableFrom, complete: false };
	}

	/**
	 * Classify the lookahead after a candidate closing quote: a quote closes a
	 * string only when the next significant char (past whitespace and comments)
	 * ends a value.
	 */
	#quoteLookahead(from: number): QuoteLook {
		const s = this.src;
		const k = skipInsignificant(s, from);
		if (k >= s.length) return QuoteLook.Closes;
		const c = s.charCodeAt(k);
		if (c === COMMA || c === RBRACE || c === RBRACKET || c === COLON) return QuoteLook.Closes;
		if (c === SLASH && k + 1 === s.length && this.mode !== "strict") return QuoteLook.Undecided;
		return QuoteLook.Inner;
	}

	/**
	 * Read a numeric token with JS `Number()` semantics (decimal with optional
	 * sign / leading or trailing dot / exponent, plus `0x` hex and `0b` binary).
	 * Non-finite or malformed tokens throw in strict mode and return
	 * `undefined` in lenient modes; the cursor is left past the token either way.
	 */
	number(): number | undefined {
		const s = this.src;
		const start = this.pos;
		let i = start;
		while (i < s.length && isNumberChar(s.charCodeAt(i))) i++;
		this.pos = i;
		const token = s.slice(start, i);
		const value = Number(token);
		if (Number.isFinite(value)) return value;
		if (this.mode === "strict") throw new SyntaxError(`Invalid number: ${token}`);
		return undefined;
	}

	/**
	 * Match a keyword literal at the cursor; consumes only on success and
	 * returns `undefined` otherwise. Requires a non-identifier boundary so
	 * `Truex` / `nullish` are not misread as the keyword followed by junk.
	 */
	keyword(): boolean | null | undefined {
		const s = this.src;
		for (const [word, value] of KEYWORDS) {
			if (s.startsWith(word, this.pos) && !isIdentChar(s.charCodeAt(this.pos + word.length))) {
				this.pos += word.length;
				return value;
			}
		}
		return undefined;
	}

	/** Read an unquoted object key: everything up to `:` / `,` / `}` / whitespace. May be empty. */
	unquotedKey(): string {
		const s = this.src;
		const start = this.pos;
		let i = start;
		while (i < s.length) {
			const cc = s.charCodeAt(i);
			if (cc === COLON || cc === COMMA || cc === RBRACE || isWhitespace(cc)) break;
			i++;
		}
		this.pos = i;
		return s.slice(start, i);
	}

	/**
	 * Recover an unquoted string value, e.g. `{"paths": packages/foo/*}`:
	 * consume until `,` / `}` / `]` / newline and trim trailing whitespace.
	 * Recovery still fails — so a final parse never accepts a half-formed or
	 * non-finite argument — when the token:
	 * - hits end-of-input before a delimiter (truncated value);
	 * - contains a `"`, `{`, `[`, or a key-like `:` — this grammar accepts
	 *   unquoted keys, so a missed comma (`{"a": foo "b": 1}`) would otherwise
	 *   silently swallow the following field. A colon followed by `/` or `\`
	 *   stays literal so URL and Windows-path values recover;
	 * - is a non-finite atom ({@link NON_RECOVERABLE_BAREWORDS}).
	 *
	 * Failure throws in strict mode and returns `undefined` in lenient modes.
	 */
	bareword(): string | undefined {
		const s = this.src;
		const start = this.pos;
		let i = start;
		while (i < s.length) {
			const cc = s.charCodeAt(i);
			if (cc === COMMA || cc === RBRACE || cc === RBRACKET || cc === 0x0a || cc === 0x0d) break;
			if (
				cc === QUOTE ||
				cc === LBRACE ||
				cc === LBRACKET ||
				(cc === COLON && s.charCodeAt(i + 1) !== SLASH && s.charCodeAt(i + 1) !== BACKSLASH)
			) {
				return this.#unexpected(start);
			}
			i++;
		}
		if (i >= s.length) return this.#unexpected(start);
		let end = i;
		while (end > start && isWhitespace(s.charCodeAt(end - 1))) end--;
		const word = s.slice(start, end);
		if (NON_RECOVERABLE_BAREWORDS[word]) return this.#unexpected(start);
		this.pos = i;
		return word;
	}

	#unexpected(at: number): undefined {
		if (this.mode === "strict") throw new SyntaxError(`Unexpected token at position ${at}`);
		return undefined;
	}
}

/**
 * The first object key repeated within one object of `src`, in source order, or
 * `undefined` when none is.
 *
 * `JSON.parse` keeps only the last value for a repeated key, and a `reviver` is
 * called once per SURVIVING member — the discarded duplicate never reaches it —
 * so a duplicate cannot be recovered after parsing. A loader that must reject a
 * repeated key rather than silently adopt its last spelling has to scan the raw
 * text, which is what this does: it walks the tokens with {@link JsonLexer} and
 * tracks a seen-set per open object. Array members are positional and cannot
 * collide, so an open array suppresses the check until it closes.
 *
 * Keys are compared DECODED, because that is the form `JSON.parse` collapses
 * them to before dropping one: `"a\u002db"` and `"a-b"` are the same member.
 *
 * This is a scan beside a real parse, never a replacement for one: it neither
 * throws nor reports a duplicate for malformed input, leaving syntax errors to
 * the caller's parser so a broken document reports as the parse error it is. A
 * quoted string in key position therefore counts as a member only once its `:`
 * arrives — a trailing `"a"` with no colon never became one, so nothing was
 * dropped for it to collide with. A string left unterminated at the end of
 * input is not a candidate either.
 *
 * Holding to that contract needs more than the scan can see on its own: the
 * lexer walks structure, not grammar, so `{"a":1,"a":2` (unclosed) and
 * `{"a":1,"a":}` (missing value) both reach a genuine second `"a":` and would
 * be reported as duplicates even though a real parse refuses them. The first
 * repeat is therefore RETAINED, not returned, and confirmed with one
 * `JSON.parse` of the whole document once the scan finishes. That parse runs
 * only on the rare duplicate path — a document with no repeated key returns
 * without it.
 */
export function findDuplicateJsonKey(src: string): string | undefined {
	// `incoming` closes double-quoted strings on the first unescaped quote, like
	// standard JSON, and reports truncation instead of throwing — the two
	// properties this scan needs. `strict` would throw on the truncated input
	// the caller's parser is responsible for rejecting.
	const lex = new JsonLexer(src, "incoming");
	// One seen-set per open object; `undefined` marks an open array.
	const stack: (Set<string> | undefined)[] = [];
	let expectKey = false;
	// A complete key string that has not reached its `:` yet. A quoted string in
	// key position becomes a MEMBER only once that colon arrives, and only a
	// member can have been dropped by a later duplicate. Committing on the
	// string alone reports the trailing `"a"` of `{"a":1,"a"` as a repeat of the
	// real `"a"`, which contradicts the documented contract that this scan
	// reports no duplicate for input a real parse would refuse.
	let pendingKey: string | undefined;
	// The first repeat found, held until the document is known to be valid.
	let candidate: string | undefined;
	while (!lex.atEnd) {
		const cp = lex.peek();
		if (cp === QUOTE) {
			const { value, complete } = lex.string(QUOTE);
			if (expectKey) {
				if (complete) pendingKey = value;
				expectKey = false;
			}
			continue;
		}
		if (cp === LBRACE) {
			stack.push(new Set());
			expectKey = true;
		} else if (cp === LBRACKET) {
			stack.push(undefined);
			expectKey = false;
		} else if (cp === RBRACE || cp === RBRACKET) {
			stack.pop();
			expectKey = false;
			pendingKey = undefined;
		} else if (cp === COLON) {
			if (pendingKey !== undefined) {
				const keys = stack[stack.length - 1];
				if (keys !== undefined) {
					if (keys.has(pendingKey)) candidate ??= pendingKey;
					keys.add(pendingKey);
				}
				pendingKey = undefined;
			}
		} else if (cp === COMMA) {
			// A comma inside an object introduces the next key; inside an array, or
			// at the top level, it introduces a positional value.
			expectKey = stack[stack.length - 1] !== undefined;
			pendingKey = undefined;
		}
		lex.pos++;
	}
	if (candidate === undefined) return undefined;
	try {
		JSON.parse(src);
	} catch {
		// Malformed: the caller's parser owns this, and reporting a duplicate here
		// would misclassify a syntax error.
		return undefined;
	}
	return candidate;
}
