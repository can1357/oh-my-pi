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

	it("leaves half the remaining budget for a fallback hop", () => {
		expect(capDurationToSessionDeadline(300_000, 90_000, true)).toBe(45_000);
		expect(capDurationToSessionDeadline(undefined, 90_000, true)).toBe(45_000);
		expect(capDurationToSessionDeadline(10_000, 90_000, true)).toBe(10_000);
		expect(capDurationToSessionDeadline(8_000, 2_000, false)).toBe(1_000);
	});
});
