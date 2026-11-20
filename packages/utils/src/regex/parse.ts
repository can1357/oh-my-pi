/**
 * Parser for JavaScript `RegExp` sources without the `u`/`v` flags (Annex B syntax).
 *
 * Feeds {@link LinearRegExp}: every matcher of one code unit (literal, escape,
 * class, `.`) keeps a standalone source the engine hands to JSC to learn which
 * code units it accepts, so character semantics are never re-implemented here.
 *
 * The source must already compile as a `RegExp`; the parser does not diagnose
 * syntax errors.
 */

/** A zero-width assertion an automaton can check from the neighbouring code units. */
export type AssertKind = "start" | "end" | "word" | "nonword";

/** One node of a parsed pattern. */
export type RegexNode =
	/**
	 * Matches one code unit. `source` is a standalone pattern for it; `code` is
	 * the exact code unit of a literal, which needs no oracle without `i`.
	 */
	| { type: "unit"; source: string; code?: number }
	| { type: "seq"; items: RegexNode[] }
	| { type: "alt"; options: RegexNode[] }
	/** `max` is `Infinity` for unbounded quantifiers. */
	| { type: "repeat"; body: RegexNode; min: number; max: number; greedy: boolean }
	/** `capture` is the 1-based group index of a capturing group. */
	| { type: "group"; body: RegexNode; capture?: number }
	/** `^`, `$`, `\b`, `\B`; the `m` flag decides line semantics at compile time. */
	| { type: "assert"; kind: AssertKind }
	| { type: "look"; body: RegexNode; behind: boolean; negate: boolean }
	/** A capture index, or a name to resolve through {@link ParsedPattern.names}. */
	| { type: "backref"; target: number | string };

/** A parsed pattern with its capturing groups. */
export interface ParsedPattern {
	root: RegexNode;
	/** Capturing group bodies by 1-based index. */
	groups: RegexNode[];
	/** Capture indices by group name; ES2025 allows one name in several alternatives. */
	names: Map<string, number[]>;
}

/** Whether `node` can match the empty string; zero-width and backreference nodes count as nullable. */
export function nullable(node: RegexNode): boolean {
	switch (node.type) {
		case "unit":
			return false;
		case "seq":
			return node.items.every(nullable);
		case "alt":
			return node.options.some(nullable);
		case "repeat":
			return node.min === 0 || nullable(node.body);
		case "group":
			return nullable(node.body);
		default:
			return true;
	}
}

/**
 * The capturing groups inside `node` as `[first, last]`, or undefined when there
 * are none. Groups are numbered by opening parenthesis, so they are contiguous.
 */
export function capturesWithin(node: RegexNode): [number, number] | undefined {
	let first = Infinity;
	let last = -Infinity;
	const visit = (current: RegexNode): void => {
		switch (current.type) {
			case "seq":
				current.items.forEach(visit);
				return;
			case "alt":
				current.options.forEach(visit);
				return;
			case "group":
				if (current.capture !== undefined) {
					first = Math.min(first, current.capture);
					last = Math.max(last, current.capture);
				}
				visit(current.body);
				return;
			case "repeat":
			case "look":
				visit(current.body);
		}
	};
	visit(node);
	return first <= last ? [first, last] : undefined;
}

/** Thrown for syntax the parser does not model (e.g. `(?i:…)` modifiers). */
export class UnsupportedPatternError extends Error {}

/**
 * Parses a `RegExp` source compiled without `u`/`v`.
 *
 * @throws {UnsupportedPatternError} on pattern modifiers or malformed groups.
 */
export function parsePattern(source: string): ParsedPattern {
	const parser = new Parser(source);
	const root = parser.disjunction();
	if (parser.pos !== source.length) throw new UnsupportedPatternError(`unbalanced ")" at ${parser.pos}`);
	return { root, groups: parser.groups, names: parser.names };
}

/** Capturing groups in `source`, counted like JS: `(` and `(?<name>`, outside classes and escapes. */
export function countCapturingGroups(source: string): number {
	let count = 0;
	for (let index = 0; index < source.length; index++) {
		const char = source[index];
		if (char === "\\") index++;
		else if (char === "[") index = classEnd(source, index) - 1;
		else if (char === "(" && (source[index + 1] !== "?" || isGroupName(source, index))) count++;
	}
	return count;
}

/** Index just past the class opened at `start`; a non-`v` class ends at the first unescaped `]`. */
function classEnd(source: string, start: number): number {
	let index = start + 1;
	if (source[index] === "^") index++;
	while (index < source.length && source[index] !== "]") index += source[index] === "\\" ? 2 : 1;
	return index + 1;
}

/** Whether the `(` at `index` opens a named group `(?<name>`, not a lookbehind. */
function isGroupName(source: string, index: number): boolean {
	return (
		source[index + 1] === "?" && source[index + 2] === "<" && source[index + 3] !== "=" && source[index + 3] !== "!"
	);
}

function hasNamedGroups(source: string): boolean {
	for (let index = 0; index < source.length; index++) {
		const char = source[index];
		if (char === "\\") index++;
		else if (char === "[") index = classEnd(source, index) - 1;
		else if (char === "(" && isGroupName(source, index)) return true;
	}
	return false;
}

const HEX = /^[0-9a-fA-F]+$/;
const QUANTIFIER_BRACE = /\{(\d+)(?:(,)(\d*))?\}/y;
/** Escapes whose code unit is fixed by the spec: `\n` → 0x0a, and so on. */
const CONTROL_ESCAPES: Record<string, number> = { f: 0x0c, n: 0x0a, r: 0x0d, t: 0x09, v: 0x0b };
/** Escapes that match a class of code units; JSC decides the members. */
const CLASS_ESCAPES = new Set("dDsSwW");

function isDigit(char: string | undefined): boolean {
	return char !== undefined && char >= "0" && char <= "9";
}

function isAsciiLetter(char: string | undefined): boolean {
	return char !== undefined && ((char >= "a" && char <= "z") || (char >= "A" && char <= "Z"));
}

function isOctal(char: string | undefined): boolean {
	return char !== undefined && char >= "0" && char <= "7";
}

/** Standalone source for one known code unit; `\uXXXX` keeps oracle cache keys canonical. */
function literal(code: number): RegexNode {
	return { type: "unit", source: `\\u${code.toString(16).padStart(4, "0")}`, code };
}

function readHex(source: string, start: number, digits: number): number | undefined {
	const hex = source.slice(start, start + digits);
	return hex.length === digits && HEX.test(hex) ? Number.parseInt(hex, 16) : undefined;
}

class Parser {
	pos = 0;
	readonly groups: RegexNode[] = [];
	readonly names = new Map<string, number[]>();
	readonly #source: string;
	readonly #groupCount: number;
	readonly #namedGroups: boolean;
	#nextGroup = 1;

	constructor(source: string) {
		this.#source = source;
		this.#groupCount = countCapturingGroups(source);
		this.#namedGroups = hasNamedGroups(source);
	}

	disjunction(): RegexNode {
		const options = [this.#alternative()];
		while (this.#source[this.pos] === "|") {
			this.pos++;
			options.push(this.#alternative());
		}
		return options.length === 1 ? options[0]! : { type: "alt", options };
	}

	#alternative(): RegexNode {
		const items: RegexNode[] = [];
		const source = this.#source;
		while (this.pos < source.length && source[this.pos] !== "|" && source[this.pos] !== ")") items.push(this.#term());
		return items.length === 1 ? items[0]! : { type: "seq", items };
	}

	#term(): RegexNode {
		const source = this.#source;
		const char = source[this.pos]!;
		if (char === "^" || char === "$") {
			this.pos++;
			return { type: "assert", kind: char === "^" ? "start" : "end" };
		}
		if (char === "\\" && (source[this.pos + 1] === "b" || source[this.pos + 1] === "B")) {
			this.pos += 2;
			return { type: "assert", kind: source[this.pos - 1] === "b" ? "word" : "nonword" };
		}
		let atom: RegexNode;
		if (char === "(") {
			atom = this.#group();
		} else if (char === "[") {
			const end = classEnd(source, this.pos);
			atom = { type: "unit", source: source.slice(this.pos, end) };
			this.pos = end;
		} else if (char === "\\") {
			atom = this.#escape();
		} else if (char === ".") {
			this.pos++;
			atom = { type: "unit", source: "." };
		} else {
			// Annex B: `]`, `{` and `}` outside a quantifier are literal characters too.
			this.pos++;
			atom = literal(char.charCodeAt(0));
		}
		return this.#quantified(atom);
	}

	#group(): RegexNode {
		const source = this.#source;
		const start = this.pos;
		let node: RegexNode;
		if (source.startsWith("(?:", start)) {
			this.pos += 3;
			node = { type: "group", body: this.disjunction() };
		} else if (source.startsWith("(?=", start) || source.startsWith("(?!", start)) {
			this.pos += 3;
			node = { type: "look", body: this.disjunction(), behind: false, negate: source[start + 2] === "!" };
		} else if (source.startsWith("(?<=", start) || source.startsWith("(?<!", start)) {
			this.pos += 4;
			node = { type: "look", body: this.disjunction(), behind: true, negate: source[start + 3] === "!" };
		} else if (isGroupName(source, start)) {
			const close = source.indexOf(">", start + 3);
			if (close === -1) throw new UnsupportedPatternError("unterminated group name");
			const name = source.slice(start + 3, close);
			const index = this.#nextGroup++;
			const indices = this.names.get(name);
			if (indices) indices.push(index);
			else this.names.set(name, [index]);
			this.pos = close + 1;
			node = this.#capture(index);
		} else if (source[start + 1] === "?") {
			throw new UnsupportedPatternError(`unsupported group "${source.slice(start, start + 4)}"`);
		} else {
			this.pos++;
			node = this.#capture(this.#nextGroup++);
		}
		if (source[this.pos] !== ")") throw new UnsupportedPatternError(`unterminated group at ${start}`);
		this.pos++;
		return node;
	}

	#capture(index: number): RegexNode {
		const body = this.disjunction();
		this.groups[index] = body;
		return { type: "group", body, capture: index };
	}

	#escape(): RegexNode {
		const source = this.#source;
		const start = this.pos;
		const char = source[start + 1]!;
		const unit = (length: number, code?: number): RegexNode => {
			this.pos = start + length;
			return code === undefined ? { type: "unit", source: source.slice(start, start + length) } : literal(code);
		};
		if (CLASS_ESCAPES.has(char)) return unit(2);
		const control = CONTROL_ESCAPES[char];
		if (control !== undefined) return unit(2, control);
		switch (char) {
			case "c":
				if (isAsciiLetter(source[start + 2])) return unit(3, source.charCodeAt(start + 2) % 32);
				// `\` before a `c` that starts no control escape is a literal backslash; `c` is read next.
				return unit(1, 0x5c);
			case "x": {
				const code = readHex(source, start + 2, 2);
				return code === undefined ? unit(2, 0x78) : unit(4, code);
			}
			case "u": {
				const code = readHex(source, start + 2, 4);
				return code === undefined ? unit(2, 0x75) : unit(6, code);
			}
			case "k":
				if (!this.#namedGroups) return unit(2, 0x6b);
				return this.#namedBackreference(start);
		}
		if (isDigit(char)) {
			let end = start + 1;
			while (isDigit(source[end])) end++;
			const index = Number(source.slice(start + 1, end));
			if (char !== "0" && index <= this.#groupCount) {
				this.pos = end;
				return { type: "backref", target: index };
			}
			// Annex B: `\8`/`\9` are identity escapes; other digits start a legacy octal escape of
			// up to three digits, the three-digit form only from `0`–`3` (so at most 0o377).
			if (char === "8" || char === "9") return unit(2, char.charCodeAt(0));
			let digits = 1;
			if (isOctal(source[start + 2])) digits = char <= "3" && isOctal(source[start + 3]) ? 3 : 2;
			return unit(1 + digits, Number.parseInt(source.slice(start + 1, start + 1 + digits), 8));
		}
		// Identity escape. Letters and non-ASCII go to the oracle; JSC decides what they mean.
		const code = source.charCodeAt(start + 1);
		return code < 0x80 && !isAsciiLetter(char) ? unit(2, code) : unit(2);
	}

	#namedBackreference(start: number): RegexNode {
		const close = this.#source.indexOf(">", start + 3);
		if (this.#source[start + 2] !== "<" || close === -1) throw new UnsupportedPatternError("malformed \\k");
		this.pos = close + 1;
		return { type: "backref", target: this.#source.slice(start + 3, close) };
	}

	#quantified(atom: RegexNode): RegexNode {
		const source = this.#source;
		const char = source[this.pos];
		let min: number;
		let max: number;
		if (char === "*") {
			min = 0;
			max = Infinity;
			this.pos++;
		} else if (char === "+") {
			min = 1;
			max = Infinity;
			this.pos++;
		} else if (char === "?") {
			min = 0;
			max = 1;
			this.pos++;
		} else if (char === "{") {
			QUANTIFIER_BRACE.lastIndex = this.pos;
			const match = QUANTIFIER_BRACE.exec(source);
			if (!match) return atom;
			min = Number(match[1]);
			max = match[2] === undefined ? min : match[3] ? Number(match[3]) : Infinity;
			this.pos = QUANTIFIER_BRACE.lastIndex;
		} else {
			return atom;
		}
		const greedy = source[this.pos] !== "?";
		if (!greedy) this.pos++;
		return { type: "repeat", body: atom, min, max, greedy };
	}
}
