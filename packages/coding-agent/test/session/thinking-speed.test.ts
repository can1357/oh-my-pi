import { afterAll, describe, expect, it } from "bun:test";
import {
	THINKING_SPEED_MAX,
	ThinkingRateMeter,
	ThinkingSpeedTracker,
} from "@oh-my-pi/pi-coding-agent/session/transcript/thinking-speed";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";

const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

describe("thinking speed gauge", () => {
	it("derives the windowed token speed from provider usage deltas", () => {
		const meter = new ThinkingRateMeter(new ThinkingSpeedTracker());
		// The first update seeds the baseline: no rate yet.
		expect(meter.sample(10, 1000)).toBe(0);
		// +47 provider output tokens 1s later → 47 tok/s.
		expect(meter.sample(57, 2000)).toBeCloseTo(47, 5);
	});

	it("clamps the speed to the ceiling", () => {
		const meter = new ThinkingRateMeter(new ThinkingSpeedTracker());
		meter.sample(10, 1000);
		// +977 tokens in 100 ms is far past the ceiling.
		expect(meter.sample(987, 1100)).toBe(THINKING_SPEED_MAX);
	});

	it("reads zero once the readings age out (streaming lull)", () => {
		const meter = new ThinkingRateMeter(new ThinkingSpeedTracker());
		meter.sample(10, 1000);
		expect(meter.sample(57, 2000)).toBeGreaterThan(0);
		expect(meter.sample(57, 30_000)).toBe(0);
	});

	it("never lends a previous block's rate to a fresh token-less block", () => {
		const tracker = new ThinkingSpeedTracker();
		const a = new ThinkingRateMeter(tracker);
		a.sample(10, 1000);
		expect(a.sample(57, 2000)).toBeGreaterThan(0);

		// Block B starts moments later with provider tokens but no delta of its own.
		const b = new ThinkingRateMeter(tracker);
		expect(b.sample(99, 2500)).toBe(0);
		// Its first own delta resets the gauge: only B's readings count.
		expect(b.sample(109, 3500)).toBeCloseTo(10, 5);
	});

	it("starts over after thinking stops", () => {
		const meter = new ThinkingRateMeter(new ThinkingSpeedTracker());
		meter.sample(10, 1000);
		meter.sample(57, 2000);
		meter.stop();
		// A jump across the stop (end-of-stream usage) is a new baseline, not a reading.
		expect(meter.sample(500, 2100)).toBe(0);
	});
});
