/**
 * Lazily built DFA over an {@link Nfa}, and the streaming matcher on top of it.
 *
 * A state is the set of NFA nodes reached after a code unit, before ε-edges
 * are followed, plus what that code unit was; ε-edges are resolved once the
 * next class (or the end) is known, so `$` and `\b` see their lookahead. Every
 * code unit costs one table read once its transition is cached, so matching is
 * linear in the text whatever the pattern. Once the interpreter has read
 * {@link DfaLimits.jitAfter} code units, eligible scans use a WebAssembly kernel
 * generated from the cached transitions ({@link compileKernel}). Uncached
 * transitions stay on the table scan.
 *
 * Scans may also start or stop mid-text. Where the text beyond a scan's edge is
 * not read, the scan starts in the universal state (every NFA node), which
 * contains whatever state reading that text would have produced: its marks are
 * then a superset of the exact ones, never missing a position.
 */
import {
	cachedLayout,
	compileKernel,
	FIND,
	type Kernel,
	type Layout,
	load,
	MARK_AHEAD,
	MARK_BACK,
	runKernel,
	type ScanMode,
	stoppedState,
} from "./jit";
import { ASSERT, AT_START, CHAR, holds, MATCH, type Nfa, SPLIT } from "./nfa";
import type { RegexStream } from "./stream";

/** Pseudo-class for the end of the text. */
const END = -1;
/** Cached transitions (states × classes) past which no kernel is generated: its source would outweigh its gain. */
const KERNEL_ENTRIES = 1 << 14;
/**
 * A text the kernels have not loaded is copied only once this automaton has
 * interpreted 1/2^LOAD_SHIFT of its length, over one scan or several of texts
 * that long. Copying costs about as much as that, so short searches in long
 * fresh strings (a match near `lastIndex`, a secret's rematch probes) do not
 * each pay for a whole string, and a long scan pays at most twice.
 */
const LOAD_SHIFT = 4;

/** Sizes a {@link LazyDfa} trades speed for memory with; they never change its answers. */
export interface DfaLimits {
	/** Transition-table entries each automaton may cache before it starts over. */
	dfaEntries: number;
	/** Code units the interpreter reads before a kernel is generated; the wait doubles after every generation. */
	jitAfter: number;
}

/**
 * DFA built on demand. When the cache fills it starts over and
 * {@link LazyDfa.epoch} advances; holders of a state re-intern its core.
 */
export class LazyDfa {
	/** Advances whenever cached states are dropped. */
	epoch = 0;
	readonly #nfa: Nfa;
	readonly #anchored: boolean;
	readonly #width: number;
	readonly #maxStates: number;
	readonly #ids = new Map<string, number>();
	readonly #startCore: Int32Array;
	readonly #universalCore: Int32Array;
	/** Start and universal states per position-flags value, valid for `#entryEpoch`. */
	readonly #initialIds: Int32Array;
	readonly #universalIds: Int32Array;
	#entryEpoch = 0;
	#cores: Int32Array[] = [];
	#flags: number[] = [];
	/** `(next << 1) | matched` per state × class; -1 until computed. */
	#transitions: Int32Array;
	/** Whether a match ends at the end of the text, per state; -1 until computed. */
	#atEnd: Int8Array;
	readonly #visited: Uint32Array;
	/** The state the last {@link LazyDfa.#scan} stopped in. */
	#reached = 0;
	#generation = 0;
	readonly #stack: number[] = [];
	/** Kernels by {@link ScanMode}, generated during epoch `#kernelEpoch`. */
	#kernels: (Kernel | undefined)[] = [];
	#kernelEpoch = 0;
	/** Code units interpreted since the last kernel generation; the next one is due at `#jitAt`. */
	#interpreted = 0;
	#jitAt: number;
	readonly #jitAfter: number;
	/** Units interpreted, since the last copy, in texts of `#coldLength` units the kernels had not loaded. */
	#coldUnits = 0;
	#coldLength = -1;

	/** With `anchored`, matches must start where the run starts; otherwise anywhere. */
	constructor(nfa: Nfa, anchored: boolean, limits: DfaLimits) {
		this.#nfa = nfa;
		this.#anchored = anchored;
		this.#initialIds = new Int32Array(nfa.classes.positionFlags).fill(-1);
		this.#universalIds = new Int32Array(nfa.classes.positionFlags).fill(-1);
		this.#width = nfa.classes.alphabet.size;
		this.#maxStates = Math.max(1, Math.floor(limits.dfaEntries / this.#width));
		this.#jitAfter = limits.jitAfter;
		this.#jitAt = limits.jitAfter;
		this.#startCore = Int32Array.of(nfa.start);
		this.#universalCore = Int32Array.from(nfa.kind, (_, node) => node);
		this.#transitions = new Int32Array(16 * this.#width).fill(-1);
		this.#atEnd = new Int8Array(16).fill(-1);
		this.#visited = new Uint32Array(nfa.kind.length);
	}

	/** The state before the first code unit read, given the position flags before it. */
	initial(before: number = AT_START): number {
		return this.#entry(this.#initialIds, this.#startCore, before);
	}

	coreOf(state: number): Int32Array {
		return this.#cores[state]!;
	}

	flagsOf(state: number): number {
		return this.#flags[state]!;
	}

	/** Id of the state with this sorted core and flags, creating it (and possibly starting over) if new. */
	intern(core: Int32Array, flags: number): number {
		const key = `${flags}:${core.join(",")}`;
		const known = this.#ids.get(key);
		if (known !== undefined) return known;
		if (this.#cores.length >= this.#maxStates) {
			this.#ids.clear();
			this.#cores = [];
			this.#flags = [];
			this.#transitions.fill(-1);
			this.#atEnd.fill(-1);
			this.epoch++;
		}
		const id = this.#cores.push(core) - 1;
		this.#flags.push(flags);
		this.#ids.set(key, id);
		if (this.#atEnd.length <= id) {
			const atEnd = new Int8Array(this.#atEnd.length * 2).fill(-1);
			atEnd.set(this.#atEnd);
			this.#atEnd = atEnd;
			const transitions = new Int32Array(atEnd.length * this.#width).fill(-1);
			transitions.set(this.#transitions);
			this.#transitions = transitions;
		}
		return id;
	}

	/** Reads `text`; returns the state reached, or -1 once a match ends inside it. */
	run(state: number, text: string): number {
		return this.#scan(FIND, text, 0, text.length, state, undefined, 0) < text.length ? -1 : this.#reached;
	}

	/**
	 * Where the earliest-ending match that starts at or after `from` ends (only at
	 * `from` when anchored), or -1 without one. `before` is the position flags at `from`.
	 */
	firstMatchEnd(text: string, from: number, before: number): number {
		const end = this.#scan(FIND, text, from, text.length, this.initial(before), undefined, 0);
		if (end < text.length) return end;
		return this.acceptsAtEnd(this.#reached) ? text.length : -1;
	}

	/**
	 * Reads `text` from `index` towards `stop` (exclusive; downwards under
	 * {@link MARK_BACK}) starting in `state`: in the kernel while there is one, in
	 * the interpreter for each code unit the kernel leaves. {@link FIND} stops
	 * before the code unit whose transition ends a match; the mark modes record
	 * matches in `marks` relative to `lo`. Returns where it stopped and leaves the
	 * state there in `#reached`.
	 *
	 * The interpreter ({@link LazyDfa.#interpret}) runs a quota of code units at
	 * a time: a method call or the kernel bookkeeping per code unit multiplies its cost.
	 */
	#scan(
		mode: ScanMode,
		text: string,
		index: number,
		stop: number,
		state: number,
		marks: Uint8Array | undefined,
		lo: number,
	): number {
		const step = mode === MARK_BACK ? -1 : 1;
		let kernel = this.#kernel(mode);
		let interpreted = 0;
		let due = this.#jitAt - this.#interpreted;
		const start = index;
		let layout: Layout | -1 = -1;
		/** Units this scan interprets before copying `text`: unset until the cache was asked, Infinity once copying is ruled out. */
		let loadAfter: number | undefined;
		while (index !== stop) {
			if (kernel && layout === -1) {
				if (loadAfter === undefined) {
					layout =
						mode === MARK_BACK
							? cachedLayout(text, stop + 1, index + 1, true)
							: cachedLayout(text, index, stop, false);
					if (this.#coldLength !== text.length) {
						this.#coldLength = text.length;
						this.#coldUnits = 0;
					}
					loadAfter = (text.length >>> LOAD_SHIFT) - this.#coldUnits;
				}
				if (layout === -1 && Math.abs(index - start) >= loadAfter) {
					layout = load(text, mode === MARK_BACK ? index - stop : stop - index);
					if (layout === -1) {
						loadAfter = Infinity;
						kernel = undefined;
					} else {
						this.#coldUnits = 0;
					}
				}
			}
			if (kernel && layout !== -1) {
				index = runKernel(kernel, layout, mode, index, stop, state, marks, lo);
				if (mode === FIND && index < 0) return ~index;
				state = stoppedState();
				if (index === stop) break;
			}
			// Units to interpret before anything above can change: one to step over what the kernel
			// left, else up to the point a kernel is due or the text has earned its copy.
			let quota = Math.abs(stop - index);
			if (kernel && layout !== -1) {
				quota = 1;
			} else if (loadAfter !== Infinity) {
				quota = Math.min(quota, Math.max(1, due - interpreted));
				if (kernel) quota = Math.min(quota, Math.max(1, loadAfter! - Math.abs(index - start)));
			}
			// An int32 bound keeps the loop's index arithmetic out of doubles.
			const end = index + step * (quota | 0);
			index = this.#interpret(mode, text, index, end, state, marks, lo);
			state = this.#reached;
			interpreted += quota - Math.abs(end - index);
			// Only a FIND match stops the interpreter short.
			if (index !== end) break;
			// Interpreting can start the cache over, which outdates `kernel`, or make a new one due.
			if (loadAfter !== Infinity) {
				this.#interpreted += interpreted;
				interpreted = 0;
				kernel = this.#kernel(mode);
				due = this.#jitAt - this.#interpreted;
			}
		}
		this.#interpreted += interpreted;
		if (loadAfter !== undefined && layout === -1) this.#coldUnits += Math.abs(index - start);
		this.#reached = state;
		return index;
	}

	/**
	 * The table scan: reads `text` from `index` to `end` (exclusive; downwards
	 * under {@link MARK_BACK}) starting in `state`. Returns where it stopped, short
	 * of `end` only before the code unit whose transition ends a {@link FIND}
	 * match, and leaves the state there in `#reached`.
	 *
	 * Nothing but the loop lives here, so the optimizing compiler takes it whole.
	 */
	#interpret(
		mode: ScanMode,
		text: string,
		index: number,
		end: number,
		state: number,
		marks: Uint8Array | undefined,
		lo: number,
	): number {
		const step = mode === MARK_BACK ? -1 : 1;
		const width = this.#width;
		const { blockIndex, blocks } = this.#nfa.classes.alphabet;
		let transitions = this.#transitions;
		while (index !== end) {
			const unit = text.charCodeAt(index);
			const id = blocks[(blockIndex[unit >>> 8]! << 8) | (unit & 255)]!;
			let next = transitions[state * width + id]!;
			if (next < 0) {
				next = this.#step(state, id);
				// A step can grow the table or start it over.
				transitions = this.#transitions;
			}
			if (next & 1) {
				if (mode === FIND) break;
				if (mode === MARK_BACK) marks![index + 1 - lo] = 1;
				else if (index >= lo) marks![index - lo] = 1;
			}
			state = next >>> 1;
			index += step;
		}
		this.#reached = state;
		return index;
	}

	/**
	 * The kernel for `mode`, regenerated from the cached transitions once the
	 * interpreter has read `#jitAt` code units since the last generation.
	 */
	#kernel(mode: ScanMode): Kernel | undefined {
		if (this.#kernelEpoch !== this.epoch) {
			// Starting over renumbers the states: kernels from before are wrong, not just incomplete.
			this.#kernels = [];
			this.#kernelEpoch = this.epoch;
			this.#interpreted = 0;
			this.#jitAt = this.#jitAfter;
		}
		if (this.#interpreted >= this.#jitAt) {
			this.#interpreted = 0;
			// Doubling the wait bounds generation work by the units interpreted, however long the cache keeps growing.
			this.#jitAt = Math.max(1, this.#jitAt * 2);
			if (!this.#kernels[mode] && this.#nfa.kind.length <= 128) this.#prefill();
			const states = this.#cores.length;
			const kernel =
				states * this.#width > KERNEL_ENTRIES
					? undefined
					: compileKernel(mode, states, this.#width, this.#transitions, this.#nfa.classes.alphabet.runs);
			// An older kernel stays valid within its epoch, only less complete.
			if (kernel) this.#kernels[mode] = kernel;
		}
		return this.#kernels[mode];
	}

	/** Complete a small DFA before optimizing; don't renumber a live scan's state. */
	#prefill(): void {
		const width = this.#width;
		for (let state = 0; state < this.#cores.length && (state + 1) * width <= 256; state++) {
			for (let id = 0; id < width; id++) {
				if (this.#cores.length >= this.#maxStates) return;
				if (this.#transitions[state * width + id]! < 0) this.#step(state, id);
			}
		}
	}

	/**
	 * For an unanchored automaton compiled `reverse`: sets `marks[p - lo]` for
	 * every position `p` in `[lo, hi]` where a match of the original pattern can
	 * start (and clears the others), reading `text` from `hi` back to `lo`. Exact
	 * when `hi` is the end of the text, a superset otherwise.
	 */
	markStarts(text: string, lo: number, hi: number, marks: Uint8Array): void {
		marks.fill(0, 0, hi - lo + 1);
		const state = hi === text.length ? this.initial() : this.#universal(this.#nfa.classes.flagsAt(text, hi) << 1);
		// One unit past `lo` (when there is one) decides whether a match can start at `lo`; a
		// reversed match ending before `text[index]` is a match starting after it.
		this.#scan(MARK_BACK, text, hi - 1, Math.max(lo - 2, -1), state, marks, lo);
		if (lo === 0 && this.acceptsAtEnd(this.#reached)) marks[0] = 1;
	}

	/**
	 * For an unanchored forward automaton: sets `marks[p - lo]` for every position
	 * `p` in `[lo, hi]` where a match can end, reading from `context` units before
	 * `lo`. Exact when that reaches the start of the text, a superset otherwise.
	 */
	markEnds(text: string, lo: number, hi: number, context: number, marks: Uint8Array): void {
		marks.fill(0, 0, hi - lo + 1);
		const from = Math.max(0, lo - context);
		const state = from === 0 ? this.initial() : this.#universal(this.#nfa.classes.flagsBefore(text, from));
		this.#scan(MARK_AHEAD, text, from, Math.min(hi + 1, text.length), state, marks, lo);
		if (hi === text.length && this.acceptsAtEnd(this.#reached)) marks[hi - lo] = 1;
	}

	/** Whether a match ends at the end of the text when `state` is the last state. */
	acceptsAtEnd(state: number): boolean {
		let accepts = this.#atEnd[state]!;
		if (accepts < 0) {
			accepts = this.#close(state, END, undefined) ? 1 : 0;
			this.#atEnd[state] = accepts;
		}
		return accepts === 1;
	}

	/** The state holding every node, for a scan that starts mid-text with position flags `before`. */
	#universal(before: number): number {
		return this.#entry(this.#universalIds, this.#universalCore, before);
	}

	/** The state for `core` with position flags `before`, through the per-epoch cache `ids`. */
	#entry(ids: Int32Array, core: Int32Array, before: number): number {
		let id = this.#entryEpoch === this.epoch ? ids[before]! : -1;
		if (id < 0) {
			id = this.intern(core, before);
			// Interning can start the cache over; ids cached under an older epoch are gone.
			if (this.#entryEpoch !== this.epoch) {
				this.#initialIds.fill(-1);
				this.#universalIds.fill(-1);
				this.#entryEpoch = this.epoch;
			}
			ids[before] = id;
		}
		return id;
	}

	#step(state: number, id: number): number {
		const successors: number[] = [];
		const matched = this.#close(state, id, successors);
		if (!this.#anchored) successors.push(this.#nfa.start);
		const core = Int32Array.from(new Set(successors)).sort();
		const epoch = this.epoch;
		const next = (this.intern(core, this.#nfa.classes.classFlags[id]! << 1) << 1) | (matched ? 1 : 0);
		if (epoch === this.epoch) this.#transitions[state * this.#width + id] = next;
		return next;
	}

	/**
	 * Follows ε-edges from `state`'s core with class `id` (or {@link END}) next,
	 * collecting the nodes `CHAR` edges reach on it. Returns whether `MATCH` was reached.
	 */
	#close(state: number, id: number, successors: number[] | undefined): boolean {
		const { kind, out1, out2, classes } = this.#nfa;
		const { sets, classFlags } = classes;
		const before = this.#flags[state]!;
		const after = id === END ? 0 : classFlags[id]!;
		const visited = this.#visited;
		if (++this.#generation === 0xffffffff) {
			visited.fill(0);
			this.#generation = 1;
		}
		const generation = this.#generation;
		const stack = this.#stack;
		for (const node of this.#cores[state]!) stack.push(node);
		let matched = false;
		while (stack.length > 0) {
			const node = stack.pop()!;
			if (visited[node] === generation) continue;
			visited[node] = generation;
			switch (kind[node]) {
				case CHAR:
					if (successors && sets[out2[node]!]![id]) successors.push(out1[node]!);
					break;
				case SPLIT:
					stack.push(out2[node]!, out1[node]!);
					break;
				case ASSERT:
					if (holds(out2[node]!, before, id === END, after)) stack.push(out1[node]!);
					break;
				case MATCH:
					matched = true;
			}
		}
		return matched;
	}
}

/**
 * Incremental match detection over text that arrives in chunks: after each
 * {@link RegexStream.push}, {@link RegexStream.matched} is whether the
 * automaton matches all text so far, at the cost of the new chunk only.
 */
export class DfaStream implements RegexStream {
	readonly #dfa: LazyDfa;
	#state: number;
	#epoch: number;
	#core: Int32Array;
	#flags: number;
	#settled = false;

	constructor(dfa: LazyDfa) {
		this.#dfa = dfa;
		this.#state = dfa.initial();
		this.#epoch = dfa.epoch;
		this.#core = dfa.coreOf(this.#state);
		this.#flags = dfa.flagsOf(this.#state);
	}

	/** Appends text. */
	push(chunk: string): void {
		if (this.#settled || chunk.length === 0) return;
		const state = this.#dfa.run(this.#current(), chunk);
		if (state < 0) {
			this.#settled = true;
			return;
		}
		this.#state = state;
		this.#epoch = this.#dfa.epoch;
		this.#core = this.#dfa.coreOf(state);
		this.#flags = this.#dfa.flagsOf(state);
	}

	/** Whether the text so far contains a match. */
	get matched(): boolean {
		return this.#settled || this.#dfa.acceptsAtEnd(this.#current());
	}

	#current(): number {
		if (this.#epoch !== this.#dfa.epoch) {
			this.#state = this.#dfa.intern(this.#core, this.#flags);
			this.#epoch = this.#dfa.epoch;
		}
		return this.#state;
	}
}
