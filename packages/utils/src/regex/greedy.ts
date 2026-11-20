import type { CharClasses } from "./nfa";
import type { RegexNode } from "./parse";

/** Bound speculative work before handing a candidate back to the memoized VM. */
const MAX_UNITS = 128;
const MAX_RETRIES = 8;
const MAX_STEPS = 64;
const START_WINDOW = 64;
const DONE = -1;
const UNSUPPORTED = -2;

/** Replay did not resolve a match within its speculative budget. */
export const REPLAY_LIMIT = -2;

interface Run {
	type: "run";
	members: Uint8Array;
	min: number;
	max: number;
	next: number;
	retry: boolean;
	/** First unit of an overlapping literal suffix, or -1 without one. */
	retryUnit: number;
}

type Step =
	| Run
	| { type: "literal"; text: string; next: number }
	| { type: "save"; register: number; next: number }
	| { type: "choice"; next: number; other: number };

interface Needle {
	text: string;
	/** Single run before a required delimiter; absent for a literal prefix. */
	leading?: Run;
	/** Replay can skip the known prefix when it contains no capture writes. */
	resume: number | undefined;
}

/**
 * Resolves short matches made of character runs and ordered alternatives.
 * One choice point can represent every shorter length of a greedy run. Choice
 * points restore captures before retrying; a budget exit defers to the full VM.
 */
export class GreedyRuns {
	readonly #classes: CharClasses;
	readonly #steps: readonly Step[];
	readonly #entry: number;
	readonly #needle: Needle | undefined;
	readonly #starts: Uint8Array | undefined;
	/** Continuation, position, minimum position, and undo length. */
	readonly #choices: Int32Array;
	/** Saved register and its old value. */
	readonly #undo: Int32Array | undefined;

	private constructor(
		classes: CharClasses,
		steps: Step[],
		entry: number,
		{ branched, captures }: { branched: boolean; captures: boolean },
	) {
		this.#classes = classes;
		this.#steps = steps;
		this.#entry = entry;
		this.#needle = startNeedle(steps, entry, classes);
		this.#starts = branched && !this.#needle ? startClasses(steps, entry, classes) : undefined;
		this.#choices = new Int32Array(steps.length * 4);
		this.#undo = branched && captures ? new Int32Array(steps.length * 2) : undefined;
	}

	/** Builds bounded replay for greedy unit repetitions and non-repeated groups. */
	static compile(root: RegexNode, classes: CharClasses): GreedyRuns | undefined {
		const steps: Step[] = [];
		let branched = false;
		let captures = false;
		const add = (step: Step): number => (steps.length < MAX_STEPS ? steps.push(step) - 1 : UNSUPPORTED);
		const run = (node: RegexNode, min: number, max: number, next: number): number => {
			if (min > MAX_UNITS) return UNSUPPORTED;
			const members = classes.sets[classes.setOf(node)]!;
			const alphabet = classes.alphabet;
			if (min === 1 && max === 1) {
				const unit = alphabet.singleUnit(members);
				if (unit !== undefined) {
					const tail = steps[next];
					const char = String.fromCharCode(unit);
					return tail?.type === "literal"
						? add({ type: "literal", text: char + tail.text, next: tail.next })
						: add({ type: "literal", text: char, next });
				}
			}
			const suffix = steps[afterSaves(steps, next)];
			// Giving back a unit cannot help if the next required step rejects it.
			const unit = suffix?.type === "literal" ? suffix.text.charCodeAt(0) : -1;
			const retry =
				min !== max &&
				suffix !== undefined &&
				(unit >= 0
					? members[alphabet.classOf(unit)] !== 0
					: suffix.type !== "run" ||
						suffix.min === 0 ||
						members.some((member, id) => member !== 0 && suffix.members[id] !== 0));
			return add({ type: "run", members, min, max, next, retry, retryUnit: retry ? unit : -1 });
		};
		const visit = (node: RegexNode, next: number): number => {
			if (next === UNSUPPORTED) return UNSUPPORTED;
			switch (node.type) {
				case "unit":
					return run(node, 1, 1, next);
				case "repeat":
					return node.greedy && node.body.type === "unit" ? run(node.body, node.min, node.max, next) : UNSUPPORTED;
				case "seq": {
					let at = next;
					for (let i = node.items.length - 1; i >= 0 && at !== UNSUPPORTED; i--) at = visit(node.items[i]!, at);
					return at;
				}
				case "alt": {
					branched = true;
					let other = visit(node.options[node.options.length - 1]!, next);
					for (let i = node.options.length - 2; i >= 0 && other !== UNSUPPORTED; i--) {
						const preferred = visit(node.options[i]!, next);
						other = preferred === UNSUPPORTED ? UNSUPPORTED : add({ type: "choice", next: preferred, other });
					}
					return other;
				}
				case "group": {
					if (node.capture === undefined) return visit(node.body, next);
					captures = true;
					const register = 2 * node.capture;
					const body = visit(node.body, add({ type: "save", register: register + 1, next }));
					return body === UNSUPPORTED ? UNSUPPORTED : add({ type: "save", register, next: body });
				}
				default:
					return UNSUPPORTED;
			}
		};
		const entry = visit(root, DONE);
		return entry >= 0 ? new GreedyRuns(classes, steps, entry, { branched, captures }) : undefined;
	}

	/** Returns the replay end, -1 for no match, or REPLAY_LIMIT. On a match or limit, writes the start. */
	probe(text: string, from: number, registers: Int32Array, startOut: Int32Array): number {
		const needle = this.#needle;
		// Try a few false leads before handing the rest of the search to the VM.
		for (let attempts = 0; attempts < 3; attempts++) {
			let start: number;
			let at: number;
			let pc = this.#entry;
			if (needle) {
				const found = text.indexOf(needle.text, from);
				if (found < 0) return -1;
				start = needle.leading ? this.#leadingStart(text, from, found, needle.leading) : found;
				if (start < 0) break;
				at = start;
				if (needle.resume !== undefined) {
					// The prefix matched and any leading run cannot cross the
					// delimiter. Neither has choices for replay to retry.
					at = found + needle.text.length;
					pc = needle.resume;
				}
			} else {
				const starts = this.#starts;
				if (!starts) break;
				const limit = Math.min(text.length, from + START_WINDOW);
				const { blockIndex, blocks } = this.#classes.alphabet;
				start = from;
				while (start < limit) {
					const unit = text.charCodeAt(start);
					if (starts[blocks[(blockIndex[unit >>> 8]! << 8) | (unit & 255)]!]) break;
					start++;
				}
				if (start >= limit) {
					if (limit === text.length) return -1;
					break;
				}
				at = start;
			}
			const end = this.#replay(text, start, registers, at, pc);
			if (end !== -1) {
				startOut[0] = start;
				return end;
			}
			from = start + 1;
		}
		startOut[0] = from;
		return REPLAY_LIMIT;
	}

	#leadingStart(text: string, from: number, found: number, { min, max, members }: Run): number {
		const { blockIndex, blocks } = this.#classes.alphabet;
		const earliest = Math.max(from, found - max);
		const stop = Math.max(earliest, found - MAX_UNITS);
		let start = found;
		while (start > stop) {
			const unit = text.charCodeAt(start - 1);
			if (!members[blocks[(blockIndex[unit >>> 8]! << 8) | (unit & 255)]!]) break;
			start--;
		}
		return (start === stop && stop > earliest) || found - start < min ? -1 : start;
	}

	/** Fills captures on success; -1 means no match, {@link REPLAY_LIMIT} means undecided. */
	match(text: string, start: number, registers: Int32Array): number {
		return this.#replay(text, start, registers, start, this.#entry);
	}

	#replay(text: string, start: number, registers: Int32Array, at: number, pc: number): number {
		const stop = Math.min(text.length, start + MAX_UNITS);
		if (at > stop && stop < text.length) return REPLAY_LIMIT;
		const { blockIndex, blocks } = this.#classes.alphabet;
		const latin1 = blockIndex[0]! << 8;
		const steps = this.#steps;
		const choices = this.#choices;
		const undo = this.#undo;
		let depth = 0;
		let saved = 0;
		if (undo) registers.fill(-1);
		let retries = MAX_RETRIES;
		while (pc !== DONE) {
			const step = steps[pc]!;
			if (step.type === "save") {
				if (undo && depth !== 0) {
					undo[saved++] = step.register;
					undo[saved++] = registers[step.register]!;
				}
				registers[step.register] = at;
				pc = step.next;
				continue;
			}
			if (step.type === "choice") {
				choices[depth++] = step.other;
				choices[depth++] = at;
				choices[depth++] = at;
				choices[depth++] = saved;
				pc = step.next;
				continue;
			}
			if (step.type === "literal") {
				const end = at + step.text.length;
				if (end > stop && stop < text.length) return REPLAY_LIMIT;
				if (text.startsWith(step.text, at)) {
					at = end;
					pc = step.next;
					continue;
				}
			} else {
				const { members, min, max, next, retry, retryUnit } = step;
				const from = at;
				const limit = Math.min(stop, at + max);
				while (at < limit) {
					const unit = text.charCodeAt(at);
					const block = unit < 256 ? latin1 : blockIndex[unit >>> 8]! << 8;
					if (!members[blocks[block | (unit & 255)]!]) break;
					at++;
				}
				if (at === stop && stop < text.length && at - from < max) return REPLAY_LIMIT;
				const minimum = from + min;
				// Shorter lengths that cannot enter the suffix are not real choices.
				if (retryUnit >= 0) {
					while (at >= minimum && text.charCodeAt(at) !== retryUnit) at--;
				}
				if (at >= minimum) {
					if (retry && at > minimum) {
						choices[depth++] = next;
						choices[depth++] = at - 1;
						choices[depth++] = minimum;
						choices[depth++] = saved;
					}
					pc = next;
					continue;
				}
			}
			if (depth === 0) return -1;
			if (retries-- === 0) return REPLAY_LIMIT;
			const mark = choices[depth - 1]!;
			while (saved > mark) {
				const old = undo![--saved]!;
				registers[undo![--saved]!] = old;
			}
			const minimum = choices[depth - 2]!;
			at = choices[depth - 3]!;
			pc = choices[depth - 4]!;
			if (at > minimum) choices[depth - 3] = at - 1;
			else depth -= 4;
		}
		return at;
	}
}

function afterSaves(steps: readonly Step[], pc: number): number {
	let step = steps[pc];
	while (step?.type === "save") {
		pc = step.next;
		step = steps[pc];
	}
	return pc;
}

/** Proves a leading singleton sequence, or a required delimiter one run cannot cross. */
function startNeedle(steps: readonly Step[], entry: number, classes: CharClasses): Needle | undefined {
	const alphabet = classes.alphabet;
	let text = "";
	let pc = afterSaves(steps, entry);
	for (let step = steps[pc]; step?.type === "literal"; step = steps[pc]) {
		text += step.text;
		pc = afterSaves(steps, step.next);
	}
	if (text !== "") {
		const first = steps[entry];
		return { text, resume: first?.type === "literal" && first.text === text ? first.next : undefined };
	}
	const leading = steps[pc];
	if (leading?.type !== "run") return undefined;
	const delimiterPc = afterSaves(steps, leading.next);
	const delimiter = steps[delimiterPc];
	if (delimiter?.type !== "literal" || leading.members[alphabet.classOf(delimiter.text.charCodeAt(0))])
		return undefined;
	const resume = pc === entry && delimiterPc === leading.next ? delimiter.next : undefined;
	return { text: delimiter.text, leading, resume };
}

/** Union of eligible first classes. Nullable programs cannot skip any start. */
function startClasses(steps: readonly Step[], entry: number, { alphabet }: CharClasses): Uint8Array | undefined {
	const width = alphabet.size;
	const starts = new Uint8Array(width);
	const stack = [entry];
	const seen = new Uint8Array(steps.length);
	while (stack.length) {
		const pc = stack.pop()!;
		if (pc === DONE) return undefined;
		if (seen[pc]) continue;
		seen[pc] = 1;
		const step = steps[pc]!;
		if (step.type === "run") {
			if (step.max > 0) for (let id = 0; id < width; id++) starts[id]! |= step.members[id]!;
			if (step.min === 0) stack.push(step.next);
		} else if (step.type === "literal") {
			starts[alphabet.classOf(step.text.charCodeAt(0))] = 1;
		} else {
			stack.push(step.next);
			if (step.type === "choice") stack.push(step.other);
		}
	}
	return starts;
}
