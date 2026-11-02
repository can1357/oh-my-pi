import { vi } from "bun:test";
import { scheduler } from "node:timers/promises";

/**
 * Take both clocks a retry loop reads and advance them only by the waits it makes.
 *
 * `Date.now()` and `performance.now()` freeze at the values they had when this was called, and
 * each mocked `scheduler.wait(ms)` adds exactly `ms` to both. Real time spent inside the test
 * then changes nothing a deadline is compared against: a test that parks a credential for 2 s or
 * reads a 30 s failure window gets the same answer on an idle machine and on a loaded one. Any
 * deadline the test establishes from a clock — a `retryAfterMs`, a `resetsAt`, a `Date.now()`
 * sum — must be established after this call, or the real time between the two drifts into it.
 *
 * Throws when `performance.now` is already mocked: spying on it again would make the new clock
 * read itself, and the next clock read would fail with `RangeError: Maximum call stack size
 * exceeded`. Restore with `vi.restoreAllMocks()` in `afterEach`; a restore inside a test body
 * does not run when the test times out.
 */
export function mockSchedulerWaitWithClock() {
	if ("_isMockFunction" in performance.now) {
		throw new Error(
			"mockSchedulerWaitWithClock: performance.now is already mocked, by an earlier installation or another spy that was not restored. Restore with vi.restoreAllMocks() in afterEach: a restore inside a test body does not run when the test times out.",
		);
	}
	// Freeze the monotonic base on a multiple of 1/1024 ms, rounded up. A raw base such as
	// 5536.18 has no exact binary form, so `(base + 60_000) - base` reads 59999.99999999999 and a
	// test comparing elapsed virtual time with the waits it made fails on float rounding. Adding a
	// whole number of milliseconds to a base with ten binary fraction digits is exact, so every
	// difference of two readings equals the waits between them. Rounding up, by under a
	// microsecond, keeps the frozen clock at or after the real one it replaces: a monotonic clock
	// must never read earlier than a value someone took before this call.
	const monotonicBase = Math.ceil(performance.now() * 1024) / 1024;
	const wallBase = Date.now();
	let advancedMs = 0;
	vi.spyOn(performance, "now").mockImplementation(() => monotonicBase + advancedMs);
	if (!("mock" in Date.now)) {
		vi.spyOn(Date, "now").mockImplementation(() => Math.floor(wallBase + advancedMs));
	}
	return vi.spyOn(scheduler, "wait").mockImplementation(async (delayMs, options) => {
		options?.signal?.throwIfAborted();
		advancedMs += delayMs;
		options?.signal?.throwIfAborted();
	});
}
