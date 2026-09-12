import { describe, expect, it } from "bun:test";
import { StdinStallWatchdog } from "@oh-my-pi/pi-tui/terminal";

// Heavyweight `omp --resume` sessions have frozen under real multiplexer
// panes with keystrokes stuck unread in the kernel tty queue while
// process.stdin reported healthy (not paused, listener attached, not ended or
// destroyed) and no disconnect fired — the stream's read pump died silently.
// A live reader drains typed bytes in milliseconds, so the watchdog's only
// inputs are the kernel queue depth (FIONREAD), the last `data` event time,
// and the clock. These tests pin that decision — when it recovers, and how it
// escalates — the contract #armStdinStallWatchdog relies on to revive the
// pump without ever tearing the terminal down.
//
// The stall window is measured between observations: it opens at the first
// sample with no liveness signal (queue empty, queue draining, or a data
// event within stallMs) and closes stallMs later, so expectations below are
// written against explicit sample times. Stale last-data timestamps model a
// pump that has not emitted anything.
const STALL_MS = 1500;
const SOFT = 2;
const make = () => new StdinStallWatchdog(STALL_MS, SOFT);
/** A last-data timestamp comfortably older than the liveness window at `now`. */
const stale = (now: number) => now - 10 * STALL_MS;

describe("StdinStallWatchdog", () => {
	it("does nothing while the queue is empty or draining", () => {
		const wd = make();
		for (let t = 0; t < 100_000; t += 250) {
			expect(wd.sample(0, stale(t), t)).toBe("none");
			let queued = 4096;
			while (queued > 0) {
				expect(wd.sample(queued, stale(t), t)).toBe("none");
				queued -= 512; // forward progress each poll
			}
		}
	});

	it("does nothing while data events are arriving, even with bytes queued", () => {
		const wd = make();
		// Mid-paste: the queue is deep but the reader is emitting data events
		// more recently than the liveness window.
		for (let t = 0; t < 10_000; t += 250) {
			expect(wd.sample(8192, t - 100, t)).toBe("none");
		}
	});

	it("declares a stall once bytes sit undrained with no data for stallMs", () => {
		const wd = make();
		expect(wd.sample(3, stale(1000), 1000)).toBe("none"); // window opens
		expect(wd.sample(3, stale(2499), 2499)).toBe("none"); // not yet elapsed
		expect(wd.sample(3, stale(2500), 2500)).toBe("resume"); // dead pump
	});

	it("escalates: soft resume re-arms first, then listener re-attach", () => {
		const wd = make();
		expect(wd.sample(3, stale(1000), 1000)).toBe("none");
		expect(wd.sample(3, stale(2500), 2500)).toBe("resume");
		expect(wd.sample(3, stale(4000), 4000)).toBe("resume");
		for (const t of [5500, 7000, 8500]) {
			expect(wd.sample(3, stale(t), t)).toBe("reattach");
		}
	});

	it("measures the window from the last observed liveness, not from arm time", () => {
		const wd = make();
		expect(wd.sample(3, stale(0), 0)).toBe("none"); // window opens at 0
		expect(wd.sample(2, stale(200), 200)).toBe("none"); // queue draining: alive
		expect(wd.sample(2, stale(1699), 1699)).toBe("none"); // window reopens at 1699
		expect(wd.sample(2, stale(3198), 3198)).toBe("none"); // 1499ms since reopen
		expect(wd.sample(2, stale(3199), 3199)).toBe("resume"); // 1500ms elapsed
	});

	it("a fresh episode after recovery starts over at soft resume", () => {
		const wd = make();
		expect(wd.sample(3, stale(1000), 1000)).toBe("none");
		expect(wd.sample(3, stale(2500), 2500)).toBe("resume");
		expect(wd.sample(3, stale(4000), 4000)).toBe("resume");
		expect(wd.sample(3, stale(5500), 5500)).toBe("reattach");
		// Re-arm worked: the queue drained and data flows again.
		expect(wd.sample(0, 5510, 5510)).toBe("none");
		expect(wd.sample(5, stale(60_000), 60_000)).toBe("none"); // fresh window opens
		expect(wd.sample(5, stale(61_499), 61_499)).toBe("none");
		expect(wd.sample(5, stale(61_500), 61_500)).toBe("resume"); // soft again
	});

	it("does not inherit a stale window across a healthy period", () => {
		const wd = make();
		expect(wd.sample(3, stale(0), 0)).toBe("none"); // window opens at 0
		expect(wd.sample(0, 500, 500)).toBe("none"); // healthy: liveness at 500
		expect(wd.sample(3, stale(10_000), 10_000)).toBe("none"); // fresh window at 10_000
		expect(wd.sample(3, stale(11_499), 11_499)).toBe("none");
		expect(wd.sample(3, stale(11_500), 11_500)).toBe("resume");
	});
});
