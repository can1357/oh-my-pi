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
});
