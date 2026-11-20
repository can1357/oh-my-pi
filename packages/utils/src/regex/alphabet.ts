/**
 * Code-unit sets decided by JSC, and the alphabet a pattern's automaton reads.
 *
 * {@link LinearRegExp} never re-implements JavaScript character semantics: each
 * atom (a class, `.`, `\s`, a literal under `i`) is run by JSC over the
 * UTF-16 code units and, for Unicode atoms, supplementary code points. Case
 * folding, tables and Annex B quirks match the engine running the original.
 * The sets then partition the code units into the classes no matcher tells
 * apart; the automaton steps on one class per code unit.
 */

/** Set of UTF-16 code units: bit `u` is word `u >>> 5`, bit `u & 31`. */
export type UnitSet = Uint32Array;

const UNIT_COUNT = 0x10000;
const SET_WORDS = UNIT_COUNT / 32;
/** Oracle results kept across patterns; atoms such as `\s` or `[^\n]` repeat between rules. */
const ORACLE_CACHE_LIMIT = 4096;

const oracleCache = new Map<string, UnitSet>();
let allUnits: string | undefined;
let unicodeUnits: string | undefined;
let supplementaryPoints: string | undefined;
const supplementaryCache = new Map<string, readonly number[]>();
const unicodeFoldCache = new Map<number, RegExp>();
let anyUnit: UnitSet | undefined;
let lineTerminators: UnitSet | undefined;
/** First UTF-16 high surrogate. */
export const LEAD_SURROGATE = 0xd800;
/** First UTF-16 low surrogate. */
export const TRAIL_SURROGATE = 0xdc00;
/** First UTF-16 code unit after the surrogate ranges. */
export const SURROGATE_END = 0xe000;

/** UTF-16 position inside (rather than before or after) a code point. */
export function insideSurrogatePair(text: string, index: number): boolean {
	const before = text.charCodeAt(index - 1);
	const after = text.charCodeAt(index);
	return before >= LEAD_SURROGATE && before < TRAIL_SURROGATE && after >= TRAIL_SURROGATE && after < SURROGATE_END;
}

/** Thrown when an atom source does not behave as a matcher of exactly one code unit. */
export class OracleMismatchError extends Error {}

/** Every code unit, in order: the haystack the oracle runs one-unit matchers over. */
function unitString(): string {
	if (allUnits === undefined) {
		const chunks: string[] = [];
		for (let start = 0; start < UNIT_COUNT; start += 4096) {
			chunks.push(String.fromCharCode(...Array.from({ length: 4096 }, (_, offset) => start + offset)));
		}
		allUnits = chunks.join("");
	}
	return allUnits;
}

function has(set: UnitSet, unit: number): boolean {
	return (set[unit >>> 5]! & (1 << (unit & 31))) !== 0;
}

/** The first member of a code-unit set, if any. */
export function firstUnit(set: UnitSet): number | undefined {
	for (let word = 0; word < set.length; word++) {
		const bits = set[word]!;
		if (bits) return word * 32 + 31 - Math.clz32(bits & -bits);
	}
	return undefined;
}

/** The set holding every code unit except the units left in `rest`. */
function complementOf(rest: string): UnitSet {
	const set = new Uint32Array(SET_WORDS).fill(0xffffffff);
	for (let index = 0; index < rest.length; index++) {
		const unit = rest.charCodeAt(index);
		set[unit >>> 5]! &= ~(1 << (unit & 31));
	}
	return set;
}

/** All code units: the set of `[\s\S]`. */
export function anyUnitSet(): UnitSet {
	anyUnit ??= new Uint32Array(SET_WORDS).fill(0xffffffff);
	return anyUnit;
}

/** Adds the closed code-unit interval `[first, last]` to a set. */
export function addUnitRange(set: UnitSet, first: number, last: number): void {
	const start = first >>> 5;
	const end = last >>> 5;
	const leading = 0xffffffff << (first & 31);
	const trailing = 0xffffffff >>> (31 - (last & 31));
	if (start === end) set[start]! |= leading & trailing;
	else {
		set[start]! |= leading;
		set.fill(0xffffffff, start + 1, end);
		set[end]! |= trailing;
	}
}

/** A set of the code units in the closed interval `[first, last]`. */
export function unitRange(first: number, last: number): UnitSet {
	const set = new Uint32Array(SET_WORDS);
	addUnitRange(set, first, last);
	return set;
}

/** Whether a BMP set includes any lone surrogate. */
export function hasSurrogate(set: UnitSet): boolean {
	for (let word = LEAD_SURROGATE >>> 5; word < SURROGATE_END >>> 5; word++) {
		if (set[word]) return true;
	}
	return false;
}

/** Every supplementary code point, in order and exactly two code units wide. */
function supplementaryString(): string {
	if (supplementaryPoints === undefined) {
		const chunks: string[] = [];
		for (let first = 0x10000; first < 0x110000; first += 4096) {
			chunks.push(String.fromCodePoint(...Array.from({ length: 4096 }, (_, offset) => first + offset)));
		}
		supplementaryPoints = chunks.join("");
	}
	return supplementaryPoints;
}

const ALL_SUPPLEMENTARY = [0x10000, 0x10ffff];
const NO_SUPPLEMENTARY: readonly number[] = [];

/** Closed supplementary code-point ranges accepted by one Unicode atom. */
export function supplementaryRanges(source: string, flags: string): readonly number[] {
	switch (source) {
		case ".":
		case "\\D":
		case "\\S":
			return ALL_SUPPLEMENTARY;
		case "\\d":
		case "\\s":
			return NO_SUPPLEMENTARY;
		case "\\w":
			if (!flags.includes("i")) return NO_SUPPLEMENTARY;
			break;
		case "\\W":
			if (!flags.includes("i")) return ALL_SUPPLEMENTARY;
			break;
	}
	const key = `${flags}/${source}`;
	const cached = supplementaryCache.get(key);
	if (cached) return cached;
	const ranges: number[] = [];
	const matcher = new RegExp(`(?:${source})+`, `${flags}g`);
	const text = supplementaryString();
	for (let match = matcher.exec(text); match; match = matcher.exec(text)) {
		ranges.push(0x10000 + match.index / 2, 0x10000 + matcher.lastIndex / 2 - 1);
	}
	if (supplementaryCache.size >= ORACLE_CACHE_LIMIT) supplementaryCache.clear();
	supplementaryCache.set(key, ranges);
	return ranges;
}

/** The single code unit `code`, without asking JSC: no flag changes a literal outside `i`. */
export function literalSet(code: number): UnitSet {
	const set = new Uint32Array(SET_WORDS);
	set[code >>> 5] = 1 << (code & 31);
	return set;
}

/**
 * BMP code points (including lone surrogates) accepted by an atom, as JSC decides.
 *
 * @throws {OracleMismatchError} when `source` is not a matcher of exactly one code unit.
 */
export function oracleSet(source: string, flags: string): UnitSet {
	const key = `${flags}/${source}`;
	const cached = oracleCache.get(key);
	if (cached) return cached;
	// Removing whole runs keeps the replace to a few matches even for sets like `.` or `[^\n]`.
	const units = unitString();
	// Keep every surrogate isolated; in ascending order the middle two form a pair.
	const text =
		flags.includes("u") || flags.includes("v")
			? (unicodeUnits ??=
					units.slice(0, LEAD_SURROGATE) +
					units.slice(TRAIL_SURROGATE, SURROGATE_END) +
					units.slice(LEAD_SURROGATE, TRAIL_SURROGATE) +
					units.slice(SURROGATE_END))
			: units;
	const set = complementOf(text.replace(new RegExp(`(?:${source})+`, `${flags}g`), ""));
	const member = firstUnit(set);
	if (member !== undefined && !new RegExp(`^(?:${source})$`, flags).test(String.fromCharCode(member))) {
		throw new OracleMismatchError(`"${source}" does not match one code unit`);
	}
	if (oracleCache.size >= ORACLE_CACHE_LIMIT) oracleCache.clear();
	oracleCache.set(key, set);
	return set;
}

/** Whether `/a/i` matches `b`: JavaScript's case-insensitive comparison of two code units, as JSC decides. */
export function caseFoldEquals(a: number, b: number): boolean {
	return a === b || has(oracleSet(`\\u${a.toString(16).padStart(4, "0")}`, "i"), b);
}

/** JSC's Unicode case equivalence for two code points in a folded backreference. */
export function unicodeCaseFoldEquals(a: number, b: number): boolean {
	if (a === b) return true;
	if ((a | b) < 128) {
		const lower = a | 32;
		return lower >= 97 && lower <= 122 && lower === (b | 32);
	}
	let matcher = unicodeFoldCache.get(a);
	if (!matcher) {
		if (unicodeFoldCache.size >= ORACLE_CACHE_LIMIT) unicodeFoldCache.clear();
		matcher = new RegExp(`\\u{${a.toString(16)}}`, "iu");
		unicodeFoldCache.set(a, matcher);
	}
	return matcher.test(String.fromCodePoint(b));
}

/** Code units `\b` treats as word characters, with extra folds only when both `i` and `u` apply. */
export function wordUnitSet(unicodeIgnoreCase: boolean): UnitSet {
	return oracleSet("\\w", unicodeIgnoreCase ? "iu" : "");
}

/** Code units after which `^` holds under `m`: JavaScript's line terminators. */
export function lineTerminatorSet(): UnitSet {
	// `[\s\S]^` consumes exactly the units a multiline `^` may follow.
	lineTerminators ??= complementOf(unitString().replace(/[\s\S]^/gm, ""));
	return lineTerminators;
}

/**
 * The code units of a pattern, partitioned into classes no set tells apart.
 * {@link Alphabet.classOf} maps a code unit to its class in two table reads.
 */
export class Alphabet {
	/** Number of classes. */
	readonly size: number;
	/** Class table index per 256-unit block; most blocks share one uniform table. */
	readonly blockIndex: Uint16Array;
	/** Class tables, 256 entries each. */
	readonly blocks: Uint16Array;
	/** Each class's code units as flattened `[first, last]` runs, by class id. */
	readonly runs: readonly (readonly number[])[];

	/**
	 * @throws {RangeError} when the sets split the code units into more than `maxClasses` classes.
	 */
	constructor(sets: readonly UnitSet[], maxClasses: number) {
		const distinct = [...new Set(sets)];
		// Between consecutive boundaries every set is uniform, so each segment lies in one class.
		const cuts = new Uint32Array(SET_WORDS);
		cuts[0] = 1;
		const words = [0];
		for (const set of distinct) addBoundaries(set, cuts, words);
		words.sort((a, b) => a - b);
		const bounds: number[] = [];
		for (const word of words) {
			for (let bits = cuts[word]!; bits; bits &= bits - 1) {
				bounds.push((word << 5) + firstBit(bits));
			}
		}
		bounds.push(UNIT_COUNT);
		const classes = new Uint16Array(UNIT_COUNT);
		const refine = distinct.length > 32;
		if (refine) refineClasses(distinct, cuts, words, bounds.length - 1, classes, maxClasses);
		// Assign public IDs in order of the first code unit in each class.
		const ids = new Map<number, number>();
		const runs: number[][] = [];
		for (let segment = 0; segment + 1 < bounds.length; segment++) {
			const first = bounds[segment]!;
			const end = bounds[segment + 1]!;
			const signature = refine ? classes[first]! : signatureOf(distinct, first);
			let id = ids.get(signature);
			if (id === undefined) {
				if (ids.size >= maxClasses) throw new RangeError(`more than ${maxClasses} character classes`);
				id = ids.size;
				ids.set(signature, id);
				runs.push([]);
			}
			runs[id]!.push(first, end - 1);
			classes.fill(id, first, end);
		}
		this.runs = runs;
		this.size = runs.length;
		const tables: Uint16Array[] = [];
		const uniform = new Map<number, number>();
		this.blockIndex = new Uint16Array(256);
		for (let block = 0; block < 256; block++) {
			const table = classes.subarray(block * 256, block * 256 + 256);
			const first = table[0]!;
			if (table.every(id => id === first)) {
				let index = uniform.get(first);
				if (index === undefined) {
					index = tables.push(table) - 1;
					uniform.set(first, index);
				}
				this.blockIndex[block] = index;
			} else {
				this.blockIndex[block] = tables.push(table) - 1;
			}
		}
		this.blocks = new Uint16Array(tables.length * 256);
		for (const [index, table] of tables.entries()) this.blocks.set(table, index * 256);
	}

	/** Class of one code unit. */
	classOf(unit: number): number {
		return this.blocks[(this.blockIndex[unit >>> 8]! << 8) | (unit & 255)]!;
	}

	/** The sole code unit accepted by `members`, or undefined for empty or wider sets. */
	singleUnit(members: Uint8Array): number | undefined {
		const id = members.indexOf(1);
		if (id < 0 || members.indexOf(1, id + 1) !== -1) return undefined;
		const run = this.runs[id]!;
		return run.length === 2 && run[0] === run[1] ? run[0] : undefined;
	}

	/** Which classes lie inside `set`: 1 per member class, by class id. */
	membership(set: UnitSet): Uint8Array {
		return Uint8Array.from(this.runs, run => Number(has(set, run[0]!)));
	}
}

/** Adds every code unit where membership in `set` changes. */
function addBoundaries(set: UnitSet, cuts: Uint32Array, words: number[]): void {
	let previous = 0;
	for (let word = 0; word < SET_WORDS; word++) {
		const bits = set[word]!;
		if (bits === (previous ? 0xffffffff : 0)) continue;
		const old = cuts[word]!;
		if (!old) words.push(word);
		cuts[word] = old | (bits ^ ((bits << 1) | previous));
		previous = bits >>> 31;
	}
}

/** Index of the lowest set bit in a nonzero word. */
function firstBit(bits: number): number {
	return 31 - Math.clz32(bits & -bits);
}

/** A packed membership signature for at most 32 sets. */
function signatureOf(sets: readonly UnitSet[], unit: number): number {
	let signature = 0;
	const word = unit >>> 5;
	const bit = 1 << (unit & 31);
	for (const set of sets) signature = (signature << 1) | Number((set[word]! & bit) !== 0);
	return signature;
}

function popcount(bits: number): number {
	bits -= (bits >>> 1) & 0x55555555;
	bits = (bits & 0x33333333) + ((bits >>> 2) & 0x33333333);
	return Math.imul((bits + (bits >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
}

/** Refine on each set, enumerating segment starts only on its smaller side. */
function refineClasses(
	sets: readonly UnitSet[],
	cuts: Uint32Array,
	words: readonly number[],
	segmentCount: number,
	classes: Uint16Array,
	maxClasses: number,
): void {
	if (segmentCount === 1) return;
	// Counts may reach 65,536; IDs and segment starts are at most 65,535.
	const counts = new Uint32Array(segmentCount);
	const moved = new Uint32Array(segmentCount);
	const split = new Uint16Array(segmentCount);
	const selected = new Uint16Array(segmentCount >>> 1);
	counts[0] = segmentCount;
	let size = 1;

	for (const set of sets) {
		let inside = 0;
		for (const word of words) inside += popcount(set[word]! & cuts[word]!);
		if (inside === 0 || inside === segmentCount) continue;
		const invert = inside > segmentCount - inside ? -1 : 0;
		let length = 0;
		for (const word of words) {
			for (let bits = (set[word]! ^ invert) & cuts[word]!; bits; bits &= bits - 1) {
				const first = (word << 5) + firstBit(bits);
				selected[length++] = first;
				moved[classes[first]!]!++;
			}
		}
		for (let i = 0; i < length; i++) {
			const first = selected[i]!;
			const id = classes[first]!;
			const count = moved[id]!;
			if (count) {
				// If the entire class was selected, it needs no split.
				if (count === counts[id]) split[id] = id;
				else {
					if (size >= maxClasses) throw new RangeError(`more than ${maxClasses} character classes`);
					counts[id]! -= count;
					counts[size] = count;
					split[id] = size++;
				}
				moved[id] = 0;
			}
			classes[first] = split[id]!;
		}
		if (size === segmentCount) break;
	}
}
