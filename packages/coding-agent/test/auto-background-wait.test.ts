import { describe, expect, test } from "bun:test";
import {
	AUTO_BACKGROUND_TIMEOUT_BUFFER_MS,
	findBackgroundNotice,
	formatBackgroundNotice,
	formatJobLabel,
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

describe("background notice", () => {
	test("names the job's command so parallel results stay attributable out of order", () => {
		// Two auto-promoted bash calls return in completion order; without the
		// label the model pairs `bg_N` positionally against its own calls.
		const notice = formatBackgroundNotice("bg_5", formatJobLabel("uv run verify.py"));
		expect(notice).toBe("Backgrounded as job bg_5 (uv run verify.py); result will be delivered automatically.");
	});

	test("keeps a multi-line or oversized command on one notice line", () => {
		const label = formatJobLabel(`for f in *.png; do\n\t${"x".repeat(200)}\ndone`);
		expect(label).not.toContain("\n");
		expect(label.startsWith("for f in *.png; do x")).toBe(true);
		expect(label.length).toBe(120);
		expect(label.endsWith("...")).toBe(true);
	});

	test("finds the exact trailing notice for a job id without knowing its label", () => {
		const notice = formatBackgroundNotice("bg_7", formatJobLabel("sleep 30"));
		const text = `started\n\n${notice}`;
		expect(findBackgroundNotice(text, "bg_7")).toBe(notice);
		// A different job's notice, or output that merely mentions the prefix, never matches.
		expect(findBackgroundNotice(text, "bg_1")).toBeUndefined();
		expect(findBackgroundNotice("echo Backgrounded as job bg_7 (fake)", "bg_7")).toBeUndefined();
	});
});
