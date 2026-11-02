import {
	afterAll as bunAfterAll,
	afterEach as bunAfterEach,
	beforeAll as bunBeforeAll,
	beforeEach as bunBeforeEach,
	test as bunTest,
	type Test,
} from "bun:test";

/**
 * Tests and hooks of tracked files that have not settled yet, each with its name. Bun shares one
 * module registry across the test files of a process, so this sees every tracked file in it.
 */
const unsettled = new Map<object, string>();

/** The first tracked test or hook found still running when a later one started; it stays set. */
let timedOut: string | undefined;

/**
 * Refuse to start once a tracked test or hook has outlived its timeout.
 *
 * Bun does not stop a body that times out: it starts the next test while that body keeps running,
 * so whatever the body does after its next `await` — a write to a shared fixture, a spy, a
 * process-wide cache, through any alias or helper — lands while later tests run, and they can pass
 * or fail on it. No test result after that point says anything, so none is produced: every later
 * tracked test fails at once with the name of the one that timed out. Settling later does not lift
 * this; what the body wrote by then stays written.
 */
function refuseAfterTimeout(): void {
	if (timedOut === undefined) {
		for (const name of unsettled.values()) {
			timedOut = name;
			break;
		}
	}
	if (timedOut !== undefined) {
		throw new Error(
			`"${timedOut}" timed out and may still be running; no test after it in this process can be trusted, so this one did not run`,
		);
	}
}

/** Run a test or hook body, and keep it in {@link unsettled} until the promise it returns settles. */
function runTracked<T>(name: string, fn: (...args: unknown[]) => T, args: unknown[]): T {
	const result = fn(...args);
	if (result instanceof Promise) {
		const entry = {};
		unsettled.set(entry, name);
		const settle = (): void => {
			unsettled.delete(entry);
		};
		result.then(settle, settle);
	}
	return result;
}

type TestBody = (...args: unknown[]) => void | Promise<unknown>;
type AnyTest = Test<unknown[]>;
type Hook = typeof bunBeforeEach;

/** Test variants that run one test at a time, so a test still running when the next starts has timed out. */
const SERIAL_VARIANTS = ["only", "skip", "todo", "failing", "serial"] as const;
const SERIAL_CONDITIONS = ["if", "skipIf", "todoIf", "failingIf", "serialIf"] as const;

function trackTest(base: AnyTest): AnyTest {
	const tracked = ((label: string, fn: TestBody, options?: number) =>
		base(label, (...args: unknown[]) => runTracked(label, fn, args), options)) as unknown as AnyTest;
	for (const variant of SERIAL_VARIANTS) {
		Object.defineProperty(tracked, variant, { get: () => trackTest(base[variant]) });
	}
	for (const condition of SERIAL_CONDITIONS) {
		Object.defineProperty(tracked, condition, {
			value: (when: boolean) => trackTest(base[condition](when)),
		});
	}
	Object.defineProperty(tracked, "each", {
		value: (table: readonly unknown[]) => trackTest(base.each(table as unknown[][]) as AnyTest),
	});
	for (const concurrent of ["concurrent", "concurrentIf"]) {
		Object.defineProperty(tracked, concurrent, {
			get: () => {
				throw new Error("trackTestLifetime: a tracked file runs its tests one at a time");
			},
		});
	}
	return tracked;
}

/** The test API of a tracked file. */
export interface TestLifetime {
	test: Test<[]>;
	it: Test<[]>;
	beforeEach: Hook;
	afterEach: Hook;
	beforeAll: Hook;
	afterAll: Hook;
}

/**
 * Declare a test file's tests and hooks so that no test result is produced on state a timed-out
 * body could have changed.
 *
 * Every test and hook declared through the returned functions is tracked until the promise it
 * returns settles. When one is still running as a later test or `beforeAll` starts, it timed out,
 * and every later test of every tracked file in the process fails before its setup with that
 * test's name (see {@link refuseAfterTimeout}). `afterEach` and `afterAll` hooks still run, so a
 * timed-out test's cleanup releases the processes and files it owns.
 *
 * Call once at file scope, before the file declares any hook, and take every test and hook from
 * the result: the check runs in a `beforeEach` this registers first, ahead of the file's own.
 */
export function trackTestLifetime(): TestLifetime {
	bunBeforeEach(refuseAfterTimeout);
	const test = trackTest(bunTest as AnyTest) as unknown as Test<[]>;
	const hook =
		(register: Hook, name: string, refuse: boolean): Hook =>
		(fn, options) =>
			register(() => {
				if (refuse) refuseAfterTimeout();
				return runTracked(name, fn as () => unknown, []);
			}, options);
	return {
		test,
		it: test,
		beforeEach: hook(bunBeforeEach, "a beforeEach hook", false),
		afterEach: hook(bunAfterEach, "an afterEach hook", false),
		beforeAll: hook(bunBeforeAll, "a beforeAll hook", true),
		afterAll: hook(bunAfterAll, "an afterAll hook", false),
	};
}
