import { afterEach, describe, expect, it, vi } from "bun:test";
import { sleepLong } from "@oh-my-pi/pi-utils";
import { mockSchedulerWaitWithClock } from "./helpers/mock-scheduler-clock";

describe("mockSchedulerWaitWithClock", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	// The reserve-prompt deadline sleeps through `sleepLong(..., { ref: false })`, which arms
	// `timers/promises` `setTimeout` instead of `scheduler.wait`. A suite on the shared clock
	// must not sleep that deadline in real time.
	it("advances the clock instead of sleeping for an unreferenced sleepLong", async () => {
		mockSchedulerWaitWithClock();
		const start = performance.now();

		await sleepLong(10 * 60_000, undefined, { ref: false });

		expect(performance.now() - start).toBeGreaterThanOrEqual(10 * 60_000);
	});
});
