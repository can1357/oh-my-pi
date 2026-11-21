import type { CharClasses } from "./nfa";
import type { RegexNode } from "./parse";

/** A mandatory fragment at a fixed distance, or within a bounded range of distances, from a candidate start. */
export type ScanPrefix =
	| { kind: "literal"; text: string; low: number; high: number }
	| { kind: "native"; source: string; width: number; low: number; high: number }
	| { kind: "run"; text: string; set: number; min: number; max: number; anchor: "absolute" | "line" | undefined };

interface Flags {
	ignoreCase: boolean;
	multiline: boolean;
}

const MAX_WIDTH = 16;
const MAX_BRANCHES = 16;
const MAX_OFFSET = 64;

type Unit = Extract<RegexNode, { type: "unit" }>;

/** Lower bound on UTF-16 units consumed along any branch. */
export function minimumWidth(node: RegexNode): number {
	switch (node.type) {
		case "unit":
			return 1;
		case "group":
			return minimumWidth(node.body);
		case "repeat":
			return node.min * minimumWidth(node.body);
		case "seq":
			return node.items.reduce((sum, item) => sum + minimumWidth(item), 0);
		case "alt":
			return node.options.reduce((min, option) => Math.min(min, minimumWidth(option)), Infinity);
		default:
			return 0;
	}
}

/** Upper bound for a lookbehind; backreferences and unbounded consuming runs are not bounded. */
function maximumWidth(node: RegexNode): number {
	switch (node.type) {
		case "unit":
			return 1;
		case "group":
			return maximumWidth(node.body);
		case "repeat": {
			const width = maximumWidth(node.body);
			return width === 0 || node.max === 0 ? 0 : node.max * width;
		}
		case "seq":
			return node.items.reduce((sum, item) => sum + maximumWidth(item), 0);
		case "alt":
			return node.options.reduce((max, option) => Math.max(max, maximumWidth(option)), 0);
		case "string":
		case "backref":
			return Infinity;
		default:
			return 0;
	}
}

/** The top-level sequence with group boundaries removed, without crossing an alternative or repeat. */
function flatten(node: RegexNode, into: RegexNode[]): void {
	if (node.type === "seq") for (const item of node.items) flatten(item, into);
	else if (node.type === "group") flatten(node.body, into);
	else into.push(node);
}

function singleton(unit: Unit, classes: CharClasses): string | undefined {
	const code = classes.alphabet.singleUnit(classes.sets[classes.setOf(unit)]!);
	return code === undefined ? undefined : String.fromCharCode(code);
}

interface Fragment {
	source: string;
	width: number;
	branches: number;
	literals: number;
	/** Covers the whole node, so the next token can extend this fragment. */
	whole: boolean;
}

/** Prefixes of equal width so native test's lastIndex identifies the start, even for alternatives. */
function nativeFragment(nodes: readonly RegexNode[], flags: Flags): Fragment {
	let visits = 128;
	const empty: Fragment = { source: "", width: 0, branches: 1, literals: 0, whole: true };
	const stop = { ...empty, whole: false };
	const unitSource = (unit: Unit): string => {
		if (unit.source === ".") return "[\\s\\S]";
		const ignoreCase = unit.ignoreCase ?? flags.ignoreCase;
		if (ignoreCase === flags.ignoreCase) return unit.source;
		return `(?${ignoreCase ? "i" : "-i"}:${unit.source})`;
	};
	const seq = (items: readonly RegexNode[], limit: number): Fragment => {
		let { source, width, branches, literals, whole } = empty;
		for (const item of items) {
			const next = visit(item, limit - width);
			if (branches * next.branches > MAX_BRANCHES) {
				whole = false;
				break;
			}
			source += next.source;
			width += next.width;
			branches *= next.branches;
			literals += next.literals;
			if (!next.whole) {
				whole = false;
				break;
			}
		}
		return { source, width, branches, literals, whole };
	};
	const visit = (node: RegexNode, limit: number): Fragment => {
		if (--visits < 0 || !limit) return stop;
		switch (node.type) {
			case "look":
			case "assert":
				return empty;
			case "unit":
				return {
					source: unitSource(node),
					width: 1,
					branches: 1,
					literals: Number(node.code !== undefined),
					whole: true,
				};
			case "seq":
				return seq(node.items, limit);
			case "group":
				return visit(node.body, limit);
			case "repeat": {
				if (node.body.type !== "unit" || !node.min) return stop;
				const width = Math.min(node.min, limit);
				return {
					source: unitSource(node.body).repeat(width),
					width,
					branches: 1,
					literals: node.body.code === undefined ? 0 : width,
					whole: width === node.max,
				};
			}
			case "alt": {
				if (node.options.length > MAX_BRANCHES) return stop;
				const options = node.options.map(option => visit(option, limit));
				const width = Math.min(...options.map(option => option.width));
				if (!width) return stop;
				const prefixes = options.map((option, index) =>
					option.width === width ? option : visit(node.options[index]!, width),
				);
				const branches = prefixes.reduce((sum, option) => sum + option.branches, 0);
				if (branches > MAX_BRANCHES || prefixes.some(option => option.width !== width)) return stop;
				return {
					source: `(?:${[...new Set(prefixes.map(option => option.source))].join("|")})`,
					width,
					branches,
					literals: Math.min(...prefixes.map(option => option.literals)),
					whole: options.every(option => option.width === width && option.whole),
				};
			}
			case "string":
			case "backref":
				return stop;
		}
	};
	return seq(nodes, MAX_WIDTH);
}

interface Needle {
	text: string;
	low: number;
	high: number;
}

/** The longest literal within a bounded distance, even after classes or alternatives. */
function literalNeedle(items: readonly RegexNode[], classes: CharClasses): Needle | undefined {
	let low = 0;
	let high = 0;
	let text = "";
	let best: Needle | undefined;
	for (const item of items) {
		if (item.type === "assert" || item.type === "look") continue;
		const unit =
			item.type === "unit" ? item : item.type === "repeat" && item.body.type === "unit" ? item.body : undefined;
		const char = unit && singleton(unit, classes);
		const min = minimumWidth(item);
		const max = maximumWidth(item);
		if (char !== undefined && min !== 0) {
			const left = low - text.length;
			const right = high - text.length;
			text += char.repeat(Math.min(min, MAX_WIDTH - text.length));
			if (!best || text.length > best.text.length) best = { text, low: left, high: right };
			if (text.length === MAX_WIDTH) break;
		} else if (max !== 0) {
			text = "";
		}
		if (high + max > MAX_OFFSET) break;
		if (min !== max) text = "";
		low += min;
		high += max;
	}
	return best;
}

type BoundedPrefix = Exclude<ScanPrefix, { kind: "run" }>;

function boundedPrefix(
	items: readonly RegexNode[],
	classes: CharClasses,
	flags: Flags,
	bias: number,
	spread: number,
): BoundedPrefix | undefined {
	const needle = literalNeedle(items, classes);
	if (needle && needle.text.length > 1) {
		return { kind: "literal", text: needle.text, low: bias + needle.low, high: bias + needle.high + spread };
	}
	const fragment = nativeFragment(items, flags);
	// A folded word plus a space is more selective than the space alone.
	if (fragment.width > 1 && fragment.literals >= (needle ? 3 : 1)) {
		// All choices consume exactly `width` code units and the expanded choice count is capped.
		return {
			kind: "native",
			source: fragment.source,
			width: fragment.width,
			low: bias,
			high: bias + spread,
		};
	}
	return needle && { kind: "literal", text: needle.text, low: bias + needle.low, high: bias + needle.high + spread };
}

/** Plans jumps across starts without running the original pattern or changing its match priority. */
export function scanPrefix(root: RegexNode, classes: CharClasses, flags: Flags): ScanPrefix | undefined {
	const items: RegexNode[] = [];
	flatten(root, items);
	const consumes = items.findIndex(item => item.type !== "look" && item.type !== "assert");
	if (consumes < 0) return undefined;
	let prefix = boundedPrefix(items, classes, flags, 0, 0);
	let score = prefix ? (prefix.kind === "literal" ? prefix.text.length : prefix.width) : 0;
	let line: Extract<RegexNode, { type: "assert" }> | undefined;
	for (let i = 0; i < consumes; i++) {
		const item = items[i]!;
		if (item.type === "assert" && item.kind === "start") line = item;
		if (item.type !== "look" || item.negate || !item.behind) continue;
		const min = minimumWidth(item.body);
		const max = maximumWidth(item.body);
		if (min === 0 || max > MAX_OFFSET) continue;
		const body: RegexNode[] = [];
		flatten(item.body, body);
		const candidate = boundedPrefix(body, classes, flags, -max, max - min);
		if (!candidate) continue;
		const width = candidate.kind === "literal" ? candidate.text.length : candidate.width;
		if (width > score) {
			prefix = candidate;
			score = width;
		}
	}
	const leading = items[consumes];
	if (leading?.type === "repeat" && leading.min !== leading.max && leading.body.type === "unit") {
		const tail = literalNeedle(items.slice(consumes + 1), classes);
		if (tail?.high === 0 && tail.text.length >= score) {
			const set = classes.setOf(leading.body);
			const members = classes.sets[set]!;
			// A run cannot cross the needle. Once found, all eligible starts lie
			// within the run before it, even when the earlier starts fail.
			if (!members[classes.alphabet.classOf(tail.text.charCodeAt(0))]) {
				let anchor: "absolute" | "line" | undefined;
				if (line) {
					const multiline = line.multiline ?? flags.multiline;
					if (!multiline) anchor = "absolute";
					else if (![10, 13, 0x2028, 0x2029].some(code => members[classes.alphabet.classOf(code)]))
						anchor = "line";
				}
				return { kind: "run", text: tail.text, set, min: leading.min, max: leading.max, anchor };
			}
		}
	}
	return prefix;
}

/** Rejects a search only when a mandatory consuming fragment is absent. */
export type RequiredProbe = (text: string, from: number) => boolean;

/**
 * A required fragment can rule out a long miss without scanning the automata.
 * Restrict this extra search to loops that cannot use a scanner or to wide
 * alphabets, where each DFA step pays for the larger transition table.
 */
export function compileRequiredProbe(root: RegexNode, classes: CharClasses): RequiredProbe | undefined {
	const wide = classes.alphabet.size > 128;
	if (!wide && root.type !== "seq" && root.type !== "group") return undefined;
	const items: RegexNode[] = [];
	flatten(root, items);
	if (!wide && !items.some(item => item.type === "repeat" && item.max === Infinity && item.body.type !== "unit")) {
		return undefined;
	}

	let literal = "";
	let longest = "";
	for (const item of items) {
		const unit = item.type === "unit" ? singleton(item, classes) : undefined;
		literal = unit === undefined ? "" : literal + unit;
		if (literal.length > longest.length) longest = literal;
		if (longest.length === MAX_WIDTH) break;
	}
	if (longest.length > 1) return (text, from) => text.indexOf(longest, from) >= 0;
	if (!wide) return undefined;

	// A small ASCII interval is a cheap native scan, even with thousands of
	// unrelated classes. The containing interval need not be exact.
	const { runs } = classes.alphabet;
	let bestLow = 0;
	let bestHigh = 127;
	for (const item of items) {
		if (item.type !== "unit") continue;
		const members = classes.sets[classes.setOf(item)]!;
		let low = 128;
		let high = -1;
		for (let id = 0; id < members.length; id++) {
			if (!members[id]) continue;
			const ranges = runs[id]!;
			low = Math.min(low, ranges[0]!);
			high = Math.max(high, ranges[ranges.length - 1]!);
			if (high >= 128 || high - low >= bestHigh - bestLow) break;
		}
		if (high >= low && high < 128 && high - low < bestHigh - bestLow) {
			bestLow = low;
			bestHigh = high;
		}
	}
	if (bestLow === bestHigh) {
		const char = String.fromCharCode(bestLow);
		return (text, from) => text.indexOf(char, from) >= 0;
	}
	if (bestHigh - bestLow >= 16) return undefined;
	const escape = (unit: number) => `\\x${unit.toString(16).padStart(2, "0")}`;
	const probe = new RegExp(`[${escape(bestLow)}-${escape(bestHigh)}]`, "g");
	return (text, from) => {
		probe.lastIndex = from;
		return probe.test(text);
	};
}
