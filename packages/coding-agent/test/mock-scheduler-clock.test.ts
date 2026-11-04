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

	// The reserve prompt races its deadline against the person's answer. On real timers an
	// answer that is already settling wins; a clock that resolves the wait at once would hand
	// the race to the deadline on promise order alone and keep the wrong model.
	it("lets an answer that takes no clock time beat an unreferenced deadline", async () => {
		mockSchedulerWaitWithClock();
		const cancelled = new AbortController();
		const deadline = sleepLong(10 * 60_000, cancelled.signal, { ref: false }).then(
			() => "deadline",
			() => "cancelled",
		);
		const answer = (async () => {
			// An answer passed through a few wrappers settles some microtasks later.
			for (let hop = 0; hop < 100; hop++) await Promise.resolve();
			return "answer";
		})();

		const winner = await Promise.race([answer, deadline]);
		cancelled.abort();

		expect(winner).toBe("answer");
		expect(await deadline).toBe("cancelled");
	});
});
