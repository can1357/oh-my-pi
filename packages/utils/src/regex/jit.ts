/**
 * Scan kernels: WebAssembly generated from the transitions a {@link LazyDfa} has
 * cached, run over the text copied into one linear memory shared by every kernel.
 *
 * The shared buffer caches the most recent text: ASCII takes one byte per code
 * unit, other text keeps its UTF-16 code units. Kernels compile on first use per
 * layout. SIMD skips 16 bytes at a time in self-loops and across pairs of states
 * that agree on their transitions. Unknown transitions return to the table scan;
 * known FIND matches return directly. The marks region is cleared during copy-out,
 * not every time the text changes.
 *
 * @example
 * // Not runnable: `transitions` and `runs` come from a LazyDfa and its Alphabet.
 * const kernel = compileKernel(FIND, states, width, transitions, alphabet.runs);
 * const layout = load(text, text.length - from);
 * if (kernel && layout !== -1) {
 *   const at = runKernel(kernel, layout, FIND, from, text.length, state, undefined, 0);
 *   // at < 0: match at ~at; otherwise stoppedState() is the state at at.
 * }
 */

/** Reads forward; stops before the code unit whose transition ends a match. */
export const FIND = 0;
/** Reads forward; a match ending at `i >= lo` sets `marks[i - lo]`. */
export const MARK_AHEAD = 1;
/** Reads backward; a match of the reversed text ending after `text[i]` sets `marks[i + 1 - lo]`. */
export const MARK_BACK = 2;

/** What a scan returns or records. */
export type ScanMode = typeof FIND | typeof MARK_AHEAD | typeof MARK_BACK;

/** Text layouts in memory: one byte per code unit (ASCII text) or two. */
const NARROW = 0;
const WIDE = 1;
/** Byte-address shift for ASCII or UTF-16 text. */
export type Layout = typeof NARROW | typeof WIDE;

/**
 * Exported kernel function: reads from byte address `p` towards `stop` (exclusive)
 * until `stop` or the first transition left to the interpreter; returns the byte
 * address it stopped at and stores the state there in word 0. A FIND match returns
 * the complemented byte address instead, without storing a state. The mark for
 * the code unit at `p` goes to `bias + (p >>> layout)` (`+ 1` backwards), forwards
 * only from `lo` on.
 */
type Run = (p: number, stop: number, state: number, bias: number, lo: number) => number;

/** Kernels needing more range tests than this stay unbuilt; the interpreter keeps them. */
const MAX_TESTS = 1 << 15;
/** Above this many runs, use an ASCII table or leave UTF-16 to the scalar loop. */
const MAX_SIMD_RUNS = 4;
/** Action of code units whose transition the kernel leaves to the interpreter. */
const EXIT = -1;
/** A cached transition that ends a FIND match without consuming the current unit. */
const HIT = -2;
const LAST_UNIT = 0xffff;
const LAST_ASCII = 0x7f;
/** Byte address of mark 0; bytes 0-3 hold a kernel's stopping state. */
const MARKS = 16;
/** Scans shorter than this interpret rather than copy a new text in (a copy and a call cost ~25 ns). */
const MIN_LOAD_SPAN = 16;
/** Bound the shared text and marks storage; larger inputs use the table scan. */
const MAX_TEXT_UNITS = 1 << 23;
/** Limit how much non-ASCII text we transcode before switching to UTF-16. */
const COPY_BLOCK = 32 * 1024;

const memory = new WebAssembly.Memory({ initial: 1 });
/** Code units the marks and text regions hold. */
let capacity = 0;
/** Byte address of code unit 0. */
let textAt = MARKS;
let bytes = new Uint8Array(memory.buffer);
let word = new Int32Array(memory.buffer, 0, 1);
let writer = Buffer.from(memory.buffer);
let loaded: string | undefined;
let loadedLayout: Layout = NARROW;

/** Makes room for a text of `units` code units; the marks region ends up zeroed. */
function reserve(units: number): void {
	if (units <= capacity) return;
	capacity = Math.min(MAX_TEXT_UNITS, (Math.max(units, capacity * 2, 1024) + 15) & ~15);
	textAt = MARKS + capacity + 16;
	const need = textAt + 2 * capacity;
	if (need > memory.buffer.byteLength) memory.grow(Math.ceil((need - memory.buffer.byteLength) / 65536));
	bytes = new Uint8Array(memory.buffer);
	word = new Int32Array(memory.buffer, 0, 1);
	writer = Buffer.from(memory.buffer);
	// The marks region now covers bytes earlier texts were written to.
	bytes.fill(0, MARKS, textAt);
	loaded = undefined;
}

/** Code units at a scan's start compared with the shared copy before the whole texts are. */
const HEAD = 1024;

/**
 * The shared copy's layout when it can stand in for `text` over a scan of the
 * code units `[from, to)` (read from `to` down when `backward`), or -1 if the
 * scan would have to copy the text.
 *
 * The copy only has to agree with `text` where the scan reads, so a scan of at
 * most {@link HEAD} units is decided by comparing just those. A longer scan
 * needs the whole text to be the cached one. Comparing two strings reads up to
 * their first difference, and a different text of the same length is usually
 * the cached one rewritten near where it is now searched (a candidate
 * substituted for a match): its head is compared first, so that such a text
 * costs a kilobyte to rule out and not most of its length on every scan.
 */
export function cachedLayout(text: string, from: number, to: number, backward: boolean): Layout | -1 {
	if (loaded === undefined || text.length !== loaded.length) return -1;
	const headFrom = backward ? Math.max(from, to - HEAD) : from;
	const headTo = backward ? to : Math.min(to, from + HEAD);
	if (text.substring(headFrom, headTo) !== loaded.substring(headFrom, headTo)) return -1;
	if (headFrom === from && headTo === to) return loadedLayout;
	if (text !== loaded) return -1;
	// Equal content in another string object: adopt it, so its next checks are identity checks.
	loaded = text;
	return loadedLayout;
}

/** Copies a new text; -1 if the scan is too short or the text exceeds the shared buffer limit. */
export function load(text: string, span: number): Layout | -1 {
	if (span < MIN_LOAD_SPAN || text.length > MAX_TEXT_UNITS) return -1;
	reserve(text.length);
	loadedLayout = NARROW;
	for (let start = 0; start < text.length; start += COPY_BLOCK) {
		const end = Math.min(start + COPY_BLOCK, text.length);
		const part = start === 0 && end === text.length ? text : text.slice(start, end);
		// Four extra bytes fit any next UTF-8 scalar, so a write returning exactly
		// one byte per code unit cannot have stopped early on a multibyte scalar.
		if (writer.write(part, textAt + start, part.length + 4, "utf8") === part.length) continue;
		writer.write(text, textAt, "utf16le");
		loadedLayout = WIDE;
		break;
	}
	loaded = text;
	return loadedLayout;
}

/**
 * Runs `kernel` over the loaded text from `index` towards `stop` in `state`;
 * returns its stopping index and copies the marks into `marks`. FIND matches
 * return the complemented index. Otherwise the state is {@link stoppedState}.
 */
export function runKernel(
	kernel: Kernel,
	layout: Layout,
	mode: ScanMode,
	index: number,
	stop: number,
	state: number,
	marks: Uint8Array | undefined,
	lo: number,
): number {
	const run = kernel.run(layout);
	const at = run(
		textAt + (index << layout),
		textAt + (stop << layout),
		state,
		MARKS - lo - (textAt >> layout),
		textAt + (lo << layout),
	);
	// FIND encodes a match as the complement of the address of its unread unit.
	if (at < 0) return ~((~at - textAt) >> layout);
	const end = (at - textAt) >> layout;
	if (marks && end !== index) {
		const from = mode === MARK_BACK ? end + 2 - lo : Math.max(index, lo) - lo;
		const to = mode === MARK_BACK ? index + 2 - lo : end - lo;
		if (to > from) {
			marks.set(bytes.subarray(MARKS + from, MARKS + to), from);
			bytes.fill(0, MARKS + from, MARKS + to);
		}
	}
	return end;
}

/** The state the last {@link runKernel} stopped in. */
export function stoppedState(): number {
	return word[0]!;
}

/** The generated module exports only one function, with the signature in its type section. */
function isRun(value: unknown): value is Run {
	return typeof value === "function";
}

/** One DFA snapshot's scan code, compiled on first use per layout. */
export class Kernel {
	readonly #mode: ScanMode;
	readonly #layout: Layout | undefined;
	/** Code units by action, per state. */
	readonly #plan: Map<number, number[]>[];
	readonly #runs: (Run | undefined)[] = [];

	/** Stores the transition ranges for compilation against the eventual input layout. */
	constructor(mode: ScanMode, plan: Map<number, number[]>[], layout?: Layout) {
		this.#mode = mode;
		this.#plan = plan;
		this.#layout = layout;
	}

	/** Whether this snapshot covers the loaded text's layout. */
	supports(layout: Layout): boolean {
		return this.#layout === undefined || this.#layout === layout;
	}

	/** The compiled function bound to the current shared memory. */
	run(layout: Layout): Run {
		const existing = this.#runs[layout];
		if (existing) return existing;
		const rows = layout === NARROW && this.#layout === undefined ? this.#plan.map(clip) : this.#plan;
		const module = new WebAssembly.Module(emit(this.#mode, rows, layout));
		const run: unknown = new WebAssembly.Instance(module, { m: { m: memory } }).exports.k;
		if (!isRun(run)) throw new TypeError("Wasm kernel does not export k");
		this.#runs[layout] = run;
		return run;
	}
}

/**
 * Kernel for `mode` over the first `states` states of a DFA whose transitions
 * are `transitions[state * width + class]` (`(next << 1) | matched`, -1 unknown);
 * `runs[class]` lists each class's code units as flattened `[first, last]` runs.
 * Undefined when the kernel would exceed {@link MAX_TESTS} range tests.
 */
export function compileKernel(
	mode: ScanMode,
	states: number,
	width: number,
	transitions: Int32Array,
	runs: readonly (readonly number[])[],
): Kernel | undefined {
	const plan: Map<number, number[]>[] = [];
	let tests = 0;
	for (let state = 0; state < states; state++) {
		const groups = groupUnits(mode, transitions, state * width, width, runs);
		for (const units of groups.values()) tests += units.length / 2;
		if (tests > MAX_TESTS) return undefined;
		plan.push(groups);
	}
	return new Kernel(mode, plan);
}

/**
 * Snapshot only ASCII transitions when compiling every class in a wide
 * alphabet would exceed the kernel budget. Unknown rows still yield to the DFA.
 */
export function compileAsciiKernel(
	mode: ScanMode,
	states: number,
	width: number,
	transitions: Int32Array,
	asciiClasses: Uint16Array,
): Kernel {
	const plan: Map<number, number[]>[] = [];
	for (let state = 0; state < states; state++) {
		const groups = new Map<number, number[]>();
		const row = state * width;
		let first = 0;
		let action = transitionAction(mode, transitions[row + asciiClasses[0]!]!);
		for (let unit = 1; unit <= LAST_ASCII + 1; unit++) {
			const next = unit > LAST_ASCII ? undefined : transitionAction(mode, transitions[row + asciiClasses[unit]!]!);
			if (next === action) continue;
			let units = groups.get(action);
			if (!units) groups.set(action, (units = []));
			units.push(first, unit - 1);
			first = unit;
			if (next !== undefined) action = next;
		}
		plan.push(groups);
	}
	return new Kernel(mode, plan, NARROW);
}

// Parameters, followed by the scalar unit, vector scratch and pair-scan entry pointer.
const P = 0;
const STOP = 1;
const STATE = 2;
const BIAS = 3;
const LO = 4;
const C = 5;
const V = 6;
const ENTRY = 7;

const I32 = 0x7f;
const V128 = 0x7b;
const SIMD = 0xfd;
const OP = {
	eqz: 0x45,
	eq: 0x46,
	ltU: 0x49,
	gtU: 0x4b,
	leU: 0x4d,
	geU: 0x4f,
	clz: 0x67,
	ctz: 0x68,
	add: 0x6a,
	sub: 0x6b,
	or: 0x72,
	xor: 0x73,
	shl: 0x74,
	shrU: 0x76,
};
/** SIMD sub-opcodes per lane width: [i8x16, i16x8]. */
const LANE = {
	splat: [0x0f, 0x10],
	eq: [0x23, 0x2d],
	ltU: [0x26, 0x30],
	geU: [0x2c, 0x36],
	sub: [0x71, 0x91],
	bitmask: [0x64, 0x84],
};

/** Function-body bytes; each method appends one instruction. */
class Code {
	readonly bytes: number[] = [];

	op(...ops: number[]): this {
		for (const op of ops) this.bytes.push(op);
		return this;
	}
	simd(op: number): this {
		return this.op(SIMD, ...uleb(op));
	}
	i32(value: number): this {
		this.bytes.push(0x41);
		for (;;) {
			const low = value & 0x7f;
			value >>= 7;
			if ((value === 0 && !(low & 0x40)) || (value === -1 && low & 0x40)) return this.op(low);
			this.bytes.push(low | 0x80);
		}
	}
	get(local: number): this {
		return this.op(0x20, local);
	}
	set(local: number): this {
		return this.op(0x21, local);
	}
	block(): this {
		return this.op(0x02, 0x40);
	}
	loop(): this {
		return this.op(0x03, 0x40);
	}
	if(): this {
		return this.op(0x04, 0x40);
	}
	end(): this {
		return this.op(0x0b);
	}
	br(depth: number): this {
		return this.op(0x0c, ...uleb(depth));
	}
	brIf(depth: number): this {
		return this.op(0x0d, ...uleb(depth));
	}
}

function uleb(value: number): number[] {
	const out: number[] = [];
	do {
		let low = value & 0x7f;
		value >>>= 7;
		if (value) low |= 0x80;
		out.push(low);
	} while (value);
	return out;
}

const vec = (items: number[][]): number[] => [...uleb(items.length), ...items.flat()];
const section = (id: number, body: number[]): number[] => [id, ...uleb(body.length), ...body];

/**
 * Module bytes of a kernel for `layout`.
 * Layout: `block $exit { loop $dispatch { block $s(n-1) … block $s0 { br_table state } <s0> } … <s(n-1)> } }`:
 * branching to block k's label lands on state k's code; states past the snapshot exit.
 */
function emit(mode: ScanMode, rows: readonly Map<number, number[]>[], layout: Layout): Uint8Array<ArrayBuffer> {
	const narrow = layout === NARROW;
	const back = mode === MARK_BACK;
	const unit = narrow ? 1 : 2;
	const step = back ? -unit : unit;
	const states = rows.length;
	const c = new Code();
	c.block().loop();
	for (let state = 0; state < states; state++) c.block();
	c.get(STATE).op(0x0e, ...uleb(states));
	for (let state = 0; state < states; state++) c.op(...uleb(state));
	c.op(...uleb(states + 1));

	/** Pushes the mark address for the code unit at `P` (before the backward `+ 1` store offset). */
	const markAddress = (): void => {
		c.get(BIAS).get(P);
		if (!narrow) c.i32(1).op(OP.shrU);
		c.op(OP.add);
	};

	for (let state = 0; state < states; state++) {
		c.end();
		const exitDepth = states - state;
		const groups = rows[state]!;
		if (groups.size === 0 || (groups.size === 1 && groups.has(EXIT))) {
			c.br(exitDepth);
			continue;
		}
		// Leave the most fragmented group implicit; test the self-loop first.
		let fallback = EXIT;
		let widest = -1;
		for (const [action, units] of groups) {
			if (units.length > widest) {
				fallback = action;
				widest = units.length;
			}
		}
		const order = [...groups.keys()].sort((a, b) => Number(b >>> 1 === state) - Number(a >>> 1 === state));
		const shared = narrow && mode === FIND ? sharedRun(rows, state) : undefined;
		// The pair scan runs on dispatch, not on every scalar self-loop iteration.
		if (shared) emitSharedRun(c, shared, exitDepth);
		/** Takes `action` from inside `nested` blocks of this state's loop. */
		const act = (action: number, nested: number): void => {
			if (action === EXIT) {
				c.br(exitDepth + 1 + nested);
				return;
			}
			if (action === HIT) {
				c.get(P).i32(-1).op(OP.xor, 0x0f); // return ~P
				return;
			}
			const marked = (action & 1) !== 0;
			if (marked) {
				if (back) {
					markAddress();
					c.i32(1).op(0x3a, 0, 1);
				} else {
					c.get(P).get(LO).op(OP.geU).if();
					markAddress();
					c.i32(1).op(0x3a, 0, 0).end();
				}
			}
			c.get(P).i32(step).op(OP.add).set(P);
			const target = action >>> 1;
			if (target !== state) {
				c.i32(target)
					.set(STATE)
					.br(exitDepth + nested);
				return;
			}
			c.br(nested);
		};

		c.loop();
		const unmarkedStay = groups.get(state << 1);
		if (unmarkedStay) emitSkip(c, unmarkedStay, { narrow, back, marked: false, markAddress });
		const markedStay = groups.get((state << 1) | 1);
		if (markedStay) emitSkip(c, markedStay, { narrow, back, marked: true, markAddress });
		c.get(P)
			.get(STOP)
			.op(back ? OP.leU : OP.geU)
			.brIf(exitDepth + 1);
		c.get(P)
			.op(narrow ? 0x2d : 0x2f, narrow ? 0 : 1, 0)
			.set(C);
		for (const action of order) {
			if (action === fallback) continue;
			const units = groups.get(action)!;
			const last = narrow ? LAST_ASCII : LAST_UNIT;
			if (units.length === 2) {
				emitRange(c, units[0]!, units[1]!, last);
				c.if();
			} else {
				// First range that holds wins: `block $miss { block $hit { … br_if $hit … } act }`.
				c.block().block();
				for (let index = 0; index < units.length; index += 2) {
					emitRange(c, units[index]!, units[index + 1]!, last);
					if (index + 2 < units.length) c.brIf(0);
					else c.op(OP.eqz).brIf(1);
				}
				c.end();
			}
			act(action, 1);
			c.end();
		}
		act(fallback, 0);
		c.end();
	}
	c.end().end();
	c.i32(0).get(STATE).op(0x36, 2, 0).get(P).end();

	const body = [
		...vec([
			[1, I32],
			[1, V128],
			[1, I32],
		]),
		...c.bytes,
	];
	const name = (text: string): number[] => vec([...text].map(ch => [ch.charCodeAt(0)]));
	return new Uint8Array([
		0x00,
		0x61,
		0x73,
		0x6d,
		0x01,
		0x00,
		0x00,
		0x00,
		...section(1, vec([[0x60, ...vec([[I32], [I32], [I32], [I32], [I32]]), ...vec([[I32]])]])),
		...section(2, vec([[...name("m"), ...name("m"), 0x02, 0x00, 0x00]])),
		...section(3, vec([[0]])),
		...section(7, vec([[...name("k"), 0x00, 0]])),
		...section(10, vec([[...uleb(body.length), ...body]])),
	]);
}

/**
 * At entry to a state loop, skips whole vectors of one self-loop action.
 * Unmarked, it then lands on the first unit with another action. Marked, it
 * stores the marks and leaves the partial vector to the scalar loop.
 */
function emitSkip(
	c: Code,
	stay: readonly number[],
	{ narrow, back, marked, markAddress }: { narrow: boolean; back: boolean; marked: boolean; markAddress: () => void },
): void {
	const last = narrow ? LAST_ASCII : LAST_UNIT;
	const leave = complement(stay, last);
	if (leave.length === 0 && !marked) {
		c.get(STOP).set(P);
		return;
	}
	const testStay = stay.length <= leave.length;
	const tested = testStay ? stay : leave;
	const nibble = tested.length / 2 > MAX_SIMD_RUNS;
	if (nibble && !narrow) return;
	const lane = narrow ? 0 : 1;
	const lanes = narrow ? 16 : 8;
	const unit = narrow ? 1 : 2;
	c.block().loop();
	// Forwards the units at [P, P + 16) must lie before STOP; backwards (P - 16, P] after it.
	if (back) c.get(P).get(STOP).i32(16).op(OP.add, OP.ltU).brIf(1);
	else c.get(P).i32(16).op(OP.add).get(STOP).op(OP.gtU).brIf(1);
	// Marks forwards only count from `lo` on.
	if (marked && !back) c.get(P).get(LO).op(OP.ltU).brIf(1);
	if (tested.length === 0) {
		c.i32(1);
	} else {
		c.get(P);
		if (back) c.i32(16 - unit).op(OP.sub);
		c.simd(0x00).op(0, 0).set(V);
		if (nibble) emitAsciiMembership(c, leave);
		else {
			emitVectorRanges(c, tested, lane, last);
			if (testStay) c.simd(0x4d); // v128.not: lanes that leave
		}
		c.set(V).get(V).simd(0x53).op(OP.eqz); // !v128.any_true
	}
	c.if();
	if (marked) {
		// The whole vector stays and marks: one store covers its marks.
		markAddress();
		if (back) c.i32(lanes - 2).op(OP.sub);
		c.i32(1).simd(0x0f);
		if (narrow) c.simd(0x0b).op(0, 0); // v128.store
		else c.simd(0x5b).op(0, 0, 0); // v128.store64_lane
	}
	c.get(P)
		.i32(back ? -16 : 16)
		.op(OP.add)
		.set(P)
		.br(1)
		.end();
	if (!marked) {
		// Land on the first unit that leaves: the lowest set bit forwards, the highest backwards.
		c.get(P).get(V);
		if (nibble) c.i32(0).simd(0x0f).simd(0x24); // i8x16.ne: set the sign bit of every leaving lane
		c.simd(LANE.bitmask[lane]!);
		if (back) c.i32(32 - lanes).op(OP.shl, OP.clz);
		else c.op(OP.ctz);
		if (!narrow) c.i32(1).op(OP.shl);
		c.op(back ? OP.sub : OP.add).set(P);
	}
	c.end().end();
}

interface SharedRun {
	/** The code units neither state can consume without leaving the pair. */
	leave: number[];
	/** Units which take either state to `other`. */
	toOther: number[];
	other: number;
}

/**
 * Both states must take exactly the same unmarked transition on each skipped byte.
 * Only the last skipped byte is then needed to recover the DFA state.
 */
function sharedRun(rows: readonly ReadonlyMap<number, number[]>[], state: number): SharedRun | undefined {
	const ours = rows[state]!;
	const stay = ours.get(state << 1);
	if (!stay) return undefined;
	let best: SharedRun | undefined;
	let shortest = 65;
	for (const [action, units] of ours) {
		if (action < 0 || action & 1 || action >>> 1 === state) continue;
		const other = action >>> 1;
		const theirs = rows[other]!;
		const toUs = intersect(stay, theirs.get(state << 1));
		const toOther = intersect(units, theirs.get(action));
		if (toUs.length === 0 || toOther.length === 0) continue;
		const leave = complement(joinRuns([...toUs, ...toOther]), LAST_ASCII);
		let excluded = 0;
		for (let i = 0; i < leave.length; i += 2) excluded += leave[i + 1]! - leave[i]! + 1;
		if (excluded < shortest) {
			shortest = excluded;
			best = { leave, toOther, other };
		}
	}
	return best;
}

function intersect(a: readonly number[], b: readonly number[] | undefined): number[] {
	const out: number[] = [];
	if (!b) return out;
	for (let i = 0, j = 0; i < a.length && j < b.length;) {
		const lo = Math.max(a[i]!, b[j]!);
		const hi = Math.min(a[i + 1]!, b[j + 1]!);
		if (lo <= hi) out.push(lo, hi);
		if (a[i + 1]! < b[j + 1]!) i += 2;
		else j += 2;
	}
	return out;
}

/** Skip full vectors, then recover the state before handling the first partial vector. */
function emitSharedRun(c: Code, { leave, toOther, other }: SharedRun, exitDepth: number): void {
	c.get(P).set(ENTRY);
	c.block().loop();
	c.get(P).i32(16).op(OP.add).get(STOP).op(OP.gtU).brIf(1);
	if (leave.length) {
		c.get(P).simd(0).op(0, 0).set(V);
		if (leave.length <= 4) emitVectorRanges(c, leave, 0, LAST_ASCII);
		else emitAsciiMembership(c, leave);
		c.simd(0x53).brIf(1); // v128.any_true
	}
	c.get(P).i32(16).op(OP.add).set(P).br(0).end().end();
	c.get(P).get(ENTRY).op(0x47).if(); // i32.ne
	c.get(P).i32(1).op(OP.sub).op(0x2d, 0, 0).set(C);
	for (let i = 0; i < toOther.length; i += 2) {
		emitRange(c, toOther[i]!, toOther[i + 1]!, LAST_ASCII);
		if (i > 0) c.op(OP.or);
	}
	c.if()
		.i32(other)
		.set(STATE)
		.br(exitDepth + 1)
		.end()
		.end();
}

/** Pushes a vector with a nonzero byte for each ASCII lane of `V` in the given ranges. */
function emitAsciiMembership(c: Code, ranges: readonly number[]): void {
	// For ASCII x, table[x & 15] has bit (x >>> 4) set iff x belongs.
	const table = Array<number>(16).fill(0);
	for (let i = 0; i < ranges.length; i += 2) {
		for (let unit = ranges[i]!; unit <= ranges[i + 1]!; unit++) table[unit & 15]! |= 1 << (unit >>> 4);
	}
	c.simd(0x0c)
		.op(...table)
		.get(V)
		.i32(15)
		.simd(0x0f)
		.simd(0x4e)
		.simd(0x0e);
	c.simd(0x0c).op(1, 2, 4, 8, 16, 32, 64, 128, 0, 0, 0, 0, 0, 0, 0, 0);
	c.get(V).i32(4).simd(0x6d).simd(0x0e).simd(0x4e);
}

/** Pushes a vector with all bits set in each lane of `V` that belongs to the given ranges. */
function emitVectorRanges(c: Code, ranges: readonly number[], lane: Layout, last: number): void {
	for (let index = 0; index < ranges.length; index += 2) {
		const first = ranges[index]!;
		const end = ranges[index + 1]!;
		const splat = LANE.splat[lane]!;
		c.get(V);
		if (first === end) c.i32(first).simd(splat).simd(LANE.eq[lane]!);
		else if (first === 0)
			c.i32(end + 1)
				.simd(splat)
				.simd(LANE.ltU[lane]!);
		else if (end === last) c.i32(first).simd(splat).simd(LANE.geU[lane]!);
		else
			c.i32(first)
				.simd(splat)
				.simd(LANE.sub[lane]!)
				.i32(end - first + 1)
				.simd(splat)
				.simd(LANE.ltU[lane]!);
		if (index !== 0) c.simd(0x50); // v128.or
	}
}

/** Pushes whether `C` lies in `[first, end]`; `last` is the highest code unit the layout holds. */
function emitRange(c: Code, first: number, end: number, last: number): void {
	c.get(C);
	if (first === end) c.i32(first).op(OP.eq);
	else if (first === 0) c.i32(end + 1).op(OP.ltU);
	else if (end === last) c.i32(first).op(OP.geU);
	else
		c.i32(first)
			.op(OP.sub)
			.i32(end - first + 1)
			.op(OP.ltU);
}

/** The groups restricted to ASCII code units, dropping those left empty. */
function clip(groups: ReadonlyMap<number, number[]>): Map<number, number[]> {
	const clipped = new Map<number, number[]>();
	for (const [action, units] of groups) {
		const ascii: number[] = [];
		for (let index = 0; index < units.length && units[index]! <= LAST_ASCII; index += 2) {
			ascii.push(units[index]!, Math.min(units[index + 1]!, LAST_ASCII));
		}
		if (ascii.length > 0) clipped.set(action, ascii);
	}
	return clipped;
}

/** Code units up to `last` outside the sorted, joined runs `runs`, as runs. */
function complement(runs: readonly number[], last: number): number[] {
	const out: number[] = [];
	let next = 0;
	for (let index = 0; index < runs.length; index += 2) {
		if (runs[index]! > next) out.push(next, runs[index]! - 1);
		next = runs[index + 1]! + 1;
	}
	if (next <= last) out.push(next, last);
	return out;
}

/**
 * Code units by action: `(next << 1) | matched`, {@link EXIT} for unknown
 * transitions, or {@link HIT} for matching FIND transitions. Each group's
 * runs are sorted and adjacent runs joined.
 */
function groupUnits(
	mode: ScanMode,
	transitions: Int32Array,
	row: number,
	width: number,
	runs: readonly (readonly number[])[],
): Map<number, number[]> {
	const groups = new Map<number, number[]>();
	for (let id = 0; id < width; id++) {
		const action = transitionAction(mode, transitions[row + id]!);
		let units = groups.get(action);
		if (!units) {
			units = [];
			groups.set(action, units);
		}
		for (const unit of runs[id]!) units.push(unit);
	}
	for (const [action, units] of groups) groups.set(action, joinRuns(units));
	return groups;
}

function transitionAction(mode: ScanMode, next: number): number {
	return next < 0 ? EXIT : mode === FIND && (next & 1) !== 0 ? HIT : next;
}

/** Sorts flattened, disjoint `[first, last]` runs and joins adjacent ones. */
function joinRuns(runs: readonly number[]): number[] {
	const order = Array.from({ length: runs.length / 2 }, (_, run) => run).sort((a, b) => runs[2 * a]! - runs[2 * b]!);
	const joined: number[] = [];
	for (const run of order) {
		const first = runs[2 * run]!;
		const last = runs[2 * run + 1]!;
		if (joined.length > 0 && joined[joined.length - 1]! + 1 === first) joined[joined.length - 1] = last;
		else joined.push(first, last);
	}
	return joined;
}
