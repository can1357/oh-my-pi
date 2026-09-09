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
});
