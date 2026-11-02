import {
	afterAll as bunAfterAll,
	afterEach as bunAfterEach,
	beforeAll as bunBeforeAll,
	beforeEach as bunBeforeEach,
	onTestFinished,
	spyOn as bunSpyOn,
	test as bunTest,
	vi as bunVi,
	type Test,
} from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";

const RESUMED_AFTER_END = "this test body resumed after its test ended; it stopped before touching shared state";

/**
 * One phase's claim on shared state. A claim ends when the phase it covers ends, and never comes
 * back: code still running under it afterwards is code that outlived its phase.
 */
class Ownership {
	ended = false;
	end(): void {
		this.ended = true;
	}
}

/**
 * The claim of the code running now. `AsyncLocalStorage` carries it through every continuation the
 * code creates — an `await`, a `.then` callback, a timer, a helper's own awaits — so a body that
 * resumes after its test timed out still holds its own ended claim, not the next test's.
 */
const current = new AsyncLocalStorage<Ownership>();

/**
 * Whether the code running now may touch shared state: false only when it belongs to a phase that
 * already ended. Code outside every tracked phase (file scope, untracked files) holds no claim and
 * is live.
 */
export function isLive(): boolean {
	return current.getStore()?.ended !== true;
}

/** Throw if the code running now belongs to a phase that already ended (see {@link isLive}). */
export function assertLive(): void {
	if (!isLive()) throw new Error(RESUMED_AFTER_END);
}

/**
 * Run `fn` under `claim`, and end the claim the moment `fn` settles: whatever it scheduled and
 * left running is then code that outlived its phase.
 */
function runToSettle(claim: Ownership, fn: () => unknown): unknown {
	let result: unknown;
	try {
		result = current.run(claim, fn);
	} catch (error) {
		claim.end();
		throw error;
	}
	if (result instanceof Promise) return result.finally(() => claim.end());
	claim.end();
	return result;
}

type TestBody = (...args: unknown[]) => void | Promise<unknown>;
type AnyTest = Test<unknown[]>;
type Hook = typeof bunBeforeEach;

/** Test variants that keep one test running at a time, so "the running test" stays one claim. */
const SERIAL_VARIANTS = ["only", "skip", "todo", "failing", "serial"] as const;
const SERIAL_CONDITIONS = ["if", "skipIf", "todoIf", "failingIf", "serialIf"] as const;

function trackTest(base: AnyTest, claim: () => Ownership): AnyTest {
	const tracked = ((label: string, fn: TestBody, options?: number) =>
		base(label, (...args: unknown[]) => current.run(claim(), fn, ...args), options)) as unknown as AnyTest;
	for (const variant of SERIAL_VARIANTS) {
		Object.defineProperty(tracked, variant, { get: () => trackTest(base[variant], claim) });
	}
	for (const condition of SERIAL_CONDITIONS) {
		Object.defineProperty(tracked, condition, {
			value: (when: boolean) => trackTest(base[condition](when), claim),
		});
	}
	Object.defineProperty(tracked, "each", {
		value: (table: readonly unknown[]) => trackTest(base.each(table as unknown[][]) as AnyTest, claim),
	});
	for (const concurrent of ["concurrent", "concurrentIf"]) {
		Object.defineProperty(tracked, concurrent, {
			get: () => {
				throw new Error("trackTestLifetime: concurrent tests share one claim; run them serially");
			},
		});
	}
	return tracked;
}

/** The test API of a tracked file: every test and hook runs under its phase's claim. */
export interface TestLifetime {
	test: Test<[]>;
	it: Test<[]>;
	beforeEach: Hook;
	afterEach: Hook;
	beforeAll: Hook;
	afterAll: Hook;
}

/**
 * Track every phase of a whole test file, so that no test body or hook writes shared state after
 * its phase ended.
 *
 * A body or hook that times out keeps running: everything it does after its next `await` happens
 * during whatever runs next. Declare every test and hook with the functions this returns, and give
 * {@link guard} everything another test can reach. Stale code then throws at its first touch of
 * shared state, wherever that touch is — straight after the await, in a helper, in a `.then`
 * callback, through an alias taken before the await — because the claim it carries is checked,
 * not where the code stands.
 *
 * The claims, in the order a file runs them:
 * - each `beforeAll` and `afterAll` call holds its own claim, which ends when that hook settles,
 *   or when the next test or suite hook starts if it timed out;
 * - a test's `beforeEach` hooks and body share one claim, which ends when its teardown starts;
 * - each `afterEach` call holds its own claim, which ends when that hook settles, and at the latest
 *   when the test finishes or the next test starts.
 *
 * Call once, at file scope, before the file declares any hook: the `beforeEach` this registers then
 * runs outermost, ahead of every `beforeEach` of the file.
 */
export function trackTestLifetime(): TestLifetime {
	let run: Ownership | undefined;
	const teardowns = new Set<Ownership>();
	const suiteHooks = new Set<Ownership>();
	const endAll = (claims: Set<Ownership>): void => {
		for (const claim of claims) claim.end();
		claims.clear();
	};
	const runClaim = (): Ownership => {
		if (run === undefined || run.ended) {
			endAll(teardowns);
			endAll(suiteHooks);
			run = new Ownership();
		}
		return run;
	};
	const teardownClaim = (): Ownership => {
		run?.end();
		const claim = new Ownership();
		teardowns.add(claim);
		return claim;
	};
	const suiteHookClaim = (): Ownership => {
		run?.end();
		endAll(teardowns);
		endAll(suiteHooks);
		const claim = new Ownership();
		suiteHooks.add(claim);
		return claim;
	};
	bunBeforeEach(() => {
		runClaim();
		onTestFinished(() => endAll(teardowns));
	});
	// A tracked `afterEach` ends the run as it starts; this one ends it in files with no hook of their own.
	bunAfterEach(() => run?.end());
	bunAfterAll(() => {
		run?.end();
		endAll(teardowns);
		endAll(suiteHooks);
	});
	const test = trackTest(bunTest as AnyTest, runClaim) as unknown as Test<[]>;
	const hook =
		(register: Hook, claim: () => Ownership, toSettle: boolean): Hook =>
		(fn, options) =>
			register(() => {
				const owner = claim();
				const body = fn as () => unknown;
				return toSettle ? runToSettle(owner, body) : current.run(owner, body);
			}, options);
	return {
		test,
		it: test,
		beforeEach: hook(bunBeforeEach, runClaim, false),
		afterEach: hook(bunAfterEach, teardownClaim, true),
		beforeAll: hook(bunBeforeAll, suiteHookClaim, true),
		afterAll: hook(bunAfterAll, suiteHookClaim, true),
	};
}

/** Guard → the object it guards. */
const guardedTarget = new WeakMap<object, object>();
/** Guards whose methods must run on the object itself, which keeps private fields and internal slots reachable. */
const methodReceivers = new WeakSet<object>();
/** Object → its strict guard, and object → its data view, so each object has one of each. */
const strictGuardOf = new WeakMap<object, object>();
const dataViewOf = new WeakMap<object, object>();

/** Plain data: an array, or an object of plain prototype with no function property. */
function isPlainData(value: object): boolean {
	if (typeof value === "function") return false;
	const proto = Object.getPrototypeOf(value);
	if (proto === Array.prototype) return true;
	if (proto !== Object.prototype && proto !== null) return false;
	return !Object.values(value).some(entry => typeof entry === "function");
}

/** Values a guard hands out as they are: primitives, mocks, and promises (whose results it guards instead). */
function passesThrough(value: unknown): boolean {
	if ((typeof value !== "object" && typeof value !== "function") || value === null) return true;
	if (typeof value === "function" && "mock" in value) return true;
	return value instanceof Promise;
}

/** Writes through any guard check the caller's claim; this is what keeps a stale write out. */
const writeTraps: ProxyHandler<object> = {
	set(target, key, value) {
		assertLive();
		return Reflect.set(target, key, value, target);
	},
	defineProperty(target, key, descriptor) {
		assertLive();
		return Reflect.defineProperty(target, key, descriptor);
	},
	deleteProperty(target, key) {
		assertLive();
		return Reflect.deleteProperty(target, key);
	},
	setPrototypeOf(target, proto) {
		assertLive();
		return Reflect.setPrototypeOf(target, proto);
	},
};

function readThrough(target: object, key: string | symbol): unknown {
	const value = Reflect.get(target, key, target);
	const own = Reflect.getOwnPropertyDescriptor(target, key);
	// A proxy must return a non-configurable, read-only property exactly as stored.
	if (own && !own.configurable && !own.writable && "value" in own) return value;
	return protect(value);
}

/**
 * A strict guard checks the caller's claim on every operation, reads included, so stale code stops
 * at its first touch. Method calls run with the receiver the object needs, and their results come
 * back guarded too.
 */
const strictHandler: ProxyHandler<object> = {
	...writeTraps,
	get(target, key) {
		assertLive();
		return readThrough(target, key);
	},
	apply(target, thisArg, args) {
		assertLive();
		const self =
			typeof thisArg === "object" && thisArg !== null && methodReceivers.has(thisArg)
				? guardedTarget.get(thisArg)
				: thisArg;
		return protectResult(Reflect.apply(target as (...args: unknown[]) => unknown, self, args));
	},
	construct(target, args, newTarget) {
		assertLive();
		const constructor = target as new (...args: unknown[]) => object;
		return Reflect.construct(constructor, args, guardedTarget.get(newTarget) === target ? constructor : newTarget);
	},
};

/**
 * A data view lets anyone read and checks only writes: plain data reached through a guard (an
 * array a method returned, a model in a registry's cache, a nested options object) may be read late
 * harmlessly, but a stale write to it would land in state the next test reads.
 */
const dataHandler: ProxyHandler<object> = {
	...writeTraps,
	get(target, key) {
		return readThrough(target, key);
	},
};

function wrap<T extends object>(value: T, strict: boolean): T {
	const cache = strict ? strictGuardOf : dataViewOf;
	let guarded = cache.get(value);
	if (!guarded) {
		guarded = new Proxy(value, strict ? strictHandler : dataHandler);
		cache.set(value, guarded);
		guardedTarget.set(guarded, value);
		if (!isPlainData(value)) methodReceivers.add(guarded);
	}
	return guarded as T;
}

/**
 * Guard what a guard hands out: objects with behaviour get a strict guard, plain data a data view.
 * Without this, an alias to a cached array or model taken through a guard escapes every check.
 */
function protect<T>(value: T): T {
	if (passesThrough(value) || guardedTarget.has(value as object)) return value;
	const object = value as T & object;
	return wrap(object, !isPlainData(object));
}

function protectResult(result: unknown): unknown {
	return result instanceof Promise ? result.then(protect) : protect(result);
}

/**
 * The guarded setter for shared state. It checks first that the code running now still owns its
 * phase, then returns `value` guarded strictly: every later read, write, method call or property
 * definition on it makes the same check against the claim of whoever does it, and everything it
 * hands out — properties, method results, resolved promise values — is guarded in turn.
 *
 * Give it every value another test can reach, as you store it: a file-scope or describe-level
 * fixture (`authStorage = guard(await AuthStorage.create(…))`), each test's `session`, and any
 * shared collection. Assigning through it guards the binding write too, since the check runs
 * before the assignment. A primitive comes back as it is, after the check.
 */
export function guard<T>(value: T): T {
	assertLive();
	if (passesThrough(value)) return value;
	const object = value as T & object;
	const target = (guardedTarget.get(object) as (T & object) | undefined) ?? object;
	return wrap(target, true);
}

/** Call-checked function or class → the function or class itself. */
const callCheckedTarget = new WeakMap<object, object>();
/** Function or class → its call-checked stand-in, and namespace → its call-checked view. */
const callCheckedOf = new WeakMap<object, object>();

/**
 * A function or class whose every call and construction checks the caller's claim first. Its
 * results come back as they are: what a factory builds belongs to the caller. Statics read
 * through it are call-checked too, and run on the class itself, so static private fields work.
 */
const callCheckHandler: ProxyHandler<object> = {
	get(target, key) {
		const value = Reflect.get(target, key, target);
		const own = Reflect.getOwnPropertyDescriptor(target, key);
		if (own && !own.configurable && !own.writable && "value" in own) return value;
		return typeof value === "function" && !("mock" in value) ? callChecked(value) : value;
	},
	apply(target, thisArg, args) {
		assertLive();
		const self =
			(typeof thisArg === "object" || typeof thisArg === "function") && thisArg !== null
				? (callCheckedTarget.get(thisArg) ?? thisArg)
				: thisArg;
		return Reflect.apply(target as (...args: unknown[]) => unknown, self, args);
	},
	construct(target, args, newTarget) {
		assertLive();
		const constructor = target as new (...args: unknown[]) => object;
		return Reflect.construct(
			constructor,
			args,
			callCheckedTarget.get(newTarget) === target ? constructor : newTarget,
		);
	},
};

function callChecked<T extends object>(value: T): T {
	let checked = callCheckedOf.get(value);
	if (!checked) {
		checked = new Proxy(value, callCheckHandler);
		callCheckedOf.set(value, checked);
		callCheckedTarget.set(checked, value);
	}
	return checked as T;
}

/**
 * Call-checked access to a module whose functions or classes change process-wide state: a cache,
 * a registry, a list of live instances (`Settings` remembers every instance it builds). Every
 * function and class read through the result checks the caller's claim on each call and each
 * `new`, from wherever the call comes; what it returns is the caller's, unguarded. Use it where a
 * guarded result would differ from the real one — an instance that production code also holds
 * as itself — and {@link guard} for shared objects.
 *
 * `const { Settings } = checkCalls(settingsModule);` — and, where the file also needs the type,
 * `type Settings = settingsModule.Settings;`.
 */
export function checkCalls<T extends object>(namespace: T): T {
	let checked = callCheckedOf.get(namespace);
	if (!checked) {
		checked = new Proxy(namespace, {
			get(target, key) {
				const value = Reflect.get(target, key, target);
				return typeof value === "function" && !("mock" in value) ? callChecked(value) : value;
			},
		});
		callCheckedOf.set(namespace, checked);
	}
	return checked as T;
}

/** The object a guard or a call check stands for; anything else unchanged. */
function unguarded<T>(value: T): T {
	if ((typeof value !== "object" && typeof value !== "function") || value === null) return value;
	return ((guardedTarget.get(value) ?? callCheckedTarget.get(value)) as T | undefined) ?? value;
}

/**
 * `spyOn` that installs only for a live caller, on the object itself when given its guard: Bun's
 * `spyOn` installs nothing through a proxy. A spy passes calls through to the original method on
 * the object itself, because the caller may hold the guard, and a method reaches its private
 * fields only through the object.
 */
export const spyOn: typeof bunSpyOn = (obj, key) => {
	assertLive();
	const target = unguarded(obj);
	const original: unknown = Reflect.get(target, key, target);
	const spy = bunSpyOn(target, key);
	if (typeof original === "function") {
		spy.mockImplementation(function (this: unknown, ...args: unknown[]) {
			return Reflect.apply(original, unguarded(this), args);
		} as never);
	}
	return spy;
};

/**
 * Bun's `vi`, with every installation, restore and timer change checked against the caller's
 * claim: a spy a stale body installs after `vi.restoreAllMocks()` would otherwise stay installed
 * for every later test.
 */
export const vi: typeof bunVi = Object.fromEntries(
	Object.entries(bunVi).map(([name, fn]) => [
		name,
		name === "spyOn"
			? spyOn
			: (...args: unknown[]) => {
					assertLive();
					return (fn as (...args: unknown[]) => unknown)(...args);
				},
	]),
) as typeof bunVi;
