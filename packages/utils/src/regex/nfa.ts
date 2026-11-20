/**
 * Character classes and Thompson NFAs for {@link LinearRegExp}.
 *
 * {@link CharClasses} turns every one-unit matcher of a parsed pattern into a
 * set of JSC-decided classes, shared by the automata and the backtracker.
 * {@link compileNfa} builds the automaton a {@link LazyDfa} runs, forward or
 * over reversed text. Automata decide whether a match exists, so lookarounds
 * compile to ε and a backreference to an optional copy of its group: a
 * superset, flagged by {@link Nfa.exact}.
 */
import {
	Alphabet,
	anyUnitSet,
	LEAD_SURROGATE,
	lineTerminatorSet,
	literalSet,
	OracleMismatchError,
	oracleSet,
	supplementaryRanges,
	SURROGATE_END,
	TRAIL_SURROGATE,
	type UnitSet,
	unitRange,
	wordUnitSet,
} from "./alphabet";
import type { AssertKind, ParsedPattern, RegexNode } from "./parse";

/** Node kinds. */
export const CHAR = 0;
export const SPLIT = 1;
export const ASSERT = 2;
export const MATCH = 3;

/** Assertions, stored in `out2` of an `ASSERT` node. */
export const ASSERT_START = 0;
export const ASSERT_END = 1;
export const ASSERT_LINE_START = 2;
export const ASSERT_LINE_END = 3;
export const ASSERT_WORD = 4;
export const ASSERT_NONWORD = 5;
const ASSERT_BOUNDARY = 6;
const ASSERT_REVERSE_BOUNDARY = 7;
const ASSERT_UNICODE_WORD = 8;
const ASSERT_UNICODE_NONWORD = 9;

/** Class flag: `\b` counts the class as word characters. */
export const WORD_CLASS = 1;
/** Class flag: the class holds JavaScript line terminators (`m`-mode `^`/`$`). */
export const LINE_CLASS = 2;
const LEAD_CLASS = 4;
const TRAIL_CLASS = 8;
const UNICODE_WORD_CLASS = 16;

/** Position flag: nothing precedes the position. */
export const AT_START = 1;
/** Position flag: a word character precedes the position (`WORD_CLASS << 1`). */
export const AFTER_WORD = WORD_CLASS << 1;
/** Position flag: a line terminator precedes the position (`LINE_CLASS << 1`). */
export const AFTER_LINE = LINE_CLASS << 1;

/** Patterns past this many nodes stay on the `RegExp`: each DFA step walks the NFA. */
export const MAX_NODES = 10_000;
/** Patterns splitting the code units finer than this stay on the `RegExp`: the DFA table is states × classes. */
const MAX_CLASSES = 1024;

/** The `RegExp` flags that change what a pattern matches. */
export interface PatternFlags {
	ignoreCase: boolean;
	multiline: boolean;
	dotAll: boolean;
}

/**
 * Whether `assertion` holds between a position with flags `before` and the
 * class flags `after` of the next code unit (0 at the end of the text).
 */
export function holds(assertion: number, before: number, atEnd: boolean, after: number): boolean {
	switch (assertion) {
		case ASSERT_START:
			return (before & AT_START) !== 0;
		case ASSERT_END:
			return atEnd;
		case ASSERT_LINE_START:
			return (before & (AT_START | AFTER_LINE)) !== 0;
		case ASSERT_LINE_END:
			return atEnd || (after & LINE_CLASS) !== 0;
		case ASSERT_WORD:
			return ((before & AFTER_WORD) !== 0) !== ((after & WORD_CLASS) !== 0);
		case ASSERT_NONWORD:
			return ((before & AFTER_WORD) !== 0) === ((after & WORD_CLASS) !== 0);
		case ASSERT_BOUNDARY:
			return (before & (LEAD_CLASS << 1)) === 0 || (after & TRAIL_CLASS) === 0;
		case ASSERT_REVERSE_BOUNDARY:
			return (before & (TRAIL_CLASS << 1)) === 0 || (after & LEAD_CLASS) === 0;
		case ASSERT_UNICODE_WORD:
			return ((before & (UNICODE_WORD_CLASS << 1)) !== 0) !== ((after & UNICODE_WORD_CLASS) !== 0);
		default:
			return ((before & (UNICODE_WORD_CLASS << 1)) !== 0) === ((after & UNICODE_WORD_CLASS) !== 0);
	}
}

/** The assertion an `assert` node compiles to; mirrored when the text is read backwards. */
export function assertionOf(kind: AssertKind, multiline: boolean, mirrored: boolean, unicodeWord?: boolean): number {
	switch (kind) {
		case "start":
		case "end": {
			const atStart = (kind === "start") !== mirrored;
			if (multiline) return atStart ? ASSERT_LINE_START : ASSERT_LINE_END;
			return atStart ? ASSERT_START : ASSERT_END;
		}
		case "word":
			return unicodeWord ? ASSERT_UNICODE_WORD : ASSERT_WORD;
		case "nonword":
			return unicodeWord ? ASSERT_UNICODE_NONWORD : ASSERT_NONWORD;
		case "boundary":
			return mirrored ? ASSERT_REVERSE_BOUNDARY : ASSERT_BOUNDARY;
	}
}

/**
 * The classes a pattern's code units fall into, with one membership table per
 * distinct one-unit matcher. Built once per pattern and shared by every
 * automaton and the backtracker compiled from it.
 */
export class CharClasses {
	readonly alphabet: Alphabet;
	/** {@link WORD_CLASS} and {@link LINE_CLASS} bits by class id. */
	readonly classFlags: Uint8Array;
	/** Capacity of a cache keyed by position flags. */
	readonly positionFlags: number;
	/** Class membership per character set, by class id. */
	readonly sets: Uint8Array[] = [];
	readonly #unitSets = new Map<RegexNode, UnitSet>();
	readonly #setIndex = new Map<UnitSet, number>();

	/**
	 * @throws {RangeError} when the pattern needs more than {@link MAX_CLASSES} classes.
	 * @throws {OracleMismatchError} when JSC does not read an atom as one code unit.
	 */
	constructor(pattern: ParsedPattern, flags: PatternFlags) {
		const literals = new Map<number, UnitSet>();
		let usesWord = false;
		let usesUnicodeWord = false;
		let usesBoundary = false;
		let usesLines = false;
		const visit = (node: RegexNode): void => {
			switch (node.type) {
				case "unit": {
					if (this.#unitSets.has(node)) return;
					const { code } = node;
					const ignoreCase = node.ignoreCase ?? flags.ignoreCase;
					if (node.set) {
						this.#unitSets.set(node, node.set);
					} else if (code !== undefined && (!ignoreCase || pattern.unicode)) {
						let set = literals.get(code);
						if (!set) {
							set = literalSet(code);
							literals.set(code, set);
						}
						this.#unitSets.set(node, set);
					} else {
						// `s` only changes `.`; leaving it off elsewhere shares oracle results between patterns.
						const oracleFlags = `${ignoreCase ? "i" : ""}${(node.dotAll ?? flags.dotAll) && node.source === "." ? "s" : ""}`;
						this.#unitSets.set(node, oracleSet(node.source, oracleFlags));
					}
					return;
				}
				case "seq":
					node.items.forEach(visit);
					return;
				case "alt":
					node.options.forEach(visit);
					return;
				case "repeat":
				case "group":
				case "look":
					visit(node.body);
					return;
				case "assert":
					if (node.kind === "word" || node.kind === "nonword") {
						if (node.unicodeWord) usesUnicodeWord = true;
						else usesWord = true;
					} else if (node.kind === "boundary") usesBoundary = true;
					else if (node.multiline ?? flags.multiline) usesLines = true;
			}
		};
		visit(pattern.root);
		const flagSets: [number, UnitSet][] = [];
		if (usesWord) flagSets.push([WORD_CLASS, wordUnitSet(false)]);
		if (usesLines) flagSets.push([LINE_CLASS, lineTerminatorSet()]);
		if (usesBoundary) {
			flagSets.push(
				[LEAD_CLASS, unitRange(LEAD_SURROGATE, TRAIL_SURROGATE - 1)],
				[TRAIL_CLASS, unitRange(TRAIL_SURROGATE, SURROGATE_END - 1)],
			);
		}
		if (usesUnicodeWord) {
			// The JSC Unicode fold table currently adds only BMP letters to ASCII words.
			if (supplementaryRanges("\\w", "iu").length) throw new OracleMismatchError("supplementary Unicode word");
			flagSets.push([UNICODE_WORD_CLASS, wordUnitSet(true)]);
		}
		this.positionFlags = usesUnicodeWord ? UNICODE_WORD_CLASS << 2 : usesBoundary ? TRAIL_CLASS << 2 : 8;
		const sets = [...this.#unitSets.values()];
		for (const [, set] of flagSets) sets.push(set);
		this.alphabet = new Alphabet(sets, MAX_CLASSES);
		this.classFlags = new Uint8Array(this.alphabet.size);
		for (const [bit, set] of flagSets) {
			for (const [id, member] of this.alphabet.membership(set).entries()) {
				if (member) this.classFlags[id]! |= bit;
			}
		}
	}

	/** Index into {@link CharClasses.sets} of the classes one `unit` node accepts. */
	setOf(node: RegexNode): number {
		return this.indexOf(this.#unitSets.get(node)!);
	}

	/** Index into {@link CharClasses.sets} of every class. */
	anySet(): number {
		return this.indexOf(anyUnitSet());
	}

	/** Class flags before position `index` of `text`: {@link AT_START} at 0. */
	flagsBefore(text: string, index: number): number {
		return index === 0 ? AT_START : this.classFlags[this.alphabet.classOf(text.charCodeAt(index - 1))]! << 1;
	}

	/** Class flags of the code unit at `index`, 0 past the end. */
	flagsAt(text: string, index: number): number {
		return index >= text.length ? 0 : this.classFlags[this.alphabet.classOf(text.charCodeAt(index))]!;
	}

	indexOf(set: UnitSet): number {
		let index = this.#setIndex.get(set);
		if (index === undefined) {
			index = this.sets.push(this.alphabet.membership(set)) - 1;
			this.#setIndex.set(set, index);
		}
		return index;
	}
}

/** Compiled automaton; node `i` is described by `kind[i]`, `out1[i]`, `out2[i]`. */
export interface Nfa {
	readonly kind: Uint8Array;
	/** Successor; for `SPLIT` the first branch. */
	readonly out1: Int32Array;
	/** `CHAR`: index into {@link CharClasses.sets}; `SPLIT`: the other branch; `ASSERT`: the assertion. */
	readonly out2: Int32Array;
	readonly start: number;
	readonly classes: CharClasses;
	/** Whether the automaton accepts exactly the pattern's matches rather than a superset. */
	readonly exact: boolean;
}

/**
 * Compiles a parsed pattern; with `reverse`, the automaton reads text backwards
 * (its matches are the pattern's matches, reversed).
 *
 * @throws {RangeError} when the pattern needs more than {@link MAX_NODES} nodes.
 */
export function compileNfa(pattern: ParsedPattern, classes: CharClasses, multiline: boolean, reverse: boolean): Nfa {
	return new NfaBuilder(pattern, classes, multiline, reverse).build();
}

class NfaBuilder {
	readonly #kind: number[] = [];
	readonly #out1: number[] = [];
	readonly #out2: number[] = [];
	readonly #expanding = new Set<number>();
	readonly #pattern: ParsedPattern;
	readonly #classes: CharClasses;
	readonly #multiline: boolean;
	readonly #reverse: boolean;
	#exact = true;

	constructor(pattern: ParsedPattern, classes: CharClasses, multiline: boolean, reverse: boolean) {
		this.#pattern = pattern;
		this.#classes = classes;
		this.#multiline = multiline;
		this.#reverse = reverse;
	}

	build(): Nfa {
		const start = this.#compile(this.#pattern.root, this.#add(MATCH, -1, -1));
		return {
			kind: Uint8Array.from(this.#kind),
			out1: Int32Array.from(this.#out1),
			out2: Int32Array.from(this.#out2),
			start,
			classes: this.#classes,
			exact: this.#exact,
		};
	}

	#add(kind: number, out1: number, out2: number): number {
		if (this.#kind.length >= MAX_NODES) throw new RangeError(`more than ${MAX_NODES} NFA nodes`);
		this.#kind.push(kind);
		this.#out1.push(out1);
		this.#out2.push(out2);
		return this.#kind.length - 1;
	}

	/** Entry node of `node` followed by the node `next`. */
	#compile(node: RegexNode, next: number): number {
		switch (node.type) {
			case "unit":
				return this.#add(CHAR, next, this.#classes.setOf(node));
			case "seq": {
				// Chained back to front: forwards the first item is the entry, backwards the last.
				const { items } = node;
				let entry = next;
				for (let index = 0; index < items.length; index++) {
					entry = this.#compile(items[this.#reverse ? index : items.length - 1 - index]!, entry);
				}
				return entry;
			}
			case "alt": {
				const entries = node.options.map(option => this.#compile(option, next));
				let entry = entries[entries.length - 1]!;
				for (let index = entries.length - 2; index >= 0; index--) entry = this.#add(SPLIT, entries[index]!, entry);
				return entry;
			}
			case "group":
				return this.#compile(node.body, next);
			case "assert":
				if (this.#expanding.size > 0) return next;
				return this.#add(
					ASSERT,
					next,
					assertionOf(node.kind, node.multiline ?? this.#multiline, this.#reverse, node.unicodeWord),
				);
			case "look":
				this.#exact = false;
				return next;
			case "backref":
				return this.#backreference(
					node.target,
					next,
					node.ignoreCase === true && (this.#pattern.scopedCase === true || this.#pattern.unicode === true),
				);
			case "repeat":
				return this.#repeat(node.body, node.min, node.max, next);
		}
	}

	/** Existence does not depend on greediness, so every split prefers the body. */
	#repeat(body: RegexNode, min: number, max: number, next: number): number {
		if (min > MAX_NODES || (max !== Infinity && max > MAX_NODES)) {
			throw new RangeError(`quantifier bound past ${MAX_NODES}`);
		}
		let entry = next;
		if (max === Infinity) {
			const loop = this.#add(SPLIT, -1, next);
			this.#out1[loop] = this.#compile(body, loop);
			entry = loop;
		} else {
			for (let count = min; count < max; count++) entry = this.#add(SPLIT, this.#compile(body, entry), next);
		}
		for (let count = 0; count < min; count++) entry = this.#compile(body, entry);
		return entry;
	}

	/** An optional copy of the capture, dropping assertions that need not hold again at the reference. */
	#backreference(target: number | string, next: number, mayFold: boolean): number {
		this.#exact = false;
		const indices = typeof target === "number" ? [target] : this.#pattern.names.get(target);
		const index = indices?.length === 1 ? indices[0]! : undefined;
		const body = index === undefined ? undefined : this.#pattern.groups[index];
		// A reference inside its own group expands once more, then widens to any text.
		if (mayFold || index === undefined || !body || this.#expanding.has(index)) {
			const loop = this.#add(SPLIT, -1, next);
			this.#out1[loop] = this.#add(CHAR, loop, this.#classes.anySet());
			return loop;
		}
		this.#expanding.add(index);
		try {
			return this.#repeat(body, 0, 1, next);
		} finally {
			this.#expanding.delete(index);
		}
	}
}
