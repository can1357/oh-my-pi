import { describe, expect, it } from "bun:test";
import { WheelScrollAccelerator } from "@oh-my-pi/pi-tui";

/** Drives the accelerator with an explicit timeline so fling timings are deterministic. */
function timeline(gapsMs: number[]): number[] {
	let clock = 10_000;
	const events: number[] = [];
	let first = true;
	const accelerator = new WheelScrollAccelerator(() => clock);
	for (const gap of gapsMs) {
		if (!first) clock += gap;
		first = false;
		events.push(accelerator.linesForEvent());
	}
	return events;
}

describe("WheelScrollAccelerator", () => {
	it("scrolls one line for discrete notches", () => {
		expect(timeline([0, 150, 150])).toEqual([1, 1, 1]);
	});

	it("scales up as the fling speeds up", () => {
		// First event of a gesture is always the slowest tier; subsequent events
		// are judged by the gap to their predecessor.
		expect(timeline([0, 100, 50, 20])).toEqual([1, 1, 2, 5]);
		expect(timeline([0, 19])).toEqual([1, 6]);
	});

	it("treats sub-burst-gap events as duplicates of the same physical notch", () => {
		// Ghostty emits ~4ms bursts per notch: only the opening event scrolls.
		expect(timeline([0, 4, 4, 4])).toEqual([1, 0, 0, 0]);
	});

	it("restarts from one line after the gesture pauses", () => {
		expect(timeline([0, 20, 200, 20])).toEqual([1, 5, 1, 5]);
	});
});
