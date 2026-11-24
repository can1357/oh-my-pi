import { describe, expect, it } from "bun:test";
import {
	AUTOMATIC_RETRY_JITTER_WINDOW_MS,
	automaticRetryJitterMs,
} from "../src/session/turn-recovery";

describe("automaticRetryJitterMs", () => {
	it("is deterministic for the same session id", () => {
		const id = "pi:01a20077-be4f-701f-9a95-7ed6cd4f7051";
		expect(automaticRetryJitterMs(id, AUTOMATIC_RETRY_JITTER_WINDOW_MS)).toBe(
			automaticRetryJitterMs(id, AUTOMATIC_RETRY_JITTER_WINDOW_MS),
		);
	});

	it("stays within [0, windowMs)", () => {
		for (let i = 0; i < 500; i++) {
			const offset = automaticRetryJitterMs(`session-${i}`, AUTOMATIC_RETRY_JITTER_WINDOW_MS);
			expect(offset).toBeGreaterThanOrEqual(0);
			expect(offset).toBeLessThan(AUTOMATIC_RETRY_JITTER_WINDOW_MS);
		}
	});

	it("spreads distinct session ids across the window", () => {
		const offsets = new Set<number>();
		for (let i = 0; i < 200; i++) {
			offsets.add(
				automaticRetryJitterMs(
					`pi:00000000-0000-7000-8000-${String(i).padStart(12, "0")}`,
					AUTOMATIC_RETRY_JITTER_WINDOW_MS,
				),
			);
		}
		// A lockstep resume storm needs distinct offsets: 200 ids must land on
		// many different offsets, never collapse to one or a few.
		expect(offsets.size).toBeGreaterThan(100);
	});

	it("maps an empty id to zero without throwing", () => {
		expect(automaticRetryJitterMs("", AUTOMATIC_RETRY_JITTER_WINDOW_MS)).toBe(0);
	});

	it("returns zero for a zero window (the exact-clock test seam)", () => {
		expect(automaticRetryJitterMs("any-session", 0)).toBe(0);
		expect(automaticRetryJitterMs("any-session", -1)).toBe(0);
	});

	it("scales offsets into a smaller window", () => {
		for (let i = 0; i < 200; i++) {
			expect(automaticRetryJitterMs(`session-${i}`, 100)).toBeLessThan(100);
		}
	});
});
