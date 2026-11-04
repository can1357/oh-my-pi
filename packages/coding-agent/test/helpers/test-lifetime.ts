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
import * as fs from "node:fs";
import { types } from "node:util";

/**
 * Tracked tests and hooks not yet seen settled, by the promise each returned: its name, and the
 * real time by which it must settle, where it has one. Bun shares one module registry across the
 * test files of a process, so this sees every tracked file in it.
 */
const running = new Map<Promise<unknown>, { name: string; deadline: number | undefined }>();

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
	for (const [promise, body] of running) {
		if (Bun.peek.status(promise) !== "pending") {
			running.delete(promise);
			continue;
		}
		timedOut = body.name;
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

/** The words of this process's own command line, which carries the test flags Bun keeps out of `Bun.argv`. */
function ownCommandLine(): string[] | undefined {
	try {
		return fs.readFileSync("/proc/self/cmdline", "utf8").split("\0");
	} catch {
		// No /proc (macOS, BSD): `ps` prints the same words, space-joined (measured).
		const ps = Bun.spawnSync(["ps", "-ww", "-o", "args=", "-p", String(process.pid)]);
		if (!ps.success) return undefined;
		const line = new TextDecoder().decode(ps.stdout).trim();
		return line === "" ? undefined : line.split(" ");
	}
}

/**
 * The process's default timeout of tests and hooks: the last `bun test --timeout <ms>` of the
 * process's own command line, which is the one Bun applies. Else Bun's own 5000. Undefined only
 * where the command line cannot be read at all, which leaves default-timeout bodies to the phase
 * checks alone.
 *
 * `bunfig.toml`'s `[test] timeout` is deliberately not read: Bun 1.4.4 does not apply it (measured:
 * a 400 ms test passes under `[test] timeout=100`), so honouring it here would refuse healthy tests.
 * A file changes its own default with the tracked {@link TestLifetime.setDefaultTimeout}.
 */
const processDefaultTimeoutMs: number | undefined = (() => {
	const argv = ownCommandLine();
	if (argv === undefined) return undefined;
	let timeout = 5000;
	for (const [index, arg] of argv.entries()) {
		const value = arg === "--timeout" ? argv[index + 1] : arg.startsWith("--timeout=") ? arg.slice(10) : undefined;
		// Bun takes the last of repeated flags (measured), so keep looking.
		if (value !== undefined && Number.isFinite(Number(value))) timeout = Number(value);
	}
	return timeout;
})();

/** The timeout Bun applies to a test or hook declared with `options` while its file's default is `fileDefault`. */
function timeoutOf(options: unknown, fileDefault: number | undefined): number | undefined {
	if (typeof options === "number") return options;
	if (typeof options === "object" && options !== null && "timeout" in options && typeof options.timeout === "number") {
		return options.timeout;
	}
	return fileDefault;
}

/**
 * Real time in milliseconds, from a worker that keeps it (see `./test-lifetime-clock`). No clock
 * of this thread serves: Bun's fake timers move every one a test can read — `Bun.nanoseconds`,
 * `performance.now`, `Date.now`, `process.hrtime`, `process.uptime` (measured) — and a test that
 * blocks the thread stops its timers and delays an `Atomics.waitAsync` wake past a late write
 * (measured: a 50 ms wake arrived after a 200 ms body, both released by one 600 ms block).
 *
 * Zero until the worker's first tick, and zero for good where no worker can start, which arms no
 * deadline and leaves the phase checks to stand alone: never a refusal of a healthy test.
 */
const realTimeMs: () => number = (() => {
	try {
		const buffer = new SharedArrayBuffer(8);
		const cell = new Int32Array(buffer);
		const worker = new Worker(new URL("./test-lifetime-clock.ts", import.meta.url).href, { type: "module" });
		worker.unref();
		worker.postMessage(buffer);
		// The first tick, so that a body entered right away is timed from a live clock.
		Atomics.wait(cell, 1, 0, 5000);
		return () => Atomics.load(cell, 0);
	} catch {
		return () => 0;
	}
})();

/** A tick of the clock, as slack: a deadline is past only when the clock has gone beyond it. */
const CLOCK_TICK_MS = 2;

/** The native `then`, taken before any test runs: a test may replace its own promise's `then`. */
const nativeThen = Promise.prototype.then;

/**
 * Run a test or hook body, and keep the promise it returns in {@link running}. Any native promise
 * counts, also one from another realm (`node:vm`), which Bun awaits too.
 *
 * A body that settles later than Bun's deadline for it has timed out, even where nothing observed
 * it pending: Bun gives up at the deadline and runs on, and the body may settle while no tracked
 * test or hook is watching (during the next file's module setup, say, which can block this thread
 * for longer than the deadline). The clock starts as the body is entered, as Bun's deadline does,
 * so synchronous work before its first `await` counts.
 */
function runTracked<T>(name: string, fn: (...args: unknown[]) => T, args: unknown[], timeoutMs?: number): T {
	const armed = timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0;
	const deadline = armed ? realTimeMs() + (timeoutMs as number) + CLOCK_TICK_MS : undefined;
	const result = fn(...args);
	if (types.isPromise(result)) {
		const promise = result as Promise<unknown>;
		running.set(promise, { name, deadline });
		if (deadline !== undefined) {
			const noteIfLate = (): void => {
				if (timedOut === undefined && realTimeMs() > deadline) timedOut = name;
			};
			try {
				void nativeThen.call(promise, noteIfLate, noteIfLate);
			} catch {
				// A promise whose native `then` refuses it: the phase checks still cover it.
			}
		}
	}
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
 * test. `fileDefault` is the file's default timeout as of each registration, which is when Bun
 * applies `setDefaultTimeout`.
 */
function trackTest(base: AnyTest, fileDefault: () => number | undefined, rows?: readonly unknown[]): AnyTest {
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
		const timeoutMs = timeoutOf(options, fileDefault());
		return base(label, (...args: unknown[]) => runTracked(label, fn, args, timeoutMs), options);
	}) as unknown as AnyTest;
	for (const variant of SERIAL_VARIANTS) {
		Object.defineProperty(tracked, variant, { get: () => trackTest(base[variant], fileDefault, rows) });
	}
	for (const condition of SERIAL_CONDITIONS) {
		Object.defineProperty(tracked, condition, {
			value: (when: boolean) => trackTest(base[condition](when), fileDefault, rows),
		});
	}
	Object.defineProperty(tracked, "each", {
		value: (table: readonly unknown[]) => trackTest(base.each(table as unknown[][]) as AnyTest, fileDefault, table),
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
	/** Bun's `setDefaultTimeout` for this file, which tracked tests and hooks registered after it time out by too. */
	setDefaultTimeout: typeof bunSetDefaultTimeout;
}

/**
 * Declare a test file's tests and hooks so that no test result is produced on state a timed-out
 * body could have changed.
 *
 * Every test, hook and `onTestFinished` callback declared through the returned functions is tracked
 * until the promise it returns settles. One still pending at its deadline (its own timeout, else the
 * file's default), or still running as any later hook or test starts — its own test's teardown
 * included — timed out, and every later test of every tracked file in the process fails before its
 * setup with that test's name (see {@link refuseAfterTimeout}). `afterEach`, `afterAll` and
 * `onTestFinished` callbacks still run, so a timed-out test's cleanup releases the processes and
 * files it owns.
 *
 * Call once at file scope, before the file declares any hook, and take every test, hook,
 * `onTestFinished` and `setDefaultTimeout` from the result: the checks run in a `beforeEach` and an
 * `afterEach` this registers, at the start of every tracked hook and callback, and at each tracked
 * body's deadline.
 */
export function trackTestLifetime(): TestLifetime {
	bunBeforeEach(startTest);
	bunAfterEach(noteTeardown);
	let fileDefaultMs = processDefaultTimeoutMs;
	const fileDefault = () => fileDefaultMs;
	const test = trackTest(bunTest as AnyTest, fileDefault) as unknown as Test<[]>;
	const hook =
		(register: Hook, name: string, atStart: () => void): Hook =>
		(fn, options) => {
			noteTimeout();
			refuseDoneCallback(name.replace(/^an? /, ""), fn as (...args: never[]) => unknown);
			const timeoutMs = timeoutOf(options, fileDefaultMs);
			return register(() => {
				atStart();
				return runTracked(name, fn as () => unknown, [], timeoutMs);
			}, options);
		};
	const onTestFinished: typeof bunOnTestFinished = (fn, options) => {
		noteTimeout();
		refuseDoneCallback("onTestFinished callback", fn as (...args: never[]) => unknown);
		const timeoutMs = timeoutOf(options, fileDefaultMs);
		return bunOnTestFinished(() => {
			noteTeardown();
			return runTracked("an onTestFinished callback", fn as () => unknown, [], timeoutMs);
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
		setDefaultTimeout: milliseconds => {
			bunSetDefaultTimeout(milliseconds);
			fileDefaultMs = milliseconds;
		},
	};
}
