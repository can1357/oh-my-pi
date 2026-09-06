import { describe, expect, test } from "bun:test";
import {
	AUTO_BACKGROUND_TIMEOUT_BUFFER_MS,
	resolveAutoBackgroundWaitMs,
} from "@oh-my-pi/pi-coding-agent/async/auto-background";

describe("resolveAutoBackgroundWaitMs", () => {
	test("waits the full threshold without a timeout", () => {
		expect(resolveAutoBackgroundWaitMs(1_000, undefined, "wall-clock")).toBe(1_000);
		expect(resolveAutoBackgroundWaitMs(60_000, undefined, "runtime")).toBe(60_000);
	});

	test("backgrounds immediately for a zero or negative threshold regardless of the timeout", () => {
		expect(resolveAutoBackgroundWaitMs(0, undefined, "wall-clock")).toBe(0);
		expect(resolveAutoBackgroundWaitMs(0, 500, "wall-clock")).toBe(0);
		expect(resolveAutoBackgroundWaitMs(-1, 60_000, "wall-clock")).toBe(0);
		expect(resolveAutoBackgroundWaitMs(0, 500, "runtime")).toBe(0);
	});

	test("wall-clock: never backgrounds when the deadline cannot outlive the threshold plus the buffer", () => {
		const threshold = 1_000;
		const boundary = threshold + AUTO_BACKGROUND_TIMEOUT_BUFFER_MS;
		expect(resolveAutoBackgroundWaitMs(threshold, 1, "wall-clock")).toBeUndefined();
		expect(resolveAutoBackgroundWaitMs(threshold, threshold, "wall-clock")).toBeUndefined();
		expect(resolveAutoBackgroundWaitMs(threshold, boundary, "wall-clock")).toBeUndefined();
		expect(resolveAutoBackgroundWaitMs(threshold, boundary + 1, "wall-clock")).toBe(threshold);
	});

	test("wall-clock: does not shorten the wait toward a longer deadline", () => {
		expect(resolveAutoBackgroundWaitMs(60_000, 300_000, "wall-clock")).toBe(60_000);
		expect(resolveAutoBackgroundWaitMs(60_000, 61_001, "wall-clock")).toBe(60_000);
		expect(resolveAutoBackgroundWaitMs(60_000, 61_000, "wall-clock")).toBeUndefined();
	});

	test("runtime: clamps the wait to just before the budget and never runs inline-only", () => {
		expect(resolveAutoBackgroundWaitMs(60_000, 30_000, "runtime")).toBe(30_000 - AUTO_BACKGROUND_TIMEOUT_BUFFER_MS);
		expect(resolveAutoBackgroundWaitMs(60_000, 300_000, "runtime")).toBe(60_000);
		expect(resolveAutoBackgroundWaitMs(60_000, AUTO_BACKGROUND_TIMEOUT_BUFFER_MS, "runtime")).toBe(0);
		expect(resolveAutoBackgroundWaitMs(60_000, 1, "runtime")).toBe(0);
	});
});
