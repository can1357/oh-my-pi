import type { ExtensionCallbackOwner } from "./types";

/** Properties of a provider configuration whose consumer outlives the session that registered
 *  them, so the session's retirement must not disable them. `streamSimple` goes to the
 *  process-global custom-API registry keyed by its `api` id: a parent session and the child that
 *  rebound the same extension stream through one entry, and retiring the child must not stop the
 *  parent's requests — `sdk-restricted-extension-provider.test.ts` holds that line. Everything
 *  else a configuration carries is invoked on behalf of the session that registered it. */
const SESSION_SHARED_KEYS: Record<string, true> = { streamSimple: true };

/**
 * A read-through view of an object an extension handed the host, whose every callable property is
 * owned by the session that accepted it.
 *
 * Copying the object and rewriting its own enumerable functions — what this replaced — owns only
 * the shape the first probe happened to use. A provider may be a class instance (its methods live
 * on the prototype), expose a callback through a getter, or hide one behind a non-enumerable
 * descriptor; a copy misses all three, and a copy that keeps only the prototype is not an instance
 * of the class, so an inherited method reading a private field fails on it. Both were observed.
 *
 * A `get` trap has none of those blind spots: it sees inherited, accessor and non-enumerable
 * properties alike, and it evaluates each one against the ORIGINAL object, so a getter or method
 * reading `#private` works exactly as it does for its author. The extension's object is never
 * rewritten and never copied; `Object.entries`, spreads and `JSON.stringify` all read through the
 * trap, so a consumer that copies the view copies owned functions.
 *
 * Nested plain objects are viewed the same way, so a callback inside an `oauth` or `usage` block
 * is owned by the same rule rather than by a list the next block would have to join. Arrays are
 * left alone: a model catalog carries data, not callbacks, and a proxied array is a liability for
 * no gain.
 *
 * `shareSessionIndependentKeys` exempts the entries in {@link SESSION_SHARED_KEYS} at the top
 * level, for the one case where the consumer is not this session.
 */
export function ownCallableSurface<T extends object>(
	target: T,
	owner: ExtensionCallbackOwner,
	shareSessionIndependentKeys = false,
): T {
	// One wrapper per underlying function and one view per underlying object, so a consumer that
	// reads the same property twice gets the same value both times and an identity comparison
	// still means what it meant.
	const wrapped = new WeakMap<object, unknown>();
	const view = (value: object, receiver: object): unknown => {
		const existing = wrapped.get(value);
		if (existing !== undefined) return existing;
		let owned: unknown;
		if (typeof value === "function") {
			// Bound to the object that owns the slot, not to whoever reads the property: the
			// receiver is why a prototype method can see the instance's private fields.
			owned = owner.ownInvocation((value as (...args: unknown[]) => unknown).bind(receiver));
		} else if (Array.isArray(value)) {
			return value;
		} else {
			owned = ownCallableSurface(value, owner);
		}
		wrapped.set(value, owned);
		return owned;
	};
	return new Proxy(target, {
		get(object, key) {
			// `object`, not the reading receiver: an accessor must run against the extension's own
			// instance. A view installed as another object's prototype would otherwise evaluate
			// the getter against that object, which has none of the private slots it reads.
			const value = Reflect.get(object, key, object) as unknown;
			if (value === null || (typeof value !== "object" && typeof value !== "function")) return value;
			if (shareSessionIndependentKeys && typeof key === "string" && SESSION_SHARED_KEYS[key]) return value;
			return view(value, object);
		},
	});
}
