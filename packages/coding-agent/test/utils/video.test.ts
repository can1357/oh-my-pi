/**
 * Video selector parsing: bare integers are frame indices, timestamp shapes
 * are seek positions. Locks the `:412` vs `:1h5m42s` contract the read tool,
 * @mentions, and composer paste all share — a bare `:90` must stay a frame,
 * never silently become 90 seconds.
 *
 * Under the OS sandbox the media binaries never open the path themselves: they read the verified
 * file as stdin, or on ffmpeg before 6.0 a private copy made once per operation. The contained
 * cases skip where no sandbox backend (or, for the stdin cases, an ffmpeg 6.0+ on PATH) exists.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { withContainedFileAccess } from "@oh-my-pi/pi-coding-agent/sandbox/file-access";
import {
	buildVideoContactSheetPng,
	extractVideoFramePng,
	formatVideoTimestamp,
	parseVideoSelector,
	parseVideoTimestamp,
	probeVideo,
	splitVideoReadTarget,
	type VideoMetadata,
} from "@oh-my-pi/pi-coding-agent/utils/video";
import {
	beginContainedSandboxTest,
	type ContainedSandboxTest,
	containedToolSession,
	endContainedSandboxTest,
	SANDBOX_BACKEND_PRESENT,
} from "../helpers/sandbox-test-state";

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

/** Major version of the `ffmpeg`/`ffprobe` on PATH; undefined when absent or unnumbered. */
function binaryMajor(name: "ffmpeg" | "ffprobe"): number | undefined {
	try {
		const out = Bun.spawnSync([name, "-version"]).stdout.toString();
		const match = /^\S+ version n?(\d+)\./.exec(out);
		return match ? Number(match[1]) : undefined;
	} catch {
		return undefined;
	}
}

const modernMedia = (binaryMajor("ffmpeg") ?? 0) >= 6 && (binaryMajor("ffprobe") ?? 0) >= 6;

let fixture: ContainedSandboxTest;
let workspace: string;

describe.skipIf(!SANDBOX_BACKEND_PRESENT || process.platform === "win32")("media input under the OS sandbox", () => {
	beforeEach(async () => {
		fixture = await beginContainedSandboxTest("video-input");
		workspace = fixture.workspace;
	});

	afterEach(() => endContainedSandboxTest(fixture));

	it.skipIf(!modernMedia)("probes, extracts a frame and builds a contact sheet from the verified handle", async () => {
		const clip = path.join(workspace, "clip.mp4");
		const made = Bun.spawnSync([
			"ffmpeg",
			"-v",
			"error",
			"-y",
			"-f",
			"lavfi",
			"-i",
			"testsrc=duration=2:size=64x48:rate=25",
			"-c:v",
			"mpeg4",
			clip,
		]);
		expect(made.exitCode).toBe(0);
		await withContainedFileAccess(containedToolSession(fixture), async () => {
			const meta = await probeVideo(clip);
			expect(meta.width).toBe(64);
			expect(meta.height).toBe(48);
			expect(meta.durationSec).toBeCloseTo(2, 0);
			const frame = await extractVideoFramePng(clip, { kind: "time", seconds: 1, raw: "1s" });
			expect(frame.data.length).toBeGreaterThan(0);
			const sheet = await buildVideoContactSheetPng(clip, meta);
			expect(sheet.thumbs).toBe(6);
		});
	});

	it("copies the file once for all runs of an operation on an ffmpeg before 6.0, and removes the copy", async () => {
		const fakeBin = path.join(path.dirname(workspace), "bin");
		const log = path.join(fakeBin, "inputs.log");
		fs.mkdirSync(fakeBin);
		fs.writeFileSync(log, "");
		// An ffmpeg 5.1 that logs its first input and writes a stand-in output.
		fs.writeFileSync(
			path.join(fakeBin, "ffmpeg"),
			[
				"#!/bin/sh",
				'if [ "$1" = "-version" ]; then echo "ffmpeg version 5.1.2"; exit 0; fi',
				'prev=""',
				'for a in "$@"; do',
				'  if [ "$prev" = "-i" ]; then echo "$a" >> "$(dirname "$0")/inputs.log"; break; fi',
				'  prev="$a"',
				"done",
				"for last; do :; done",
				'printf png > "$last"',
				"",
			].join("\n"),
			{ mode: 0o755 },
		);
		process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`;
		const clip = path.join(workspace, "clip.mp4");
		fs.writeFileSync(clip, "not really a video");
		const meta: VideoMetadata = {
			durationSec: 6,
			videoCodec: undefined,
			audioCodec: undefined,
			width: undefined,
			height: undefined,
			fps: undefined,
			formatName: undefined,
		};
		await withContainedFileAccess(containedToolSession(fixture), async () => {
			const sheet = await buildVideoContactSheetPng(clip, meta);
			expect(sheet.thumbs).toBe(6);
		});
		const copies = fs
			.readFileSync(log, "utf-8")
			.split("\n")
			.filter(line => path.basename(line) === "input.mp4");
		// One run per thumbnail, all over the same private copy of the file, which is gone afterwards.
		expect(copies).toHaveLength(6);
		expect(new Set(copies).size).toBe(1);
		expect(copies[0]).not.toBe(clip);
		expect(fs.existsSync(copies[0]!)).toBe(false);
	});
});
