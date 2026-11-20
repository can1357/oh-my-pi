import { type CharClasses, LINE_CLASS, WORD_CLASS } from "./nfa";
import type { ParsedPattern, RegexNode } from "./parse";

const MAX_WIDTH = 128;
const MAX_PATHS = 32;
const MAX_STEPS = 256;

/** Proves bounded native retries per position and per maximal run of a unit class. */
export function canUseNativeExec(pattern: ParsedPattern, classes: CharClasses): boolean {
	// This proof counts code units. Lowered Unicode atoms and positions have extra constraints.
	if (pattern.unicode) return false;
	let { root } = pattern;
	let depth = 0;
	while (root.type === "group") {
		if (++depth > MAX_STEPS) return false;
		root = root.body;
	}
	const items = root.type === "seq" ? root.items : [root];
	if (items.length > MAX_STEPS) return false;

	for (let index = 0; index < items.length; index++) {
		const first = items[index]!;
		const run = unitRun(first);
		if (!run) continue;

		const left = members(run.body, classes);
		const fence = items[index + 1];
		const tail = items[index + 2];
		const right = tail && unitRun(tail);
		if (fence?.type === "unit" && (right || tail?.type === "backref")) {
			if (!bounded(items, index, 3)) return false;
			const separator = members(fence, classes);
			// With a disjoint fence only the maximal left run can reach it. If
			// the fence overlaps either run, retries can scan the same long span
			// again (e.g. [0-9]*0[0-9]+! or x[0-9]*@[a-z@]+!).
			if (overlap(left, separator)) return false;
			if (tail?.type === "backref") {
				// With a leading word boundary, only the start of each word can
				// enter the run, and the comparison costs at most the capture length.
				const boundary = items[0]!;
				if (index !== 1 || boundary.type !== "assert" || boundary.kind !== "word") return false;
				if (first.type !== "group" || first.capture === undefined || run.min === 0) return false;
				const target = tail.target;
				const names = typeof target === "string" ? pattern.names.get(target) : undefined;
				const capture = typeof target === "number" ? target : names?.length === 1 ? names[0] : undefined;
				return capture === first.capture && wordOnly(left, classes);
			}
			// A right run can only be entered at the preceding fence, which is
			// reachable from a bounded number of starts by the left-run proof.
			return (
				right !== undefined &&
				!overlap(members(right.body, classes), separator) &&
				separates(items, index, left, classes)
			);
		}

		if (!bounded(items, index, 1)) return false;
		// Without a suffix, starts that fail the minimum do bounded work; a
		// scan past the minimum returns a match on its first try.
		if (index + 1 === items.length && run.min <= MAX_WIDTH) return true;
		// A bounded suffix may overlap the run: there is only bounded work per
		// possible endpoint. It is re-entry at every start (e.g. a[a-z]+!) that
		// would rescan a long span quadratically.
		return separates(items, index, left, classes);
	}
	return bounded(items);
}

function members(unit: RegexNode, classes: CharClasses): Uint8Array {
	return classes.sets[classes.setOf(unit)]!;
}

function unitRun(node: RegexNode): Extract<RegexNode, { type: "repeat" }> | undefined {
	const run = node.type === "group" ? node.body : node;
	return run.type === "repeat" && run.max === Infinity && run.body.type === "unit" ? run : undefined;
}

function overlap(a: Uint8Array, b: Uint8Array): boolean {
	return a.some((value, id) => value !== 0 && b[id] !== 0);
}

function wordOnly(run: Uint8Array, classes: CharClasses): boolean {
	return run.every((member, id) => !member || (classes.classFlags[id]! & WORD_CLASS) !== 0);
}

interface Bounds {
	width: number;
	paths: number;
	steps: number;
}

const UNIT: Bounds = { width: 1, paths: 1, steps: 1 };
const ASSERT: Bounds = { width: 0, paths: 1, steps: 1 };

function withinBounds(width: number, paths: number, steps: number): Bounds | undefined {
	return width <= MAX_WIDTH && paths <= MAX_PATHS && steps <= MAX_STEPS ? { width, paths, steps } : undefined;
}

/**
 * Bound consumed width, complete backtracking paths, and expanded syntax along
 * those paths. A failed partial path is also a prefix of one of those paths.
 * Counting width alone would admit e.g. (?:a|aa){24}!, and counting source nodes
 * alone would admit deeply expanded fixed repeats. Lookarounds consume nothing
 * but still contribute their work (and have bounded bodies).
 */
function bounded(items: readonly RegexNode[], skipStart = items.length, skipCount = 0): boolean {
	let visited = 0;
	function measure(node: RegexNode): Bounds | undefined {
		if (++visited > MAX_STEPS) return undefined;
		switch (node.type) {
			case "unit":
				return UNIT;
			case "assert":
				return ASSERT;
			case "seq":
				return combine(node.items, false);
			case "alt":
				return combine(node.options, true);
			case "look":
			case "group": {
				const body = measure(node.body);
				if (!body) return undefined;
				return withinBounds(node.type === "look" ? 0 : body.width, body.paths, 1 + body.steps);
			}
			case "repeat": {
				const { min, max } = node;
				if (max > MAX_STEPS) return undefined;
				const body = measure(node.body);
				if (!body) return undefined;
				return withinBounds(max * body.width, (max - min + 1) * body.paths ** max, 1 + max * (1 + body.steps));
			}
			case "backref":
				return undefined;
		}
	}

	function combine(
		nodes: readonly RegexNode[],
		alternate: boolean,
		skipAt = nodes.length,
		skip = 0,
	): Bounds | undefined {
		let width = 0;
		let paths = alternate ? 0 : 1;
		let steps = 1;
		for (let index = 0; index < nodes.length; index++) {
			if (index === skipAt) index += skip;
			if (index === nodes.length) break;
			const part = measure(nodes[index]!);
			if (!part) return undefined;
			width = alternate ? Math.max(width, part.width) : width + part.width;
			paths = alternate ? paths + part.paths : paths * part.paths;
			steps += part.steps;
			if (width > MAX_WIDTH || paths > MAX_PATHS || steps > MAX_STEPS) return undefined;
		}
		return { width, paths, steps };
	}

	return combine(items, false, skipStart, skipCount) !== undefined;
}

/**
 * A successful bounded prefix must encounter a nonmember of the run, or an
 * input boundary, within bounded distance of its endpoint. Only starts near
 * the edges of a maximal run can then enter it. For example, the space in
 * (?<=\bBearer ) separates the run just as a consumed space would, but
 * (?<=a)a+! has no such separation. Use the effective, JSC-folded classes.
 */
function separates(nodes: readonly RegexNode[], end: number, run: Uint8Array, classes: CharClasses): boolean {
	const hasEdge = (node: RegexNode): boolean => {
		switch (node.type) {
			case "unit":
				return !overlap(run, members(node, classes));
			case "seq":
				return node.items.some(hasEdge);
			case "alt":
				return node.options.every(hasEdge);
			case "group":
				return hasEdge(node.body);
			case "repeat":
				return node.min > 0 && hasEdge(node.body);
			case "look": {
				if (!node.negate) return hasEdge(node.body);
				if (node.body.type !== "unit") return false;
				const excluded = members(node.body, classes);
				return run.every((member, id) => !member || excluded[id] !== 0);
			}
			case "assert":
				if (node.kind === "word") return wordOnly(run, classes);
				if (node.kind !== "start" && node.kind !== "end") return false;
				// A multiline anchor adjacent to a line terminator is an edge
				// only if the run excludes line terminators.
				return (
					node.multiline === false || run.every((member, id) => !member || !(classes.classFlags[id]! & LINE_CLASS))
				);
			case "backref":
				return false;
		}
	};

	for (let index = 0; index < end; index++) if (hasEdge(nodes[index]!)) return true;
	return false;
}
