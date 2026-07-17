import { describe, expect, it } from "bun:test";
import { segmentFramesIntoClips } from "../src/segmentation";
import { frame } from "./fixtures";

describe("segmentFramesIntoClips", () => {
	it("keeps contiguous same-app frames within the idle window in one segment", () => {
		const frames = [
			frame({ id: 1, timestamp: "2026-07-13T14:00:00.000Z" }),
			frame({ id: 2, timestamp: "2026-07-13T14:01:00.000Z" }),
			frame({ id: 3, timestamp: "2026-07-13T14:02:00.000Z" }),
		];

		const segments = segmentFramesIntoClips(frames, { maximumIdleMs: 5 * 60_000 });

		expect(segments).toHaveLength(1);
		expect(segments[0]?.frames.map(f => f.id)).toEqual([1, 2, 3]);
		expect(segments[0]?.window).toEqual({
			startedAt: "2026-07-13T14:00:00.000Z",
			endedAt: "2026-07-13T14:02:00.000Z",
		});
		expect(segments[0]?.appIdentity).toEqual({ processName: "code" });
	});

	it("splits a segment when the app changes", () => {
		const frames = [
			frame({ id: 1, timestamp: "2026-07-13T14:00:00.000Z", app_name: "code" }),
			frame({ id: 2, timestamp: "2026-07-13T14:00:30.000Z", app_name: "firefox", window_name: "docs" }),
		];

		const segments = segmentFramesIntoClips(frames, { maximumIdleMs: 5 * 60_000 });

		expect(segments).toHaveLength(2);
		expect(segments.map(s => s.appIdentity.processName)).toEqual(["code", "firefox"]);
	});

	it("splits a segment when the idle gap is exceeded", () => {
		const frames = [
			frame({ id: 1, timestamp: "2026-07-13T14:00:00.000Z" }),
			frame({ id: 2, timestamp: "2026-07-13T14:10:00.000Z" }),
		];

		const segments = segmentFramesIntoClips(frames, { maximumIdleMs: 60_000 });

		expect(segments).toHaveLength(2);
	});

	it("segments each device independently", () => {
		const frames = [
			frame({ id: 1, timestamp: "2026-07-13T14:00:00.000Z", device_name: "laptop" }),
			frame({ id: 2, timestamp: "2026-07-13T14:00:30.000Z", device_name: "desktop", app_name: "slack" }),
		];

		const segments = segmentFramesIntoClips(frames, { maximumIdleMs: 5 * 60_000 });

		expect(segments).toHaveLength(2);
		expect(segments.map(s => s.deviceName).sort()).toEqual(["desktop", "laptop"]);
	});

	it("derives a browser origin from browser_url, dropping the path and query", () => {
		const frames = [
			frame({
				id: 1,
				timestamp: "2026-07-13T14:00:00.000Z",
				app_name: "firefox",
				browser_url: "https://example.com/secret/path?token=abc",
			}),
		];

		const segments = segmentFramesIntoClips(frames);

		expect(segments[0]?.appIdentity).toEqual({ processName: "firefox", browserOrigin: "https://example.com" });
	});

	it("pads a single-frame segment so its window has nonzero duration", () => {
		const frames = [frame({ id: 1, timestamp: "2026-07-13T14:00:00.000Z" })];

		const segments = segmentFramesIntoClips(frames);

		expect(segments[0]?.window).toEqual({
			startedAt: "2026-07-13T14:00:00.000Z",
			endedAt: "2026-07-13T14:00:01.000Z",
		});
	});

	it("does not merge distinct app/window pairs whose concatenation collides", () => {
		const frames = [
			frame({ id: 1, timestamp: "2026-07-13T14:00:00.000Z", app_name: "A", window_name: "B C" }),
			frame({ id: 2, timestamp: "2026-07-13T14:00:30.000Z", app_name: "A B", window_name: "C" }),
		];

		const segments = segmentFramesIntoClips(frames, { maximumIdleMs: 5 * 60_000 });

		expect(segments).toHaveLength(2);
	});

	it("rejects a non-positive maximumIdleMs", () => {
		expect(() => segmentFramesIntoClips([], { maximumIdleMs: 0 })).toThrow(
			"maximumIdleMs must be a positive integer",
		);
	});

	it("returns no segments for no frames", () => {
		expect(segmentFramesIntoClips([])).toEqual([]);
	});
});
