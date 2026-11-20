/**
 * Code-unit sets decided by JSC, and the alphabet a pattern's automaton reads.
 *
 * {@link LinearRegExp} never re-implements JavaScript character semantics: each
 * one-unit matcher (a class, `.`, `\s`, a literal under `i`) is run by JSC over
 * all 65,536 UTF-16 code units, so case folding, Unicode table versions and
 * Annex B quirks are whatever the engine that runs the original `RegExp` does.
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
let anyUnit: UnitSet | undefined;
let lineTerminators: UnitSet | undefined;
const wordUnits = new Map<boolean, UnitSet>();

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

/** The single code unit `code`, without asking JSC: no flag changes a literal outside `i`. */
export function literalSet(code: number): UnitSet {
	const set = new Uint32Array(SET_WORDS);
	set[code >>> 5] = 1 << (code & 31);
	return set;
}

/**
 * Code units the one-unit matcher `source` accepts under `flags` (a subset of `is`), as JSC decides.
 *
 * @throws {OracleMismatchError} when `source` is not a matcher of exactly one code unit.
 */
export function oracleSet(source: string, flags: string): UnitSet {
	const key = `${flags}/${source}`;
	const cached = oracleCache.get(key);
	if (cached) return cached;
	// Removing whole runs keeps the replace to a few matches even for sets like `.` or `[^\n]`.
	const set = complementOf(unitString().replace(new RegExp(`(?:${source})+`, `${flags}g`), ""));
	let member = 0;
	while (member < UNIT_COUNT && !has(set, member)) member++;
	if (member < UNIT_COUNT && !new RegExp(`^(?:${source})$`, flags).test(String.fromCharCode(member))) {
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

/** Code units `\b` treats as word characters under the pattern's `i` flag. */
export function wordUnitSet(ignoreCase: boolean): UnitSet {
	let set = wordUnits.get(ignoreCase);
	if (!set) {
		set = new Uint32Array(SET_WORDS);
		const boundary = new RegExp("\\b", ignoreCase ? "i" : "");
		for (let unit = 0; unit < UNIT_COUNT; unit++) {
			// In a one-unit string `\b` holds exactly when that unit is a word character.
			if (boundary.test(String.fromCharCode(unit))) set[unit >>> 5]! |= 1 << (unit & 31);
		}
		wordUnits.set(ignoreCase, set);
	}
	return set;
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
	/** One code unit of each class. */
	readonly #representatives: number[] = [];
	readonly #singletons: boolean[] = [];
	#runs: number[][] | undefined;

	/**
	 * @throws {RangeError} when the sets split the code units into more than `maxClasses` classes.
	 */
	constructor(sets: readonly UnitSet[], maxClasses: number) {
		const distinct = [...new Set(sets)];
		// Between consecutive boundaries every set is uniform, so each segment lies in one class.
		const cuts = new Set([0, UNIT_COUNT]);
		for (const set of distinct) addBoundaries(set, cuts);
		const bounds = [...cuts].sort((a, b) => a - b);
		const classes = new Uint16Array(UNIT_COUNT);
		const ids = new Map<string, number>();
		for (let segment = 0; segment + 1 < bounds.length; segment++) {
			const first = bounds[segment]!;
			const end = bounds[segment + 1]!;
			const signature = distinct.map(set => (has(set, first) ? "1" : "0")).join("");
			let id = ids.get(signature);
			if (id === undefined) {
				if (ids.size >= maxClasses) throw new RangeError(`more than ${maxClasses} character classes`);
				id = ids.size;
				ids.set(signature, id);
				this.#representatives.push(first);
				this.#singletons.push(end === first + 1);
			} else {
				this.#singletons[id] = false;
			}
			classes.fill(id, first, end);
		}
		this.size = ids.size;
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

	/** Each class's code units as flattened `[first, last]` runs, by class id; for generated scan code. */
	get runs(): readonly (readonly number[])[] {
		if (!this.#runs) {
			const runs: number[][] = Array.from({ length: this.size }, () => []);
			let first = 0;
			let current = this.classOf(0);
			for (let unit = 1; unit <= UNIT_COUNT; unit++) {
				const id = unit < UNIT_COUNT ? this.classOf(unit) : -1;
				if (id === current) continue;
				runs[current]!.push(first, unit - 1);
				first = unit;
				current = id;
			}
			this.#runs = runs;
		}
		return this.#runs;
	}

	/** The sole code unit accepted by `members`, or undefined for empty or wider sets. */
	singleUnit(members: Uint8Array): number | undefined {
		const id = members.indexOf(1);
		return id >= 0 && this.#singletons[id] && members.indexOf(1, id + 1) === -1
			? this.#representatives[id]
			: undefined;
	}

	/** Which classes lie inside `set`: 1 per member class, by class id. */
	membership(set: UnitSet): Uint8Array {
		return Uint8Array.from(this.#representatives, unit => (has(set, unit) ? 1 : 0));
	}
}

/** Adds every code unit where membership in `set` changes. */
function addBoundaries(set: UnitSet, cuts: Set<number>): void {
	let inside = false;
	for (let word = 0; word < SET_WORDS; word++) {
		const bits = set[word]!;
		if (bits === (inside ? 0xffffffff : 0)) continue;
		for (let bit = 0; bit < 32; bit++) {
			if (((bits & (1 << bit)) !== 0) !== inside) {
				inside = !inside;
				cuts.add(word * 32 + bit);
			}
		}
	}
}
