import { vi } from "bun:test";
import { scheduler } from "node:timers/promises";

/** Advance scheduler clocks, preserving a wall clock already controlled by the caller. */
export function mockSchedulerWaitWithClock() {
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
