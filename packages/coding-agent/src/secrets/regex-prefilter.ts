/**
 * Translate a JavaScript secret regex into a Rust `regex`-crate pattern that
 * matches wherever the JavaScript one does (a superset), for the native
 * prefilter: a text the translation cannot match cannot match the original, so
 * the JavaScript regex is only run where the prefilter reports a hit.
 *
 * Constructs the Rust engine lacks are widened, never narrowed:
 * - a positive lookbehind opening a top-level alternative, and a positive
 *   lookahead closing one, become consuming groups (the context they assert is
 *   present in the text next to the match); every other lookaround, every
 *   anchor and every word boundary is dropped;
 * - a backreference becomes any text;
 * - JavaScript's ASCII `\d`, `\w`, `\s` and their negations are spelled out as
 *   explicit classes, so Rust's Unicode classes cannot narrow them;
 * - negated classes skip case folding, which in Rust drops characters a
 *   case-insensitive JavaScript negated class matches; under `i` any other
 *   non-ASCII character but whitespace becomes any character, since the two
 *   engines' case tables disagree on them;
 * - without `u`, atoms that can match half of a surrogate pair count UTF-16
 *   units: one may match nothing and `{m,n}` becomes `{⌈(m-1)/2⌉,n}`, so an
 *   astral character can account for two units, also across neighbours. Lone
 *   surrogates reach the native side as U+FFFD.
 *
 * Returns `null` for anything it does not understand; the caller then always
 * runs that regex in JavaScript.
 */

const JS_SPACE =
	"\\t\\n\\x0B\\x0C\\r \\x{A0}\\x{1680}\\x{2000}-\\x{200A}\\x{2028}\\x{2029}\\x{202F}\\x{205F}\\x{3000}\\x{FEFF}";
const DIGIT = "0-9";
const WORD = "A-Za-z0-9_";

/** Class bodies (without brackets) for the JavaScript shorthand escapes. */
const SHORTHAND: Record<string, { body: string; negated: boolean }> = {
	d: { body: DIGIT, negated: false },
	D: { body: DIGIT, negated: true },
	w: { body: WORD, negated: false },
	W: { body: WORD, negated: true },
	s: { body: JS_SPACE, negated: false },
	S: { body: JS_SPACE, negated: true },
};

class Unsupported extends Error {}

function hex(code: number): string {
	return `\\x{${code.toString(16).toUpperCase()}}`;
}

interface Cursor {
	src: string;
	i: number;
	unicode: boolean;
	dotAll: boolean;
	ignoreCase: boolean;
}

/** Any one character, line terminators included. */
const ANY = "(?s:.)";

/**
 * Whether case-insensitive matching of `cp` may differ between JavaScript and
 * Rust: their case tables disagree on non-ASCII letters (non-`u` JavaScript
 * folds through `toUpperCase`, and either side may know newer Unicode case
 * pairs), so only ASCII and whitespace are trusted.
 */
function caseUnsafe(cp: number): boolean {
	return cp >= 0x80 && !/^\s$/u.test(String.fromCodePoint(cp));
}

function coversSurrogate(lo: number, hi: number): boolean {
	return lo <= 0xdfff && hi >= 0xd800;
}

/** A translated atom. */
interface Atom {
	text: string;
	/**
	 * Whether it can match half of a surrogate pair. Without `u`, JavaScript
	 * counts UTF-16 units, so one astral character can satisfy two such atoms
	 * (or two repetitions of one); the native side counts code points.
	 */
	units: boolean;
}

/** Reads an escape after `\`; returns a code point, or a class body for shorthands, or a marker. */
function readEscape(
	c: Cursor,
	inClass: boolean,
): { cp: number } | { cls: string; negated: boolean } | { drop: true } | { any: true } {
	const ch = c.src[c.i++];
	if (ch === undefined) throw new Unsupported();
	const short = SHORTHAND[ch];
	if (short) return { cls: short.body, negated: short.negated };
	switch (ch) {
		case "b":
			if (inClass) return { cp: 8 };
			return { drop: true };
		case "B":
			if (inClass) throw new Unsupported();
			return { drop: true };
		case "n":
			return { cp: 10 };
		case "r":
			return { cp: 13 };
		case "t":
			return { cp: 9 };
		case "v":
			return { cp: 11 };
		case "f":
			return { cp: 12 };
		case "0":
			if (/[0-9]/.test(c.src[c.i] ?? "")) throw new Unsupported();
			return { cp: 0 };
		case "c": {
			const letter = c.src[c.i];
			if (letter === undefined || !/[A-Za-z]/.test(letter)) throw new Unsupported();
			c.i++;
			return { cp: letter.charCodeAt(0) % 32 };
		}
		case "x": {
			const h = c.src.slice(c.i, c.i + 2);
			if (!/^[0-9A-Fa-f]{2}$/.test(h)) throw new Unsupported();
			c.i += 2;
			return { cp: Number.parseInt(h, 16) };
		}
		case "u": {
			if (c.src[c.i] === "{" && c.unicode) {
				const end = c.src.indexOf("}", c.i);
				const h = c.src.slice(c.i + 1, end);
				if (end < 0 || !/^[0-9A-Fa-f]{1,6}$/.test(h)) throw new Unsupported();
				c.i = end + 1;
				return { cp: Number.parseInt(h, 16) };
			}
			const h = c.src.slice(c.i, c.i + 4);
			if (!/^[0-9A-Fa-f]{4}$/.test(h)) throw new Unsupported();
			c.i += 4;
			const cp = Number.parseInt(h, 16);
			// A `\uHHHH\uHHHH` surrogate pair spells one astral character; outside a
			// class (or in `u` mode) it matches exactly that character. Any other
			// surrogate cannot occur in the UTF-8 text the native side scans.
			if (cp >= 0xd800 && cp <= 0xdbff && (!inClass || c.unicode)) {
				const low = /^\\u(D[C-F][0-9A-F]{2})/i.exec(c.src.slice(c.i))?.[1];
				if (low !== undefined) {
					c.i += 6;
					return { cp: 0x10000 + ((cp - 0xd800) << 10) + (Number.parseInt(low, 16) - 0xdc00) };
				}
			}
			if (cp >= 0xd800 && cp <= 0xdfff) throw new Unsupported();
			return { cp };
		}
		case "k":
			if (inClass) throw new Unsupported();
			if (c.src[c.i] === "<") {
				const end = c.src.indexOf(">", c.i);
				if (end < 0) throw new Unsupported();
				c.i = end + 1;
			}
			return { any: true };
		case "p":
		case "P":
			throw new Unsupported();
		default:
			if (/[1-9]/.test(ch)) {
				if (inClass) throw new Unsupported();
				while (/[0-9]/.test(c.src[c.i] ?? "")) c.i++;
				return { any: true };
			}
			// Identity escape: the character itself.
			return { cp: ch.codePointAt(0)! };
	}
}

/**
 * Translates one `[...]` class starting after `[`. Negated parts are emitted
 * without case folding: Rust folds a class before negating it, which drops
 * characters a case-insensitive JavaScript negated class still matches
 * (`[^k]` and KELVIN SIGN). Lone surrogates in text reach the native side as
 * U+FFFD, so a class covering surrogates also takes U+FFFD, and a negated one
 * excluding U+FFFD is not translated.
 */
function readClass(c: Cursor): Atom {
	let negated = false;
	if (c.src[c.i] === "^") {
		negated = true;
		c.i++;
	}
	const items: string[] = [];
	const negatedShorthands: string[] = [];
	let widen = false;
	let surrogates = false;
	let fffd = false;
	let closed = false;
	while (c.i < c.src.length) {
		const ch = c.src[c.i];
		if (ch === "]") {
			c.i++;
			closed = true;
			break;
		}
		let atom: { cp: number } | { cls: string; negated: boolean };
		if (ch === "\\") {
			c.i++;
			const e = readEscape(c, true);
			if ("drop" in e || "any" in e) throw new Unsupported();
			atom = e;
		} else {
			const cp = c.src.codePointAt(c.i)!;
			c.i += cp > 0xffff ? 2 : 1;
			atom = { cp };
		}
		if ("cls" in atom) {
			if (atom.negated) negatedShorthands.push(atom.cls);
			else items.push(atom.cls);
			continue;
		}
		let hi = atom.cp;
		// Range `a-b`?
		if (c.src[c.i] === "-" && c.src[c.i + 1] !== "]" && c.i + 1 < c.src.length) {
			c.i++;
			if (c.src[c.i] === "\\") {
				c.i++;
				const e = readEscape(c, true);
				if (!("cp" in e)) throw new Unsupported();
				hi = e.cp;
			} else {
				hi = c.src.codePointAt(c.i)!;
				c.i += hi > 0xffff ? 2 : 1;
			}
			if (hi < atom.cp) throw new Unsupported();
			items.push(`${hex(atom.cp)}-${hex(hi)}`);
		} else {
			items.push(hex(atom.cp));
		}
		// Without `u` an astral member stands for its two surrogate units.
		const foldRisk = hi === atom.cp ? caseUnsafe(hi) : hi >= 0x80;
		if ((!c.unicode && hi > 0xffff) || (c.ignoreCase && foldRisk)) widen = true;
		if (coversSurrogate(atom.cp, hi)) surrogates = true;
		if (atom.cp <= 0xfffd && hi >= 0xfffd) fffd = true;
	}
	if (!closed) throw new Unsupported();
	if (negated) {
		if (fffd) throw new Unsupported();
		if (items.length === 0 && negatedShorthands.length === 0) return { text: ANY, units: !c.unicode };
		// A negated shorthand inside (`[^\S]`) is a nested negated class.
		const body = items.join("") + negatedShorthands.map(cls => `[^${cls}]`).join("");
		return { text: `(?-i:[^${body}])`, units: !c.unicode };
	}
	if (items.length === 0 && negatedShorthands.length === 0) throw new Unsupported();
	if (widen) return { text: ANY, units: !c.unicode };
	if (surrogates) items.push(hex(0xfffd));
	// A negated shorthand inside a positive class (`[\S]`, `[\W-]`) unions a complement.
	const parts = [
		...(items.length > 0 ? [`[${items.join("")}]`] : []),
		...negatedShorthands.map(cls => `(?-i:[^${cls}])`),
	];
	return {
		text: parts.length === 1 ? parts[0]! : `(?:${parts.join("|")})`,
		units: !c.unicode && (surrogates || negatedShorthands.length > 0),
	};
}

interface Piece {
	text: string;
	/** Positive lookaround kind when this piece is one, else undefined. */
	look?: "behind" | "ahead";
	/** See {@link Atom.units}. */
	units?: boolean;
	/** A literal astral character outside `u` mode: two units a quantifier would split. */
	astral?: boolean;
}

/** Parses an alternation until `)` or end; returns its alternatives as piece lists. */
function readAlternation(c: Cursor, depth: number): Piece[][] {
	const alternatives: Piece[][] = [[]];
	while (c.i < c.src.length) {
		const ch = c.src[c.i];
		if (ch === ")") {
			if (depth === 0) throw new Unsupported();
			break;
		}
		if (ch === "|") {
			c.i++;
			alternatives.push([]);
			continue;
		}
		const pieces = alternatives[alternatives.length - 1]!;
		let piece: Piece;
		if (ch === "(") {
			c.i++;
			let kind: "group" | "behind" | "ahead" | "negative" = "group";
			if (c.src.startsWith("?:", c.i)) c.i += 2;
			else if (c.src.startsWith("?<=", c.i)) {
				kind = "behind";
				c.i += 3;
			} else if (c.src.startsWith("?<!", c.i)) {
				kind = "negative";
				c.i += 3;
			} else if (c.src.startsWith("?=", c.i)) {
				kind = "ahead";
				c.i += 2;
			} else if (c.src.startsWith("?!", c.i)) {
				kind = "negative";
				c.i += 2;
			} else if (c.src.startsWith("?<", c.i)) {
				const end = c.src.indexOf(">", c.i);
				if (end < 0) throw new Unsupported();
				c.i = end + 1;
			} else if (c.src[c.i] === "?") throw new Unsupported();
			const inner = readAlternation(c, depth + 1);
			if (c.src[c.i] !== ")") throw new Unsupported();
			c.i++;
			const innerText = inner.map(alt => emit(alt, false)).join("|");
			if (kind === "negative") piece = { text: "" };
			else if (kind === "group") piece = { text: `(?:${innerText})` };
			else piece = { text: `(?:${innerText})`, look: kind };
		} else if (ch === "[") {
			c.i++;
			piece = readClass(c);
		} else if (ch === "\\") {
			c.i++;
			const e = readEscape(c, false);
			if ("drop" in e) piece = { text: "" };
			else if ("any" in e) piece = { text: "(?s:.*?)" };
			else if ("cls" in e) {
				piece = e.negated ? { text: `(?-i:[^${e.cls}])`, units: !c.unicode } : { text: `[${e.cls}]` };
			} else piece = literal(c, e.cp);
		} else if (ch === "^" || ch === "$") {
			c.i++;
			piece = { text: "" };
		} else if (ch === ".") {
			c.i++;
			piece = { text: c.dotAll ? ANY : ".", units: !c.unicode };
		} else if (ch === "*" || ch === "+" || ch === "?" || ch === "{") {
			// A quantifier with nothing before it; JavaScript allows a literal `{` only outside `u` mode.
			if (ch === "{" && !c.unicode && !isQuantifier(c.src, c.i)) {
				c.i++;
				piece = { text: hex(0x7b) };
			} else throw new Unsupported();
		} else {
			const cp = c.src.codePointAt(c.i)!;
			c.i += cp > 0xffff ? 2 : 1;
			piece = literal(c, cp);
		}
		const quantifier = readQuantifier(c);
		if (piece.look !== undefined || piece.text === "") {
			// A quantified lookaround or an emptied construct stays harmless: drop
			// the assertion, keep consuming pieces quantified.
			if (quantifier) piece = { text: "" };
		} else if (piece.units) {
			piece = { text: `(?:${piece.text})${unitQuantifier(quantifier)}` };
		} else if (quantifier) {
			// Without `u` a quantifier after an astral literal repeats only its low surrogate.
			if (piece.astral) throw new Unsupported();
			piece = { text: `(?:${piece.text})${quantifier}` };
		}
		pieces.push(piece);
	}
	return alternatives;
}

function isQuantifier(src: string, i: number): boolean {
	return /^\{\d+(,\d*)?\}/.test(src.slice(i));
}

function readQuantifier(c: Cursor): string | undefined {
	const ch = c.src[c.i];
	let q: string | undefined;
	if (ch === "*" || ch === "+" || ch === "?") {
		q = ch;
		c.i++;
	} else if (ch === "{" && isQuantifier(c.src, c.i)) {
		const end = c.src.indexOf("}", c.i);
		q = c.src.slice(c.i, end + 1);
		c.i = end + 1;
	} else return undefined;
	if (c.src[c.i] === "?") {
		q += "?";
		c.i++;
	}
	return q;
}

/** A literal character: exact, or any character under `i` when the engines' case tables may disagree. */
function literal(c: Cursor, cp: number): Piece {
	const astral = !c.unicode && cp > 0xffff;
	if (c.ignoreCase && caseUnsafe(cp)) return { text: ANY, astral };
	return { text: /[A-Za-z0-9 ]/.test(String.fromCodePoint(cp)) ? String.fromCodePoint(cp) : hex(cp), astral };
}

/**
 * The code-point quantifier for an atom that counts UTF-16 units (see
 * {@link Atom.units}). Of `m` units, one may be the low half of a pair a
 * preceding atom started, and pairs take two units per character, so at least
 * `⌈(m-1)/2⌉` characters remain; a pair it starts and a following atom
 * finishes counts here, within the `n` limit.
 */
function unitQuantifier(quantifier: string | undefined): string {
	if (quantifier === undefined) return "?";
	const lazy = quantifier.length > 1 && quantifier.endsWith("?") ? "?" : "";
	const core = lazy ? quantifier.slice(0, -1) : quantifier;
	if (core === "*" || core === "?") return quantifier;
	if (core === "+") return `*${lazy}`;
	const [, min, comma, max] = /^\{(\d+)(,)?(\d*)\}$/.exec(core)!;
	const low = Math.max(0, Math.ceil((Number(min) - 1) / 2));
	return `{${low},${comma ? max : min}}${lazy}`;
}

/**
 * Emits one alternative. At the top level a leading positive lookbehind and a
 * trailing positive lookahead consume their context; elsewhere a positive
 * lookaround may overlap its neighbours, so it is dropped.
 */
function emit(pieces: Piece[], topLevel: boolean): string {
	let first = 0;
	while (first < pieces.length && pieces[first]!.text === "") first++;
	let last = pieces.length - 1;
	while (last >= 0 && pieces[last]!.text === "") last--;
	return pieces
		.map((piece, index) => {
			if (piece.look === undefined) return piece.text;
			if (topLevel && piece.look === "behind" && index === first) return piece.text;
			if (topLevel && piece.look === "ahead" && index === last) return piece.text;
			return "";
		})
		.join("");
}

/** The Rust prefilter pattern for a JavaScript regex, or null when it cannot be translated soundly. */
export function rustPrefilterPattern(regex: RegExp): string | null {
	const c: Cursor = {
		src: regex.source,
		i: 0,
		unicode: regex.unicode || regex.unicodeSets,
		dotAll: regex.dotAll,
		ignoreCase: regex.ignoreCase,
	};
	try {
		if (regex.unicodeSets) throw new Unsupported();
		const alternatives = readAlternation(c, 0);
		if (c.i !== c.src.length) throw new Unsupported();
		const body = alternatives.map(alt => emit(alt, true)).join("|");
		// An alternative that emptied out would match everywhere; no use as a filter.
		if (alternatives.some(alt => emit(alt, true) === "")) return null;
		return regex.ignoreCase ? `(?i:${body})` : body;
	} catch (error) {
		if (error instanceof Unsupported) return null;
		throw error;
	}
}
