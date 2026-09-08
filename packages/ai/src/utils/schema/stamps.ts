/**
 * Symbol-keyed lazy memoization stamped directly onto the host object.
 *
 * Faster than a module-level `WeakMap` in V8/JSC because the symbol slot is
 * resolved through the object's hidden class instead of a side-table hash
 * lookup. The slot is defined as a non-enumerable property so the stamp
 * does not leak through `{...spread}`, `Object.keys`, `JSON.stringify`, or
 * `toEqual`-style deep equality.
 *
 * Caveats: the stamp lives as long as the host object, even after callers
 * release their references to the cached value — only use this for caches
 * whose lifetime should match the host. Nonextensible hosts use a weak
 * side table. Mutable cells keep traversal state writable when a host is
 * frozen after its first traversal.
 */
interface Cell<V> {
	value: V | undefined;
}

const fallback = new WeakMap<object, Map<symbol, Cell<unknown>>>();

function cell<V>(target: object, key: symbol): Cell<V> {
	const existing = Object.hasOwn(target, key) ? (target as Record<symbol, Cell<V>>)[key] : undefined;
	if (existing) return existing;
	if (Object.isExtensible(target)) {
		const created: Cell<V> = { value: undefined };
		Object.defineProperty(target, key, { value: created });
		return created;
	}
	let slots = fallback.get(target);
	if (!slots) {
		slots = new Map();
		fallback.set(target, slots);
	}
	let stored = slots.get(key);
	if (!stored) {
		stored = { value: undefined };
		slots.set(key, stored);
	}
	return stored as Cell<V>;
}

export function stamp<T extends object, V>(target: T, key: symbol, compute: (target: T) => V): V {
	const slot = cell<V>(target, key);
	const existing = slot.value;
	if (existing !== undefined) return existing;
	const value = compute(target);
	slot.value = value;
	return value;
}

/**
 * Epoch-keyed cycle guard. Cheaper than `WeakSet` for recursive traversal
 * because the marker is a single property slot on the host object, written
 * once and overwritten in place on every subsequent traversal — the hidden
 * class transitions once per object lifetime, not per traversal.
 *
 * Usage:
 *   function walk(node, epoch = epochNext()) {
 *     if (!once(node, epoch)) return; // cycle
 *     for (const child of node.children) walk(child, epoch);
 *   }
 */
const kEpoch = Symbol("pi.schema.epoch");
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
	const slot = cell<number>(target, kEpoch);
	const cur = slot.value;
	if (cur !== undefined && cur >= epoch) return false;
	slot.value = epoch;
	return true;
}

/**
 * Counter-based path tracker. Use when a traversal needs to distinguish
 * "currently on the recursion path" from "previously visited" — i.e. cycle
 * detection that throws while still allowing DAG sharing. Increment on
 * entry, decrement on exit; the slot returns to 0 after a balanced walk so
 * subsequent top-level calls see a fresh state without any reset.
 *
 * Unlike a `WeakSet` with `seen.delete(...)`, the property is never deleted
 * — only incremented and decremented — so the host object's hidden class
 * is never invalidated.
 *
 * Usage:
 *   function walk(node) {
 *     if (!enter(node)) throw new Error("cycle");
 *     try { for (const c of node.children) walk(c); }
 *     finally { exit(node); }
 *   }
 */
const kDepth = Symbol("pi.schema.depth");

/**
 * Returns `true` on first entry, `false` if `target` is already on the
 * current path. A `false` return does NOT deepen the counter — callers pair
 * `exit` only with successful enters (`if (!enter(n)) bail; try {…} finally
 * { exit(n); }`), so incrementing on the cycle branch would leak depth and
 * make every later top-level walk of the same object misreport a cycle.
 */
export function enter<T extends object>(target: T): boolean {
	const slot = cell<number>(target, kDepth);
	const cur = slot.value;
	if (cur !== undefined && cur !== 0) return false;
	slot.value = 1;
	return true;
}

export function exit<T extends object>(target: T): void {
	const slot = cell<number>(target, kDepth);
	const cur = slot.value;
	if (cur === undefined) return;
	slot.value = cur - 1;
}
