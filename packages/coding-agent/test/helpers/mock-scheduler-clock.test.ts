import { afterEach, describe, expect, test, vi } from "bun:test";
import { mockSchedulerWaitWithClock } from "./mock-scheduler-clock";

describe("mockSchedulerWaitWithClock", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("refuses an installation over one that was never restored instead of recursing on the next clock read", () => {
		mockSchedulerWaitWithClock();

		expect(() => mockSchedulerWaitWithClock()).toThrow("performance.now is already mocked");
		// The refused call left the first installation working.
		expect(Number.isFinite(performance.now())).toBe(true);
	});
});
