/**
 * The plain-text step of inline lexing over one inline source: where text can end ({@link TextStops}, which also
 * tells the bare-URL rule where it can match) and how it is appended ({@link TextRun}).
 */
import type { Lexer, Token, TokenizerExtension, TokenizerStartFromFunction, Tokens } from "./core";

// Where plain text can end: the characters that start other inline tokens, and
// the scheme alternatives of the bare-URL rule. Global so a search can resume
// at `lastIndex`.
const TOKEN_START_CHAR = /[\\`<[!*_~\n]/g;
const BARE_URL_SCHEME = /https?:\/\/|ftp:\/\/|www\./gi;
// What the bare-URL rule's e-mail alternative requires after its "@", sticky to test one offset.
const DOTTED_DOMAIN = /[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+/iy;
/** A stop not searched for yet lies before every search offset. */
const UNSEARCHED = -1;

/** Whether `code` is in `[A-Za-z0-9._+-]`, the local part of a bare e-mail address. */
function isMailLocalChar(code: number): boolean {
	return (
		(code >= 0x61 && code <= 0x7a) ||
		(code >= 0x41 && code <= 0x5a) ||
		(code >= 0x30 && code <= 0x39) ||
		code === 0x2e ||
		code === 0x5f ||
		code === 0x2b ||
		code === 0x2d
	);
}

/** Where `startFrom` answers at or after `from` in `src`, `Infinity` for none. Any other answer throws. */
function askStartFrom(
	extension: TokenizerExtension,
	startFrom: TokenizerStartFromFunction,
	lexer: Lexer,
	src: string,
	from: number,
): number {
	const found = startFrom.call({ lexer }, src, from);
	// Only undefined or a number at or past `from` answers: a -1 or NaN "none" would be searched for again at every
	// text step, and `null >= 0` holds only at offset 0.
	if (found !== undefined && !(typeof found === "number" && found >= from)) {
		throw new Error(`inline extension "${extension.name}": startFrom returned ${found} for offset ${from}`);
	}
	return found ?? Infinity;
}

/**
 * The places where plain text can end in one root inline source, as offsets into it, shared by every source lexed
 * inside it (a link label, the text of emphasis). Each stop is the first offset at or after a search offset where a
 * test passes, and each test reads the source only from its own offset on, so a found stop stays the answer for every
 * later search offset up to it. A stop is searched for again only after lexing passes it, starting past it, so all
 * the text steps of a paragraph, at every nesting level, read it a bounded number of times instead of once per step.
 * Search offsets never decrease: the lexer asks at its position for the bare-URL rule and one past it for the text
 * step, its position only grows, and a nested source is lexed from its start to its end before the lexer goes on
 * past it.
 *
 * A nested source is the part of the root source before `end`, and a stop that holds there is a stop of the root
 * source whose match ends by `end`. The first root stop after an offset tells whether there is one: when its match
 * runs past `end`, no stop that ends by `end` follows it, for the reason each search gives.
 */
class RootTextStops {
	readonly #src: string;
	// The next character in TOKEN_START_CHAR.
	#tokenChar = UNSEARCHED;
	// The next bare-URL scheme and the end of its match.
	#scheme = UNSEARCHED;
	#schemeEnd = UNSEARCHED;
	// The next offset in a run of e-mail local characters that ends at "@", and that "@".
	#mail = UNSEARCHED;
	#mailAt = UNSEARCHED;
	// The next hard break (two or more spaces, or a backslash, before "\n") and its "\n".
	#hardBreak = UNSEARCHED;
	#hardBreakAt = UNSEARCHED;
	// Per inline extension, the offset its `startFrom` last returned. Keyed by the extension itself: `Marked.use`
	// can add extensions to the live registry during a lex, shifting every index.
	#extensionStarts: Map<TokenizerExtension, number> | undefined;

	constructor(src: string) {
		this.#src = src;
	}

	/** The first character that can start another token at or after `from`. */
	tokenCharFrom(from: number): number {
		if (this.#tokenChar < from) {
			TOKEN_START_CHAR.lastIndex = from;
			this.#tokenChar = TOKEN_START_CHAR.test(this.#src) ? TOKEN_START_CHAR.lastIndex - 1 : Infinity;
		}
		return this.#tokenChar;
	}

	/** The first bare-URL scheme at or after `from` that ends by `end`. */
	schemeFrom(from: number, end: number): number {
		if (this.#scheme < from) {
			BARE_URL_SCHEME.lastIndex = from;
			const match = BARE_URL_SCHEME.exec(this.#src);
			this.#scheme = match ? match.index : Infinity;
			this.#schemeEnd = match ? BARE_URL_SCHEME.lastIndex : Infinity;
		}
		// Two scheme matches never overlap (inside one, no later character starts another), so when this one runs
		// past `end`, the next starts past it.
		return this.#schemeEnd <= end ? this.#scheme : Infinity;
	}

	/** The "@" of the run {@link mailFrom} last found. */
	get mailAt(): number {
		return this.#mailAt;
	}

	/** The first offset at or after `from` that starts a match of `/[A-Za-z0-9._+-]+@/` whose "@" is before `end`. */
	mailFrom(from: number, end: number): number {
		// Every offset in the run before the found "@" starts a match of its own, and reaches no other "@".
		if (this.#mail < from) this.#mail = from < this.#mailAt ? from : this.#seekMail(from);
		return this.#mailAt < end ? this.#mail : Infinity;
	}

	/** The first offset at or after `from` that starts a match of `/(?: {2,}|\\)\n/` whose "\n" is before `end`. */
	hardBreakFrom(from: number, end: number): number {
		// A text step never starts where a hard break still matches (the `br` rule takes it first), so a search
		// after passing a found break starts at or past its "\n". A match ends at the first "\n" after it starts.
		if (this.#hardBreak < from) this.#hardBreak = this.#seekHardBreak(from);
		return this.#hardBreakAt < end ? this.#hardBreak : Infinity;
	}

	/** Where `extension`'s `startFrom` hint points at or after `from`, asked again only once lexing passes it. */
	startFrom(extension: TokenizerExtension, startFrom: TokenizerStartFromFunction, lexer: Lexer, from: number): number {
		const starts = (this.#extensionStarts ??= new Map());
		const cached = starts.get(extension) ?? UNSEARCHED;
		if (cached >= from) return cached;
		const start = askStartFrom(extension, startFrom, lexer, this.#src, from);
		starts.set(extension, start);
		return start;
	}

	/** The first offset at or after `from` that starts a match of `/[A-Za-z0-9._+-]+@/`, recording its "@". */
	#seekMail(from: number): number {
		const src = this.#src;
		for (let at = src.indexOf("@", from + 1); at !== -1; at = src.indexOf("@", at + 1)) {
			let start = at;
			while (start > from && isMailLocalChar(src.charCodeAt(start - 1))) start--;
			if (start < at) {
				this.#mailAt = at;
				return start;
			}
		}
		return Infinity;
	}

	/** The first offset at or after `from` that starts a match of `/(?: {2,}|\\)\n/`, recording its "\n". */
	#seekHardBreak(from: number): number {
		const src = this.#src;
		for (let end = src.indexOf("\n", from + 1); end !== -1; end = src.indexOf("\n", end + 1)) {
			let start = end;
			while (start > from && src.charCodeAt(start - 1) === 0x20 /* space */) start--;
			if (end - start < 2) {
				if (src.charCodeAt(end - 1) !== 0x5c /* \ */) continue;
				start = end - 1;
			}
			this.#hardBreakAt = end;
			return start;
		}
		return Infinity;
	}
}

/**
 * The places where one inline source's plain text can end, as offsets into that source: its root source's stops
 * that hold before the source's end. The source is a root source, or a part of one lexed as its own source (a link
 * label, the text of emphasis), which ends right before the delimiter that closes it.
 */
export class TextStops {
	readonly #src: string;
	readonly #lexer: Lexer;
	readonly #root: RootTextStops;
	// Where the source starts and ends in its root source, and whether it is the root source itself.
	readonly #start: number;
	readonly #end: number;
	readonly #isRoot: boolean;
	// The last "@" whose domain was tested, and whether a dotted domain follows it in the source.
	#domainAt = UNSEARCHED;
	#dottedDomain = false;
	// In a nested source, per inline extension, the offset its `startFrom` hint last pointed to in the source.
	#extensionStarts: Map<TokenizerExtension, number> | undefined;

	/** The stops of `src`, a root source, or else the part of `root`'s source that ends at `end`. */
	constructor(src: string, lexer: Lexer, root?: RootTextStops, end = src.length) {
		this.#src = src;
		this.#lexer = lexer;
		this.#root = root ?? new RootTextStops(src);
		this.#start = end - src.length;
		this.#end = end;
		this.#isRoot = root === undefined;
	}

	/** The stops of `src`, the part of this source's root source that ends at `end`, lexed as its own source. */
	nested(src: string, end: number): TextStops {
		return new TextStops(src, this.#lexer, this.#root, end);
	}

	/**
	 * Whether the bare-URL rule can match at `pos`: its first alternative needs a scheme there, and its second a
	 * run of e-mail local characters from `pos` to an "@" (the only "@" such a run can reach) with a dotted domain
	 * right after that "@", which is the same test for every offset of the run.
	 */
	bareUrlCanStart(pos: number): boolean {
		const root = this.#root;
		const at = this.#start + pos;
		if (root.schemeFrom(at, this.#end) === at) return true;
		if (root.mailFrom(at, this.#end) !== at) return false;
		const mailAt = root.mailAt - this.#start;
		if (this.#domainAt !== mailAt) {
			this.#domainAt = mailAt;
			DOTTED_DOMAIN.lastIndex = mailAt + 1;
			this.#dottedDomain = DOTTED_DOMAIN.test(this.#src);
		}
		return this.#dottedDomain;
	}

	/**
	 * Length of the plain text at the start of `rest`, a suffix of the source: the distance to the nearest later
	 * offset where another token could start or an inline extension's start hint points.
	 */
	textLength(rest: string): number {
		const root = this.#root;
		const end = this.#end;
		const pos = this.#src.length - rest.length;
		const at = this.#start + pos;
		const from = at + 1;
		let next =
			Math.min(
				end,
				root.tokenCharFrom(from),
				root.schemeFrom(from, end),
				root.mailFrom(from, end),
				root.hardBreakFrom(from, end),
			) - at;
		const lexer = this.#lexer;
		const extensions = lexer.extensions.inline;
		// Only a lexer with inline extensions enters the loop. The JIT can hoist a hint it inlined from another lexer's
		// extension, such as a search of `rest`, ahead of the loop, where it would run at every text step.
		if (extensions.length !== 0) {
			for (const extension of extensions) {
				// A hint at `pos` itself yields 0, which is ignored exactly like `start` returning 0.
				const hint = extension.startFrom
					? this.#startFrom(extension, extension.startFrom, pos) - pos
					: extension.start?.call({ lexer }, rest);
				if (typeof hint === "number" && hint > 0 && hint < next) next = hint;
			}
		}
		// `slice` reads a fractional hint from `start` as its integer part.
		return Math.trunc(next);
	}

	/**
	 * Where `extension`'s `startFrom` hint points at or after `pos`. A nested source takes the root source's answer
	 * and asks the hint in the source at it: a candidate of the source is one of the root source, since the hint's
	 * test at an offset reads only from there on and still passes where the source goes on, so none lies before the
	 * root's answer.
	 */
	#startFrom(extension: TokenizerExtension, startFrom: TokenizerStartFromFunction, pos: number): number {
		const root = this.#root;
		const lexer = this.#lexer;
		if (this.#isRoot) return root.startFrom(extension, startFrom, lexer, pos);
		const starts = (this.#extensionStarts ??= new Map());
		const cached = starts.get(extension) ?? UNSEARCHED;
		if (cached >= pos) return cached;
		const candidate = root.startFrom(extension, startFrom, lexer, this.#start + pos) - this.#start;
		const start =
			candidate < this.#src.length ? askStartFrom(extension, startFrom, lexer, this.#src, candidate) : Infinity;
		starts.set(extension, start);
		return start;
	}
}

/**
 * Appends plain text to one inline source's token list, merging into a text token before it as marked does. A text
 * token this run created grows by taking a longer slice of the source instead of by concatenation, so its raw stays
 * a flat string: reading its last character (the emphasis rule's look-behind) does not copy the whole token.
 */
export class TextRun {
	readonly #src: string;
	// The text token this run created, the source range it covers, and the one string held as its raw and text.
	#token: Tokens.Text | undefined;
	#start = 0;
	#end = 0;
	#value = "";

	constructor(src: string) {
		this.#src = src;
	}

	/** Appends the source text from `start` to `end`. */
	append(tokens: Token[], start: number, end: number): void {
		if (end <= start) return;
		const previous = tokens.at(-1);
		if (previous?.type === "text" && previous.tokens === undefined && previous.escaped === false) {
			// An extension may have rewritten this token; then append by concatenation as marked does.
			if (
				previous === this.#token &&
				start === this.#end &&
				previous.raw === this.#value &&
				previous.text === this.#value
			) {
				this.#end = end;
				this.#value = this.#src.slice(this.#start, end);
				previous.raw = this.#value;
				previous.text = this.#value;
				return;
			}
			const raw = this.#src.slice(start, end);
			previous.raw += raw;
			previous.text += raw;
			return;
		}
		const raw = this.#src.slice(start, end);
		this.#token = { type: "text", raw, text: raw, escaped: false };
		this.#start = start;
		this.#end = end;
		this.#value = raw;
		tokens.push(this.#token);
	}
}
