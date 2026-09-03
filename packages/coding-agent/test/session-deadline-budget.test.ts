import { describe, expect, it } from "bun:test";
import {
	capDurationToSessionDeadline,
	remainingSessionDeadlineMs,
} from "../src/session/session-deadline.ts";

describe("session deadline budget", () => {
	it("reports remaining --max-time as a non-negative millisecond budget", () => {
		expect(remainingSessionDeadlineMs(undefined, 1_000)).toBeUndefined();
		expect(remainingSessionDeadlineMs(5_000, 1_000)).toBe(4_000);
		expect(remainingSessionDeadlineMs(500, 1_000)).toBe(0);
	});

	it("reserves a bounded fixed slice for a fallback hop", () => {
		// 90s budget: primary keeps 75s, not 45s — a slow-but-viable primary is
		// only preempted inside the last 15s.
		expect(capDurationToSessionDeadline(300_000, 90_000, true)).toBe(75_000);
		expect(capDurationToSessionDeadline(undefined, 90_000, true)).toBe(75_000);
		expect(capDurationToSessionDeadline(10_000, 90_000, true)).toBe(10_000);
	});

	it("never withholds more than half the remaining budget", () => {
		// Below 2x the reserve the fixed slice would starve the primary.
		expect(capDurationToSessionDeadline(undefined, 20_000, true)).toBe(10_000);
		expect(capDurationToSessionDeadline(undefined, 4_000, true)).toBe(2_000);
	});

	it("withholds only 1s when model fallback is off", () => {
		expect(capDurationToSessionDeadline(8_000, 60_000, false)).toBe(8_000);
		expect(capDurationToSessionDeadline(8_000, 2_000, false)).toBe(1_000);
	});
});
