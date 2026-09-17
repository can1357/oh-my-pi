import { afterEach, describe, expect, it, vi } from "bun:test";
import { scheduler } from "node:timers/promises";
import { MAX_TIMER_DELAY_MS, sleepLong } from "@oh-my-pi/pi-utils/async";

function mockMonotonicScheduler(elapsedForWait: (delayMs: number) => number = delayMs => delayMs) {
	const startedAt = 10_000;
	let now = startedAt;
	vi.spyOn(performance, "now").mockImplementation(() => now);
	const wait = vi.spyOn(scheduler, "wait").mockImplementation(async (delayMs, options) => {
		options?.signal?.throwIfAborted();
		now += elapsedForWait(delayMs);
		options?.signal?.throwIfAborted();
	});
	return { elapsed: () => now - startedAt, wait };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("sleepLong", () => {
	it("waits until the requested monotonic deadline", async () => {
		const clock = mockMonotonicScheduler();

		await sleepLong(60_000);

		expect(clock.elapsed()).toBe(60_000);
	});

	it("waits across the native timer boundary without overflowing a timer", async () => {
		const clock = mockMonotonicScheduler(delayMs => {
			if (delayMs > MAX_TIMER_DELAY_MS) throw new RangeError("timer overflow");
			return delayMs;
		});
		const delayMs = MAX_TIMER_DELAY_MS + 1_000;

		await sleepLong(delayMs);

		expect(clock.elapsed()).toBe(delayMs);
	});

	it("re-arms after early wakes until the full delay has elapsed", async () => {
		const clock = mockMonotonicScheduler(delayMs => Math.max(1, delayMs / 2));

		await sleepLong(60_000);

		expect(clock.elapsed()).toBeGreaterThanOrEqual(60_000);
	});

	it("propagates an abort during a wait", async () => {
		const controller = new AbortController();
		mockMonotonicScheduler(delayMs => {
			controller.abort(new Error("cancelled"));
			return delayMs;
		});

		await expect(sleepLong(MAX_TIMER_DELAY_MS + 1_000, controller.signal)).rejects.toThrow("cancelled");
	});

	it("rejects a pre-aborted zero-length sleep without arming a timer", async () => {
		const clock = mockMonotonicScheduler();
		const controller = new AbortController();
		controller.abort();

		await expect(sleepLong(0, controller.signal)).rejects.toThrow("The operation was aborted");
		expect(clock.wait).not.toHaveBeenCalled();
	});
});
