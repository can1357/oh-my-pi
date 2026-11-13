import { describe, expect, it } from "bun:test";
import { SpeedTracker } from "@oh-my-pi/pi-tui/chat/assistant-message";

const WINDOW_MS = 3000;

describe("SpeedTracker", () => {
	it("reports tokens over the summed span, not the mean of per-sample ratios", () => {
		const tracker = new SpeedTracker();
		// A 5-token burst after a 5 ms gap, then 10 tokens after 400 ms. The mean of
		// the ratios would read (1000 + 25) / 2 ≈ 512 tok/s; the stream actually
		// carried 15 tokens in 405 ms ≈ 37 tok/s.
		tracker.observe(5, 5, 0);
		tracker.observe(10, 400, 400);
		expect(tracker.getSpeed(400)).toBeCloseTo((15 * 1000) / 405, 5);
	});

	it("does not cap a fast stream at the badge's accent ceiling", () => {
		const tracker = new SpeedTracker();
		for (let i = 0; i < 10; i++) tracker.observe(20, 50, i * 50); // 400 tok/s
		expect(tracker.getSpeed(450)).toBeGreaterThan(350);
		expect(tracker.getSpeed(450)).toBeCloseTo(400, 5);
	});

	it("ignores samples that carry no rate", () => {
		const tracker = new SpeedTracker();
		tracker.observe(0, 100, 0);
		tracker.observe(10, 0, 0);
		tracker.observe(-4, 100, 0);
		tracker.observe(Number.NaN, 100, 0);
		expect(tracker.getSpeed(0)).toBe(0);

		tracker.observe(30, 100, 10);
		expect(tracker.getSpeed(10)).toBeCloseTo(300, 5);
	});

	it("forgets samples that age out of the window", () => {
		const tracker = new SpeedTracker();
		tracker.observe(10, 100, 0); // 100 tok/s, recorded at the window's edge
		tracker.observe(100, 100, WINDOW_MS - 1); // 1000 tok/s
		expect(tracker.getSpeed(WINDOW_MS - 1)).toBeCloseTo(110000 / 200, 5);
		// Exactly one window later the early sample has aged out.
		expect(tracker.getSpeed(WINDOW_MS + 1)).toBeCloseTo(1000, 5);
		expect(tracker.getSpeed(WINDOW_MS * 2 + 1)).toBe(0);
	});

	it("drops everything on reset", () => {
		const tracker = new SpeedTracker();
		tracker.observe(25, 100, 0);
		tracker.reset();
		expect(tracker.getSpeed(0)).toBe(0);
	});
});
