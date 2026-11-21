import { LEAD_SURROGATE, SURROGATE_END, TRAIL_SURROGATE } from "./alphabet";
import type { BacktrackMatch } from "./backtrack";
import type { ParsedPattern, RegexNode } from "./parse";
import type { RegexStream } from "./stream";

const MIN_LITERAL_WEIGHT = 1024;
// State 0 is the root. A 16-bit state id lets each sparse edge pack a code unit and target.
const MAX_STATES = 1 << 16;
const MAX_PATTERN_ITEMS = 1 << 20;
const MAX_NESTING = 256;
const NO_RANK = 0xffffffff;
const DEAD = -1;
const FOUND = -2;

/** Cheap admission heuristic before the regular engine builds its character classes. */
function looksLarge(root: RegexNode): boolean {
	if (root.type === "seq") return root.items.length >= MIN_LITERAL_WEIGHT;
	if (root.type !== "alt") return false;
	let weight = root.options.length;
	for (let index = 0; weight < MIN_LITERAL_WEIGHT && index < root.options.length; index++) {
		const option = root.options[index]!;
		if (option.type === "seq") weight += option.items.length;
	}
	return weight >= MIN_LITERAL_WEIGHT;
}

function isLead(code: number): boolean {
	return code >= LEAD_SURROGATE && code < TRAIL_SURROGATE;
}

function escapeUnit(code: number): string {
	return `\\u${code.toString(16).padStart(4, "0")}`;
}

/**
 * Compiles fixed literal branches, optionally wrapped in whole-match captures. `force`
 * skips only the size heuristic, for retry after regular compilation rejects a pattern.
 * Branch-local captures, classes, guards, nested disjunctions and case folding stay
 * with the other engines. In Unicode mode only complete surrogate pairs are admitted.
 */
export function compileLiteralAlternatives(
	pattern: ParsedPattern,
	flags: { sticky: boolean; ignoreCase: boolean },
	force = false,
): LiteralAlternatives | undefined {
	if (flags.ignoreCase || pattern.scopedCase) return undefined;
	let root = pattern.root;
	let budget = MAX_PATTERN_ITEMS;
	while (root.type === "group") {
		if (--budget < 0) return undefined;
		root = root.body;
	}
	if (!force && !looksLarge(root)) return undefined;
	const { unicode } = pattern;
	const options = root.type === "alt" ? root.options : [root];
	if (options.length > budget) return undefined;
	const byEdge = new Map<number, number>();
	// Indexed by child state: packed (parent, code unit) and first source alternative.
	const parents = [0];
	const ranks = [NO_RANK];
	const append = (node: RegexNode, state: number, nesting: number): number => {
		if (--budget < 0 || nesting > MAX_NESTING) return DEAD;
		switch (node.type) {
			case "unit": {
				const { code } = node;
				if (code === undefined || node.set !== undefined || node.ignoreCase) return DEAD;
				if (unicode) {
					const trail = code >= TRAIL_SURROGATE && code < SURROGATE_END;
					if (isLead(parents[state]! & 0xffff) !== trail) return DEAD;
				}
				const key = (state << 16) | code;
				const known = byEdge.get(key);
				if (known !== undefined) return known;
				const child = parents.length;
				if (child === MAX_STATES) return DEAD;
				byEdge.set(key, child);
				parents.push(key);
				ranks.push(NO_RANK);
				return child;
			}
			case "seq":
				for (const item of node.items) {
					state = append(item, state, nesting + 1);
					if (state === DEAD) return DEAD;
				}
				return state;
			case "group":
				return node.capture === undefined ? append(node.body, state, nesting + 1) : DEAD;
			default:
				return DEAD;
		}
	};
	for (let index = 0; index < options.length; index++) {
		const state = append(options[index]!, 0, 0);
		if (state === DEAD || (unicode && (state === 0 || isLead(parents[state]! & 0xffff)))) return undefined;
		if (ranks[state] === NO_RANK) ranks[state] = index;
	}
	return new LiteralAlternatives(parents, ranks, flags.sticky, Math.max(1, pattern.groups.length));
}

export type { LiteralAlternatives };

/**
 * Sparse Aho–Corasick trie. A successful edge increases depth by one and a
 * failure decreases it, so a scan makes amortized O(1) edge probes per unit
 * (each non-root probe binary-searches the state's children).
 */
class LiteralAlternatives {
	readonly #groupCount: number;
	readonly #offsets: Uint16Array;
	readonly #edges: Uint32Array;
	readonly #root: Uint16Array;
	readonly #rootBase: number;
	readonly #prefix: string;
	readonly #gate: RegExp | undefined;
	/** Direct transitions for non-root states with compact, high-fanout alphabets. */
	readonly #denseOffsets: Uint32Array | undefined;
	readonly #denseEdges: Uint16Array | undefined;
	/** Missing for sticky matching: a dead prefix must not restart at a suffix. */
	readonly #failure: Uint16Array | undefined;
	/** Longest nonempty literal ending at this state (or at a suffix reachable by failure links). */
	readonly #output: Uint16Array;
	readonly #depth: Uint16Array;
	readonly #rank: Uint32Array;
	/** Earliest source alternative anywhere in this state's trie subtree. */
	readonly #bestRank: Uint32Array;

	constructor(parents: number[], ranks: number[], sticky: boolean, groupCount: number) {
		this.#groupCount = groupCount;
		const size = parents.length;
		const offsets = (this.#offsets = new Uint16Array(size + 1));
		const edges = (this.#edges = new Uint32Array(size - 1));
		this.#failure = sticky ? undefined : new Uint16Array(size);
		const output = (this.#output = new Uint16Array(size));
		const depth = (this.#depth = new Uint16Array(size));
		this.#rank = Uint32Array.from(ranks);
		const bestRank = (this.#bestRank = this.#rank.slice());
		for (let child = 1; child < size; child++) {
			const parent = parents[child]! >>> 16;
			offsets[parent]!++;
			depth[child] = depth[parent]! + 1;
			if (ranks[child] !== NO_RANK) output[child] = child;
		}
		// Accumulate end offsets, then fill edges backward to leave the start offsets behind.
		let end = 0;
		for (let state = 0; state < size; state++) {
			end += offsets[state]!;
			offsets[state] = end;
		}
		offsets[size] = end;
		for (let child = size - 1; child > 0; child--) {
			const key = parents[child]!;
			const parent = key >>> 16;
			edges[--offsets[parent]!] = (key << 16) | child;
			if (bestRank[child]! < bestRank[parent]!) bestRank[parent] = bestRank[child]!;
		}
		for (let state = 0; state < size; state++) {
			const start = offsets[state]!;
			const stop = offsets[state + 1]!;
			if (stop - start > 1) edges.subarray(start, stop).sort();
		}
		const rootEnd = offsets[1]!;
		this.#rootBase = rootEnd === 0 ? 0 : edges[0]! >>> 16;
		this.#root = new Uint16Array(rootEnd === 0 ? 0 : (edges[rootEnd - 1]! >>> 16) - this.#rootBase + 1);
		for (let edge = 0; edge < rootEnd; edge++) {
			const packed = edges[edge]!;
			this.#root[(packed >>> 16) - this.#rootBase] = packed & 0xffff;
		}
		// A literal common to every branch lets one-shot scans jump while the trie is idle.
		let prefix = "";
		let state = 0;
		if (!sticky) {
			while (prefix.length < 16 && ranks[state] === NO_RANK && offsets[state + 1]! - offsets[state]! === 1) {
				const edge = edges[offsets[state]!]!;
				prefix += String.fromCharCode(edge >>> 16);
				state = edge & 0xffff;
			}
		}
		this.#prefix = prefix;
		const lo = offsets[state]!;
		const hi = offsets[state + 1]!;
		if (!sticky && ranks[state] === NO_RANK && hi - lo >= 8) {
			const first = edges[lo]! >>> 16;
			const last = edges[hi - 1]! >>> 16;
			if (first >= 128 && last - first < 2 * (hi - lo)) {
				let source = "";
				for (let i = 0; i < prefix.length; i++) source += escapeUnit(prefix.charCodeAt(i));
				// A fixed literal and one range run in JSC's native prefilter. Range holes
				// can produce candidates but cannot change the trie’s final answer.
				this.#gate = new RegExp(`${source}[${escapeUnit(first)}-${escapeUnit(last)}]`, "g");
			}
		}
		let denseSize = 0;
		let denseOffsets: Uint32Array | undefined;
		for (let state = 1; state < size; state++) {
			const lo = offsets[state]!;
			const hi = offsets[state + 1]!;
			const count = hi - lo;
			if (count < 8) continue;
			const span = (edges[hi - 1]! >>> 16) - (edges[lo]! >>> 16) + 1;
			if (span > 2 * count) continue;
			(denseOffsets ??= new Uint32Array(size))[state] = denseSize + 1;
			denseSize += span;
		}
		if (denseOffsets) {
			const denseEdges = new Uint16Array(denseSize);
			for (let state = 1; state < size; state++) {
				const offset = denseOffsets[state]!;
				if (!offset) continue;
				const lo = offsets[state]!;
				const hi = offsets[state + 1]!;
				const base = offset - 1 - (edges[lo]! >>> 16);
				for (let i = lo; i < hi; i++) {
					const packed = edges[i]!;
					denseEdges[base + (packed >>> 16)] = packed & 0xffff;
				}
			}
			this.#denseOffsets = denseOffsets;
			this.#denseEdges = denseEdges;
		}
		if (this.#failure) this.#buildFailures(this.#failure);
	}

	/** Whether a match exists from the caller-normalized UTF-16 index `from`. */
	test(text: string, from: number): boolean {
		return from <= text.length && (this.#rank[0] !== NO_RANK || this.#scan(text, from, 0, true) === FOUND);
	}

	/**
	 * Returns the native leftmost, source-ordered match from `from`. At each end only
	 * the longest output matters: all shorter outputs start later. Once a match is
	 * known, the longest live prefix is the earliest start that can still improve it;
	 * at the same start, only a better-ranked trie descendant could do so. Therefore
	 * lookahead never passes the best start plus the longest literal, and characters
	 * aren't re-probed at successive candidate starts within the search.
	 */
	match(text: string, from: number): BacktrackMatch | undefined {
		if (from > text.length) return undefined;
		let best = this.#rank[0] === NO_RANK ? DEAD : 0;
		let start = from;
		if (best === 0 && this.#rank[0] === this.#bestRank[0]) return this.#result(from, from);
		let state = 0;
		for (let index = from; index < text.length; index++) {
			if (state === 0 && best === DEAD) {
				index = this.#nextStart(text, index);
				if (index < 0) break;
			}
			state = this.#step(state, text.charCodeAt(index));
			if (state === DEAD) break;
			const end = index + 1;
			const output = this.#output[state]!;
			if (output !== 0) {
				const outputStart = end - this.#depth[output]!;
				if (
					best === DEAD ||
					outputStart < start ||
					(outputStart === start && this.#rank[output]! < this.#rank[best]!)
				) {
					best = output;
					start = outputStart;
				}
			}
			if (best !== DEAD) {
				const liveStart = end - this.#depth[state]!;
				if (liveStart > start || (liveStart === start && this.#bestRank[state]! >= this.#rank[best]!)) break;
			}
		}
		return best === DEAD ? undefined : this.#result(start, start + this.#depth[best]!);
	}

	/** Exact existence over the concatenation of chunks, without retaining their text. */
	stream(): RegexStream {
		let state = this.#rank[0] === NO_RANK ? 0 : FOUND;
		return {
			push: chunk => {
				if (state >= 0) state = this.#scan(chunk, 0, state);
			},
			get matched() {
				return state === FOUND;
			},
		};
	}

	#result(start: number, end: number): BacktrackMatch {
		const registers = new Int32Array(this.#groupCount * 2);
		for (let index = 0; index < registers.length; index += 2) {
			registers[index] = start;
			registers[index + 1] = end;
		}
		return { start, end, registers };
	}

	/** A streaming scan cannot jump past a prefix that straddles two chunks. */
	#nextStart(text: string, from: number): number {
		const gate = this.#gate;
		if (gate) {
			gate.lastIndex = from;
			return gate.test(text) ? gate.lastIndex - this.#prefix.length - 1 : DEAD;
		}
		const prefix = this.#prefix;
		return !prefix || text.startsWith(prefix, from) ? from : text.indexOf(prefix, from + 1);
	}

	#scan(text: string, from: number, state: number, complete = false): number {
		for (let index = from; index < text.length; index++) {
			if (state === 0 && complete) {
				index = this.#nextStart(text, index);
				if (index < 0) return 0;
			}
			state = this.#step(state, text.charCodeAt(index));
			if (state === DEAD) return DEAD;
			if (this.#output[state] !== 0) return FOUND;
		}
		return state;
	}

	#step(state: number, code: number): number {
		let next = this.#edge(state, code);
		if (next !== 0) return next;
		const failure = this.#failure;
		if (!failure) return DEAD;
		while (state !== 0) {
			state = failure[state]!;
			next = this.#edge(state, code);
			if (next !== 0) return next;
		}
		return 0;
	}

	#edge(state: number, code: number): number {
		if (state === 0) {
			const index = (code - this.#rootBase) >>> 0;
			return index < this.#root.length ? this.#root[index]! : 0;
		}
		let lo = this.#offsets[state]!;
		let hi = this.#offsets[state + 1]!;
		if (hi - lo === 1) {
			const packed = this.#edges[lo]!;
			return packed >>> 16 === code ? packed & 0xffff : 0;
		}
		const dense = this.#denseOffsets?.[state];
		if (dense) {
			const first = this.#edges[lo]! >>> 16;
			const last = this.#edges[hi - 1]! >>> 16;
			return code >= first && code <= last ? this.#denseEdges![dense - 1 + code - first]! : 0;
		}
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			const packed = this.#edges[mid]!;
			const label = packed >>> 16;
			if (label === code) return packed & 0xffff;
			if (label < code) lo = mid + 1;
			else hi = mid;
		}
		return 0;
	}

	#buildFailures(failures: Uint16Array): void {
		const queue = new Uint16Array(this.#edges.length);
		let tail = 0;
		for (let edge = 0; edge < this.#offsets[1]!; edge++) queue[tail++] = this.#edges[edge]! & 0xffff;
		for (let head = 0; head < tail; head++) {
			const state = queue[head]!;
			const fallback = failures[state]!;
			for (let edge = this.#offsets[state]!; edge < this.#offsets[state + 1]!; edge++) {
				const packed = this.#edges[edge]!;
				const child = packed & 0xffff;
				const failure = this.#step(fallback, packed >>> 16);
				failures[child] = failure;
				if (this.#output[child] === 0) this.#output[child] = this.#output[failure]!;
				queue[tail++] = child;
			}
		}
	}
}
