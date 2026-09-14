import type { AgentToolContext } from "./types";

/**
 * Augment a host-provided tool context with the loop-owned
 * `addAdditionalContext` callback without disturbing the host's object.
 *
 * A structural clone must preserve more than shape: hosts may back context
 * members with ES `#private` state, which lives on the instance rather than
 * its prototype, so a naive descriptor copy throws `TypeError` the moment the
 * tool touches such a member. Functions bind to the original receiver
 * (including methods inherited through the prototype chain) and accessors are
 * re-homed onto it, keeping the private brand intact. Writable data members
 * forward through accessors: tools previously received the host object itself,
 * so a write such as `context.counter++` must stay visible through it — a
 * descriptor copy would fork storage on the clone. Read-only data still
 * copies by descriptor. The injected callback is the only member that
 * resolves against the clone.
 * A host-supplied `addAdditionalContext` is always shadowed: the loop-owned
 * callback routes to the current call. Blank and non-string input never
 * reaches the callback.
 */
export function withAdditionalContext(
	base: AgentToolContext | undefined,
	addAdditionalContext: (context: string) => void,
): AgentToolContext {
	const guardedAddAdditionalContext = (context: string): void => {
		if (typeof context === "string" && context.trim().length > 0) {
			addAdditionalContext(context);
		}
	};
	if (base === undefined) return { addAdditionalContext: guardedAddAdditionalContext } as AgentToolContext;
	const clone: AgentToolContext = Object.create(Object.getPrototypeOf(base));
	const defineForwarded = (target: object, key: string | symbol): void => {
		if (key === "addAdditionalContext") return;
		const descriptor = Object.getOwnPropertyDescriptor(target, key);
		if (descriptor === undefined) return;
		if (typeof descriptor.get === "function" || typeof descriptor.set === "function") {
			const { get, set } = descriptor;
			Object.defineProperty(clone, key, {
				...descriptor,
				...(get === undefined ? {} : { get: () => get.call(base) }),
				...(set === undefined ? {} : { set: (value: unknown) => set.call(base, value) }),
			});
		} else if (typeof descriptor.value === "function") {
			Object.defineProperty(clone, key, { ...descriptor, value: descriptor.value.bind(base) });
		} else if (descriptor.writable === true) {
			const host = base as unknown as Record<string | symbol, unknown>;
			Object.defineProperty(clone, key, {
				enumerable: descriptor.enumerable,
				configurable: descriptor.configurable,
				get: () => host[key],
				set: (value: unknown) => {
					host[key] = value;
				},
			});
		} else {
			Object.defineProperty(clone, key, descriptor);
		}
	};
	for (const key of Reflect.ownKeys(base)) defineForwarded(base, key);
	// Prototype methods run with the clone as receiver by default, which breaks
	// `#private`-backed members the same way a naive copy does. Bind the
	// inherited surface to the original instance; data members resolve through
	// the intact prototype chain untouched.
	let prototype = Object.getPrototypeOf(base);
	while (prototype !== null && prototype !== Object.prototype) {
		for (const key of Reflect.ownKeys(prototype)) {
			if (key === "constructor") continue;
			if (Object.prototype.hasOwnProperty.call(clone, key)) continue;
			defineForwarded(prototype, key);
		}
		prototype = Object.getPrototypeOf(prototype);
	}
	Object.defineProperty(clone, "addAdditionalContext", {
		value: guardedAddAdditionalContext,
		writable: true,
		enumerable: true,
		configurable: true,
	});
	return clone;
}
