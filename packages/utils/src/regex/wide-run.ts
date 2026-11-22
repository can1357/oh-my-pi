import type { BacktrackMatch } from "./backtrack";
import { type CharClasses, LINE_CLASS, MAX_NODES } from "./nfa";
import type { ParsedPattern, RegexNode } from "./parse";
import type { RegexStream } from "./stream";

const NO_CAPTURES = new Int32Array(2).fill(-1);

type Unit = Extract<RegexNode, { type: "unit" }>;
type Repeat = Extract<RegexNode, { type: "repeat" }>;
type Anchor = "absolute" | "line";

interface RunPlan {
	classes: CharClasses;
	run: UnitRun;
	min: number;
	max: number;
	greedy: boolean;
	prefix: Uint8Array | undefined;
	suffix: Uint8Array | undefined;
	start: Anchor | undefined;
	end: Anchor | undefined;
	/** Only the requested start (zero for an absolute `^`) is eligible. */
	fixed: boolean;
	/** The left edge is the only eligible repeat start in each run. */
	leftEdge: boolean;
	/** The right edge is the only eligible repeat end in each run. */
	rightEdge: boolean;
}

interface CapturePoint {
	register: number;
	fromEnd: boolean;
	offset: number;
}

function isLine(unit: number): boolean {
	return unit === 10 || unit === 13 || unit === 0x2028 || unit === 0x2029;
}

function accepts(classes: CharClasses, members: Uint8Array, unit: number): boolean {
	return unit >= 0 && members[classes.alphabet.classOf(unit)] !== 0;
}

/** A contiguous interval is one comparison per unit; other classes use the existing compact alphabet. */
class UnitRun {
	readonly empty: boolean;
	readonly needle: string | undefined;
	readonly #low: number;
	readonly #span: number;

	constructor(
		private readonly classes: CharClasses,
		private readonly members: Uint8Array,
	) {
		let low = 0x10000;
		let high = -1;
		let size = 0;
		for (let id = 0; id < members.length; id++) {
			if (!members[id]) continue;
			const ranges = classes.alphabet.runs[id]!;
			for (let i = 0; i < ranges.length; i += 2) {
				const first = ranges[i]!;
				const last = ranges[i + 1]!;
				low = Math.min(low, first);
				high = Math.max(high, last);
				size += last - first + 1;
			}
		}
		this.empty = size === 0;
		this.needle = size === 1 ? String.fromCharCode(low) : undefined;
		this.#low = low;
		this.#span = size === high - low + 1 ? high - low : -1;
	}

	skip(text: string, at: number, limit: number, direction: 1 | -1): number {
		if (this.empty) return at;
		const span = this.#span;
		if (span === 0xffff) return limit;
		if (span >= 0) {
			const low = this.#low;
			while (at !== limit && (text.charCodeAt(at) - low) >>> 0 <= span) at += direction;
		} else {
			const { blockIndex, blocks } = this.classes.alphabet;
			const latin1 = blockIndex[0]! << 8;
			const members = this.members;
			while (at !== limit) {
				const unit = text.charCodeAt(at);
				const block = unit < 256 ? latin1 : blockIndex[unit >>> 8]! << 8;
				if (!members[blocks[block | (unit & 255)]!]) break;
				at += direction;
			}
		}
		return at;
	}
}

/** Exact matching for a single repeated code-unit class, without expanding its count into instructions. */
export class WideRun {
	constructor(
		private readonly plan: RunPlan,
		private readonly groupCount: number,
		private readonly captures: readonly CapturePoint[] | undefined,
		private readonly lastIteration: readonly number[] | undefined,
	) {}

	/** Finds the native-priority match, keeping capture offsets in UTF-16 code units. */
	match(text: string, from: number): BacktrackMatch | undefined {
		return this.#search(text, from, true);
	}

	/** Checks existence from the same start without scanning for an unnecessary greedy end. */
	test(text: string, from: number): boolean {
		return this.#search(text, from, false);
	}

	/** Tracks existence over successive prefixes, with no retained input. */
	stream(): RegexStream {
		return new WideRunStream(this.plan);
	}

	#search(text: string, from: number, capture: true): BacktrackMatch | undefined;
	#search(text: string, from: number, capture: false): boolean;
	#search(text: string, from: number, capture: boolean): BacktrackMatch | boolean | undefined {
		const { classes, run, min, max, greedy, prefix, suffix, start, end, fixed, leftEdge, rightEdge } = this.plan;
		const miss = capture ? undefined : false;
		if ((start === "absolute" && from !== 0) || (run.empty && min !== 0)) return miss;
		const prefixWidth = prefix ? 1 : 0;
		const suffixWidth = suffix ? 1 : 0;
		if (end === "absolute") {
			// Only the final member region is relevant. An unanchored start with
			// no prefix can slide up to `max` units back from its right edge.
			const runEnd = text.length - suffixWidth;
			const first = from + prefixWidth;
			const available = runEnd - first;
			if (available < min || (fixed && (available > max || !this.#allowsStart(text, from)))) return miss;
			if (suffix && !accepts(classes, suffix, text.charCodeAt(runEnd))) return miss;
			const limit = fixed ? first : Math.max(first, runEnd - (capture || leftEdge ? max : min));
			const runStart = run.skip(text, runEnd - 1, limit - 1, -1) + 1;
			const wholeStart = runStart - prefixWidth;
			if (fixed ? runStart !== first : runEnd - runStart < min || !this.#allowsStart(text, wholeStart)) return miss;
			return capture ? this.#result(wholeStart, runStart, runEnd, text.length) : true;
		}
		const lastStart = text.length - min - suffixWidth;
		const needle = !leftEdge && min > 0 ? run.needle : undefined;
		for (let at = from + prefixWidth; at <= lastStart;) {
			if (needle !== undefined) {
				at = text.indexOf(needle, at);
				if (at < 0 || at > lastStart) return miss;
			}
			const eligible = this.#allowsStart(text, at - prefixWidth);
			if (!eligible && fixed) return miss;

			// Without a constrained right edge only this attempt's preferred count matters.
			// A fixed start cannot use a later part of a run to reach the right edge either.
			const limit =
				eligible && (!rightEdge || fixed)
					? Math.min(text.length, at + (rightEdge || (capture && greedy) ? max : min))
					: text.length;
			const runEnd = run.skip(text, at, limit, 1);
			const runStart = rightEdge && !leftEdge ? Math.max(at, runEnd - max) : at;
			const wholeEnd = runEnd + suffixWidth;
			if (
				eligible &&
				runEnd - runStart >= min &&
				runEnd - runStart <= max &&
				(!suffix || accepts(classes, suffix, text.charCodeAt(runEnd))) &&
				(!end || wholeEnd === text.length || isLine(text.charCodeAt(wholeEnd)))
			) {
				return capture ? this.#result(runStart - prefixWidth, runStart, runEnd, wholeEnd) : true;
			}
			if (fixed) return miss;
			// An ineligible left edge cannot sprout new eligible starts inside this run.
			// A rejected right edge invalidates all its starts (including an empty repeat there).
			at = runEnd + 1;
		}
		return miss;
	}

	#allowsStart(text: string, at: number): boolean {
		const { classes, start, prefix } = this.plan;
		return (
			(start !== "line" || at === 0 || isLine(text.charCodeAt(at - 1))) &&
			(!prefix || accepts(classes, prefix, text.charCodeAt(at)))
		);
	}

	#result(start: number, runStart: number, runEnd: number, end: number): BacktrackMatch {
		if (this.groupCount === 0) return { start, end, registers: NO_CAPTURES };
		const registers = new Int32Array(2 * (this.groupCount + 1));
		registers[0] = registers[1] = -1;
		if (this.captures) {
			for (const { register, fromEnd, offset } of this.captures) {
				registers[register] = (fromEnd ? runEnd : start) + offset;
			}
		}
		if (this.lastIteration) {
			const nonempty = runEnd !== runStart;
			for (const group of this.lastIteration) {
				registers[2 * group] = nonempty ? runEnd - 1 : -1;
				registers[2 * group + 1] = nonempty ? runEnd : -1;
			}
		}
		return { start, end, registers };
	}
}

/**
 * The open member region is represented by its saturated length and left-edge
 * eligibility. A match at EOF is only tentative when `$` still needs a boundary.
 */
class WideRunStream implements RegexStream {
	readonly #countLimit: number;
	#count = 0;
	#allowed: boolean;
	#atStart = true;
	#lastLine = false;
	#pendingEnd = false;
	#found = false;
	#dead: boolean;

	constructor(private readonly plan: RunPlan) {
		const { run, min, max, prefix, leftEdge, rightEdge } = plan;
		// A sliding left edge can always discard excess units. A fixed edge must know when it passed max.
		this.#countLimit = leftEdge && rightEdge && max !== Infinity ? max + 1 : min;
		this.#allowed = !prefix;
		this.#dead = run.empty && min !== 0;
	}

	get matched(): boolean {
		const { min, max, suffix, end } = this.plan;
		return (
			this.#found ||
			this.#pendingEnd ||
			(!suffix && this.#allowed && this.#count >= min && (!end || this.#count <= max))
		);
	}

	push(chunk: string): void {
		if (this.#found || this.#dead) return;
		const { classes, run, min, max, prefix, suffix, start, end, fixed, rightEdge } = this.plan;
		const trackLine = prefix !== undefined && start === "line";
		for (let at = 0; at < chunk.length;) {
			if (this.#pendingEnd) {
				this.#pendingEnd = false;
				if (end === "line" && isLine(chunk.charCodeAt(at))) {
					this.#found = true;
					return;
				}
				if (fixed && !this.#allowed) {
					this.#dead = true;
					return;
				}
			}
			let remaining = Infinity;
			if (this.#allowed) {
				if (!rightEdge) remaining = min - this.#count;
				else if (fixed) remaining = max + 1 - this.#count;
			} else if (fixed) {
				remaining = 1;
			}
			const runEnd = run.skip(chunk, at, Math.min(chunk.length, at + remaining), 1);
			if (runEnd !== at) {
				this.#count = Math.min(this.#countLimit, this.#count + (runEnd - at));
				if (fixed && (!this.#allowed || (rightEdge && this.#count > max))) {
					this.#allowed = false;
					this.#dead = true;
					return;
				}
				this.#atStart = false;
				if (trackLine) this.#lastLine = isLine(chunk.charCodeAt(runEnd - 1));
			}
			const enough = this.#allowed && this.#count >= min;
			if (!rightEdge && enough) {
				this.#found = true;
				return;
			}
			if (runEnd === chunk.length) return;

			const after = chunk.charCodeAt(runEnd);
			if (enough && this.#count <= max) {
				if (suffix && accepts(classes, suffix, after)) {
					if (!end) {
						this.#found = true;
						return;
					}
					// A completed suffix satisfies `$` at this prefix's EOF, but can be invalidated.
					this.#pendingEnd = true;
				} else if (!suffix && end === "line" && isLine(after)) {
					this.#found = true;
					return;
				}
			}
			this.#allowed = prefix
				? (!fixed || this.#atStart) &&
					(start !== "line" || this.#atStart || this.#lastLine) &&
					accepts(classes, prefix, after)
				: !fixed && (start !== "line" || isLine(after));
			this.#lastLine = trackLine && isLine(after);
			this.#atStart = false;
			this.#count = 0;
			at = runEnd + 1;
			if (fixed && !this.#allowed && !this.#pendingEnd) {
				this.#dead = true;
				return;
			}
		}
	}
}

/**
 * Admit only expansions that overflow the NFA: one unit repeat, optional groups,
 * outer `^`/`$` and at most one fixed-width unit on either side. A context unit
 * must be disjoint from the run, so trying it cannot move the corresponding edge
 * into the run. The same proof applies to multiline anchors next to the repeat.
 */
export function compileWideRun(
	pattern: ParsedPattern,
	classes: CharClasses,
	flags: { sticky: boolean; multiline: boolean },
): WideRun | undefined {
	if (pattern.unicode) return undefined;
	let prefix: Unit | undefined;
	let suffix: Unit | undefined;
	let repeat: Repeat | undefined;
	let unit: Unit | undefined;
	let start: Anchor | undefined;
	let end: Anchor | undefined;
	let captures: CapturePoint[] | undefined;
	let lastIteration: number[] | undefined;
	const point = (register: number): void => {
		(captures ??= []).push({ register, fromEnd: repeat !== undefined, offset: Number(!!(repeat ? suffix : prefix)) });
	};
	const visit = (node: RegexNode): boolean => {
		switch (node.type) {
			case "seq":
				return node.items.every(visit);
			case "group":
				if (node.capture !== undefined) point(2 * node.capture);
				if (!visit(node.body)) return false;
				if (node.capture !== undefined) point(2 * node.capture + 1);
				return true;
			case "unit":
				if (end) return false;
				if (repeat) {
					if (suffix) return false;
					suffix = node;
				} else {
					if (prefix) return false;
					prefix = node;
				}
				return true;
			case "repeat": {
				if (
					repeat ||
					!Number.isInteger(node.min) ||
					node.min > 0x7fffffff ||
					(node.max !== Infinity && (!Number.isInteger(node.max) || node.max > 0x7fffffff))
				) {
					return false;
				}
				let body = node.body;
				while (body.type === "group") {
					if (body.capture !== undefined) (lastIteration ??= []).push(body.capture);
					body = body.body;
				}
				if (body.type !== "unit") return false;
				repeat = node;
				unit = body;
				return true;
			}
			case "assert": {
				const anchor = (node.multiline ?? flags.multiline) ? "line" : "absolute";
				if (node.kind === "start" && !start && !prefix && !repeat) start = anchor;
				else if (node.kind === "end" && repeat && !end) end = anchor;
				else return false;
				return true;
			}
			default:
				return false;
		}
	};
	if (!visit(pattern.root) || !repeat || !unit) return undefined;
	const { min, max, greedy } = repeat;
	const count = max === Infinity ? min + 2 : max + (max - min);
	if (count + 1 + Number(!!prefix) + Number(!!suffix) + Number(!!start) + Number(!!end) <= MAX_NODES) {
		return undefined;
	}
	const members = classes.sets[classes.setOf(unit)]!;
	const left = prefix && classes.sets[classes.setOf(prefix)]!;
	const right = suffix && classes.sets[classes.setOf(suffix)]!;
	if (members.some((member, id) => member !== 0 && (left?.[id] || right?.[id]))) return undefined;
	const fixed = flags.sticky || start === "absolute";
	if (
		((!fixed && !left && start === "line") || (!right && end === "line")) &&
		members.some((member, id) => member !== 0 && (classes.classFlags[id]! & LINE_CLASS) !== 0)
	) {
		return undefined;
	}
	return new WideRun(
		{
			classes,
			run: new UnitRun(classes, members),
			min,
			max,
			greedy,
			prefix: left,
			suffix: right,
			start,
			end,
			fixed,
			leftEdge: fixed || start !== undefined || left !== undefined,
			rightEdge: end !== undefined || right !== undefined,
		},
		Math.max(0, pattern.groups.length - 1),
		captures,
		lastIteration,
	);
}
