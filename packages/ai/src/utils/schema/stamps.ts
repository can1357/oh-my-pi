/**
 * Lazy memoization keyed by host object identity, held in a module-level
 * weak side table.
 *
 * The bookkeeping deliberately lives outside the host rather than in a
 * non-enumerable symbol property: schema objects are caller-owned and may be
 * sealed, frozen, or deep-frozen after their first traversal. A recursive
 * freeze that enumerates with `Reflect.ownKeys` reaches symbol slots, so an
 * on-host slot would be frozen along with the schema and every later write
 * would throw. A side table is also invisible to `{...spread}`,
 * `Object.keys`, `JSON.stringify`, and `toEqual`-style deep equality.
 *
 * Caveats: an entry lives as long as the host object, even after callers
 * release their references to the cached value — only use this for caches
 * whose lifetime should match the host.
 */
const memos = new WeakMap<object, Map<symbol, unknown>>();

export function stamp<T extends object, V>(target: T, key: symbol, compute: (target: T) => V): V {
	let slots = memos.get(target);
	if (!slots) {
		slots = new Map();
		memos.set(target, slots);
	}
	const existing = slots.get(key) as V | undefined;
	if (existing !== undefined) return existing;
	const value = compute(target);
	slots.set(key, value);
	return value;
}

/**
 * Epoch-keyed cycle guard. Cheaper than a per-call `WeakSet` for recursive
 * traversal because the marker is a single side-table entry per host object,
 * written once and overwritten in place on every subsequent traversal — no
 * per-walk allocation.
 *
 * Usage:
 *   function walk(node, epoch = epochNext()) {
 *     if (!once(node, epoch)) return; // cycle
 *     for (const child of node.children) walk(child, epoch);
 *   }
 */
const epochs = new WeakMap<object, number>();
let __epoch = 0;

export function epochNext(): number {
	return ++__epoch;
}

/**
 * Marks `target` as visited for this `epoch`. Returns `true` the first time
 * it is called for a given (target, epoch) pair and `false` on every
 * subsequent call within the same epoch.
 */
export function once<T extends object>(target: T, epoch: number): boolean {
	const cur = epochs.get(target);
	if (cur !== undefined && cur >= epoch) return false;
	epochs.set(target, epoch);
	return true;
}

/**
 * Counter-based path tracker. Use when a traversal needs to distinguish
 * "currently on the recursion path" from "previously visited" — i.e. cycle
 * detection that throws while still allowing DAG sharing. Increment on
 * entry, decrement on exit; the counter returns to 0 after a balanced walk so
 * subsequent top-level calls see a fresh state without any reset.
 *
 * Usage:
 *   function walk(node) {
 *     if (!enter(node)) throw new Error("cycle");
 *     try { for (const c of node.children) walk(c); }
 *     finally { exit(node); }
 *   }
 */
const depths = new WeakMap<object, number>();

/**
 * Returns `true` on first entry, `false` if `target` is already on the
 * current path. A `false` return does NOT deepen the counter — callers pair
 * `exit` only with successful enters (`if (!enter(n)) bail; try {…} finally
 * { exit(n); }`), so incrementing on the cycle branch would leak depth and
 * make every later top-level walk of the same object misreport a cycle.
 */
export function enter<T extends object>(target: T): boolean {
	const cur = depths.get(target);
	if (cur !== undefined && cur !== 0) return false;
	depths.set(target, 1);
	return true;
}

export function exit<T extends object>(target: T): void {
	const cur = depths.get(target);
	if (cur === undefined) return;
	depths.set(target, cur - 1);
}
