import type { BacktrackMatch } from "./backtrack";
import { MAX_NODES } from "./nfa";
import type { ParsedPattern, RegexNode } from "./parse";
import type { RegexStream } from "./stream";

const NO_CAPTURES = new Int32Array(2).fill(-1);
const UNIT_COUNT = 0x10000;
const COMPLETE = -1;

type Anchor = "absolute" | "line";

function isLine(unit: number): boolean {
	return unit === 10 || unit === 13 || unit === 0x2028 || unit === 0x2029;
}

/** One exact literal, or a trie where every accepting path has the same width. */
class Block {
	constructor(
		readonly width: number,
		readonly first: string | undefined,
		private readonly matcher: string | ReadonlyMap<number, number>,
	) {}

	step(state: number, unit: number): number {
		const { matcher } = this;
		if (typeof matcher !== "string") return matcher.get(state * UNIT_COUNT + unit) ?? 0;
		if (matcher.charCodeAt(state) !== unit) return 0;
		return state + 1 === this.width ? COMPLETE : state + 1;
	}

	matchesAt(text: string, at: number): boolean {
		const { matcher } = this;
		if (typeof matcher === "string") return text.startsWith(matcher, at);
		let state = 0;
		for (const end = at + this.width; at < end; at++) {
			state = matcher.get(state * UNIT_COUNT + text.charCodeAt(at)) ?? 0;
			if (state === 0) return false;
		}
		return true;
	}
}

interface BlockPlan {
	block: Block;
	min: number;
	max: number;
	greedy: boolean;
	start: Anchor | undefined;
	end: Anchor | undefined;
	fixed: boolean;
}

export type { WideBlock };

/** Exact matching of a counted block, with no expansion proportional to either bound. */
class WideBlock {
	constructor(
		private readonly plan: BlockPlan,
		private readonly outerCaptures: number,
		private readonly groupCount: number,
	) {}

	test(text: string, from: number): boolean {
		return this.#search(text, from, false);
	}

	match(text: string, from: number): BacktrackMatch | undefined {
		return this.#search(text, from, true);
	}

	stream(): RegexStream {
		return new WideBlockStream(this.plan);
	}

	#search(text: string, from: number, capture: true): BacktrackMatch | undefined;
	#search(text: string, from: number, capture: false): boolean;
	#search(text: string, from: number, capture: boolean): BacktrackMatch | boolean | undefined {
		const { block, min, max, greedy, start, end, fixed } = this.plan;
		const miss = capture ? undefined : false;
		if (start === "absolute" && from !== 0) return miss;
		const { width } = block;
		const remaining = text.length - from;
		const available = Math.floor(remaining / width);
		if (available < min) return miss;
		if (end === "absolute") {
			// EOF fixes the alignment. A failed tail block rules out the entire
			// earlier run, regardless of where an unanchored match could start.
			if (fixed && (remaining % width !== 0 || available > max)) return miss;
			const limit = fixed ? available : Math.min(available, capture || start ? max : min);
			let count = 0;
			let at = text.length;
			while (count < limit && block.matchesAt(text, at - width)) {
				count++;
				at -= width;
			}
			if (
				count < min ||
				(fixed && at !== from) ||
				(start === "line" && at !== 0 && !isLine(text.charCodeAt(at - 1)))
			) {
				return miss;
			}
			return capture ? this.#result(at, text.length) : true;
		}
		const lastStart = text.length - min * width;
		const wanted = end ? (fixed ? max + 1 : Infinity) : capture && greedy ? max : min;
		const needle = !fixed && min > 0 ? block.first : undefined;
		for (let at = from; at <= lastStart;) {
			if (needle !== undefined && at < lastStart) {
				at = text.indexOf(needle, at);
				if (at < 0 || at > lastStart) return miss;
			}
			if (start === "line" && at !== 0 && !isLine(text.charCodeAt(at - 1))) {
				if (fixed) return miss;
				at++;
				continue;
			}
			const limit = Math.min(wanted, Math.floor((text.length - at) / width));
			let count = 0;
			let edge = at;
			while (count < limit && block.matchesAt(text, edge)) {
				count++;
				edge += width;
			}
			if (count >= min && (!end || edge === text.length || (end === "line" && isLine(text.charCodeAt(edge))))) {
				if (count <= max) return capture ? this.#result(at, edge) : true;
				// An unanchored start can slide to the earliest block boundary within max of the end.
				if (!fixed && !start) return capture ? this.#result(edge - max * width, edge) : true;
			}
			if (fixed) return miss;
			// The first code cannot occur inside any block. No skipped start can
			// outlast the run, and a line anchor cannot succeed inside it either.
			at = edge + 1;
		}
		return miss;
	}

	#result(start: number, end: number): BacktrackMatch {
		if (this.groupCount === 0) return { start, end, registers: NO_CAPTURES };
		const registers = new Int32Array(2 * (this.groupCount + 1));
		registers[0] = registers[1] = -1;
		for (let group = 1; group <= this.outerCaptures; group++) {
			registers[2 * group] = start;
			registers[2 * group + 1] = end;
		}
		for (let group = this.outerCaptures + 1; group <= this.groupCount; group++) {
			registers[2 * group] = start === end ? -1 : end - this.plan.block.width;
			registers[2 * group + 1] = start === end ? -1 : end;
		}
		return { start, end, registers };
	}
}

/** Keeps only the partial block, its saturated run count, and the preceding boundary. */
class WideBlockStream implements RegexStream {
	readonly #cap: number;
	#state = 0;
	#count = 0;
	#startsHere = true;
	#found: boolean;
	#dead = false;

	constructor(private readonly plan: BlockPlan) {
		const { fixed, start, end, min, max } = plan;
		// Only a constrained start needs to distinguish a run longer than max.
		this.#cap = end && (fixed || start) && max !== Infinity ? max + 1 : Math.max(1, min);
		this.#found = !end && min === 0;
	}

	get matched(): boolean {
		return this.#found || (!this.#dead && this.#acceptsBoundary());
	}

	push(chunk: string): void {
		if (this.#found || this.#dead) return;
		const { block, min, max, start, end, fixed } = this.plan;
		const trackLines = start === "line" || end === "line";
		for (let index = 0; index < chunk.length; index++) {
			const unit = chunk.charCodeAt(index);
			const line = trackLines && isLine(unit);
			if (end === "line" && line && this.#acceptsBoundary()) {
				this.#found = true;
				return;
			}
			const state = this.#state;
			let next = state || this.#count || this.#startsHere ? block.step(state, unit) : 0;
			if (next === 0) {
				if (fixed) {
					this.#dead = true;
					return;
				}
				// A failed partial block has no interior starts before this unit.
				if (state !== 0 && this.#startsHere) next = block.step(0, unit);
				this.#count = 0;
			}
			this.#startsHere = !fixed && (start !== "line" || line);
			if (next === COMPLETE) {
				this.#state = 0;
				if (this.#count < this.#cap) this.#count++;
				if (fixed && this.#count > max) {
					this.#dead = true;
					return;
				}
				if (!end && this.#count >= min) {
					this.#found = true;
					return;
				}
			} else {
				this.#state = next;
			}
		}
	}

	#acceptsBoundary(): boolean {
		const { min, max } = this.plan;
		return (
			(min === 0 && this.#startsHere) ||
			(this.#state === 0 && this.#count !== 0 && this.#count >= min && this.#count <= max)
		);
	}
}

function walkLiteral(node: RegexNode, ignoreCase: boolean, unit: (code: number) => boolean): boolean {
	switch (node.type) {
		case "unit":
			return (
				node.code !== undefined && node.set === undefined && !(node.ignoreCase ?? ignoreCase) && unit(node.code)
			);
		case "seq":
			for (const item of node.items) if (!walkLiteral(item, ignoreCase, unit)) return false;
			return true;
		case "group":
			return node.capture === undefined && walkLiteral(node.body, ignoreCase, unit);
		default:
			return false;
	}
}

/**
 * Equal-width branches give the same subsequent boundary and captures.
 * Searching starts must synchronize: a branch's first unit cannot occur
 * inside any branch. Line-free bodies likewise keep `m` anchors at run edges.
 */
export function compileWideBlock(
	pattern: ParsedPattern,
	flags: { sticky: boolean; multiline: boolean; ignoreCase: boolean },
): WideBlock | undefined {
	let node = pattern.root;
	let outerCaptures = 0;
	let start: Anchor | undefined;
	let end: Anchor | undefined;
	while (node.type !== "repeat") {
		if (node.type === "group") {
			if (node.capture !== undefined) outerCaptures++;
			node = node.body;
			continue;
		}
		if (node.type !== "seq" || node.items.length < 2 || node.items.length > 3) return undefined;
		let left = 0;
		let right = node.items.length - 1;
		const first = node.items[left]!;
		const last = node.items[right]!;
		if (!start && first.type === "assert" && first.kind === "start") {
			start = (first.multiline ?? flags.multiline) ? "line" : "absolute";
			left++;
		}
		if (!end && last.type === "assert" && last.kind === "end") {
			end = (last.multiline ?? flags.multiline) ? "line" : "absolute";
			right--;
		}
		if (left !== right) return undefined;
		node = node.items[left]!;
	}
	const { min, max, greedy } = node;
	if (
		!Number.isInteger(min) ||
		min > 0x7fffffff ||
		(max !== Infinity && (!Number.isInteger(max) || max > 0x7fffffff))
	) {
		return undefined;
	}
	let body = node.body;
	while (body.type === "group") body = body.body;
	if (body.type !== "seq" && body.type !== "alt") return undefined;
	const first = body.type === "alt" ? body.options[0]! : body;
	const lines = start === "line" || end === "line";
	const fixed = flags.sticky || start === "absolute";
	// Unicode lone surrogates carry boundary assertions, so they are not exact literals here.
	let width = 0;
	if (
		!walkLiteral(first, flags.ignoreCase, code => {
			width++;
			return !(lines && isLine(code));
		}) ||
		width === 0
	) {
		return undefined;
	}
	const branches = body.type === "alt" ? body.options.length : 1;
	const available = MAX_NODES - 1 - Number(!!start) - Number(!!end) - (max === Infinity ? 1 : max - min);
	const copies = max === Infinity ? min + 1 : max;
	if (copies <= Math.floor(available / (width * branches + branches - 1))) return undefined;

	let block: Block;
	if (body.type === "seq") {
		let literal = "";
		walkLiteral(body, flags.ignoreCase, code => {
			literal += String.fromCharCode(code);
			return true;
		});
		const lead = literal[0]!;
		if (!fixed && literal.includes(lead, 1)) return undefined;
		block = new Block(width, lead, literal);
	} else {
		const edges = new Map<number, number>();
		let states = 0;
		let lead: number | undefined;
		for (let index = 0; index < body.options.length; index++) {
			let state = 0;
			let offset = 0;
			if (
				!walkLiteral(body.options[index]!, flags.ignoreCase, code => {
					if (offset === width || (lines && isLine(code))) return false;
					if (offset++ === 0) {
						if (index === 0) lead = code;
						else if (code !== lead) lead = undefined;
					}
					const key = state * UNIT_COUNT + code;
					const next = edges.get(key);
					if (next !== undefined) state = next;
					else edges.set(key, (state = offset === width ? COMPLETE : ++states));
					return true;
				}) ||
				offset !== width
			) {
				return undefined;
			}
		}
		if (!fixed) {
			for (const key of edges.keys()) {
				if (key >= UNIT_COUNT && edges.has(key % UNIT_COUNT)) return undefined;
			}
		}
		block = new Block(width, lead === undefined ? undefined : String.fromCharCode(lead), edges);
	}
	return new WideBlock(
		{ block, min, max, greedy, start, end, fixed },
		outerCaptures,
		Math.max(0, pattern.groups.length - 1),
	);
}
