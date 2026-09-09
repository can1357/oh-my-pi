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
 * whose lifetime should match the host. Frozen hosts cannot be stamped;
 * `define` silently skips them, so memoization/visit-tracking degrades to
 * best-effort (recompute on every call, no cycle protection) instead of
 * throwing.
 */
function define<T extends object>(target: T, key: symbol, value: unknown): void {
	if (Object.isFrozen(target)) return;
	Object.defineProperty(target, key, { value, writable: true, configurable: true });
}

export function stamp<T extends object, V>(target: T, key: symbol, compute: (target: T) => V): V {
	const slot = target as Record<symbol, V | undefined>;
	const existing = slot[key];
	if (existing !== undefined) return existing;
	const value = compute(target);
	define(target, key, value);
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
	const slot = target as Record<symbol, number | undefined>;
	const cur = slot[kEpoch];
	if (cur !== undefined && cur >= epoch) return false;
	if (cur === undefined) define(target, kEpoch, epoch);
	else slot[kEpoch] = epoch;
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
	const slot = target as Record<symbol, number | undefined>;
	const cur = slot[kDepth];
	if (cur === undefined) {
		define(target, kDepth, 1);
		return true;
	}
	if (cur !== 0) return false;
	slot[kDepth] = 1;
	return true;
}

export function exit<T extends object>(target: T): void {
	const slot = target as Record<symbol, number | undefined>;
	const cur = slot[kDepth];
	// Frozen targets never received the kDepth stamp in `enter` — nothing to unwind.
	if (cur === undefined) return;
	slot[kDepth] = cur - 1;
}
