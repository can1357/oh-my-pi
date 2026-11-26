/**
 * `time_spent` status segment: how long the agent has actively worked this
 * session (not wall-clock). The status line accumulates only across
 * markActivityStart/markActivityEnd windows; an open window counts up live,
 * and `resetActiveTime` zeroes the meter for `/clear` and fresh sessions.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeStatusLines, segmentText, statusFacts, statusLine, statusSession } from "./helpers/session-status-line";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterAll(() => {
	resetSettingsForTest();
});

afterEach(() => {
	disposeStatusLines();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("time_spent segment", () => {
	it("renders active processing time and ignores wall-clock", () => {
		const text = segmentText("time_spent", statusFacts({ activeMs: 10_000, now: 999_999_999 }));
		expect(text).toContain("10");
		expect(text).toContain("s");
	});

	it("hides under one second of activity so the segment does not flash 0s at session start", () => {
		expect(segmentText("time_spent", statusFacts({ activeMs: 0 }))).toBeNull();
		expect(segmentText("time_spent", statusFacts({ activeMs: 999 }))).toBeNull();
		expect(segmentText("time_spent", statusFacts({ activeMs: 1000 }))).not.toBeNull();
	});

	it("scales beyond seconds: formatDuration produces minute/hour suffixes", () => {
		expect(segmentText("time_spent", statusFacts({ activeMs: 5 * 60_000 }))).toContain("5m");
		expect(segmentText("time_spent", statusFacts({ activeMs: 2 * 3_600_000 }))).toContain("2h");
	});
});

describe("status line active-time accounting", () => {
	/** A status line showing `time_spent` on a clock the test moves. */
	function timedLine(start: number) {
		vi.useFakeTimers({ now: start });
		const line = statusLine(statusSession(), {
			preset: "custom",
			leftSegments: ["time_spent"],
			rightSegments: [],
		});
		return {
			line,
			activeMs: () => line.facts().activeMs,
			advance: (ms: number) => vi.advanceTimersByTime(ms),
		};
	}

	it("accumulates only across markActivityStart/markActivityEnd windows, not idle time", () => {
		const { line, activeMs, advance } = timedLine(1_000_000_000);

		// Idle: nothing accrues even as wall-clock advances.
		advance(10_000);
		expect(activeMs()).toBe(0);

		// First turn: 3s.
		advance(10_000);
		line.markActivityStart();
		advance(3_000);
		line.markActivityEnd();
		expect(activeMs()).toBe(3_000);

		// Long idle gap (5 minutes) — total stays at 3s.
		advance(300_000);
		expect(activeMs()).toBe(3_000);

		// Second turn: 2s. Total = 5s.
		line.markActivityStart();
		advance(2_000);
		line.markActivityEnd();
		expect(activeMs()).toBe(5_000);
	});

	it("ticks live during an open window so the segment animates while the agent runs", () => {
		const { line, activeMs, advance } = timedLine(2_000_000_000);

		line.markActivityStart();
		advance(1_000);
		expect(activeMs()).toBe(1_000);
		advance(3_000);
		expect(activeMs()).toBe(4_000);
		expect(line.facts().turnStartedAt).toBe(2_000_000_000);
	});

	it("is idempotent: reentrant markActivityStart and unmatched markActivityEnd never double-count", () => {
		const { line, activeMs, advance } = timedLine(3_000_000_000);

		// Unmatched end while idle is a no-op.
		line.markActivityEnd();
		expect(activeMs()).toBe(0);

		line.markActivityStart();
		// A second start while already running must not reset the anchor.
		advance(5_000);
		line.markActivityStart();
		advance(2_000);
		line.markActivityEnd();
		expect(activeMs()).toBe(7_000);

		// Closing again is a no-op.
		advance(92_000);
		line.markActivityEnd();
		expect(activeMs()).toBe(7_000);
	});

	it("resetActiveTime resets the active accumulator for /clear and fresh-session flows", () => {
		const { line, activeMs, advance } = timedLine(4_000_000_000);

		line.markActivityStart();
		advance(10_000);
		line.markActivityEnd();
		expect(activeMs()).toBe(10_000);

		line.resetActiveTime();
		expect(activeMs()).toBe(0);

		// Starting after reset begins from zero, not the prior total.
		advance(2_000);
		line.markActivityStart();
		advance(1_000);
		line.markActivityEnd();
		expect(activeMs()).toBe(1_000);
	});

	it("resetActiveTime also drops an in-flight window so /clear during a turn starts fresh", () => {
		const { line, activeMs, advance } = timedLine(5_000_000_000);

		line.markActivityStart();
		advance(4_000);
		expect(activeMs()).toBe(4_000);

		line.resetActiveTime();
		expect(activeMs()).toBe(0);

		// A stale markActivityEnd after the reset must not re-credit the dropped window.
		advance(5_000);
		line.markActivityEnd();
		expect(activeMs()).toBe(0);
	});
});
