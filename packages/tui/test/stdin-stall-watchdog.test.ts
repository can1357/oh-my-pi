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
// A live strace of the flapping corpse showed why stalls are grouped into
// episodes: bun's resume() performs exactly one catch-up read (read(fd)=n,
// read(fd)=EAGAIN) and never re-registers the fd with epoll, so a broken
// pump alternates stall → one drain → stall forever. A single drained sample
// therefore must NOT close an episode or reset the escalation counter —
// only cooldownMs of sustained liveness does. While an episode is open the
// detection window tightens to fastMs so each keystroke batch costs at most
// one fast window of lag.
const STALL_MS = 1500;
const SOFT = 2;
const FAST_MS = 300;
const COOLDOWN_MS = 30_000;
const make = () => new StdinStallWatchdog(STALL_MS, SOFT, FAST_MS, COOLDOWN_MS);
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

	it("a single drained sample does not close the episode (catch-up read)", () => {
		// The flapping corpse: every pause/resume drains exactly one batch
		// via bun's speculative catch-up read, then dies again. The stall
		// counter must keep counting so escalation to re-attach is reached.
		const wd = make();
		expect(wd.sample(4, stale(1000), 1000)).toBe("none");
		expect(wd.sample(4, stale(2500), 2500)).toBe("resume"); // stall #1
		// Re-arm drained the 4 bytes and emitted data; 10ms later the user
		// types again and the pump is already dead.
		expect(wd.sample(0, 2510, 2510)).toBe("none"); // one healthy sample
		expect(wd.sample(8, stale(6000), 6000)).toBe("resume"); // stall #2 (3.5s past fire)
		expect(wd.sample(0, 6010, 6010)).toBe("none"); // another catch-up drain
		expect(wd.sample(1, stale(9000), 9000)).toBe("reattach"); // stall #3
	});

	it("detects re-stalls at the fast window once an episode is open", () => {
		const wd = make();
		expect(wd.sample(3, stale(1000), 1000)).toBe("none");
		expect(wd.sample(3, stale(2500), 2500)).toBe("resume");
		expect(wd.sample(0, 2510, 2510)).toBe("none"); // catch-up drain
		// Same batch size stuck again: only fastMs needs to elapse now, and
		// the stalled clock persisted across the drain, so it fires at the
		// first sample past the fast window.
		expect(wd.sample(3, stale(2700), 2700)).toBe("none"); // 200ms since fire
		expect(wd.sample(3, stale(2800), 2800)).toBe("resume"); // 300ms: stall #2
	});

	it("closes the episode after sustained liveness, not a brief drain", () => {
		const wd = make();
		expect(wd.sample(3, stale(1000), 1000)).toBe("none");
		expect(wd.sample(3, stale(2500), 2500)).toBe("resume"); // episode opens
		// Sustained health: the real timer samples an empty queue throughout.
		for (let t = 2600; t <= 40_000; t += 1000) {
			expect(wd.sample(0, t, t)).toBe("none");
		}
		// 30s+ of liveness closed the episode: the next stall is fresh, with
		// the full observation window and soft escalation again.
		expect(wd.sample(5, stale(60_000), 60_000)).toBe("none"); // window opens
		expect(wd.sample(5, stale(61_499), 61_499)).toBe("none");
		expect(wd.sample(5, stale(61_500), 61_500)).toBe("resume");
	});

	it("brief liveness between stalls never closes the episode", () => {
		const wd = make();
		expect(wd.sample(3, stale(1000), 1000)).toBe("none");
		expect(wd.sample(3, stale(2500), 2500)).toBe("resume"); // stall #1
		expect(wd.sample(0, 2600, 2600)).toBe("none");
		// In-episode re-stalls fire fastMs after the LAST FIRE, not after a
		// fresh observation window: 10_000 is 7.5s past the fire, so the
		// first stalled sample acts immediately (drains at the next tick).
		expect(wd.sample(3, stale(10_000), 10_000)).toBe("resume"); // stall #2
		expect(wd.sample(0, 10_100, 10_100)).toBe("none");
		expect(wd.sample(3, stale(20_000), 20_000)).toBe("reattach"); // stall #3
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
