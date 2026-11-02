import {
	afterAll as bunAfterAll,
	afterEach as bunAfterEach,
	beforeEach as bunBeforeEach,
	spyOn as bunSpyOn,
	test as bunTest,
	vi as bunVi,
	type Test,
} from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";

const RESUMED_AFTER_END = "this test body resumed after its test ended; it stopped before touching shared state";

/**
 * One test's claim on shared state: its setup and body hold one, its teardown another. A claim
 * ends when the phase it covers ends, and never comes back.
 */
class Ownership {
	ended = false;
}

/**
 * The claim of the code running now. `AsyncLocalStorage` carries it through every continuation the
 * code creates — an `await`, a `.then` callback, a timer, a helper's own awaits — so a body that
 * resumes after its test timed out still holds its own ended claim, not the next test's.
 */
const current = new AsyncLocalStorage<Ownership>();

/**
 * Whether the code running now may touch shared state: false only when it belongs to a test
 * phase that already ended. Code outside any tracked test (file scope, `beforeAll`, `afterAll`,
 * untracked files) holds no claim and is live.
 */
export function isLive(): boolean {
	return current.getStore()?.ended !== true;
}

/** Throw if the code running now belongs to a test phase that already ended (see {@link isLive}). */
export function assertLive(): void {
	if (!isLive()) throw new Error(RESUMED_AFTER_END);
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

/** The test API of a tracked file: every test and per-test hook runs under its test's claim. */
export interface TestLifetime {
	test: Test<[]>;
	it: Test<[]>;
	beforeEach: Hook;
	afterEach: Hook;
}

/**
 * Track test runs for a whole test file, so that no test body writes shared state after its
 * test ended.
 *
 * A body that times out keeps running: everything it does after its next `await` happens during
 * the next test. Declare every test and per-test hook with the functions this returns, and give
 * {@link guard} everything another test can reach. A stale body then throws at its first touch of
 * shared state, wherever that touch is — straight after the await, in a helper, in a `.then`
 * callback, through an alias taken before the await — because the claim it carries is checked,
 * not where the code stands.
 *
 * Call once, at file scope, before the file declares any hook: the `beforeEach` and `afterEach`
 * this registers then run outermost, so a claim covers a test from before its setup to the start
 * of its teardown.
 */
export function trackTestLifetime(): TestLifetime {
	let run: Ownership | undefined;
	let teardown: Ownership | undefined;
	const setupClaim = (): Ownership => {
		if (run === undefined || run.ended) {
			if (teardown) teardown.ended = true;
			teardown = undefined;
			run = new Ownership();
		}
		return run;
	};
	const teardownClaim = (): Ownership => {
		if (run && !run.ended) {
			run.ended = true;
			teardown = new Ownership();
		}
		teardown ??= new Ownership();
		return teardown;
	};
	bunBeforeEach(setupClaim);
	bunAfterEach(teardownClaim);
	bunAfterAll(() => {
		teardownClaim().ended = true;
	});
	const test = trackTest(bunTest as AnyTest, setupClaim) as unknown as Test<[]>;
	return {
		test,
		it: test,
		beforeEach: (fn, options) => bunBeforeEach(() => current.run(setupClaim(), fn as () => unknown), options),
		afterEach: (fn, options) => bunAfterEach(() => current.run(teardownClaim(), fn as () => unknown), options),
	};
}

/** Guarded object → the object it guards. */
const guardedTarget = new WeakMap<object, object>();
/** Object → its guard, so one object always has one guard and identity checks keep working. */
const guardOf = new WeakMap<object, object>();

/** A plain object holds state worth guarding when it carries behaviour: a function property. */
function holdsState(value: object): boolean {
	if (typeof value === "function") return !("mock" in value);
	if (value instanceof Promise) return false;
	const proto = Object.getPrototypeOf(value);
	if (proto === Array.prototype) return false;
	if (proto !== Object.prototype && proto !== null) return true;
	return Object.values(value).some(entry => typeof entry === "function");
}

const guardHandler: ProxyHandler<object> = {
	get(target, key) {
		assertLive();
		const value = Reflect.get(target, key, target);
		const own = Reflect.getOwnPropertyDescriptor(target, key);
		// A proxy must return a non-configurable, read-only property exactly as stored.
		if (own && !own.configurable && !own.writable && "value" in own) return value;
		const isReference = (typeof value === "object" && value !== null) || typeof value === "function";
		return isReference && holdsState(value) ? wrap(value) : value;
	},
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
	apply(target, thisArg, args) {
		assertLive();
		// Methods run on the object itself: its private fields are not reachable through a proxy.
		const self = typeof thisArg === "object" && thisArg !== null ? (guardedTarget.get(thisArg) ?? thisArg) : thisArg;
		return Reflect.apply(target as (...args: unknown[]) => unknown, self, args);
	},
	construct(target, args, newTarget) {
		assertLive();
		const constructor = target as new (...args: unknown[]) => object;
		return Reflect.construct(constructor, args, guardedTarget.get(newTarget) === target ? constructor : newTarget);
	},
};

function wrap<T extends object>(value: T): T {
	if (guardedTarget.has(value)) return value;
	let guarded = guardOf.get(value);
	if (!guarded) {
		guarded = new Proxy(value, guardHandler);
		guardOf.set(value, guarded);
		guardedTarget.set(guarded, value);
	}
	return guarded as T;
}

/**
 * The guarded setter for shared state. It checks first that the code running now still owns its
 * test, then returns `value` guarded: every later read, write, method call or property definition
 * on it, at any depth, makes the same check against the claim of whoever does it.
 *
 * Give it every value another test can reach, as you store it: a file-scope or describe-level
 * fixture (`authStorage = guard(await AuthStorage.create(…))`), each test's `session`, and any
 * shared collection. Assigning through it guards the binding write too, since the check runs
 * before the assignment. A primitive comes back as it is, after the check.
 */
export function guard<T>(value: T): T {
	assertLive();
	if ((typeof value !== "object" && typeof value !== "function") || value === null) return value;
	return wrap(value as T & object);
}

/** The object a guard stands for; anything else unchanged. */
function unguarded<T>(value: T): T {
	return typeof value === "object" && value !== null ? ((guardedTarget.get(value) as T | undefined) ?? value) : value;
}

/**
 * `spyOn` that installs only for a live test, on the object itself when given its guard: Bun's
 * `spyOn` installs nothing through a proxy. A spy passes calls through to the original method
 * on the object itself, because the caller may hold the guard, and a method reaches its private
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
