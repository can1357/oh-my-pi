import { afterEach, describe, expect, it, vi } from "bun:test";
import { scheduler } from "node:timers/promises";
import {
	AsyncDrain,
	MAX_TIMER_DELAY_MS,
	setLongInterval,
	setLongTimeout,
	sleepLong,
	sleepUntil,
	waitLong,
	withTimeout,
} from "@oh-my-pi/pi-utils/async";

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

/**
 * A clock that never moves and a `scheduler.wait` that resolves at once, as fake
 * timers with a stubbed scheduler give. A wait that re-armed until the clock caught
 * up would loop forever here; the stub fails after a few calls so it stays bounded.
 */
function freezeClockAndStubScheduler() {
	vi.spyOn(performance, "now").mockReturnValue(10_000);
	vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
	const delays: number[] = [];
	vi.spyOn(scheduler, "wait").mockImplementation(async delayMs => {
		delays.push(Number(delayMs));
		if (delays.length > 8) throw new Error("the wait kept re-arming against a clock that stands still");
	});
	return delays;
}

afterEach(() => {
	vi.useRealTimers();
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

	it("waits the requested total as counted chunks while the clock stands still", async () => {
		const delays = freezeClockAndStubScheduler();

		await sleepLong(MAX_TIMER_DELAY_MS * 2 + 1_000);

		expect(delays).toEqual([MAX_TIMER_DELAY_MS, MAX_TIMER_DELAY_MS, 1_000]);
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

describe("waitLong", () => {
	it("waits a delay past the limit as counted chunks while the clock stands still", async () => {
		const delays = freezeClockAndStubScheduler();

		await waitLong(MAX_TIMER_DELAY_MS + 1);

		expect(delays).toEqual([MAX_TIMER_DELAY_MS, 1]);
	});

	it("rejects an infinite wait at once instead of never settling", async () => {
		const delays = freezeClockAndStubScheduler();

		await expect(waitLong(Number.POSITIVE_INFINITY)).rejects.toBeInstanceOf(RangeError);
		await expect(sleepLong(Number.POSITIVE_INFINITY)).rejects.toBeInstanceOf(RangeError);
		expect(delays).toEqual([]);
	});
});

describe("sleepUntil", () => {
	it("waits no longer than the time left when it started while the wall clock stands still", async () => {
		const delays = freezeClockAndStubScheduler();

		await sleepUntil(Date.now() + 2_500);

		expect(delays).toEqual([1_000, 1_000, 500]);
	});
});

describe("setLongTimeout", () => {
	it("fires a delay past the native timer limit at its deadline while the clock stands still", () => {
		vi.useFakeTimers();
		vi.spyOn(performance, "now").mockReturnValue(0);
		const delayMs = MAX_TIMER_DELAY_MS + 1;
		let fired = 0;
		setLongTimeout(() => fired++, delayMs);

		vi.advanceTimersByTime(delayMs - 1);
		expect(fired).toBe(0);

		vi.advanceTimersByTime(1);
		expect(fired).toBe(1);

		vi.advanceTimersByTime(MAX_TIMER_DELAY_MS);
		expect(fired).toBe(1);
	});

	it("cancels a pending delay in any of its timer chunks", () => {
		vi.useFakeTimers();
		let fired = 0;
		const timer = setLongTimeout(() => fired++, MAX_TIMER_DELAY_MS * 2);

		vi.advanceTimersByTime(MAX_TIMER_DELAY_MS + 1);
		timer.clear();
		vi.advanceTimersByTime(MAX_TIMER_DELAY_MS * 2);

		expect(fired).toBe(0);
	});

	it("reads a numeric string delay as its number", () => {
		vi.useFakeTimers();
		vi.spyOn(performance, "now").mockReturnValue(5_000);
		let fired = 0;
		// An untyped caller (extension code) can pass a string; it must not be concatenated into a deadline.
		setLongTimeout(() => fired++, "2147483648" as unknown as number);

		vi.advanceTimersByTime(2 ** 31 - 1);
		expect(fired).toBe(0);
		vi.advanceTimersByTime(1);
		expect(fired).toBe(1);
	});

	it("never fires an infinite delay", () => {
		vi.useFakeTimers();
		let fired = 0;
		const timer = setLongTimeout(() => fired++, Number.POSITIVE_INFINITY);

		for (let chunk = 0; chunk < 4; chunk++) vi.advanceTimersByTime(MAX_TIMER_DELAY_MS);
		expect(fired).toBe(0);
		timer.clear();
	});
});

describe("setLongInterval", () => {
	it("repeats a period past the native timer limit once per period, not every 1 ms", () => {
		vi.useFakeTimers();
		vi.spyOn(performance, "now").mockReturnValue(0);
		const periodMs = MAX_TIMER_DELAY_MS + 1;
		let ticks = 0;
		const timer = setLongInterval(() => ticks++, periodMs);

		vi.advanceTimersByTime(periodMs - 1);
		expect(ticks).toBe(0);
		vi.advanceTimersByTime(1);
		expect(ticks).toBe(1);
		vi.advanceTimersByTime(periodMs);
		expect(ticks).toBe(2);

		timer.clear();
		vi.advanceTimersByTime(periodMs);
		vi.advanceTimersByTime(periodMs);
		expect(ticks).toBe(2);
	});
});

describe("withTimeout", () => {
	it("rejects at a timeout past the native timer limit, not after 1 ms", async () => {
		vi.useFakeTimers();
		const timeoutMs = MAX_TIMER_DELAY_MS + 1;
		let outcome: string | undefined;
		void withTimeout(Promise.withResolvers<void>().promise, timeoutMs, "deadline passed").then(
			() => {
				outcome = "resolved";
			},
			(error: Error) => {
				outcome = error.message;
			},
		);

		vi.advanceTimersByTime(timeoutMs - 1);
		for (let i = 0; i < 3; i++) await Promise.resolve();
		expect(outcome).toBeUndefined();

		vi.advanceTimersByTime(1);
		for (let i = 0; i < 3; i++) await Promise.resolve();
		expect(outcome).toBe("deadline passed");
	});
});

describe("AsyncDrain", () => {
	it("closes a batch window past the native timer limit at its end, not after 1 ms", () => {
		vi.useFakeTimers();
		const delayMs = MAX_TIMER_DELAY_MS + 1;
		const drain = new AsyncDrain<number>(delayMs);
		const batches: number[][] = [];
		void drain.push(1, values => {
			batches.push(values);
		});

		vi.advanceTimersByTime(delayMs - 1);
		expect(batches).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(batches).toEqual([[1]]);
	});
});
