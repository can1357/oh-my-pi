import { types } from "node:util";

/** How a session's work enters its request context (see `AgentSession.runInRequestContext`). */
export type SessionWorkRun = <T>(fn: () => T) => T;

/** Each live session's entry into its request context (see `AgentSession.runInRequestContext`). */
const sessionRequestContexts = new WeakMap<object, SessionWorkRun>();

/** Registers `run` as how `session`'s work enters its request context; a session does this when it is built. */
export function registerSessionWork(session: object, run: SessionWorkRun): void {
	sessionRequestContexts.set(session, run);
}

/**
 * Runs `fn` as `session`'s work, in its request context: every model request `fn` starts waits
 * for the session's holds. For a host dispatching work for a session it holds as a value — a
 * command dispatcher, a subagent reviver. An object no session registered — no session at all —
 * runs `fn` as is.
 */
export function runAsSessionWork<T>(session: object | undefined, fn: () => T): T {
	const run = session ? sessionRequestContexts.get(session) : undefined;
	return run ? run(fn) : fn();
}

type Callable = (...args: unknown[]) => unknown;

/**
 * `fn` as session work: each call runs through `run`, with the `this` and the arguments it was
 * called with. For a host function a session (or its manager or runner) keeps and calls later,
 * from whatever path triggers it: a model request the function starts waits for the session's
 * holds.
 */
export function asSessionWork<F extends (...args: never[]) => unknown>(run: SessionWorkRun, fn: F): F {
	const callable = fn as unknown as Callable;
	return function (this: unknown, ...args: unknown[]): unknown {
		return run(() => callable.apply(this, args));
	} as unknown as F;
}

/**
 * Whether reading or writing `key` on `target` runs host code: the member is an accessor, own or
 * inherited, or a proxy (whose traps are host code) stands on the way to it. A data property found
 * on ordinary objects does not.
 */
function accessRunsHostCode(target: object, key: PropertyKey): boolean {
	for (let next: object | null = target; next; next = Reflect.getPrototypeOf(next)) {
		if (types.isProxy(next)) return true;
		const descriptor = Reflect.getOwnPropertyDescriptor(next, key);
		if (descriptor) return !("value" in descriptor);
	}
	return false;
}

/**
 * `target` with every function it exposes run as session work through `run` (see
 * {@link asSessionWork}): own and inherited members, enumerable or not, read when they are read,
 * so a member the host replaces later is the one called. Reading or writing an accessor (a getter
 * or setter, own or inherited) runs as session work too, and so does every trap of a `target` that
 * is itself a proxy; a data property is read as is. Every other member, and every way of
 * inspecting the object (`in`, keys, descriptors, its prototype), passes through to `target`. A
 * member keeps one wrapper while its value is unchanged; called as a member of the result, it runs
 * on `target`, whose private fields the result lacks.
 */
export function membersAsSessionWork<T extends object>(run: SessionWorkRun, target: T): T {
	const wrappers = new Map<PropertyKey, { value: Callable; wrapper: Callable }>();
	// A proxy's traps are host code; checked once, as `target` stays the same object.
	const hostTarget = types.isProxy(target);
	const inspect = <R>(access: () => R): R => (hostTarget ? run(access) : access());
	const read = (key: PropertyKey): unknown => {
		const get = () => Reflect.get(target, key, target);
		const value: unknown = accessRunsHostCode(target, key) ? run(get) : get();
		if (typeof value !== "function") return value;
		const cached = wrappers.get(key);
		if (cached?.value === value) return cached.wrapper;
		const callable = value as Callable;
		const wrapper = function (this: unknown, ...args: unknown[]): unknown {
			const self = this === proxy ? target : this;
			return run(() => callable.apply(self, args));
		};
		wrappers.set(key, { value: callable, wrapper });
		return wrapper;
	};
	const write = (key: PropertyKey, value: unknown): boolean => {
		const set = () => Reflect.set(target, key, value);
		return accessRunsHostCode(target, key) ? run(set) : set();
	};
	// The proxy stands on an empty object rather than on `target`: a member `target` holds as
	// non-configurable and read-only (a `defineProperty` without flags) may not read as anything
	// but itself through a proxy of `target`, which would forbid its wrapper.
	const stand = Object.create(null) as T;
	const proxy: T = new Proxy(stand, {
		get: (_stand, key) => read(key),
		set: (_stand, key, value) => write(key, value),
		has: (_stand, key) => inspect(() => Reflect.has(target, key)),
		deleteProperty: (_stand, key) => inspect(() => Reflect.deleteProperty(target, key)),
		ownKeys: () => inspect(() => Reflect.ownKeys(target)),
		getOwnPropertyDescriptor(_stand, key) {
			const descriptor = inspect(() => Reflect.getOwnPropertyDescriptor(target, key));
			if (!descriptor) return undefined;
			// Reported configurable: the stand lacks the member, and a proxy may report a member
			// it lacks only as configurable.
			const reported: PropertyDescriptor = { ...descriptor, configurable: true };
			if ("value" in descriptor) reported.value = read(key);
			// An accessor reads and writes as the proxy's own members do.
			if (descriptor.get) reported.get = () => read(key);
			if (descriptor.set) reported.set = (value: unknown) => void write(key, value);
			return reported;
		},
		getPrototypeOf: () => inspect(() => Reflect.getPrototypeOf(target)),
	});
	return proxy;
}
