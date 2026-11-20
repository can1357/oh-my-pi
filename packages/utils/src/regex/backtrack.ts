/**
 * Memoized backtracking matcher with JavaScript's semantics, for {@link LinearRegExp}.
 *
 * It finds what an automaton cannot: capture groups, backreferences and
 * lookarounds, exactly as the ECMAScript matcher does — alternatives and
 * quantifiers in priority order, captures cleared at every iteration, an
 * optional iteration that consumes nothing fails, lookarounds are atomic, and
 * lookbehinds match right to left.
 *
 * The search is depth-first and stops at its first success, so a configuration
 * whose whole subtree was explored has failed for good. Such configurations are
 * recorded at join instructions (in-degree ≥ 2) and never explored again, which
 * bounds a search by instructions × positions when no backreference reads a
 * capture (Davis et al., "Using Selective Memoization to Defeat Regular
 * Expression Denial of Service"). A configuration is the instruction, the
 * position, which optional iterations have consumed nothing yet, and the
 * captures a backreference reachable from it can read. Configurations that
 * depend on captures are only tracked once an attempt has visited many of
 * them: a well-behaved backreference pattern pays nothing, a blow-up is cut short.
 */
import { caseFoldEquals } from "./alphabet";
import { GreedyRuns, REPLAY_LIMIT } from "./greedy";
import { assertionOf, type CharClasses, holds, MAX_NODES } from "./nfa";
import { capturesWithin, nullable, type ParsedPattern, type RegexNode } from "./parse";

const CHAR = 0;
const SPLIT = 1;
const OPEN = 2;
const CLOSE = 3;
const CLEAR = 4;
const MARK = 5;
const CHECK = 6;
const ASSERT = 7;
const BACKREF = 8;
const LOOK = 9;
const SUCCEED = 10;

/** Nesting limit for nullable loops: one mask bit per level. */
const MAX_NULLABLE_DEPTH = 30;
/** Positions per memo page, one bit each. */
const PAGE_SHIFT = 12;
const PAGE_MASK = (1 << PAGE_SHIFT) - 1;
const PAGE_BYTES = 1 << (PAGE_SHIFT - 3);
/** Released memo pages kept for reuse, so one-shot searches on fresh strings allocate nothing. */
const PAGE_POOL = 64;
/**
 * A memo is kept for the next search only when it records at least one failure
 * per this many code units of text. Keeping it means comparing the next text
 * with this one, which reads up to the whole text; a smaller memo is cheaper to
 * rebuild than that.
 */
const KEEP_MEMO_RATIO = 512;
/** Group zero is stored as the match's start and end, never in the register file. */
const NO_CAPTURES = new Int32Array(2).fill(-1);
/** Bounds on the failure memo of a {@link Backtracker}. */
export interface MemoLimits {
	/** Capture-dependent configurations an attempt may visit before they are memoized. */
	memoAfter: number;
	/** Memo pages (512 bytes each) kept per text; past it the memo starts over. */
	memoPages: number;
	/** Capture and iteration contexts kept per text; past it the memo starts over. */
	memoContexts: number;
}

/**
 * Compiled program. Instruction `pc` is `op[pc]` with fields:
 * - `CHAR`: `x` set index, `y` 1 when matching backwards;
 * - `SPLIT`: `next` preferred, `x` the alternative;
 * - `OPEN`/`CLOSE`: `x` group (`CLOSE.y` 1 backwards); `CLEAR`: groups `x`..`y`;
 * - `MARK`/`CHECK`: `x` mask bit; `ASSERT`: `x` assertion;
 * - `BACKREF`: `x` index into `refs`, `y` 1 backwards; `LOOK`: `x` body entry, `y` 1 when negative.
 */
interface Program {
	op: Uint8Array;
	next: Int32Array;
	x: Int32Array;
	y: Int32Array;
	entry: number;
	groupCount: number;
	/** Candidate groups per backreference; duplicate group names give several. */
	refs: number[][];
	/** 1 at join instructions, where configurations are memoized. */
	memo: Uint8Array;
	/** Index into `readGroups` per instruction; 0 when no reachable backreference reads a capture. */
	reads: Int32Array;
	/** Distinct sets of groups whose captures a reachable backreference can read; entry 0 is empty. */
	readGroups: number[][];
}

/** A match with its capture registers: group `g` spans `[registers[2g], registers[2g + 1])`, -1 when unset. */
export interface BacktrackMatch {
	start: number;
	end: number;
	registers: Int32Array;
}

class ProgramBuilder {
	readonly op: number[] = [];
	readonly next: number[] = [];
	readonly x: number[] = [];
	readonly y: number[] = [];
	readonly refs: number[][] = [];
	readonly #pattern: ParsedPattern;
	readonly #classes: CharClasses;
	readonly #multiline: boolean;
	/** Nullable loops enclosing the node being compiled, within the current (sub)program. */
	#depth = 0;

	constructor(pattern: ParsedPattern, classes: CharClasses, multiline: boolean) {
		this.#pattern = pattern;
		this.#classes = classes;
		this.#multiline = multiline;
	}

	add(op: number, next: number, x = 0, y = 0): number {
		if (this.op.length >= MAX_NODES) throw new RangeError(`more than ${MAX_NODES} instructions`);
		this.op.push(op);
		this.next.push(next);
		this.x.push(x);
		this.y.push(y);
		return this.op.length - 1;
	}

	/** Entry instruction of `node` followed by `next`, matching backwards when `backward`. */
	compile(node: RegexNode, next: number, backward: boolean): number {
		const direction = backward ? 1 : 0;
		switch (node.type) {
			case "unit":
				return this.add(CHAR, next, this.#classes.setOf(node), direction);
			case "seq": {
				// Backwards the last item is matched first.
				const { items } = node;
				let entry = next;
				for (let index = 0; index < items.length; index++) {
					entry = this.compile(items[backward ? index : items.length - 1 - index]!, entry, backward);
				}
				return entry;
			}
			case "alt": {
				const entries = node.options.map(option => this.compile(option, next, backward));
				let entry = entries[entries.length - 1]!;
				for (let index = entries.length - 2; index >= 0; index--) entry = this.add(SPLIT, entries[index]!, entry);
				return entry;
			}
			case "group": {
				if (node.capture === undefined) return this.compile(node.body, next, backward);
				const close = this.add(CLOSE, next, node.capture, direction);
				return this.add(OPEN, this.compile(node.body, close, backward), node.capture);
			}
			case "assert":
				// Assertions read both neighbours of the position, whichever way the match runs.
				return this.add(ASSERT, next, assertionOf(node.kind, this.#multiline, false));
			case "look": {
				const depth = this.#depth;
				this.#depth = 0;
				try {
					const body = this.compile(node.body, this.add(SUCCEED, -1), node.behind);
					return this.add(LOOK, next, body, node.negate ? 1 : 0);
				} finally {
					this.#depth = depth;
				}
			}
			case "backref": {
				const { target } = node;
				const groups = typeof target === "number" ? [target] : (this.#pattern.names.get(target) ?? []);
				return this.add(BACKREF, next, this.refs.push(groups) - 1, direction);
			}
			case "repeat":
				return this.#repeat(node.body, node.min, node.max, node.greedy, next, backward);
		}
	}

	#repeat(body: RegexNode, min: number, max: number, greedy: boolean, next: number, backward: boolean): number {
		if (min > MAX_NODES || (max !== Infinity && max > MAX_NODES)) {
			throw new RangeError(`quantifier bound past ${MAX_NODES}`);
		}
		const captures = capturesWithin(body);
		const emptyFails = nullable(body);
		/** One iteration: clears the body's captures; past the minimum, an empty pass fails. */
		const iteration = (optional: boolean, then: number): number => {
			const checked = optional && emptyFails;
			const bit = this.#depth;
			if (checked) {
				if (bit >= MAX_NULLABLE_DEPTH) throw new RangeError(`nullable loops nested past ${MAX_NULLABLE_DEPTH}`);
				this.#depth++;
			}
			try {
				let entry = this.compile(body, checked ? this.add(CHECK, then, bit) : then, backward);
				if (captures) entry = this.add(CLEAR, entry, captures[0], captures[1]);
				return checked ? this.add(MARK, entry, bit) : entry;
			} finally {
				if (checked) this.#depth--;
			}
		};
		const split = (body: number, exit: number): number =>
			greedy ? this.add(SPLIT, body, exit) : this.add(SPLIT, exit, body);
		let entry = next;
		if (max === Infinity) {
			const loop = this.add(SPLIT, -1, -1);
			const body = iteration(true, loop);
			this.next[loop] = greedy ? body : next;
			this.x[loop] = greedy ? next : body;
			entry = loop;
		} else {
			// `x{0,n}` as nested optionals; each one exits straight to `next`.
			for (let count = min; count < max; count++) entry = split(iteration(true, entry), next);
		}
		for (let count = 0; count < min; count++) entry = iteration(false, entry);
		return entry;
	}
}

/**
 * Compiles a parsed pattern into a backtracking program.
 *
 * @throws {RangeError} past {@link MAX_NODES} instructions or nested nullable loops.
 */
function compileProgram(pattern: ParsedPattern, classes: CharClasses, multiline: boolean): Program {
	const builder = new ProgramBuilder(pattern, classes, multiline);
	const entry = builder.compile(pattern.root, builder.add(SUCCEED, -1), false);
	const op = Uint8Array.from(builder.op);
	const next = Int32Array.from(builder.next);
	const x = Int32Array.from(builder.x);
	const size = op.length;
	const successors = (pc: number): number[] => {
		switch (op[pc]) {
			case SUCCEED:
				return [];
			case SPLIT:
			case LOOK:
				return [next[pc]!, x[pc]!];
			default:
				return [next[pc]!];
		}
	};
	const inDegree = new Uint32Array(size);
	inDegree[entry]!++;
	for (let pc = 0; pc < size; pc++) for (const successor of successors(pc)) inDegree[successor]!++;
	const memo = Uint8Array.from(inDegree, degree => (degree >= 2 ? 1 : 0));
	// Groups a reachable backreference reads, by fixpoint over the instruction graph.
	const reads = Array.from({ length: size }, (): Set<number> | undefined => undefined);
	if (builder.refs.length > 0) {
		for (let pc = 0; pc < size; pc++) if (op[pc] === BACKREF) reads[pc] = new Set(builder.refs[x[pc]!]);
		for (let changed = true; changed;) {
			changed = false;
			for (let pc = size - 1; pc >= 0; pc--) {
				for (const successor of successors(pc)) {
					const downstream = reads[successor];
					if (!downstream) continue;
					const own = (reads[pc] ??= new Set());
					for (const group of downstream) {
						if (!own.has(group)) {
							own.add(group);
							changed = true;
						}
					}
				}
			}
		}
	}
	const readGroups: number[][] = [[]];
	const readIds = new Map<string, number>();
	const readsOf = Int32Array.from(reads, groups => {
		if (!groups || groups.size === 0) return 0;
		const sorted = [...groups].sort((a, b) => a - b);
		const key = sorted.join(",");
		let id = readIds.get(key);
		if (id === undefined) {
			id = readGroups.push(sorted) - 1;
			readIds.set(key, id);
		}
		return id;
	});
	return {
		op,
		next,
		x,
		y: Int32Array.from(builder.y),
		entry,
		groupCount: pattern.groups.length === 0 ? 0 : pattern.groups.length - 1,
		refs: builder.refs,
		memo,
		reads: readsOf,
		readGroups,
	};
}

/** Runs a compiled program; keeps the failure memo while it is asked about the same text. */
export class Backtracker {
	readonly #program: Program;
	readonly #greedy: GreedyRuns | undefined;
	readonly #classes: CharClasses;
	readonly #ignoreCase: boolean;
	readonly #limits: MemoLimits;
	/** Capture start/end at `2g`/`2g + 1`; the position a group opened at, at `pending + g`. */
	readonly #registers: Int32Array;
	readonly #pending: number;
	/** (register, previous value) pairs, undone on backtracking. */
	readonly #undo: number[] = [];
	/** Choice points (instruction, position, mask, undo length, path length); each run owns the entries above its base. */
	readonly #choices: number[] = [];
	/** (memo key, bit) of the memoized configurations on the current search path: not known to fail yet. */
	readonly #path: number[] = [];
	#text: string | undefined;
	#pageCount = 1;
	/** Failed configurations, one bit per position, in pages keyed by context, page and instruction. */
	readonly #failed = new Map<number, Uint8Array>();
	readonly #freePages: Uint8Array[] = [];
	/** Failures recorded for the current text. */
	#recorded = 0;
	/** Context ids by the captures and iteration mask a configuration depends on; 0 is "neither". */
	readonly #contexts = new Map<string, number>();
	readonly #maskContexts = new Map<number, number>();
	#nextContext = 1;
	/** Bumped whenever a register changes; validates the context cached per read set. */
	#version = 0;
	readonly #cachedVersion: Float64Array;
	readonly #cachedMask: Int32Array;
	readonly #cachedContext: Int32Array;
	/** Capture-dependent configurations the current attempt visited, up to {@link MemoLimits.memoAfter}. */
	#contextVisits = 0;

	/**
	 * @throws {RangeError} past {@link MAX_NODES} instructions or nested nullable loops.
	 */
	constructor(
		pattern: ParsedPattern,
		classes: CharClasses,
		flags: { ignoreCase: boolean; multiline: boolean },
		limits: MemoLimits,
	) {
		this.#program = compileProgram(pattern, classes, flags.multiline);
		this.#greedy = GreedyRuns.compile(pattern.root, classes);
		this.#classes = classes;
		this.#ignoreCase = flags.ignoreCase;
		this.#limits = limits;
		const groups = this.#program.groupCount;
		this.#pending = 2 * groups + 2;
		this.#registers = new Int32Array(3 * groups + 3);
		const readSets = this.#program.readGroups.length;
		this.#cachedVersion = new Float64Array(readSets).fill(-1);
		this.#cachedMask = new Int32Array(readSets);
		this.#cachedContext = new Int32Array(readSets);
	}

	/**
	 * Resolves an unanchored match from a required literal, without scanning the
	 * automata. Returns null for a missing literal and undefined when undecided.
	 */
	probe(text: string, from: number): BacktrackMatch | null | undefined {
		const greedy = this.#greedy;
		if (!greedy) return undefined;
		// Try a few false leads without building a marks array. An undecided
		// attempt must still take priority over every later start.
		for (let attempts = 0; attempts < 3; attempts++) {
			const start = greedy.firstStart(text, from);
			if (start === undefined) return undefined;
			if (start < 0) return null;
			const end = greedy.match(text, start, this.#registers);
			if (end === REPLAY_LIMIT) return undefined;
			if (end >= 0) {
				if (this.#text !== undefined && text !== this.#text) this.release();
				return this.#matched(text, start, end);
			}
			from = start + 1;
		}
		return undefined;
	}

	/**
	 * The match JavaScript's `exec` finds among the `count` start positions
	 * `lo + i` with `marks[i]` set (a superset of the real starts), tried in order;
	 * without `marks`, all of them. A memo worth more than re-reading the text is
	 * kept for the next search of the same text.
	 */
	search(text: string, lo: number, marks: Uint8Array | undefined, count: number): BacktrackMatch | undefined {
		// An empty memo holds for any text: only a kept one needs the texts compared.
		if (this.#text === undefined || text !== this.#text) {
			this.release();
			this.#text = text;
			this.#pageCount = (text.length >>> PAGE_SHIFT) + 1;
		}
		for (let offset = 0; offset < count; offset++) {
			if (marks) {
				offset = marks.indexOf(1, offset);
				if (offset < 0 || offset >= count) break;
			}
			const start = lo + offset;
			let end = this.#greedy?.match(text, start, this.#registers) ?? REPLAY_LIMIT;
			if (end === REPLAY_LIMIT) {
				this.#registers.fill(-1);
				this.#version++;
				this.#undo.length = 0;
				this.#contextVisits = 0;
				end = this.#run(this.#program.entry, start);
			}
			if (end >= 0) return this.#matched(text, start, end);
		}
		return undefined;
	}

	#matched(text: string, start: number, end: number): BacktrackMatch {
		const registers = this.#pending === 2 ? NO_CAPTURES : this.#registers.slice(0, this.#pending);
		if (this.#recorded * KEEP_MEMO_RATIO < text.length) this.release();
		return { start, end, registers };
	}

	/** Forgets the text and its memo, so neither outlives the scan that used them. */
	release(): void {
		if (this.#text === undefined) return;
		this.#text = undefined;
		this.#resetMemo();
	}

	/**
	 * Depth-first search from `entry` at `start`; returns the end position of the
	 * first success or -1. Memoized configurations go on {@link Backtracker.#path}
	 * when visited and are recorded as failed once the search backtracks past them.
	 */
	#run(entry: number, start: number): number {
		const { op, next, x, y, memo, refs, reads } = this.#program;
		const { sets } = this.#classes;
		const { blockIndex, blocks } = this.#classes.alphabet;
		const size = op.length;
		const text = this.#text!;
		const length = text.length;
		const registers = this.#registers;
		const pending = this.#pending;
		const undo = this.#undo;
		const failed = this.#failed;
		const choices = this.#choices;
		const base = choices.length;
		const path = this.#path;
		const pathBase = path.length;
		let pc = entry;
		let position = start;
		let mask = 0;
		for (;;) {
			fail: {
				if (memo[pc]) {
					const context = reads[pc] === 0 && mask === 0 ? 0 : this.#contextOf(reads[pc]!, mask);
					if (context >= 0) {
						const key = (context * this.#pageCount + (position >>> PAGE_SHIFT)) * size + pc;
						const bit = position & PAGE_MASK;
						const page = failed.get(key);
						if (page !== undefined && page[bit >> 3]! & (1 << (bit & 7))) break fail;
						path.push(key, bit);
					}
				}
				switch (op[pc]) {
					case CHAR: {
						const at = y[pc] ? position - 1 : position;
						if (at < 0 || at >= length) break fail;
						const unit = text.charCodeAt(at);
						if (!sets[x[pc]!]![blocks[(blockIndex[unit >>> 8]! << 8) | (unit & 255)]!]) break fail;
						position = y[pc] ? at : at + 1;
						mask = 0;
						pc = next[pc]!;
						continue;
					}
					case SPLIT:
						choices.push(x[pc]!, position, mask, undo.length, path.length);
						pc = next[pc]!;
						continue;
					case OPEN:
						this.#set(pending + x[pc]!, position);
						pc = next[pc]!;
						continue;
					case CLOSE: {
						const group = x[pc]!;
						const opened = registers[pending + group]!;
						this.#set(2 * group, y[pc] ? position : opened);
						this.#set(2 * group + 1, y[pc] ? opened : position);
						pc = next[pc]!;
						continue;
					}
					case CLEAR:
						for (let group = x[pc]!; group <= y[pc]!; group++) {
							if (registers[2 * group]! >= 0) {
								this.#set(2 * group, -1);
								this.#set(2 * group + 1, -1);
							}
						}
						pc = next[pc]!;
						continue;
					case MARK:
						mask |= 1 << x[pc]!;
						pc = next[pc]!;
						continue;
					case CHECK:
						if (mask & (1 << x[pc]!)) break fail;
						pc = next[pc]!;
						continue;
					case ASSERT: {
						const before = this.#classes.flagsBefore(text, position);
						if (!holds(x[pc]!, before, position === length, this.#classes.flagsAt(text, position))) break fail;
						pc = next[pc]!;
						continue;
					}
					case BACKREF: {
						const consumed = this.#backreference(refs[x[pc]!]!, position, y[pc] === 1);
						if (consumed < 0) break fail;
						position += y[pc] ? -consumed : consumed;
						if (consumed > 0) mask = 0;
						pc = next[pc]!;
						continue;
					}
					case LOOK: {
						const mark = undo.length;
						const found = this.#run(x[pc]!, position) >= 0;
						// A positive lookaround keeps the captures of its first success; nothing else does.
						if (!found || y[pc]) this.#undoTo(mark);
						if (found === (y[pc] === 1)) break fail;
						pc = next[pc]!;
						continue;
					}
					default:
						// Success: what is still on the path led here, so none of it failed.
						choices.length = base;
						if (path.length > pathBase) path.length = pathBase;
						return position;
				}
			}
			if (choices.length === base) {
				this.#confirm(pathBase);
				return -1;
			}
			this.#confirm(choices.pop()!);
			this.#undoTo(choices.pop()!);
			mask = choices.pop()!;
			position = choices.pop()!;
			pc = choices.pop()!;
		}
	}

	/** Records the configurations put on the path since `length` as failed: their subtrees are exhausted. */
	#confirm(length: number): void {
		const path = this.#path;
		const failed = this.#failed;
		for (let index = length; index < path.length; index += 2) {
			const key = path[index]!;
			let page = failed.get(key);
			if (page === undefined) {
				if (failed.size >= this.#limits.memoPages) {
					this.#resetMemo();
					return;
				}
				page = this.#freePages.pop()?.fill(0) ?? new Uint8Array(PAGE_BYTES);
				failed.set(key, page);
			}
			const bit = path[index + 1]!;
			page[bit >> 3]! |= 1 << (bit & 7);
			this.#recorded++;
		}
		if (path.length > length) path.length = length;
	}

	/**
	 * Context id of a configuration that depends on the captures of read set
	 * `reads` or on `mask`; -1 while the attempt has not earned capture memoization.
	 */
	#contextOf(reads: number, mask: number): number {
		if (reads === 0) {
			let id = this.#maskContexts.get(mask);
			if (id === undefined) {
				id = this.#newContext();
				this.#maskContexts.set(mask, id);
			}
			return id;
		}
		if (this.#contextVisits < this.#limits.memoAfter) {
			this.#contextVisits++;
			return -1;
		}
		if (this.#cachedVersion[reads] === this.#version && this.#cachedMask[reads] === mask) {
			return this.#cachedContext[reads]!;
		}
		const registers = this.#registers;
		let key = `${reads}:${mask}`;
		for (const group of this.#program.readGroups[reads]!) {
			key += `:${registers[2 * group]},${registers[2 * group + 1]},${registers[this.#pending + group]}`;
		}
		let id = this.#contexts.get(key);
		if (id === undefined) {
			id = this.#newContext();
			this.#contexts.set(key, id);
		}
		this.#cachedVersion[reads] = this.#version;
		this.#cachedMask[reads] = mask;
		this.#cachedContext[reads] = id;
		return id;
	}

	#newContext(): number {
		if (this.#nextContext >= this.#limits.memoContexts) this.#resetMemo();
		return this.#nextContext++;
	}

	/** Drops every recorded failure; keys on the path would name contexts that no longer exist. */
	#resetMemo(): void {
		if (this.#failed.size > 0) {
			for (const page of this.#failed.values()) {
				if (this.#freePages.length >= PAGE_POOL) break;
				this.#freePages.push(page);
			}
			this.#failed.clear();
		}
		if (this.#nextContext > 1) {
			this.#contexts.clear();
			this.#maskContexts.clear();
			this.#nextContext = 1;
			this.#cachedVersion.fill(-1);
		}
		this.#recorded = 0;
		this.#path.length = 0;
	}

	/** Units a backreference consumes at `position`, or -1 when it does not match. */
	#backreference(groups: number[], position: number, backward: boolean): number {
		const registers = this.#registers;
		const text = this.#text!;
		for (const group of groups) {
			const start = registers[2 * group]!;
			if (start < 0) continue;
			const length = registers[2 * group + 1]! - start;
			const at = backward ? position - length : position;
			if (at < 0 || at + length > text.length) return -1;
			for (let offset = 0; offset < length; offset++) {
				const expected = text.charCodeAt(start + offset);
				const actual = text.charCodeAt(at + offset);
				if (expected !== actual && !(this.#ignoreCase && caseFoldEquals(expected, actual))) return -1;
			}
			return length;
		}
		// A reference to a group that did not participate matches the empty string.
		return 0;
	}

	#set(register: number, value: number): void {
		this.#undo.push(register, this.#registers[register]!);
		this.#registers[register] = value;
		this.#version++;
	}

	#undoTo(length: number): void {
		const undo = this.#undo;
		if (undo.length <= length) return;
		const registers = this.#registers;
		while (undo.length > length) {
			const value = undo.pop()!;
			registers[undo.pop()!] = value;
		}
		this.#version++;
	}
}
