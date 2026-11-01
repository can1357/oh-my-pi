import { vi } from "bun:test";
import { type TimerOptions } from "node:timers";
import * as timers from "node:timers/promises";

/**
 * Advance scheduler clocks, preserving a wall clock already controlled by the caller.
 * `timers/promises` `setTimeout` gets the same treatment as `scheduler.wait`: `sleepLong(..., { ref: false })`
 * arms it instead of `scheduler.wait`, and a suite on this clock must not sleep that wait in real time.
 */
export function mockSchedulerWaitWithClock() {
	const now = performance.now.bind(performance);
	const wallNow = Date.now.bind(Date);
	let advancedMs = 0;
	vi.spyOn(performance, "now").mockImplementation(() => now() + advancedMs);
	if (!("mock" in Date.now)) {
		vi.spyOn(Date, "now").mockImplementation(() => Math.floor(wallNow() + advancedMs));
	}
	vi.spyOn(timers, "setTimeout").mockImplementation(
		<T = void>(delayMs?: number, value?: T, options?: TimerOptions): Promise<T> => {
			options?.signal?.throwIfAborted();
			advancedMs += delayMs ?? 0;
			options?.signal?.throwIfAborted();
			return Promise.resolve(value as T);
		},
	);
	return vi.spyOn(timers.scheduler, "wait").mockImplementation(async (delayMs, options) => {
		options?.signal?.throwIfAborted();
		advancedMs += delayMs;
		options?.signal?.throwIfAborted();
	});
}
