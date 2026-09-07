import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { CountdownTimer } from "@oh-my-pi/pi-coding-agent/modes/components/countdown-timer";

describe("CountdownTimer", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("expires using precise sub-second timeout instead of second rounding", () => {
		const onTick = vi.fn();
		const onExpire = vi.fn();
		new CountdownTimer(250, undefined, onTick, onExpire);

		expect(onTick).toHaveBeenCalledWith(1);
		vi.advanceTimersByTime(249);
		expect(onExpire).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1);
		expect(onExpire).toHaveBeenCalledTimes(1);
	});

	it("reset restarts precise timeout window", () => {
		const onExpire = vi.fn();
		const timer = new CountdownTimer(300, undefined, () => {}, onExpire);

		vi.advanceTimersByTime(200);
		timer.reset();
		vi.advanceTimersByTime(299);
		expect(onExpire).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1);
		expect(onExpire).toHaveBeenCalledTimes(1);
	});

	it("does not fire early for windows past the 32-bit timer limit", () => {
		// A raw setTimeout above 2^31-1 ms is clamped to 1ms by the runtime, which
		// would fire a deliberately long window almost immediately.
		const onExpire = vi.fn();
		const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000; // ~2.59e9 > 2_147_483_647
		new CountdownTimer(thirtyDaysMs, undefined, () => {}, onExpire);

		vi.advanceTimersByTime(2_147_483_647);
		expect(onExpire).not.toHaveBeenCalled();

		vi.advanceTimersByTime(thirtyDaysMs - 2_147_483_647 - 1);
		expect(onExpire).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1);
		expect(onExpire).toHaveBeenCalledTimes(1);
	});
});
