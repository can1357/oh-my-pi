/**
 * Memoization for `describe()`: an unchanged component must hand the
 * reconciler the same node objects, so it can skip the subtree. {@link Memo}
 * is the one primitive; {@link OwnerMemo} keys it by an object for stateless
 * renderers (tool describe hooks) that re-describe the same args/result.
 */
import type { NativeNode } from "./node";

/** Element-wise identity (`Object.is`) of two arrays; `undefined` never matches. */
export function sameItems<T>(a: readonly T[] | undefined, b: readonly T[]): boolean {
	if (a === b) return true;
	if (a === undefined || a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
	return true;
}

/** Shallow equality of two flat prop bags built by successive describe calls. */
export function sameProps<T extends object>(a: T | undefined, b: T): boolean {
	if (a === undefined) return false;
	for (const key in b) if (a[key] !== b[key]) return false;
	for (const key in a) if (!(key in b)) return false;
	return true;
}

/** Keeps the last built value while every dependency is unchanged (`Object.is` per slot). */
export class Memo<T = NativeNode> {
	#deps: readonly unknown[] | undefined;
	#value: T | undefined;

	get(deps: readonly unknown[], build: () => T): T {
		if (this.#deps !== undefined && sameItems(this.#deps, deps)) return this.#value as T;
		const value = build();
		this.#deps = deps;
		this.#value = value;
		return value;
	}

	/** Forget the cached value (theme, glyph preset or keybindings changed). */
	clear(): void {
		this.#deps = undefined;
		this.#value = undefined;
	}
}

/**
 * One {@link Memo} per owner object, kept in a symbol slot on the owner; each
 * instance owns its own slot, so call and result views of one object don't
 * collide. Builds uncached without an owner or when the owner is frozen.
 */
export class OwnerMemo<T> {
	readonly #slot = Symbol("native.memo");

	get(owner: object | undefined, deps: readonly unknown[], build: () => T): T {
		if (!owner) return build();
		const tagged = owner as { [slot: symbol]: Memo<T> | undefined };
		let memo = tagged[this.#slot];
		if (!memo) {
			if (!Object.isExtensible(owner)) return build();
			memo = new Memo<T>();
			Object.defineProperty(owner, this.#slot, { value: memo, configurable: true });
		}
		return memo.get(deps, build);
	}
}
