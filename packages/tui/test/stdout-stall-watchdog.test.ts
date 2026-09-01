import { describe, expect, it } from "bun:test";
import { StdoutStallWatchdog } from "@oh-my-pi/pi-tui/terminal";

// The TUI must bound a never-draining stdout consumer (#6854) without killing a
// single large-but-draining frame — a `--resume` transcript repaint of many
// inline images is one multi-tens-of-MiB write (#10430). An episode runs from
// the arm cap until the backlog drains to a healthy level, so a consumer that
// wedges *below* the arm cap but above the healthy level is still caught
// (#10434). These tests pin that decision, the contract
// ProcessTerminal#trackStdoutBacklog relies on to declare a disconnect.
const ARM = 1000;
const CLEAR = 100;
const STALL_MS = 2000;
const make = () => new StdoutStallWatchdog(ARM, CLEAR, STALL_MS);

describe("StdoutStallWatchdog", () => {
	it("does not arm or trip on a backlog that never exceeds the arm cap", () => {
		const wd = make();
		for (let t = 0; t < 100_000; t += 1000) {
			expect(wd.sample(ARM, t)).toBe(false);
			expect(wd.sample(ARM - 1, t + 1)).toBe(false); // between clear and cap, but idle
			expect(wd.sample(0, t + 2)).toBe(false);
			expect(wd.armed).toBe(false);
		}
	});

	it("declares a stall once an armed backlog goes stallMs without draining (#6854)", () => {
		const wd = make();
		expect(wd.sample(ARM + 1, 0)).toBe(false); // arms and starts the clock
		expect(wd.sample(ARM + 1, STALL_MS - 1)).toBe(false); // window not elapsed
		expect(wd.sample(ARM + 1, STALL_MS)).toBe(true); // no progress for stallMs
	});

	it("never trips while a large backlog keeps draining, even past stallMs (#10430)", () => {
		const wd = make();
		let pending = 5000;
		let t = 0;
		while (pending > CLEAR) {
			expect(wd.sample(pending, t)).toBe(false);
			pending -= 100; // forward progress: a new low-water mark each poll
			t += 300; // spans well beyond STALL_MS with no false trip
		}
		expect(wd.sample(pending, t)).toBe(false); // drained to healthy: episode ends
		expect(wd.armed).toBe(false);
	});

	it("keeps the episode armed after the backlog dips below the arm cap, then stalls (#10434)", () => {
		const wd = make();
		expect(wd.sample(ARM + 500, 0)).toBe(false); // arm above the cap
		// Drains below the arm cap but stays above the healthy clear level, then
		// the consumer wedges. No write re-arms it, so the episode must persist.
		expect(wd.sample(ARM - 100, 200)).toBe(false); // progress; still armed
		expect(wd.armed).toBe(true);
		expect(wd.sample(ARM - 100, 200 + STALL_MS - 1)).toBe(false);
		expect(wd.sample(ARM - 100, 200 + STALL_MS)).toBe(true); // wedged below cap → trips
	});

	it("ends the episode and disarms once the backlog drains to the clear level", () => {
		const wd = make();
		expect(wd.sample(ARM + 1, 0)).toBe(false);
		expect(wd.armed).toBe(true);
		expect(wd.sample(CLEAR, 100)).toBe(false); // healthy again: episode over
		expect(wd.armed).toBe(false);
		// A later sub-cap backlog does not re-arm a fresh episode on its own.
		expect(wd.sample(ARM - 1, 10_000)).toBe(false);
		expect(wd.armed).toBe(false);
	});

	it("counts the stall window only since the last drain progress", () => {
		const wd = make();
		expect(wd.sample(ARM + 5000, 0)).toBe(false); // arm at t=0
		expect(wd.sample(ARM + 3000, 1500)).toBe(false); // progress: clock restarts at 1500
		expect(wd.sample(ARM + 3000, 1500 + STALL_MS - 1)).toBe(false); // measured from 1500
		expect(wd.sample(ARM + 3000, 1500 + STALL_MS)).toBe(true);
	});

	it("does not inherit a stale clock across a drained episode", () => {
		const wd = make();
		expect(wd.sample(ARM + 1, 0)).toBe(false);
		expect(wd.sample(0, 500)).toBe(false); // drained under clear: reset
		expect(wd.sample(ARM + 1, 10_000)).toBe(false); // fresh episode arms a new clock
		expect(wd.sample(ARM + 1, 10_000 + STALL_MS - 1)).toBe(false);
		expect(wd.sample(ARM + 1, 10_000 + STALL_MS)).toBe(true);
	});
});
