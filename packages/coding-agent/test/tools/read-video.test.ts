/**
 * Video reads through system ffmpeg: a bare read returns a contact-sheet
 * preview grid plus a metadata text block, while `:frame` / `:timestamp`
 * selectors extract a single frame. Requires ffmpeg + ffprobe on PATH.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { $which, removeWithRetries } from "@oh-my-pi/pi-utils";

const hasFfmpeg = Boolean($which("ffmpeg") && $which("ffprobe"));

function makeSession(testDir: string, inspectImageActive = false): ToolSession {
	const sessionFile = path.join(testDir, "session.jsonl");
	return {
		cwd: testDir,
		hasUI: false,
		getSessionFile: () => sessionFile,
		getArtifactsDir: () => sessionFile.slice(0, -6),
		getSessionSpawns: () => null,
		isToolActive: (name: string) => inspectImageActive && name === "inspect_image",
		settings: Settings.isolated({ "images.autoResize": false }),
	} as unknown as ToolSession;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(c => c.type === "text")
		.map(c => c.text ?? "")
		.join("\n");
}

describe.skipIf(!hasFfmpeg)("read video", () => {
	let testDir: string;
	let clipPath: string;

	beforeEach(async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-video-"));
		clipPath = path.join(testDir, "clip.mp4");
		const proc = Bun.spawn([
			"ffmpeg",
			"-hide_banner",
			"-loglevel",
			"error",
			"-y",
			"-f",
			"lavfi",
			"-i",
			"testsrc=duration=12:size=320x240:rate=30",
			"-pix_fmt",
			"yuv420p",
			"-c:v",
			"libx264",
			clipPath,
		]);
		const exit = await proc.exited;
		expect(exit).toBe(0);
	});

	afterEach(async () => {
		await removeWithRetries(testDir);
	});

	it("returns a preview grid plus metadata for a bare read", async () => {
		const tool = new ReadTool(makeSession(testDir));

		const result = await tool.execute("call", { path: clipPath });

		const text = textOf(result);
		expect(text).toContain("Video preview grid");
		expect(text).toContain("320x240");
		expect(text).toContain("h264");
		expect(text).toContain("FPS");
		const image = result.content.find(c => c.type === "image");
		expect(image).toBeDefined();
		expect(image && "mimeType" in image ? image.mimeType : undefined).toBe("image/png");
		const png = image?.type === "image" ? Buffer.from(image.data, "base64") : Buffer.alloc(0);
		expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
	});

	it("finishes a preview read with an active, non-aborted tool signal", async () => {
		const tool = new ReadTool(makeSession(testDir));
		const controller = new AbortController();

		const result = await tool.execute("call", { path: clipPath }, controller.signal);

		expect(result.content.find(c => c.type === "image")).toBeDefined();
	}, 5000);

	it("tiles every extracted frame into the preview grid", async () => {
		const tool = new ReadTool(makeSession(testDir));

		const result = await tool.execute("call", { path: clipPath });
		const image = result.content.find(c => c.type === "image");
		expect(image?.type).toBe("image");
		if (image?.type !== "image") return;
		const sheetPath = path.join(testDir, "sheet.png");
		await Bun.write(sheetPath, Buffer.from(image.data, "base64"));
		// The second cell of the top row must hold a real frame, not tile
		// padding: feeding still inputs straight to `tile` fills only the
		// first cell and leaves the rest black.
		const child = Bun.spawn(
			[
				"ffmpeg",
				"-hide_banner",
				"-loglevel",
				"error",
				"-i",
				sheetPath,
				"-vf",
				"crop=320:240:320:0",
				"-frames:v",
				"1",
				"-f",
				"rawvideo",
				"-pix_fmt",
				"gray",
				"pipe:1",
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
		const chunks: Uint8Array[] = [];
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value) chunks.push(value);
		}
		const exit = await child.exited;
		expect(exit).toBe(0);
		const pixels = Buffer.concat(chunks);
		expect(pixels.length).toBe(320 * 240);
		const mean = pixels.reduce((sum, pixel) => sum + pixel, 0) / pixels.length;
		expect(mean).toBeGreaterThan(5);
	});

	it("extracts a single frame for a timestamp selector", async () => {
		const tool = new ReadTool(makeSession(testDir));

		const result = await tool.execute("call", { path: `${clipPath}:0:05` });

		expect(textOf(result)).toContain("Video frame");
		expect(textOf(result)).toContain("320x240");
		const image = result.content.find(c => c.type === "image");
		expect(image?.type).toBe("image");
	});

	it("extracts a single frame for a bare frame index", async () => {
		const tool = new ReadTool(makeSession(testDir));

		const result = await tool.execute("call", { path: `${clipPath}:100` });

		expect(textOf(result)).toContain("frame 100");
		expect(result.content.find(c => c.type === "image")).toBeDefined();
	});

	it("rejects line-range selectors with a video-specific hint", async () => {
		const tool = new ReadTool(makeSession(testDir));

		const error = await tool.execute("call", { path: `${clipPath}:50-200` }).catch(e => e);
		expect(String(error?.message ?? error)).toContain(":<frame>");
	});

	it("returns metadata without pixels when inspect_image is active", async () => {
		const tool = new ReadTool(makeSession(testDir, true));

		const result = await tool.execute("call", { path: clipPath });

		expect(textOf(result)).toContain("320x240");
		expect(result.content.find(c => c.type === "image")).toBeUndefined();
	});
});
