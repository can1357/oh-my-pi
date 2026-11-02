import { afterEach, describe, expect, test, vi } from "bun:test";
import { scheduler } from "node:timers/promises";
import { mockSchedulerWaitWithClock } from "./mock-scheduler-clock";

describe("mockSchedulerWaitWithClock", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("refuses an installation over one that was never restored, and leaves the first one working", async () => {
		mockSchedulerWaitWithClock();

		expect(() => mockSchedulerWaitWithClock()).toThrow("performance.now is already mocked");
		// The refused call left the first installation in place: performance.now is still its mock,
		// and a one-minute scheduler wait returns at once and advances that clock by the full minute.
		expect("_isMockFunction" in performance.now).toBe(true);
		const before = performance.now();
		await scheduler.wait(60_000);
		expect(performance.now() - before).toBeGreaterThanOrEqual(60_000);
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
});
