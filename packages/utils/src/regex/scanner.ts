/**
 * Scanners: JavaScript generated from a pattern, tried before the automata.
 *
 * A pattern without a loop over a group — characters, classes, runs of one
 * class, alternatives, captures, assertions, backreferences, lookarounds, and
 * groups repeated a small bounded number of times — compiles into one function
 * of nested loops. It jumps to starts with a required fragment, or checks a
 * short stride before deferring to the DFA, then tries those starts in
 * JavaScript's priority order without interpreting instructions.
 *
 * What such a function cannot do is bound its work: nested runs retry
 * polynomially, and each start may rescan the same text. So it runs on a step
 * budget that every start it moves past tops up, and hands the start it could
 * not afford back to the caller ({@link BAIL}), which decides it with the
 * memoized {@link Backtracker}. Results are the same either way; a scanner only
 * ever answers what it has fully explored.
 *
 * @example
 * // Not runnable: `pattern` and `classes` come from the engine.
 * const scan = compileScanner(pattern, classes, { ignoreCase: false, multiline: false }, 256);
 * const out = new Int32Array(1);
 * const end = scan?.(text, 0, text.length, registers, out);
 * // end >= 0: text.slice(out[0], end) matched; NONE: nothing in range; BAIL: out[0] is undecided.
 */
import { caseFoldEquals } from "./alphabet";
import {
	ASSERT_END,
	ASSERT_LINE_END,
	ASSERT_LINE_START,
	ASSERT_START,
	ASSERT_WORD,
	assertionOf,
	type CharClasses,
	LINE_CLASS,
	WORD_CLASS,
} from "./nfa";
import { capturesWithin, nullable, type ParsedPattern, type RegexNode } from "./parse";
import { minimumWidth, type ScanPrefix, scanPrefix } from "./scanner-prefix";

/** No start in the range matches. */
export const NONE = -1;
/** The start in `out[0]` needs more steps than the budget holds; every start before it is ruled out. */
export const BAIL = -2;

/**
 * Tries the starts `from..to` of `text` in order. Returns the end of the first
 * match with its start in `out[0]` and its captures in `registers` (group `g`
 * at `2g`, `2g + 1`; -1 when unset), {@link NONE}, or {@link BAIL}.
 */
export type Scanner = (text: string, from: number, to: number, registers: Int32Array, out: Int32Array) => number;

/** Steps each start a scan moves past adds to its budget, up to {@link BUDGET_CAP}. */
const STEPS_PER_START = 8;
const BUDGET_CAP = 1 << 16;
/** Unfiltered ranges longer than this are cheaper to scan with the DFA. */
const SCAN_STRIDE = 256;
/** Generated source past this size is not worth compiling: alternatives duplicate what follows them. */
const MAX_SOURCE = 48_000;
/** A group repeated a bounded number of times unrolls into this many copies at most. */
const MAX_COPIES = 6;

/** Thrown for patterns a scanner does not cover; the caller keeps the interpreter. */
class NotScannable extends Error {}

/** Capture spans known on the current path: group → JavaScript expressions for its start and end. */
type Captures = ReadonlyMap<number, readonly [string, string]>;
/** Emits the code that runs once the node before it matched up to `position`. */
type Continuation = (position: string, captures: Captures) => void;

/** Necessary next consuming set, unconditional success, or no usable hint. */
type Follow = number | "accept" | undefined;

type EqualSpans = (text: string, a: number, b: number, length: number) => boolean;

/** Binds the tables a generated scanner reads and returns it. */
type ScannerFactory = (
	blockIndex: Uint16Array,
	blocks: Uint16Array,
	sets: readonly Uint8Array[],
	ascii: readonly Uint8Array[],
	classFlags: Uint8Array,
	equal: EqualSpans,
	equalIgnoringCase: EqualSpans,
	first: Uint8Array | undefined,
	firstAscii: Uint8Array | undefined,
	flagsAscii: Uint8Array,
	prefix: RegExp | undefined,
) => Scanner;

/** `new Function` is untyped; the generated source is what gives it this signature. */
function isScannerFactory(value: unknown): value is ScannerFactory {
	return typeof value === "function";
}

function equalSpans(text: string, a: number, b: number, length: number): boolean {
	for (let offset = 0; offset < length; offset++) {
		if (text.charCodeAt(a + offset) !== text.charCodeAt(b + offset)) return false;
	}
	return true;
}

function equalSpansIgnoringCase(text: string, a: number, b: number, length: number): boolean {
	for (let offset = 0; offset < length; offset++) {
		if (!caseFoldEquals(text.charCodeAt(a + offset), text.charCodeAt(b + offset))) return false;
	}
	return true;
}

/** The classes whose code units can begin a match, or undefined when a match can be empty or start with anything. */
function firstClasses(root: RegexNode, classes: CharClasses): Uint8Array | undefined {
	const first = new Uint8Array(classes.alphabet.size);
	/** Adds what `node` can start with; returns whether it can match empty, undefined when unknown. */
	const visit = (node: RegexNode): boolean | undefined => {
		switch (node.type) {
			case "unit": {
				const members = classes.sets[classes.setOf(node)]!;
				for (let id = 0; id < members.length; id++) first[id]! |= members[id]!;
				return false;
			}
			case "seq":
				for (const item of node.items) {
					const empty = visit(item);
					if (empty !== true) return empty;
				}
				return true;
			case "alt": {
				let empty: boolean | undefined = false;
				for (const option of node.options) {
					const optionEmpty = visit(option);
					if (optionEmpty === undefined) return undefined;
					empty ||= optionEmpty;
				}
				return empty;
			}
			case "repeat": {
				const empty = visit(node.body);
				return empty === undefined ? undefined : empty || node.min === 0;
			}
			case "group":
				return visit(node.body);
			// Zero-width: they only restrict, so what follows them decides.
			case "assert":
			case "look":
				return true;
			case "string":
			case "backref":
				return undefined;
		}
	};
	return visit(root) === false ? first : undefined;
}

/** The union of at most two ranges, regardless of how other atoms split the alphabet. */
function compactRanges(members: Uint8Array, byClass: readonly (readonly number[])[]): number[] | null {
	const packed: number[] = [];
	for (let id = 0; id < members.length; id++) {
		if (!members[id]) continue;
		const runs = byClass[id]!;
		if (packed.length + runs.length / 2 > 32) return null;
		for (let i = 0; i < runs.length; i += 2) packed.push(runs[i]! * 0x10000 + runs[i + 1]!);
	}
	packed.sort((a, b) => a - b);
	const ranges: number[] = [];
	for (const interval of packed) {
		const low = interval >>> 16;
		const high = interval & 0xffff;
		const previous = ranges.length - 1;
		if (previous >= 0 && ranges[previous]! + 1 === low) ranges[previous] = high;
		else if (ranges.length === 4) return null;
		else ranges.push(low, high);
	}
	return ranges;
}

class Generator {
	readonly #pattern: ParsedPattern;
	readonly #classes: CharClasses;
	readonly #multiline: boolean;
	readonly #ignoreCase: boolean;
	readonly #ranges = new Map<number, number[] | null>();
	readonly #code: string[] = [];
	#size = 0;
	#names = 0;
	/** Set indexes the code tests through tables, which the factory binds to locals. */
	readonly usedSets = new Set<number>();

	constructor(pattern: ParsedPattern, classes: CharClasses, flags: { ignoreCase: boolean; multiline: boolean }) {
		this.#pattern = pattern;
		this.#classes = classes;
		this.#multiline = flags.multiline;
		this.#ignoreCase = flags.ignoreCase;
	}

	/** Emits a jump to a conservative candidate; one-start replays need no search. */
	prefix(prefix: ScanPrefix): void {
		this.emit("if (to > from) {");
		if (prefix.kind === "run") {
			const needle = JSON.stringify(prefix.text);
			const max = prefix.max === Infinity ? "s" : `Math.max(s, hit - ${prefix.max})`;
			const anchor =
				prefix.anchor === "line"
					? " || (p !== 0 && !isLine(text.charCodeAt(p - 1)))"
					: prefix.anchor === "absolute"
						? " || p !== 0"
						: "";
			this.emit("if (s > last) {");
			this.emit(`const hit = text.indexOf(${needle}, s + ${prefix.min}); if (hit < 0) break;`);
			this.emit(`const stop = ${max}; let p = hit;`);
			this.emit(`while (p > stop) { const u = text.charCodeAt(p - 1); if (!${this.#test(prefix.set, "u")}) break;`);
			this.emit(`if (hit - p >= ${SCAN_STRIDE}) { out[0] = s; return -2; } p--; }`);
			this.emit(`if (hit - p < ${prefix.min}${anchor}) { s = hit; continue; }`);
			this.emit(`s = p; last = ${prefix.anchor ? "p" : `hit - ${prefix.min}`};`);
			this.emit("}");
		} else {
			const { low, high } = prefix;
			const start = low < 0 ? `Math.max(0, s + (${low}))` : `s + ${low}`;
			if (prefix.kind === "literal") {
				const needle = JSON.stringify(prefix.text);
				if (low === high && low >= 0) {
					this.emit(`let hit = ${start};`);
					const atHit =
						prefix.text.length === 1
							? `text.charCodeAt(hit) === ${prefix.text.charCodeAt(0)}`
							: `text.startsWith(${needle}, hit)`;
					this.emit(`if (!(${atHit})) hit = text.indexOf(${needle}, hit + 1); if (hit < 0) break;`);
				} else {
					this.emit(`const hit = text.indexOf(${needle}, ${start}); if (hit < 0) break;`);
				}
			} else {
				this.emit(`P.lastIndex = ${start}; if (!P.test(text)) break; const hit = P.lastIndex - ${prefix.width};`);
			}
			this.emit(low === high ? `s = hit - (${high});` : `s = Math.max(s, hit - (${high}));`);
		}
		this.emit("if (s > to) break;");
		this.emit("}");
	}

	get source(): string {
		return this.#code.join("\n");
	}

	emit(line: string): void {
		this.#size += line.length;
		if (this.#size > MAX_SOURCE) throw new NotScannable("generated scanner too large");
		this.#code.push(line);
	}

	#fresh(prefix: string): string {
		return `${prefix}${this.#names++}`;
	}

	/** Expression: whether the code unit in variable `unit` belongs to set `set`. */
	#test(set: number, unit: string): string {
		const members = this.#classes.sets[set]!;
		const single = this.#classes.alphabet.singleUnit(members);
		if (single !== undefined) return `(${unit} === ${single})`;
		let ranges = this.#ranges.get(set);
		if (ranges === undefined) {
			ranges = compactRanges(members, this.#classes.alphabet.runs);
			this.#ranges.set(set, ranges);
		}
		if (ranges) {
			if (ranges.length === 0) return "false";
			const test = (low: number, high: number): string =>
				low === high ? `${unit} === ${low}` : `((${unit} - ${low}) >>> 0) <= ${high - low}`;
			const first = test(ranges[0]!, ranges[1]!);
			return ranges.length === 2 ? `(${first})` : `(${first} || ${test(ranges[2]!, ranges[3]!)})`;
		}
		this.usedSets.add(set);
		return `(${unit} < 128 ? A${set}[${unit}] : S${set}[B[(I[${unit} >>> 8] << 8) | (${unit} & 255)]])`;
	}

	/** Emits code matching `node` at `position` and then `then`; a failure falls out of the emitted code. */
	node(
		node: RegexNode,
		backward: boolean,
		position: string,
		captures: Captures,
		then: Continuation,
		follow?: Follow,
	): void {
		switch (node.type) {
			case "unit": {
				const unit = this.#fresh("u");
				const next = this.#fresh("p");
				const set = this.#classes.setOf(node);
				this.emit(backward ? `if (${position} > 0) {` : `if (${position} < n) {`);
				this.emit(`const ${unit} = text.charCodeAt(${position}${backward ? " - 1" : ""});`);
				this.emit(`if (${this.#test(set, unit)}) {`);
				this.emit(`const ${next} = ${position} ${backward ? "-" : "+"} 1;`);
				then(next, captures);
				this.emit("}}");
				return;
			}
			case "seq":
				this.#sequence(
					node.items,
					backward ? node.items.length - 1 : 0,
					backward,
					position,
					captures,
					then,
					follow,
				);
				return;
			case "alt":
				// Each alternative is followed by its own copy of what comes next, in priority order.
				for (const option of node.options) {
					const width = minimumWidth(option);
					this.emit(
						width > 1 ? `if (${backward ? `${position} >= ${width}` : `${position} <= n - ${width}`}) {` : "{",
					);
					this.node(option, backward, position, captures, then, follow);
					this.emit("}");
				}
				return;
			case "group": {
				const { capture } = node;
				if (capture === undefined) {
					this.node(node.body, backward, position, captures, then, follow);
					return;
				}
				this.node(
					node.body,
					backward,
					position,
					captures,
					(end, inner) => {
						const span = backward ? ([end, position] as const) : ([position, end] as const);
						then(end, new Map(inner).set(capture, span));
					},
					follow,
				);
				return;
			}
			case "assert":
				this.emit(
					`if (${this.#assertion(assertionOf(node.kind, node.multiline ?? this.#multiline, false), position)}) {`,
				);
				then(position, captures);
				this.emit("}");
				return;
			case "backref":
				this.#backreference(node.target, node.ignoreCase ?? this.#ignoreCase, backward, position, captures, then);
				return;
			case "look":
				this.#lookaround(node, position, captures, then);
				return;
			case "string":
				throw new NotScannable("Unicode string atom");
			case "repeat":
				if (node.body.type === "unit") {
					this.#run(this.#classes.setOf(node.body), node, backward, position, captures, then, follow);
				} else {
					this.#copies(node, backward, position, captures, then);
				}
		}
	}

	#sequence(
		items: readonly RegexNode[],
		index: number,
		backward: boolean,
		position: string,
		captures: Captures,
		then: Continuation,
		follow: Follow,
	): void {
		const item = items[index];
		if (!item) {
			then(position, captures);
			return;
		}
		const step = backward ? -1 : 1;
		if (item.type === "unit" && items[index + step]?.type === "unit") {
			const chars: number[] = [];
			let last = index;
			for (let unit = items[last]; unit?.type === "unit"; unit = items[last]) {
				const code = this.#classes.alphabet.singleUnit(this.#classes.sets[this.#classes.setOf(unit)]!);
				if (code === undefined) break;
				chars.push(code);
				last += step;
			}
			if (chars.length > 1) {
				const literal = JSON.stringify(String.fromCharCode(...(backward ? chars.reverse() : chars)));
				const next = this.#fresh("p");
				this.emit(`const ${next} = ${position} ${backward ? "-" : "+"} ${chars.length};`);
				this.emit(
					`if (${backward ? `${next} >= 0 && ` : ""}text.startsWith(${literal}, ${backward ? next : position})) {`,
				);
				this.#sequence(items, last, backward, next, captures, then, follow);
				this.emit("}");
				return;
			}
		}
		const next = index + step;
		const after =
			item.type === "unit" || item.type === "assert" || item.type === "backref" || item.type === "look"
				? undefined
				: this.#follow(items, next, step, follow);
		this.node(
			item,
			backward,
			position,
			captures,
			(at, inner) => {
				this.#sequence(items, next, backward, at, inner, then, follow);
			},
			after,
		);
	}

	#follow(items: readonly RegexNode[], index: number, step: number, follow: Follow): Follow {
		if (!items[index]) return follow;
		for (let item = items[index]; item; item = items[(index += step)]) {
			while (item.type === "group") item = item.body;
			switch (item.type) {
				case "unit":
					return this.#classes.setOf(item);
				case "repeat":
					if (item.min > 0 && item.body.type === "unit") return this.#classes.setOf(item.body);
					return undefined;
				case "assert":
				case "look":
					continue;
				default:
					return undefined;
			}
		}
		return typeof follow === "number" ? follow : undefined;
	}

	#assertion(assertion: number, position: string): string {
		const before = (test: string): string => `(${position} > 0 && ${test}(text.charCodeAt(${position} - 1)))`;
		const after = (test: string): string => `(${position} < n && ${test}(text.charCodeAt(${position})))`;
		switch (assertion) {
			case ASSERT_START:
				return `${position} === 0`;
			case ASSERT_END:
				return `${position} === n`;
			case ASSERT_LINE_START:
				return `(${position} === 0 || ${before("isLine")})`;
			case ASSERT_LINE_END:
				return `(${position} === n || ${after("isLine")})`;
			case ASSERT_WORD:
				return `${before("isWord")} !== ${after("isWord")}`;
			default:
				return `${before("isWord")} === ${after("isWord")}`;
		}
	}

	/** A repetition of one set, visiting only lengths that can reach its continuation. */
	#run(
		set: number,
		{ min, max, greedy }: { min: number; max: number; greedy: boolean },
		backward: boolean,
		position: string,
		captures: Captures,
		then: Continuation,
		follow: Follow,
	): void {
		if (max === 0) {
			then(position, captures);
			return;
		}
		const unit = this.#fresh("u");
		const at = this.#fresh("r");
		const step = backward ? "-" : "+";
		const edge = backward ? "0" : "n";
		const least = `${position} ${step} ${min}`;
		const more = (limit: string): string => `${at} ${backward ? ">" : "<"} ${limit}`;
		const read = `text.charCodeAt(${at}${backward ? " - 1" : ""})`;
		const hasNext = typeof follow === "number";
		const disjoint =
			hasNext && this.#classes.sets[set]!.every((value, id) => !value || !this.#classes.sets[follow]![id]);
		const only = min === max || follow === "accept" || disjoint;
		const scanMax = only && !greedy && !disjoint ? min : max;
		const limit =
			scanMax === Infinity ? edge : `Math.${backward ? "max" : "min"}(${edge}, ${position} ${step} ${scanMax})`;
		const consume = `const ${unit} = ${read}; if (!${this.#test(set, unit)}) break; ${at}${step}${step};`;
		const charge = `budget -= ${backward ? `${position} - ${at}` : `${at} - ${position}`};`;
		const bail = "if (budget < 0) { out[0] = s; return -2; }";
		const canTry = hasNext && !only ? this.#test(follow, unit) : undefined;
		const lazy = !greedy && !only;
		const clamp = `Math.${backward ? "max" : "min"}`;
		const natural = lazy ? `${clamp}(${edge}, ${least})` : limit;
		const bound = this.#fresh("b");
		const stop = this.#fresh("t");
		this.emit(`const ${bound} = ${natural};`);
		this.emit(`const ${stop} = ${clamp}(${bound}, ${position} ${step} budget);`);
		this.emit(`let ${at} = ${position};`);
		this.emit(`while (${more(stop)}) { ${consume} }`);
		this.emit(`if (${at} === ${stop} && ${stop} !== ${bound}) { out[0] = s; return -2; }`);
		this.emit(charge);
		this.emit(bail);
		const enough = `${at} ${backward ? "<=" : ">="} ${least}`;
		this.emit(`if (${enough}) {`);
		if (only) {
			then(at, captures);
		} else {
			this.emit(lazy ? "for (;;) {" : `for (; ${enough}; ${at}${backward ? "++" : "--"}) {`);
			this.emit(`budget--; ${bail}`);
			if (canTry) {
				this.emit(`if (${more(edge)}) { const ${unit} = ${read}; if (${canTry}) {`);
			}
			then(at, captures);
			if (canTry) this.emit("}}");
			if (lazy) this.emit(`if (!(${more(limit)})) break; ${consume}`);
			this.emit("}");
		}
		this.emit("}");
	}

	/** A group repeated a small bounded number of times, unrolled; captures inside it reset every iteration. */
	#copies(
		node: Extract<RegexNode, { type: "repeat" }>,
		backward: boolean,
		position: string,
		captures: Captures,
		then: Continuation,
	): void {
		const { body, min, max, greedy } = node;
		if (max === Infinity || max > MAX_COPIES) throw new NotScannable("loop over a group");
		const inside = capturesWithin(body);
		const cleared = (known: Captures): Captures => {
			if (!inside) return known;
			const kept = new Map(known);
			for (let group = inside[0]; group <= inside[1]; group++) kept.delete(group);
			return kept;
		};
		const emptyFails = nullable(body);
		const iterate = (count: number, at: string, known: Captures): void => {
			if (count < min) {
				this.node(body, backward, at, cleared(known), (next, inner) => iterate(count + 1, next, inner));
				return;
			}
			const stop = (): void => {
				this.emit("{");
				then(at, known);
				this.emit("}");
			};
			const again = (): void => {
				if (count >= max) return;
				this.emit("{");
				this.node(body, backward, at, cleared(known), (next, inner) => {
					// An optional iteration that consumed nothing fails, as in the specification.
					if (emptyFails) this.emit(`if (${next} !== ${at}) {`);
					iterate(count + 1, next, inner);
					if (emptyFails) this.emit("}");
				});
				this.emit("}");
			};
			if (greedy) {
				again();
				stop();
			} else {
				stop();
				again();
			}
		};
		iterate(0, position, captures);
	}

	#backreference(
		target: number | string,
		ignoreCase: boolean,
		backward: boolean,
		position: string,
		captures: Captures,
		then: Continuation,
	): void {
		const groups = typeof target === "number" ? [target] : (this.#pattern.names.get(target) ?? []);
		// Alternatives are exclusive, so at most one group of a duplicated name is on this path.
		const span = groups.map(group => captures.get(group)).find(known => known !== undefined);
		if (!span) {
			// The group did not participate: the reference matches the empty string.
			then(position, captures);
			return;
		}
		const [start, end] = span;
		const length = this.#fresh("l");
		const next = this.#fresh("p");
		this.emit(`const ${length} = ${start} < 0 ? 0 : ${end} - ${start};`);
		this.emit(`const ${next} = ${position} ${backward ? "-" : "+"} ${length};`);
		const inside = backward ? `${next} >= 0` : `${next} <= n`;
		const other = backward ? next : position;
		this.emit(`if (${inside}) {`);
		this.emit(`budget -= ${length}; if (budget < 0) { out[0] = s; return -2; }`);
		this.emit(`if (${length} === 0 || ${ignoreCase ? "EQI" : "EQ"}(text, ${start}, ${other}, ${length})) {`);
		then(next, captures);
		this.emit("}}");
	}

	/** A lookaround: its body runs to its first success only, and a positive one keeps that success's captures. */
	#lookaround(
		node: Extract<RegexNode, { type: "look" }>,
		position: string,
		captures: Captures,
		then: Continuation,
	): void {
		const found = this.#fresh("ok");
		const label = this.#fresh("L");
		const inside = capturesWithin(node.body);
		const exported = new Map<number, readonly [string, string]>();
		if (inside && !node.negate) {
			for (let group = inside[0]; group <= inside[1]; group++) {
				exported.set(group, [this.#fresh("cs"), this.#fresh("ce")]);
			}
		}
		this.emit(`let ${found} = false;`);
		for (const [start, end] of exported.values()) this.emit(`let ${start} = -1, ${end} = -1;`);
		this.emit(`${label}: {`);
		this.node(
			node.body,
			node.behind,
			position,
			captures,
			(_end, inner) => {
				for (const [group, [start, end]] of exported) {
					const span = inner.get(group);
					if (span) this.emit(`${start} = ${span[0]}; ${end} = ${span[1]};`);
				}
				this.emit(`${found} = true; break ${label};`);
			},
			"accept",
		);
		this.emit("}");
		this.emit(node.negate ? `if (!${found}) {` : `if (${found}) {`);
		const after = new Map(captures);
		for (const [group, span] of exported) after.set(group, span);
		then(position, after);
		this.emit("}");
	}
}

/**
 * Compiles `pattern` into a {@link Scanner} whose budget starts at `steps`;
 * undefined when the pattern loops over a group or the code would be too large.
 */
export function compileScanner(
	pattern: ParsedPattern,
	classes: CharClasses,
	flags: { ignoreCase: boolean; multiline: boolean },
	steps: number,
): Scanner | undefined {
	const generator = new Generator(pattern, classes, flags);
	const groupCount = Math.max(0, pattern.groups.length - 1);
	const prefix = scanPrefix(pattern.root, classes, flags);
	const first = prefix ? undefined : firstClasses(pattern.root, classes);
	const min = minimumWidth(pattern.root);
	try {
		generator.emit("return function scan(text, from, to, registers, out) {");
		generator.emit("const n = text.length;");
		generator.emit(`to = Math.min(to, n - ${min});`);
		const initial = Math.min(BUDGET_CAP, Math.max(0, Math.floor(steps))) || 0;
		generator.emit(`let budget = ${initial};`);
		if (prefix?.kind === "run") generator.emit("let last = -1;");
		generator.emit(prefix ? "const stop = to;" : `const stop = Math.min(to, from + ${SCAN_STRIDE - 1});`);
		generator.emit("for (let s = from; s <= stop; s++) {");
		if (prefix) {
			generator.prefix(prefix);
		} else if (first) {
			generator.emit(
				"while (s <= stop && s < n) { const f = text.charCodeAt(s); if (f < 128 ? FA[f] : F[B[(I[f >>> 8] << 8) | (f & 255)]]) break; s++; }",
			);
			generator.emit("if (s > stop || s >= n) break;");
		}
		generator.emit(`if (budget < ${BUDGET_CAP}) budget += ${STEPS_PER_START};`);
		generator.node(
			pattern.root,
			false,
			"s",
			new Map(),
			(end, captures) => {
				for (let group = 1; group <= groupCount; group++) {
					const [start, stop] = captures.get(group) ?? ["-1", "-1"];
					generator.emit(`registers[${2 * group}] = ${start}; registers[${2 * group + 1}] = ${stop};`);
				}
				generator.emit(`out[0] = s; return ${end};`);
			},
			"accept",
		);
		generator.emit("}");
		if (!prefix) generator.emit("if (stop < to) { out[0] = stop + 1; return -2; }");
		generator.emit("return -1;");
		generator.emit("};");
	} catch (error) {
		if (error instanceof NotScannable) return undefined;
		throw error;
	}
	const { alphabet, sets, classFlags } = classes;
	const ascii = (members: Uint8Array): Uint8Array =>
		Uint8Array.from({ length: 128 }, (_, unit) => members[alphabet.classOf(unit)]!);
	const asciiSets: Uint8Array[] = [];
	const tables: string[] = [];
	for (const set of generator.usedSets) {
		asciiSets[set] = ascii(sets[set]!);
		tables.push(`const S${set} = S[${set}], A${set} = A[${set}];`);
	}
	const prelude = [
		...tables,
		`function classFlags(u) { return u < 128 ? CA[u] : CF[B[(I[u >>> 8] << 8) | (u & 255)]]; }`,
		`function isWord(u) { return (classFlags(u) & ${WORD_CLASS}) !== 0; }`,
		`function isLine(u) { return (classFlags(u) & ${LINE_CLASS}) !== 0; }`,
	];
	const factory: unknown = new Function(
		"I",
		"B",
		"S",
		"A",
		"CF",
		"EQ",
		"EQI",
		"F",
		"FA",
		"CA",
		"P",
		`${prelude.join("\n")}\n${generator.source}`,
	);
	if (!isScannerFactory(factory)) return undefined;
	return factory(
		alphabet.blockIndex,
		alphabet.blocks,
		sets,
		asciiSets,
		classFlags,
		equalSpans,
		equalSpansIgnoringCase,
		first,
		first && ascii(first),
		ascii(classFlags),
		prefix?.kind === "native" ? new RegExp(prefix.source, flags.ignoreCase ? "gi" : "g") : undefined,
	);
}
