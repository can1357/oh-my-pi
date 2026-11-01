import { vi } from "bun:test";
import { scheduler } from "node:timers/promises";

/**
 * Resolve scheduler waits immediately while advancing the monotonic clock by the requested delay.
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
	let advancedMs = 0;
	vi.spyOn(performance, "now").mockImplementation(() => now() + advancedMs);
	return vi.spyOn(scheduler, "wait").mockImplementation(async (delayMs, options) => {
		options?.signal?.throwIfAborted();
		advancedMs += delayMs;
		options?.signal?.throwIfAborted();
	});
}
