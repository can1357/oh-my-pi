import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { IdleTimeout } from "../../src/eval/idle-timeout";

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("IdleTimeout", () => {
	it("aborts with a TimeoutError reason once the idle window elapses with no activity", () => {
		using idle = new IdleTimeout(40);
		expect(idle.signal.aborted).toBe(false);
		vi.advanceTimersByTime(39);
		expect(idle.signal.aborted).toBe(false);
		vi.advanceTimersByTime(1);
		expect(idle.signal.aborted).toBe(true);
		// The reason must be a TimeoutError so downstream timeout detection
		// (kernel `isTimeoutReason`, executor `isTimedOutCancellation`) classifies
		// the cancellation as a timeout rather than a plain abort.
		expect(idle.signal.reason).toBeInstanceOf(DOMException);
		expect((idle.signal.reason as DOMException).name).toBe("TimeoutError");
	});

	it("ignores elapsed time while paused and resumes with a fresh window", () => {
		using idle = new IdleTimeout(80);
		idle.pause();
		vi.advanceTimersByTime(1_000);
		expect(idle.signal.aborted).toBe(false);

		idle.resume();
		vi.advanceTimersByTime(79);
		expect(idle.signal.aborted).toBe(false);
		vi.advanceTimersByTime(1);
		expect(idle.signal.aborted).toBe(true);
	});

	it("reference-counts overlapping pauses", () => {
		using idle = new IdleTimeout(60);
		idle.pause();
		idle.pause();
		vi.advanceTimersByTime(1_000);
		expect(idle.signal.aborted).toBe(false);

		idle.resume();
		vi.advanceTimersByTime(1_000);
		expect(idle.signal.aborted).toBe(false);

		idle.resume();
		vi.advanceTimersByTime(59);
		expect(idle.signal.aborted).toBe(false);
		vi.advanceTimersByTime(1);
		expect(idle.signal.aborted).toBe(true);
	});
	it("never fires after dispose()", () => {
		const idle = new IdleTimeout(30);
		idle.dispose();
		vi.advanceTimersByTime(1_000);
		expect(idle.signal.aborted).toBe(false);
	});

	it("ignores pause/resume after the watchdog has already fired", () => {
		using idle = new IdleTimeout(30);
		vi.advanceTimersByTime(30);
		expect(idle.signal.aborted).toBe(true);
		// Late activity must not un-abort or rearm a settled watchdog.
		idle.pause();
		idle.resume();
		expect(idle.signal.aborted).toBe(true);
	});
});
