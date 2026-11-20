/**
 * `RegExp` without catastrophic backtracking, with JavaScript's answers.
 *
 * JSC backtracks without bound and nothing can interrupt a running `RegExp`, so
 * one user-written pattern with ambiguous repetition (`(?:[ \t]+[^\n]*\n|[ \t]*\n)*?`)
 * can freeze the process for minutes on a few hundred characters.
 * {@link LinearRegExp} is a `RegExp` whose `exec` (and through it `test`,
 * `match`, `matchAll`, `replace`, `split`, `search`) runs on its own engine:
 *
 * - a lazily built DFA ({@link LazyDfa}) over character classes JSC itself
 *   computed ({@link CharClasses}) decides whether a match exists, in time
 *   linear in the text; for patterns without lookarounds or backreferences that
 *   answer is final;
 * - the automaton run backwards from where the earliest match ends marks where
 *   a match can start, and a memoized backtracker ({@link Backtracker}) with
 *   ECMAScript semantics finds the match JavaScript would return, captures
 *   included, trying only those starts and never re-exploring a failed
 *   configuration. A search reads the text only as far as its match.
 *
 * Patterns the engine does not model (`u`/`v` flags, `(?i:…)` modifiers, size
 * limits) keep the native engine.
 *
 * @example
 * const condition = new LinearRegExp("^def[^\\n]*\\n(?:[ \\t]+[^\\n]*\\n|[ \\t]*\\n)*?[ \\t]+import ", "m");
 * condition.test(source); // the native answer, in O(source.length)
 */
import * as logger from "../logger";
import { OracleMismatchError } from "./alphabet";
import { type BacktrackMatch, Backtracker, type MemoLimits } from "./backtrack";
import { type DfaLimits, LazyDfa, RegexStream } from "./dfa";
import { CharClasses, compileNfa } from "./nfa";
import { type ParsedPattern, parsePattern, type RegexNode, UnsupportedPatternError } from "./parse";

/**
 * A positive lookaround the whole pattern starts with, as an automaton marking
 * where it can hold: lookbehind bodies where they can end, lookahead bodies
 * where they can start.
 */
interface StartFilter {
	dfa: LazyDfa;
	behind: boolean;
}

/**
 * Sizes that trade speed for memory, never results. Tests shrink them so short
 * inputs reach window edges, generated kernels, memo resets and automaton cache resets.
 */
export interface EngineLimits extends MemoLimits, DfaLimits {
	/** Start positions a search step covers at least, when the automaton cannot bound where the match starts. */
	window: number;
	/** Units read before a window to decide a leading lookbehind; one that reaches further back is assumed to hold. */
	lookbehindContext: number;
}

const DEFAULT_LIMITS: EngineLimits = {
	window: 1024,
	lookbehindContext: 256,
	dfaEntries: 1 << 20,
	jitAfter: 1 << 14,
	memoAfter: 256,
	memoPages: 1 << 15,
	memoContexts: 1 << 16,
};
/** Windows up to this many positions reuse the engine's scratch buffers. */
const SCRATCH = 4096;

/** Positive lookarounds every match must satisfy at its start (before anything is consumed). */
function leadingLookarounds(root: RegexNode): Extract<RegexNode, { type: "look" }>[] {
	const items = root.type === "seq" ? root.items : [root];
	const looks: Extract<RegexNode, { type: "look" }>[] = [];
	for (const item of items) {
		if (item.type === "look") {
			if (!item.negate) looks.push(item);
		} else if (item.type !== "assert") {
			break;
		}
	}
	return looks;
}

/** One compiled pattern: automata for existence, backtracker for the match itself. */
class Engine {
	/** Whether the automaton decides alone (no lookarounds or backreferences). */
	readonly regular: boolean;
	readonly #pattern: ParsedPattern;
	readonly #classes: CharClasses;
	readonly #anchored: boolean;
	readonly #forward: LazyDfa;
	readonly #reverse: LazyDfa | undefined;
	readonly #filters: StartFilter[];
	readonly #backtracker: Backtracker;
	readonly #limits: EngineLimits;
	readonly #marks = new Uint8Array(SCRATCH);
	readonly #filterMarks = new Uint8Array(SCRATCH);

	constructor(regex: RegExp, limits: EngineLimits) {
		const flags = { ignoreCase: regex.ignoreCase, multiline: regex.multiline, dotAll: regex.dotAll };
		this.#limits = limits;
		this.#pattern = parsePattern(regex.source);
		this.#classes = new CharClasses(this.#pattern, flags);
		this.#anchored = regex.sticky;
		/** Unanchored automaton for `root`: marks where it can start (`reverse`) or end. */
		const marker = (root: RegexNode, reverse: boolean): LazyDfa =>
			new LazyDfa(compileNfa({ ...this.#pattern, root }, this.#classes, flags.multiline, reverse), false, limits);
		const forward = compileNfa(this.#pattern, this.#classes, flags.multiline, false);
		this.regular = forward.exact;
		this.#forward = new LazyDfa(forward, this.#anchored, limits);
		this.#reverse = this.#anchored ? undefined : marker(this.#pattern.root, true);
		// Without them the automata drop lookarounds, so `(?<=password=)\S+` could start almost anywhere.
		this.#filters = this.#anchored
			? []
			: leadingLookarounds(this.#pattern.root).map(look => ({
					dfa: marker(look.body, !look.behind),
					behind: look.behind,
				}));
		this.#backtracker = new Backtracker(this.#pattern, this.#classes, flags, limits);
	}

	/** Whether a match starts at or after `from`. */
	test(text: string, from: number): boolean {
		if (this.regular) return this.#firstMatchEnd(text, from) >= 0;
		return this.match(text, from) !== undefined;
	}

	/** The match JavaScript finds when searching from `from`. */
	match(text: string, from: number): BacktrackMatch | undefined {
		const candidate = this.#anchored ? undefined : this.#backtracker.probe(text, from);
		if (candidate) return candidate;
		const match =
			candidate === null ? undefined : this.#anchored ? this.#matchAt(text, from) : this.#search(text, from);
		// Finding nothing ends a scan of `text`: let go of it and of its memo.
		if (!match) this.#backtracker.release();
		return match;
	}

	stream(): RegexStream {
		return new RegexStream(this.#forward);
	}

	/** The `exec` result for a match. */
	execArray(text: string, match: BacktrackMatch, withIndices: boolean): RegExpExecArray {
		const { registers } = match;
		const count = registers.length / 2;
		const whole = text.slice(match.start, match.end);
		const values = [whole];
		for (let group = 1; group < count; group++) {
			const start = registers[2 * group]!;
			if (start >= 0) values[group] = text.slice(start, registers[2 * group + 1]);
			else defineUndefined(values, group);
		}
		const names = this.#pattern.names;
		let groups: Record<string, string> | undefined;
		if (names.size > 0) {
			groups = Object.create(null);
			for (const [name, indices] of names) {
				// Duplicate names sit in different alternatives: at most one participated.
				const index = indices.find(group => registers[2 * group]! >= 0);
				if (index === undefined) defineUndefined(groups!, name);
				else groups![name] = values[index]!;
			}
		}
		attachMatchMetadata(values, match.start, text, groups);
		if (withIndices) values.indices = this.#indices(match);
		return values;
	}

	/** The `indices` of an `exec` result under the `d` flag. */
	#indices({ start, end, registers }: BacktrackMatch): RegExpIndicesArray {
		const spans: RegExpIndicesArray = [[start, end]];
		for (let group = 1; group < registers.length / 2; group++) {
			if (registers[2 * group]! >= 0) spans[group] = [registers[2 * group]!, registers[2 * group + 1]!];
			else defineUndefined(spans, group);
		}
		const names = this.#pattern.names;
		let groups: Record<string, [number, number]> | undefined;
		if (names.size > 0) {
			groups = Object.create(null);
			for (const [name, indices] of names) {
				const index = indices.find(group => registers[2 * group]! >= 0);
				if (index === undefined) defineUndefined(groups!, name);
				else groups![name] = spans[index]!;
			}
		}
		spans.groups = groups;
		return spans;
	}

	#firstMatchEnd(text: string, from: number): number {
		return this.#forward.firstMatchEnd(text, from, this.#classes.flagsBefore(text, from));
	}

	#matchAt(text: string, from: number): BacktrackMatch | undefined {
		return this.#firstMatchEnd(text, from) < 0 ? undefined : this.#backtracker.search(text, from, undefined, 1);
	}

	/**
	 * Leftmost match from `from`, one window of start positions at a time: the
	 * forward automaton finds where the earliest match ends, the reverse one marks
	 * the starts up to there, and the backtracker tries them in order.
	 */
	#search(text: string, from: number): BacktrackMatch | undefined {
		const reverse = this.#reverse!;
		for (let lo = from; lo <= text.length;) {
			const end = this.#firstMatchEnd(text, lo);
			if (end < 0) return undefined;
			// A regular pattern's leftmost match starts no later than its earliest-ending match ends.
			// Otherwise the automaton's matches only hint: cover enough starts to amortize each step.
			const hi = this.regular ? end : Math.min(text.length, Math.max(end, lo + this.#limits.window - 1));
			const size = hi - lo + 1;
			const marks = size <= SCRATCH ? this.#marks : new Uint8Array(size);
			reverse.markStarts(text, lo, hi, marks);
			for (const { dfa, behind } of this.#filters) {
				const holds = size <= SCRATCH ? this.#filterMarks : new Uint8Array(size);
				if (behind) dfa.markEnds(text, lo, hi, this.#limits.lookbehindContext, holds);
				else dfa.markStarts(text, lo, hi, holds);
				for (let index = 0; index < size; index++) marks[index]! &= holds[index]!;
			}
			const match = this.#backtracker.search(text, lo, marks, size);
			if (match) return match;
			lo = hi + 1;
		}
		return undefined;
	}
}

/** Gives the captures array the own metadata properties of a native `exec` result. */
function attachMatchMetadata(
	values: string[],
	index: number,
	input: string,
	groups: Record<string, string> | undefined,
): asserts values is RegExpExecArray {
	const match: string[] & Partial<Pick<RegExpExecArray, "index" | "input" | "groups">> = values;
	match.index = index;
	match.input = input;
	match.groups = groups;
}

/** Sets an own `undefined` element, as native `exec` results have for groups that did not participate. */
function defineUndefined(target: object, key: number | string): void {
	Object.defineProperty(target, key, { value: undefined, writable: true, enumerable: true, configurable: true });
}

/** `ToLength(lastIndex)`. */
function toLength(value: unknown): number {
	const number = Math.trunc(Number(value));
	return Number.isNaN(number) || number <= 0 ? 0 : Math.min(number, Number.MAX_SAFE_INTEGER);
}

/**
 * A `RegExp` that cannot backtrack catastrophically; see the module documentation.
 * Construct it like `RegExp`; everything that matches through `exec` follows.
 */
export class LinearRegExp extends RegExp {
	#engine: Engine | null | undefined;
	readonly #limits: EngineLimits;

	/**
	 * Like `RegExp`. `limits` overrides {@link EngineLimits} defaults; a copy of a
	 * `LinearRegExp` with the same flags (as `matchAll` makes) shares its compiled engine.
	 */
	constructor(pattern: string | RegExp, flags?: string, limits?: Partial<EngineLimits>) {
		super(pattern, flags);
		const original = pattern instanceof LinearRegExp ? pattern : undefined;
		if (limits) this.#limits = { ...DEFAULT_LIMITS, ...limits };
		else this.#limits = original ? original.#limits : DEFAULT_LIMITS;
		if (original && !limits && original.flags === this.flags) this.#engine = original.#compiled();
	}

	override exec(string: string): RegExpExecArray | null {
		const engine = this.#compiled();
		if (!engine) return super.exec(string);
		const text = String(string);
		const advancing = this.global || this.sticky;
		const from = advancing ? toLength(this.lastIndex) : 0;
		// `toLength` leaves the index double-tagged; at most `text.length` it fits int32, which the JIT code
		// below speculates on (a double index makes every scan bail out of optimized code).
		const match = from > text.length ? undefined : engine.match(text, from | 0);
		if (!match) {
			if (advancing) this.lastIndex = 0;
			return null;
		}
		if (advancing) this.lastIndex = match.end;
		return engine.execArray(text, match, this.hasIndices);
	}

	override test(string: string): boolean {
		const engine = this.#compiled();
		if (!engine) return super.test(string);
		if (this.global || this.sticky) return this.exec(string) !== null;
		return engine.test(String(string), 0);
	}

	/**
	 * Match detection over text that arrives in chunks, from index 0; undefined
	 * when the pattern keeps the native engine. A stream's "no" is final; its
	 * "yes" is final only when {@link LinearRegExp.streamsExactly}.
	 */
	stream(): RegexStream | undefined {
		return this.#compiled()?.stream();
	}

	/** Whether {@link LinearRegExp.stream} answers exactly (no lookarounds or backreferences). */
	get streamsExactly(): boolean {
		return this.#compiled()?.regular ?? false;
	}

	#compiled(): Engine | null {
		if (this.#engine === undefined) this.#engine = compile(this, this.#limits);
		return this.#engine;
	}
}

function compile(regex: RegExp, limits: EngineLimits): Engine | null {
	if (regex.unicode || regex.unicodeSets) return null;
	try {
		return new Engine(regex, limits);
	} catch (error) {
		if (
			error instanceof UnsupportedPatternError ||
			error instanceof OracleMismatchError ||
			error instanceof RangeError
		) {
			logger.debug("Regex keeps the native engine", { source: regex.source, reason: error.message });
			return null;
		}
		throw error;
	}
}
