import { vi } from "bun:test";
import { scheduler } from "node:timers/promises";

/**
 * Advance scheduler clocks, preserving a wall clock already controlled by the caller.
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
	const now = performance.now.bind(performance);
	const wallNow = Date.now.bind(Date);
	let advancedMs = 0;
	vi.spyOn(performance, "now").mockImplementation(() => now() + advancedMs);
	if (!("mock" in Date.now)) {
		vi.spyOn(Date, "now").mockImplementation(() => Math.floor(wallNow() + advancedMs));
	}
	return vi.spyOn(scheduler, "wait").mockImplementation(async (delayMs, options) => {
		options?.signal?.throwIfAborted();
		advancedMs += delayMs;
		options?.signal?.throwIfAborted();
	});
}
