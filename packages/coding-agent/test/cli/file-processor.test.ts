/**
 * CLI `@file` video attachments become a compact PNG preview grid rather than
 * reading the whole container into memory. The fixture is deliberately over
 * the normal text-file limit: a normal video commonly exceeds 5 MiB, and the
 * processor must still seek frames through ffmpeg instead of skipping it.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { processFileArguments } from "@oh-my-pi/pi-coding-agent/cli/file-processor";
import { $which, removeWithRetries } from "@oh-my-pi/pi-utils";

const hasFfmpeg = Boolean($which("ffmpeg") && $which("ffprobe"));

describe.skipIf(!hasFfmpeg)("processFileArguments video attachments", () => {
	let testDir: string;
	let videoPath: string;

	beforeEach(async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "file-processor-video-"));
		videoPath = path.join(testDir, "clip.mp4");
		const process = Bun.spawn([
			"ffmpeg",
			"-hide_banner",
			"-loglevel",
			"error",
			"-y",
			"-f",
			"lavfi",
			"-i",
			"testsrc=duration=1:size=320x240:rate=30",
			"-pix_fmt",
			"yuv420p",
			"-c:v",
			"libx264",
			videoPath,
		]);
		expect(await process.exited).toBe(0);
		await fs.truncate(videoPath, 6 * 1024 * 1024);
	});

	afterEach(async () => {
		await removeWithRetries(testDir);
	});

	it("attaches a preview image for a video larger than the text-file limit", async () => {
		const processed = await processFileArguments([videoPath], { autoResizeImages: false });

		expect(processed.images).toHaveLength(1);
		expect(processed.images[0]?.mimeType).toBe("image/png");
		expect(processed.text).toContain("Video:");
		expect(processed.text).toContain("Preview grid: 6 frames (3x2)");
	});
});
