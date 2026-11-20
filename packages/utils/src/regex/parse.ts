/**
 * Parser for JavaScript `RegExp` sources in legacy and Unicode (`u`/`v`) modes.
 *
 * Feeds {@link LinearRegExp}: each atom keeps a standalone source for JSC to
 * classify. Unicode atoms are lowered into sequences of UTF-16 matchers, with
 * guards when a surrogate must stand alone.
 *
 * The source must already compile as a `RegExp`; the parser does not diagnose
 * syntax errors.
 */

import {
	addUnitRange,
	firstUnit,
	hasSurrogate,
	insideSurrogatePair,
	LEAD_SURROGATE,
	oracleSet,
	supplementaryRanges,
	SURROGATE_END,
	TRAIL_SURROGATE,
	type UnitSet,
	unitRange,
} from "./alphabet";

/** A zero-width assertion an automaton can check from the neighbouring code units. */
export type AssertKind = "start" | "end" | "word" | "nonword" | "boundary";

/** One node of a parsed pattern. */
export type RegexNode =
	/**
	 * Matches one code unit. `source` is a standalone pattern for it; `code` is
	 * the exact code unit of a literal, which needs no oracle without `i`.
	 */
	| { type: "unit"; source: string; code?: number; ignoreCase?: boolean; dotAll?: boolean; set?: UnitSet }
	| { type: "seq"; items: RegexNode[] }
	| { type: "alt"; options: RegexNode[] }
	/** `max` is `Infinity` for unbounded quantifiers. */
	| { type: "repeat"; body: RegexNode; min: number; max: number; greedy: boolean }
	/** `capture` is the 1-based group index of a capturing group. */
	| { type: "group"; body: RegexNode; capture?: number }
	/** `^`, `$`, `\b`, `\B`; the `m` flag decides line semantics at compile time. */
	| { type: "assert"; kind: AssertKind; multiline?: boolean; unicodeWord?: boolean }
	| { type: "look"; body: RegexNode; behind: boolean; negate: boolean }
	/** A capture index, or a name to resolve through {@link ParsedPattern.names}. */
	| { type: "backref"; target: number | string; ignoreCase?: boolean };

/** A parsed pattern with its capturing groups. */
export interface ParsedPattern {
	root: RegexNode;
	/** The original source uses Unicode code point semantics. */
	unicode?: boolean;
	/** Effective case modes can differ between a capture and its reference. */
	scopedCase?: boolean;
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

/** Thrown for syntax the parser does not model. */
export class UnsupportedPatternError extends Error {}

/**
 * Parses a compiled `RegExp` source.
 *
 * @throws {UnsupportedPatternError} on unsupported constructs or malformed groups.
 */
export function parsePattern(source: string, flags = ""): ParsedPattern {
	const parser = new Parser(source, flags);
	let root = parser.disjunction();
	// Nonempty matches already start at a boundary: every consuming atom ensures it.
	if (parser.unicode && nullable(root)) {
		root = { type: "seq", items: [BOUNDARY, ...(root.type === "seq" ? root.items : [root])] };
	}
	if (parser.pos !== source.length) throw new UnsupportedPatternError(`unbalanced ")" at ${parser.pos}`);
	return { root, groups: parser.groups, names: parser.names, unicode: parser.unicode, scopedCase: parser.scopedCase };
}

/** Capturing groups in `source`, ignoring escapes and (under `v`) nested classes. */
export function countCapturingGroups(source: string, flags = ""): number {
	const unicodeSets = flags.includes("v");
	let count = 0;
	for (let index = 0; index < source.length; index++) {
		const char = source[index];
		if (char === "\\") index++;
		else if (char === "[") index = classEnd(source, index, unicodeSets) - 1;
		else if (char === "(" && (source[index + 1] !== "?" || isGroupName(source, index))) count++;
	}
	return count;
}

/** Index just past the class opened at `start`; in `v` only unescaped brackets can nest. */
function classEnd(source: string, start: number, unicodeSets: boolean): number {
	let depth = 1;
	for (let index = start + 1; index < source.length; index++) {
		switch (source[index]) {
			case "\\":
				index++;
				break;
			case "[":
				if (unicodeSets) depth++;
				break;
			case "]":
				if (--depth === 0) return index + 1;
				break;
		}
	}
	return source.length + 1;
}

/** Whether the `(` at `index` opens a named group `(?<name>`, not a lookbehind. */
function isGroupName(source: string, index: number): boolean {
	return (
		source[index + 1] === "?" && source[index + 2] === "<" && source[index + 3] !== "=" && source[index + 3] !== "!"
	);
}

function hasNamedGroups(source: string, unicodeSets: boolean): boolean {
	for (let index = 0; index < source.length; index++) {
		const char = source[index];
		if (char === "\\") index++;
		else if (char === "[") index = classEnd(source, index, unicodeSets) - 1;
		else if (char === "(" && isGroupName(source, index)) return true;
	}
	return false;
}

const HEX = /^[0-9a-fA-F]+$/;
const MODIFIER_GROUP = /\(\?([ims]*)(?:-([ims]+))?:/y;
const NAME_ESCAPE = /\\u(?:\{([0-9a-fA-F]+)\}|([0-9a-fA-F]{4}))/g;
const QUANTIFIER_BRACE = /\{(\d+)(?:(,)(\d*))?\}/y;

function decodeName(name: string): string {
	return name.replace(NAME_ESCAPE, (_, braced: string | undefined, fixed: string) =>
		String.fromCodePoint(Number.parseInt(braced ?? fixed, 16)),
	);
}

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
function literalSource(code: number): string {
	return code <= 0xffff ? `\\u${code.toString(16).padStart(4, "0")}` : `\\u{${code.toString(16)}}`;
}

const BOUNDARY: RegexNode = { type: "assert", kind: "boundary" };

/** Splits code-point ranges into an equivalent union of leading/trailing surrogate sets. */
function lowerUnit(source: string, flags: string, code: number | undefined): RegexNode {
	if (code !== undefined && !flags.includes("i")) {
		if (code > 0xffff) {
			const value = code - 0x10000;
			const lead = LEAD_SURROGATE + (value >>> 10);
			const trail = TRAIL_SURROGATE + (value & 1023);
			return {
				type: "seq",
				items: [
					{ type: "unit", source: literalSource(lead), code: lead },
					{ type: "unit", source: literalSource(trail), code: trail },
				],
			};
		}
		const unit: RegexNode = { type: "unit", source, code };
		return code >= LEAD_SURROGATE && code < SURROGATE_END ? { type: "seq", items: [BOUNDARY, unit, BOUNDARY] } : unit;
	}
	const bmp = oracleSet(source, flags);
	const unit: RegexNode = { type: "unit", source, set: bmp };
	// A standalone surrogate is an atom only when not part of a pair.
	const bmpNode: RegexNode = hasSurrogate(bmp) ? { type: "seq", items: [BOUNDARY, unit, BOUNDARY] } : unit;
	const astral = supplementaryRanges(source, flags);
	if (!astral.length) return bmpNode;
	const options: RegexNode[] = bmp.some(word => word !== 0) ? [bmpNode] : [];
	const byTrail = new Map<number, UnitSet>();
	const add = (firstLead: number, lastLead: number, firstTrail: number, lastTrail: number): void => {
		const key = (firstTrail << 10) | lastTrail;
		const first = LEAD_SURROGATE + firstLead;
		const last = LEAD_SURROGATE + lastLead;
		const set = byTrail.get(key);
		if (set) addUnitRange(set, first, last);
		else byTrail.set(key, unitRange(first, last));
	};
	for (let range = 0; range < astral.length; range += 2) {
		const first = astral[range]! - 0x10000;
		const last = astral[range + 1]! - 0x10000;
		const firstLead = first >>> 10;
		const lastLead = last >>> 10;
		const firstTrail = first & 1023;
		const lastTrail = last & 1023;
		if (firstLead === lastLead) {
			add(firstLead, lastLead, firstTrail, lastTrail);
		} else {
			const middleStart = firstLead + (firstTrail === 0 ? 0 : 1);
			const middleEnd = lastLead - (lastTrail === 1023 ? 0 : 1);
			if (firstTrail !== 0) add(firstLead, firstLead, firstTrail, 1023);
			if (middleStart <= middleEnd) add(middleStart, middleEnd, 0, 1023);
			if (lastTrail !== 1023) add(lastLead, lastLead, 0, lastTrail);
		}
	}
	for (const [trail, leadSet] of byTrail) {
		const trailSet = unitRange(TRAIL_SURROGATE + (trail >>> 10), TRAIL_SURROGATE + (trail & 1023));
		options.push({
			type: "seq",
			items: [
				{ type: "unit", source, set: leadSet },
				{ type: "unit", source, set: trailSet },
			],
		});
	}
	return options.length === 1 ? options[0]! : { type: "alt", options };
}

function readHex(source: string, start: number, digits: number): number | undefined {
	const hex = source.slice(start, start + digits);
	return hex.length === digits && HEX.test(hex) ? Number.parseInt(hex, 16) : undefined;
}

/** Reads `\uXXXX`, the paired spelling of a supplementary point, or `\u{...}`. */
function readUnicodeEscape(source: string, start: number, unicode: boolean): { code: number; end: number } | undefined {
	if (unicode && source[start + 2] === "{") {
		const close = source.indexOf("}", start + 3);
		return { code: Number.parseInt(source.slice(start + 3, close), 16), end: close + 1 };
	}
	const code = readHex(source, start + 2, 4);
	if (code === undefined) return undefined;
	const end = start + 6;
	if (unicode && code >= LEAD_SURROGATE && code < TRAIL_SURROGATE && source.startsWith("\\u", end)) {
		const trail = readHex(source, end + 2, 4);
		if (trail !== undefined && trail >= TRAIL_SURROGATE && trail < SURROGATE_END) {
			return { code: 0x10000 + ((code - LEAD_SURROGATE) << 10) + trail - TRAIL_SURROGATE, end: end + 6 };
		}
	}
	return { code, end };
}

/** Only `v` recognizes properties of strings. Use the engine's property names, not a Unicode snapshot. */
function requireCodePointProperty(source: string): void {
	try {
		new RegExp(source, "u");
	} catch (error) {
		if (!(error instanceof SyntaxError)) throw error;
		throw new UnsupportedPatternError(`v-mode property of strings: ${source}`);
	}
}

const CLASS_SET_ESCAPE = "^$\\.*+?()[]{}|/&-!#%,:;<=>@`~";

/** Decodes one `\q` alternative and stops at its unescaped delimiter. */
function readClassString(
	source: string,
	start: number,
): { text: string; end: number; codePoints: number; matchable: boolean } {
	let text = "";
	let codePoints = 0;
	let matchable = true;
	let index = start;
	while (index < source.length) {
		const char = source[index]!;
		if (char === "|" || char === "}") return { text, end: index, codePoints, matchable };
		let code: number | undefined;
		if (char !== "\\") {
			code = source.codePointAt(index)!;
			index += code > 0xffff ? 2 : 1;
		} else {
			const escape = source[index + 1]!;
			if (escape === "u") {
				const value = readUnicodeEscape(source, index, true);
				code = value?.code;
				index = value?.end ?? index + 2;
			} else {
				index += 2;
				const control = CONTROL_ESCAPES[escape];
				if (control !== undefined) code = control;
				else if (escape === "b") code = 0x08;
				else if (escape === "0") code = 0;
				else if (escape === "x") {
					code = readHex(source, index, 2);
					index += 2;
				} else if (escape === "c") {
					const letter = source[index++];
					if (isAsciiLetter(letter)) code = letter!.charCodeAt(0) % 32;
				} else if (CLASS_SET_ESCAPE.includes(escape)) {
					code = escape.charCodeAt(0);
				}
			}
		}
		if (code === undefined) throw new UnsupportedPatternError("unsupported escape in v-mode class string");
		const boundary = text.length;
		text += String.fromCodePoint(code);
		// Two separately escaped surrogates are distinct set elements but can
		// never match adjacent input code points if they form a pair.
		matchable &&= !insideSurrogatePair(text, boundary);
		codePoints++;
	}
	throw new UnsupportedPatternError("unterminated v-mode class string");
}

/**
 * Projects a `v` class onto one-code-point members and collects its finite string candidates.
 * Projection distributes over set operations, so preserving the syntax leaves the engine in
 * charge of deciding membership. Without string properties, any other member must originate
 * in a `\q` operand; intersection and subtraction cannot create new strings.
 */
function inspectUnicodeSet(source: string): { points: string; strings?: Map<string, number> } {
	let strings: Map<string, number> | undefined;
	let points = "";
	let copied = 0;
	for (let index = 0; index < source.length; index++) {
		if (source[index] !== "\\") continue;
		const escape = source[++index];
		if (escape === "p" || escape === "P") {
			const end = source.indexOf("}", index + 2);
			requireCodePointProperty(source.slice(index - 1, end + 1));
			index = end;
		} else if (escape === "q") {
			const start = index - 1;
			let next = index + 2;
			const singles: string[] = [];
			let removed = false;
			for (;;) {
				const alternative = readClassString(source, next);
				if (alternative.codePoints === 1) singles.push(source.slice(next, alternative.end));
				else {
					if (alternative.matchable) (strings ??= new Map()).set(alternative.text, alternative.codePoints);
					removed = true;
				}
				index = alternative.end;
				if (source[index] === "}") break;
				next = index + 1;
			}
			if (removed) {
				points += source.slice(copied, start) + (singles.length ? `\\q{${singles.join("|")}}` : "[]");
				copied = index + 1;
			}
		}
	}
	return { points: copied ? points + source.slice(copied) : source, strings };
}

class Parser {
	pos = 0;
	readonly groups: RegexNode[] = [];
	readonly names = new Map<string, number[]>();
	readonly #source: string;
	readonly #groupCount: number;
	readonly #namedGroups: boolean;
	readonly #unicodeSets: boolean;
	readonly unicode: boolean;
	scopedCase = false;
	readonly #outerFlags: string;
	readonly #lowered = new Map<string, RegexNode>();
	#modifiers: { ignoreCase?: boolean; multiline?: boolean; dotAll?: boolean } = {};
	#nextGroup = 1;

	constructor(source: string, flags: string) {
		this.#unicodeSets = flags.includes("v");
		this.unicode = this.#unicodeSets || flags.includes("u");
		this.#outerFlags = flags;
		this.#source = source;
		this.#groupCount = countCapturingGroups(source, flags);
		this.#namedGroups = hasNamedGroups(source, this.#unicodeSets);
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
			return { type: "assert", kind: char === "^" ? "start" : "end", multiline: this.#modifiers.multiline };
		}
		if (char === "\\" && (source[this.pos + 1] === "b" || source[this.pos + 1] === "B")) {
			this.pos += 2;
			return {
				type: "assert",
				kind: source[this.pos - 1] === "b" ? "word" : "nonword",
				unicodeWord: this.unicode && (this.#modifiers.ignoreCase ?? this.#outerFlags.includes("i")),
			};
		}
		let atom: RegexNode;
		if (char === "(") {
			atom = this.#group();
		} else if (char === "[") {
			const end = classEnd(source, this.pos, this.#unicodeSets);
			atom = this.#unit(source.slice(this.pos, end));
			this.pos = end;
		} else if (char === "\\") {
			atom = this.#escape();
		} else if (char === ".") {
			this.pos++;
			atom = this.#unit(".");
		} else {
			// Annex B: `]`, `{` and `}` outside a quantifier are literal characters too.
			const code = this.unicode ? source.codePointAt(this.pos)! : char.charCodeAt(0);
			this.pos += code > 0xffff ? 2 : 1;
			atom = this.#unit(literalSource(code), code);
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
			const name = decodeName(source.slice(start + 3, close));
			const index = this.#nextGroup++;
			const indices = this.names.get(name);
			if (indices) indices.push(index);
			else this.names.set(name, [index]);
			this.pos = close + 1;
			node = this.#capture(index);
		} else if (source[start + 1] === "?") {
			MODIFIER_GROUP.lastIndex = start;
			const match = MODIFIER_GROUP.exec(source);
			if (!match) throw new UnsupportedPatternError(`unsupported group "${source.slice(start, start + 4)}"`);
			this.pos = MODIFIER_GROUP.lastIndex;
			const previous = this.#modifiers;
			const add = match[1]!;
			const remove = match[2] ?? "";
			this.scopedCase ||= add.includes("i") || remove.includes("i");
			const effective = (flag: string, inherited: boolean | undefined): boolean | undefined =>
				add.includes(flag) ? true : remove.includes(flag) ? false : inherited;
			this.#modifiers = {
				ignoreCase: effective("i", previous.ignoreCase),
				multiline: effective("m", previous.multiline),
				dotAll: effective("s", previous.dotAll),
			};
			node = { type: "group", body: this.disjunction() };
			this.#modifiers = previous;
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

	#unit(source: string, code?: number): RegexNode {
		const { ignoreCase, dotAll } = this.#modifiers;
		if (!this.unicode) return { type: "unit", source, code, ignoreCase, dotAll };
		const folded = ignoreCase ?? this.#outerFlags.includes("i");
		const matchesAll = source === "." && (dotAll ?? this.#outerFlags.includes("s"));
		const flags = `${folded ? "i" : ""}${matchesAll ? "s" : ""}${this.#unicodeSets ? "v" : "u"}`;
		const key = `${flags}/${source}`;
		let node = this.#lowered.get(key);
		if (!node) {
			if (this.#unicodeSets && source[0] === "[") {
				node = this.#lowerSet(source, flags);
			} else {
				if (this.#unicodeSets && (source.startsWith("\\p{") || source.startsWith("\\P{"))) {
					requireCodePointProperty(source);
				}
				node = lowerUnit(source, flags, code);
			}
			this.#lowered.set(key, node);
		}
		return node;
	}

	#lowerSet(source: string, flags: string): RegexNode {
		const { points, strings } = inspectUnicodeSet(source);
		const single = lowerUnit(points, flags, undefined);
		if (!strings) return single;

		// The class itself decides membership, including case folding and set operations.
		const whole = new RegExp(`^(?:${source})(?![\\s\\S])`, flags);
		const options: RegexNode[] = [];
		const ordered: [string, number][] = [];
		for (const entry of strings) {
			if (entry[0] !== "" && whole.test(entry[0])) ordered.push(entry);
		}
		ordered.sort((left, right) => right[1] - left[1]);
		for (const [text] of ordered) {
			const items: RegexNode[] = [];
			for (const char of text) {
				const code = char.codePointAt(0)!;
				items.push(this.#unit(literalSource(code), code));
			}
			options.push({ type: "seq", items });
		}

		if (strings.has("") && whole.test("")) {
			const empty: RegexNode = { type: "seq", items: [] };
			const point = firstUnit(oracleSet(points, flags)) ?? supplementaryRanges(points, flags)[0];
			// JSC can put its empty branch before the singleton class. Observe the
			// actual priority, without a suffix forcing either alternative to retry.
			const emptyFirst =
				point !== undefined && new RegExp(`^(?:${source})`, flags).exec(String.fromCodePoint(point))?.[0] === "";
			if (emptyFirst) options.push(empty, single);
			else options.push(single, empty);
		} else {
			options.push(single);
		}
		return options.length === 1 ? single : { type: "alt", options };
	}

	#backreference(target: string | number): RegexNode {
		const ignoreCase = this.#modifiers.ignoreCase ?? this.#outerFlags.includes("i");
		return { type: "backref", target, ignoreCase };
	}

	#escape(): RegexNode {
		const source = this.#source;
		const start = this.pos;
		const char = source[start + 1]!;
		const unit = (length: number, code?: number): RegexNode => {
			this.pos = start + length;
			return this.#unit(code === undefined ? source.slice(start, start + length) : literalSource(code), code);
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
				const escape = readUnicodeEscape(source, start, this.unicode);
				return escape === undefined ? unit(2, 0x75) : unit(escape.end - start, escape.code);
			}
			case "p":
			case "P":
				if (this.unicode) return unit(source.indexOf("}", start + 3) + 1 - start);
				break;
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
				return this.#backreference(index);
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
		return this.#backreference(decodeName(this.#source.slice(start + 3, close)));
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
