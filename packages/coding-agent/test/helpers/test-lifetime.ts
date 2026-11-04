import {
	afterAll as bunAfterAll,
	afterEach as bunAfterEach,
	beforeAll as bunBeforeAll,
	beforeEach as bunBeforeEach,
	onTestFinished as bunOnTestFinished,
	setDefaultTimeout as bunSetDefaultTimeout,
	test as bunTest,
	type Test,
} from "bun:test";
import { types } from "node:util";

/**
 * Tracked tests and hooks not yet seen settled, by the promise each returned, with its name. Bun
 * shares one module registry across the test files of a process, so this sees every tracked file
 * in it.
 */
const running = new Map<Promise<unknown>, string>();

/** The first tracked test or hook found to have outlived its timeout; it stays set. */
let timedOut: string | undefined;

/**
 * Note a timeout: a tracked test or hook still running as another one starts has outlived its
 * timeout. Teardown counts: a body still running as its test's first `afterEach` starts timed out,
 * even if it settles before the next test does.
 *
 * Settlement is read from the promise's own state (`Bun.peek.status`), as Bun's runner reads it:
 * subscribing through `then` would read properties a test can replace on its promise (`then`,
 * `constructor`, `Symbol.species`).
 */
function noteTimeout(): void {
	if (timedOut !== undefined) return;
	for (const [promise, name] of running) {
		if (Bun.peek.status(promise) !== "pending") {
			running.delete(promise);
			continue;
		}
		timedOut = name;
		return;
	}
}

/**
 * Refuse to start once a tracked test or hook has outlived its timeout.
 *
 * Bun does not stop a body that times out: it runs the test's teardown and starts the next test
 * while that body keeps running, so whatever the body does after its next `await` — a write to a
 * shared fixture, a spy, a process-wide cache, through any alias or helper — lands while teardown
 * and later tests run, and they can pass or fail on it. No test result after that point says
 * anything, so none is produced: every later tracked test fails at once with the name of the one
 * that timed out. Settling later does not lift this; what the body wrote by then stays written.
 */
function refuseAfterTimeout(): void {
	noteTimeout();
	if (timedOut !== undefined) {
		throw new Error(
			`"${timedOut}" timed out and may still be running; no test after it in this process can be trusted, so this one did not run`,
		);
	}
}

/**
 * Run a test or hook body, and keep the promise it returns in {@link running}. Any native promise
 * counts, also one from another realm (`node:vm`), which Bun awaits too.
 *
 * There is no deadline of this helper's own. Bun's deadline cannot be rebuilt from this thread:
 * its fake timers move every clock a test can read (`Bun.nanoseconds`, `performance.now`,
 * `Date.now`, `process.hrtime`, `process.uptime`), a test that blocks the thread delays an
 * `Atomics.waitAsync` wake past the write it was meant to catch, a clock kept in a worker has no
 * freshness bound against that worker being descheduled, and Bun does not report the timeout it
 * applied. Three rounds of building one produced both false refusals of healthy tests and missed
 * late writes, each measured. What stands is what Bun's own behaviour proves: Bun starts the next
 * phase only once it has given up on a body, so a body still pending at that moment timed out.
 */
function runTracked<T>(name: string, fn: (...args: unknown[]) => T, args: unknown[]): T {
	const result = fn(...args);
	if (types.isPromise(result)) running.set(result as Promise<unknown>, name);
	return result;
}

/**
 * Bun runs a test or hook whose function declares a parameter in callback style, and counts it done
 * when it calls `done`, not when it returns. A tracked body is a promise, or nothing: refuse the other.
 */
function refuseDoneCallback(kind: string, fn: (...args: never[]) => unknown): void {
	if (fn.length > 0) {
		throw new Error(`trackTestLifetime: a tracked ${kind} takes no \`done\` callback; return a promise instead`);
	}
}

type TestBody = (...args: unknown[]) => void | Promise<unknown>;
type AnyTest = Test<unknown[]>;
type Hook = typeof bunBeforeEach;

/** Test variants that run one test at a time, so a test still running when the next starts has timed out. */
const SERIAL_VARIANTS = ["only", "skip", "todo", "failing", "serial"] as const;
const SERIAL_CONDITIONS = ["if", "skipIf", "todoIf", "failingIf", "serialIf"] as const;

/**
 * The arguments a `.each` body receives per row: an array row is spread, any other row is one
 * argument. A body declaring more takes a `done` callback.
 */
function rowArity(row: unknown): number {
	return Array.isArray(row) ? row.length : 1;
}

/**
 * `rows` is the table of a `.each`, whose body takes its row as arguments; undefined for a plain
 * test.
 */
function trackTest(base: AnyTest, rows?: readonly unknown[]): AnyTest {
	const tracked = ((label: string, fn: TestBody | undefined, options?: number) => {
		// Registration happens as a file is evaluated: a tracked body of an earlier file that is
		// still running then has outlived its phase, and no later phase has started to see it.
		noteTimeout();
		// A bodyless `.todo` or `.skip` declares a test that never runs.
		if (typeof fn !== "function") return base(label, fn as never, options);
		const params = rows === undefined ? 0 : Math.min(...rows.map(rowArity));
		if (fn.length > params) {
			throw new Error("trackTestLifetime: a tracked test takes no `done` callback; return a promise instead");
		}
		return base(label, (...args: unknown[]) => runTracked(label, fn, args), options);
	}) as unknown as AnyTest;
	for (const variant of SERIAL_VARIANTS) {
		Object.defineProperty(tracked, variant, { get: () => trackTest(base[variant], rows) });
	}
	for (const condition of SERIAL_CONDITIONS) {
		Object.defineProperty(tracked, condition, {
			value: (when: boolean) => trackTest(base[condition](when), rows),
		});
	}
	Object.defineProperty(tracked, "each", {
		value: (table: readonly unknown[]) => trackTest(base.each(table as unknown[][]) as AnyTest, table),
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

/**
 * Whether the test that started last has reached its teardown. Bun runs a file's tests one at a
 * time unless told otherwise, and always starts a test's teardown before the next test starts.
 */
let lastTestTornDown = true;

/**
 * Start of a tracked test: refuse it when an earlier one timed out, and refuse it plainly when Bun
 * runs tests concurrently (`describe.concurrent`, `--concurrent`), where a body still running as
 * another test starts says nothing about a timeout.
 */
function startTest(): void {
	if (!lastTestTornDown) throw new Error(ONE_AT_A_TIME);
	lastTestTornDown = false;
	refuseAfterTimeout();
}

const ONE_AT_A_TIME =
	"trackTestLifetime: tracked files run their tests one at a time (no describe.concurrent, test.concurrent or --concurrent)";

/**
 * The start of a test's teardown: note a body still running then as timed out. Every tracked
 * `afterEach` and `onTestFinished` callback calls this first. A helper module that registers its
 * own `afterEach` in tracked files calls it first in that hook too: Bun runs a file's hooks in the
 * order they were registered, so a helper's runs before the file's own.
 */
export function noteTeardown(): void {
	lastTestTornDown = true;
	noteTimeout();
}

/** The test API of a tracked file. */
export interface TestLifetime {
	test: Test<[]>;
	it: Test<[]>;
	beforeEach: Hook;
	afterEach: Hook;
	beforeAll: Hook;
	afterAll: Hook;
	onTestFinished: typeof bunOnTestFinished;
	/** Bun's `setDefaultTimeout`, passed through so a tracked file takes its whole API from one place. */
	setDefaultTimeout: typeof bunSetDefaultTimeout;
}

/**
 * Declare a test file's tests and hooks so that no test result is produced on state a timed-out
 * body could have changed.
 *
 * Every test, hook and `onTestFinished` callback declared through the returned functions is tracked
 * until the promise it returns settles. One still running as any later tracked hook or test starts
 * — its own test's teardown included, and the registration of the next file's tests — timed out,
 * and every later test of every tracked file in the process fails before its setup with that
 * test's name (see {@link refuseAfterTimeout}). `afterEach`, `afterAll` and `onTestFinished`
 * callbacks still run, so a timed-out test's cleanup releases the processes and files it owns.
 *
 * The boundary, stated because it is not covered: a body Bun gave up on that settles while nothing
 * tracked is watching — during a later file's module setup, before that file registers — is not
 * caught, and its write can be read. Judging that case needs Bun's own deadline on real time, and
 * {@link runTracked} records what was measured about why this thread cannot have it. Calling
 * `trackTestLifetime()` at the top of a file, before any module-level `await`, keeps the gap shut
 * for that file, because registration then happens before the file waits for anything.
 *
 * Call once at file scope, before the file declares any hook, and take every test, hook and
 * `onTestFinished` from the result: the checks run in a `beforeEach` and an `afterEach` this
 * registers, at every registration, and at the start of every tracked hook and callback.
 */
export function trackTestLifetime(): TestLifetime {
	bunBeforeEach(startTest);
	bunAfterEach(noteTeardown);
	const test = trackTest(bunTest as AnyTest) as unknown as Test<[]>;
	const hook =
		(register: Hook, name: string, atStart: () => void): Hook =>
		(fn, options) => {
			noteTimeout();
			refuseDoneCallback(name.replace(/^an? /, ""), fn as (...args: never[]) => unknown);
			return register(() => {
				atStart();
				return runTracked(name, fn as () => unknown, []);
			}, options);
		};
	const onTestFinished: typeof bunOnTestFinished = (fn, options) => {
		noteTimeout();
		refuseDoneCallback("onTestFinished callback", fn as (...args: never[]) => unknown);
		return bunOnTestFinished(() => {
			noteTeardown();
			return runTracked("an onTestFinished callback", fn as () => unknown, []);
		}, options);
	};
	return {
		test,
		it: test,
		beforeEach: hook(bunBeforeEach, "a beforeEach hook", noteTimeout),
		afterEach: hook(bunAfterEach, "an afterEach hook", noteTeardown),
		beforeAll: hook(bunBeforeAll, "a beforeAll hook", refuseAfterTimeout),
		afterAll: hook(bunAfterAll, "an afterAll hook", noteTimeout),
		onTestFinished,
		setDefaultTimeout: bunSetDefaultTimeout,
	};
}
