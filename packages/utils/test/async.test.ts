import { afterEach, describe, expect, it, vi } from "bun:test";
import * as timers from "node:timers/promises";
import { MAX_TIMER_DELAY_MS, sleepLong } from "@oh-my-pi/pi-utils/async";

function mockMonotonicScheduler(elapsedForWait: (delayMs: number) => number = delayMs => delayMs) {
	const startedAt = 10_000;
	let now = startedAt;
	vi.spyOn(performance, "now").mockImplementation(() => now);
	const advance = (delayMs: number, signal: AbortSignal | undefined) => {
		signal?.throwIfAborted();
		now += elapsedForWait(delayMs);
		signal?.throwIfAborted();
	};
	const wait = vi.spyOn(timers.scheduler, "wait").mockImplementation(async (delayMs, options) => {
		advance(delayMs, options?.signal);
	});
	const unrefWait = vi.spyOn(timers, "setTimeout").mockImplementation(async (delayMs, _value, options) => {
		advance(delayMs ?? 0, options?.signal);
		return undefined as never;
	});
	return { elapsed: () => now - startedAt, wait, unrefWait };
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
		expect(clock.unrefWait).not.toHaveBeenCalled();
	});

	it("keeps a referenced sleep on scheduler.wait, the timer a caller's clock mock replaces", async () => {
		const clock = mockMonotonicScheduler();

		await sleepLong(MAX_TIMER_DELAY_MS + 1_000);

		expect(clock.wait).toHaveBeenCalledTimes(2);
		expect(clock.unrefWait).not.toHaveBeenCalled();
	});

	it("arms every chunk unreferenced when ref is false", async () => {
		const clock = mockMonotonicScheduler();

		await sleepLong(MAX_TIMER_DELAY_MS + 1_000, undefined, { ref: false });

		expect(clock.unrefWait.mock.calls.map(([, , options]) => options?.ref)).toEqual([false, false]);
		expect(clock.wait).not.toHaveBeenCalled();
	});

	it("lets a process exit while an unreferenced long sleep is pending", async () => {
		// The reserve-prompt deadline must never be the only reason a finished
		// process stays alive, and only the real event loop can show that: a
		// mocked timer proves nothing about the platform's ref semantics.
		const source = `
			import { sleepLong } from "@oh-my-pi/pi-utils/async";
			void sleepLong(30 * 24 * 60 * 60 * 1000, undefined, { ref: false });
			console.log("armed");
		`;
		const proc = Bun.spawn([process.execPath, "-e", source], {
			cwd: new URL("../", import.meta.url).pathname,
			stdout: "pipe",
			stderr: "pipe",
		});
		const exited = await Promise.race([proc.exited, timers.setTimeout(10_000).then(() => "timed out" as const)]);
		if (exited === "timed out") proc.kill();
		expect(await new Response(proc.stdout).text()).toContain("armed");
		expect(exited).toBe(0);
	}, 20_000);
});
