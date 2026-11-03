import { describe, expect, vi } from "bun:test";
import { scheduler } from "node:timers/promises";
import { mockSchedulerWaitWithClock } from "./mock-scheduler-clock";
import { trackTestLifetime } from "./test-lifetime";

const { test, afterEach } = trackTestLifetime();

// The real clock, captured before any test replaces it, so afterEach can put it back.
const realPerformanceNow = performance.now;

describe("mockSchedulerWaitWithClock", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		// A test may replace performance.now with a plain function before installing the mock; the
		// spy restore puts that function back, so restore the real clock after it.
		performance.now = realPerformanceNow;
	});

	test("refuses an installation over one that was never restored, and leaves the first one working", async () => {
		mockSchedulerWaitWithClock();

		expect(() => mockSchedulerWaitWithClock()).toThrow("performance.now is already mocked");
		// The refused call left the first installation in place: performance.now is still its mock,
		// and a one-minute scheduler wait returns at once and advances that clock by the full minute.
		expect("_isMockFunction" in performance.now).toBe(true);
		const before = performance.now();
		await scheduler.wait(60_000);
		expect(performance.now() - before).toBe(60_000);
	});

	test("advances both clocks by the waits alone, so real time spent in a test changes no deadline", async () => {
		mockSchedulerWaitWithClock();

		const wallStart = Date.now();
		const monotonicStart = performance.now();
		// Real time passes here. A deadline the test took before this point must still be the same
		// distance away, or a loaded machine decides the test's outcome.
		await Bun.sleep(60);
		expect(Date.now()).toBe(wallStart);
		expect(performance.now()).toBe(monotonicStart);

		await scheduler.wait(1_500);
		await Bun.sleep(60);
		expect(Date.now()).toBe(wallStart + 1_500);
		expect(performance.now()).toBe(monotonicStart + 1_500);
	});

	test("measures waits exactly from a clock frozen at a fractional millisecond, and never reads earlier", async () => {
		// A real monotonic clock almost always reads a fractional millisecond.
		performance.now = () => 5536.18;
		mockSchedulerWaitWithClock();

		const before = performance.now();
		expect(before).toBeGreaterThanOrEqual(5536.18);
		await scheduler.wait(60_000);
		expect(performance.now() - before).toBe(60_000);
		await scheduler.wait(1);
		expect(performance.now() - before).toBe(60_001);
	});
});
