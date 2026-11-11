import { describe, expect, it } from "bun:test";
import { formatDuration, truncate } from "@oh-my-pi/pi-utils/format";

describe("formatDuration", () => {
	// Codex's wham/usage endpoint returns the prior window's reset_at until the
	// next request opens a fresh window, so the `resetsAt - now` delta can land
	// in the recent past. The util must defend against that — older builds
	// rendered "-612090ms", which leaked straight into the /usage TUI.
	it("clamps non-positive, NaN, and Infinity inputs to 0ms", () => {
		expect(formatDuration(-612_090)).toBe("0ms");
		expect(formatDuration(-1)).toBe("0ms");
		expect(formatDuration(0)).toBe("0ms");
		expect(formatDuration(Number.NaN)).toBe("0ms");
		expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("0ms");
		expect(formatDuration(Number.NEGATIVE_INFINITY)).toBe("0ms");
	});

	it("formats sub-second, sub-minute, sub-hour, sub-day, and multi-day ranges", () => {
		expect(formatDuration(500)).toBe("500ms");
		expect(formatDuration(289.99999999999994)).toBe("289ms");
		expect(formatDuration(1_500)).toBe("1.5s");
		expect(formatDuration(90_000)).toBe("1m30s");
		expect(formatDuration(3_600_000)).toBe("1h");
		expect(formatDuration(3_660_000)).toBe("1h1m");
		expect(formatDuration(2 * 86_400_000 + 3_600_000)).toBe("2d1h");
	});

	it("never prints a 60-second remainder at the minute boundary", () => {
		expect(formatDuration(59_940)).toBe("59.9s");
		expect(formatDuration(59_960)).toBe("1m");
		expect(formatDuration(119_600)).toBe("1m59s");
	});
});

describe("truncate", () => {
	it("retains leading or trailing slices within maxLen and handles zero remaining budget", () => {
		expect(truncate("abcdef", 6)).toBe("abcdef");
		expect(truncate("abcdef", 6, { direction: "tail" })).toBe("abcdef");
		expect(truncate("abcdef", 4)).toBe("abc…");
		expect(truncate("abcdef", 5, "..")).toBe("abc..");
		expect(truncate("abcdef", 4, { direction: "tail" })).toBe("…def");
		expect(truncate("abcdef", 5, { direction: "tail", ellipsis: ".." })).toBe("..def");
		expect(truncate("abcdef", 1, { direction: "tail" })).toBe("…");
		expect(truncate("abcdef", 0, { direction: "tail" })).toBe("…");
	});
});
