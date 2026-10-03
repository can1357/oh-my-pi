/**
 * Video selector parsing: bare integers are frame indices, timestamp shapes
 * are seek positions. Locks the `:412` vs `:1h5m42s` contract the read tool,
 * @mentions, and composer paste all share — a bare `:90` must stay a frame,
 * never silently become 90 seconds.
 */
import { describe, expect, it } from "bun:test";
import {
	formatVideoTimestamp,
	parseVideoSelector,
	parseVideoTimestamp,
	splitVideoReadTarget,
} from "@oh-my-pi/pi-coding-agent/utils/video";

describe("parseVideoSelector", () => {
	it("reads a bare integer as a frame index", () => {
		expect(parseVideoSelector("412")).toEqual({ kind: "frame", frame: 412 });
	});

	it("reads f/frame-prefixed integers as frame indices", () => {
		expect(parseVideoSelector("f7")).toEqual({ kind: "frame", frame: 7 });
		expect(parseVideoSelector("frame102")).toEqual({ kind: "frame", frame: 102 });
	});

	it("reads unit timestamps as seek positions", () => {
		expect(parseVideoSelector("90s")).toEqual({ kind: "time", seconds: 90, raw: "90s" });
		expect(parseVideoSelector("1h5m42s")).toEqual({ kind: "time", seconds: 3942, raw: "1h5m42s" });
		expect(parseVideoSelector("5m30s")).toEqual({ kind: "time", seconds: 330, raw: "5m30s" });
	});

	it("reads colon timestamps as seek positions", () => {
		expect(parseVideoSelector("01:23")).toEqual({ kind: "time", seconds: 83, raw: "01:23" });
		expect(parseVideoSelector("1:02:03")).toEqual({ kind: "time", seconds: 3723, raw: "1:02:03" });
	});

	it("reads fractional seconds as a seek position, not a frame", () => {
		expect(parseVideoSelector("42.5")).toEqual({ kind: "time", seconds: 42.5, raw: "42.5" });
	});

	it("rejects line-range shapes so text selectors stay text errors", () => {
		expect(parseVideoSelector("50-200")).toBeNull();
		expect(parseVideoSelector("raw")).toBeNull();
		expect(parseVideoSelector("img")).toBeNull();
		expect(parseVideoSelector(undefined)).toBeNull();
	});
});

describe("parseVideoTimestamp", () => {
	it("parses minute-only units", () => {
		expect(parseVideoTimestamp("5m")).toBe(300);
	});

	it("rejects non-timestamp shapes", () => {
		expect(parseVideoTimestamp("412")).toBeNull();
		expect(parseVideoTimestamp("abc")).toBeNull();
	});
});

describe("formatVideoTimestamp", () => {
	it("formats sub-hour positions as m:ss", () => {
		expect(formatVideoTimestamp(83)).toBe("1:23");
	});

	it("formats hour positions with h/m/s units", () => {
		expect(formatVideoTimestamp(3942)).toBe("1h5m42s");
	});
});

describe("splitVideoReadTarget", () => {
	it("splits a timestamp suffix off a video path", () => {
		expect(splitVideoReadTarget("clip.mp4:1h5m42s")).toEqual({ path: "clip.mp4", sel: "1h5m42s" });
	});

	it("splits a frame suffix off a video path", () => {
		expect(splitVideoReadTarget("clip.mp4:412")).toEqual({ path: "clip.mp4", sel: "412" });
	});

	it("leaves non-video paths and non-selector suffixes alone", () => {
		expect(splitVideoReadTarget("notes.txt:12")).toBeNull();
		expect(splitVideoReadTarget("clip.mp4:50-200")).toBeNull();
		expect(splitVideoReadTarget("clip.mp4")).toBeNull();
	});
});
