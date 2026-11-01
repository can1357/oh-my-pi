import { vi } from "bun:test";
import { type TimerOptions } from "node:timers";
import * as timers from "node:timers/promises";

/**
 * Resolve scheduler waits immediately while advancing the monotonic clock by the requested delay.
 * `timers/promises` `setTimeout` gets the same treatment: `sleepLong(..., { ref: false })` arms it
 * instead of `scheduler.wait`, and a suite on this clock must not sleep that wait in real time.
 */
export function mockSchedulerWaitWithClock() {
	const now = performance.now.bind(performance);
	let advancedMs = 0;
	vi.spyOn(performance, "now").mockImplementation(() => now() + advancedMs);
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
