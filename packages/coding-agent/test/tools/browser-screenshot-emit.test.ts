import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageTokenization } from "@oh-my-pi/pi-catalog/compat/image-tokenization";
import { PointerSpace } from "@oh-my-pi/pi-coding-agent/tools/browser/pointer-space";
import { RunOutput } from "@oh-my-pi/pi-coding-agent/tools/browser/run-output";
import { emitScreenshot, type ScreenshotCapture } from "@oh-my-pi/pi-coding-agent/tools/browser/screenshot";
import type { ScreenshotResult, SessionSnapshot } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-protocol";
import { encodeRawPng } from "@oh-my-pi/pi-coding-agent/utils/png-encode";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";

/** Claude's standard tier: images past 1,568 28px patches are shrunk by the API. */
const STANDARD: ImageTokenization = { regime: "anthropic-patch", maxEdge: 1568, maxTokens: 1568 };
const HIRES: ImageTokenization = { regime: "anthropic-patch", maxEdge: 2576, maxTokens: 4784 };
/** A GPT line whose default level (`auto` = `high`) keeps fewer patches than `original` does. */
const GPT_AUTO_HIGH: ImageTokenization = {
	regime: "openai-patch",
	multiplier: 1.2,
	auto: "high",
	low: { maxEdge: 512 },
	high: { maxEdge: 2048, patchBudget: 2500 },
	original: { maxEdge: 6000, patchBudget: 10_000 },
};

const stored: string[] = [];

afterEach(async () => {
	await Promise.all(stored.splice(0).map(file => fs.rm(file, { force: true })));
});

interface Emitted {
	dest: string;
	/** The capture's line (and notes) as the model reads it. */
	text: string;
	imageCount: number;
	screenshots: ScreenshotResult[];
	/** Size of the stored file's image. */
	stored: { width: number; height: number };
}

/** Emit a blank `width`x`height` PNG capture. */
async function emit(
	width: number,
	height: number,
	capture: Partial<ScreenshotCapture> = {},
	options: { session?: Partial<SessionSnapshot>; pointer?: PointerSpace } = {},
): Promise<Emitted> {
	const output = new RunOutput();
	const screenshots: ScreenshotResult[] = [];
	const dest = await emitScreenshot(
		{
			bytes: encodeRawPng(new Uint8Array(width * height * 3), width, height, 3),
			mimeType: "image/png",
			area: "viewport",
			scale: 1,
			...capture,
		},
		{
			session: { cwd: os.tmpdir(), ...options.session },
			output,
			screenshots,
			pointer: options.pointer ?? new PointerSpace(),
		},
	);
	stored.push(dest);
	const displays = output.finish();
	const metadata = await new Bun.Image(await fs.readFile(dest)).metadata();
	return {
		dest,
		text: displays.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n"),
		imageCount: displays.filter(block => block.type === "image").length,
		screenshots,
		stored: { width: metadata.width, height: metadata.height },
	};
}

describe("emitScreenshot", () => {
	it.each([
		// The reported capture: a 1003x903 viewport at omp's 1.25 device scale came back 1024x922 with a factor.
		{ name: "a 1.25x capture", device: [1254, 1129], scale: 1.25, css: [1003, 903] },
		// Already in CSS pixels: nothing to resample.
		{ name: "a 1x capture", device: [1365, 768], scale: 1, css: [1365, 768] },
	])("shows $name in CSS pixels, with nothing to convert", async ({ device, scale, css }) => {
		const shot = await emit(device[0], device[1], { scale });

		expect(shot.text).toBe(`Screenshot ${css[0]}x${css[1]}.`);
		expect(shot.imageCount).toBe(1);
		expect(shot.stored).toEqual({ width: css[0], height: css[1] });
		expect(shot.screenshots).toEqual([expect.objectContaining({ dest: shot.dest, width: css[0], height: css[1] })]);
	});

	it("scales a viewport past the size cap and reads pointer positions on that image", async () => {
		const pointer = new PointerSpace();
		const shot = await emit(2500, 1250, {}, { pointer });

		expect(shot.stored).toEqual({ width: 2000, height: 1000 });
		expect(shot.text).toContain("Screenshot 2000x1000.");
		expect(shot.text).toContain("2500x1250 viewport");
		expect(shot.text).toContain("{css: true}");
		// The image's centre is the viewport's centre; a page-measured position passes through.
		expect(pointer.toViewport({ x: 1000, y: 500 })).toEqual({ x: 1250, y: 625 });
		expect(pointer.toViewport({ x: 1250, y: 625, css: true })).toEqual({ x: 1250, y: 625 });
	});

	it("sizes a viewport for the detail level the model's wire sends", async () => {
		// 2000x1500 is 63x47 patches of 32px: more than the 2,500 the default level keeps, which leaves 57x43.
		const dropped = await emit(2000, 1500, {}, { session: { screenshotLimits: { tokenization: GPT_AUTO_HIGH } } });
		const sent = await emit(
			2000,
			1500,
			{},
			{ session: { screenshotLimits: { tokenization: GPT_AUTO_HIGH, detail: "original" } } },
		);

		expect(Math.ceil(dropped.stored.width / 32)).toBe(57);
		expect(Math.ceil(dropped.stored.height / 32)).toBe(43);
		expect(sent.stored).toEqual({ width: 2000, height: 1500 });
	});

	it.each([
		// 1440x900 is 1,716 patches: the standard tier would shrink it to 1389x868 after the size was reported.
		{ name: "the model's own resize", limits: { tokenization: STANDARD }, size: [1389, 868] },
		{ name: "a model that takes it whole", limits: { tokenization: HIRES }, size: [1440, 900] },
		{ name: "the host's edge cap", limits: { maxEdge: 1024 }, size: [1024, 640] },
	])("sizes a 1440x900 viewport for $name", async ({ limits, size }) => {
		const pointer = new PointerSpace();
		const shot = await emit(1440, 900, {}, { session: { screenshotLimits: limits }, pointer });

		expect(shot.stored).toEqual({ width: size[0], height: size[1] });
		// Whatever size the model sees, the image's right edge is the viewport's.
		expect(pointer.toViewport({ x: size[0], y: 0 }).x).toBeCloseTo(1440, 6);
	});

	it("returns the pointer helpers to CSS pixels once a screenshot is in them again", async () => {
		const pointer = new PointerSpace();
		await emit(2500, 1250, {}, { pointer });
		await emit(1280, 720, {}, { pointer });

		expect(pointer.toViewport({ x: 1000, y: 500 })).toEqual({ x: 1000, y: 500 });
	});

	it("keeps an explicit factor for a full-page capture and leaves the pointer helpers on the viewport", async () => {
		const pointer = new PointerSpace();
		await emit(2500, 1250, {}, { pointer });
		const page = await emit(1365, 5000, { area: "page" }, { pointer });

		expect(page.stored).toEqual({ width: 546, height: 2000 });
		expect(page.text).toContain(
			"Multiply image coordinates by 2.50 to get CSS pixels from the page's top-left corner",
		);
		expect(pointer.toViewport({ x: 1000, y: 500 })).toEqual({ x: 1250, y: 625 });
	});

	it("enlarges an element crop under the vision floor and says how it maps", async () => {
		// A 100x30 CSS px button captured at 2x: 200x60 device pixels.
		const shot = await emit(200, 60, { area: "element", scale: 2 });

		expect(shot.stored).toEqual({ width: 667, height: 200 });
		expect(shot.text).toContain("by 0.15 to get CSS pixels from the element's top-left corner");
	});

	it("says the mapping is unknown instead of guessing one, and stops reading positions on images", async () => {
		const pointer = new PointerSpace();
		await emit(2500, 1250, {}, { pointer });
		const shot = await emit(2000, 1000, { scale: undefined }, { pointer });

		expect(shot.text).toContain("scale to CSS pixels could not be read");
		expect(pointer.toViewport({ x: 1000, y: 500 })).toEqual({ x: 1000, y: 500 });
	});

	it("stores a silent capture without showing it or moving the pointer helpers", async () => {
		const pointer = new PointerSpace();
		await emit(2500, 1250, {}, { pointer });
		const shot = await emit(1280, 720, { silent: true }, { pointer });

		expect(shot.text).toBe("");
		expect(shot.imageCount).toBe(0);
		expect(shot.screenshots).toHaveLength(1);
		expect(pointer.toViewport({ x: 1000, y: 500 })).toEqual({ x: 1250, y: 625 });
	});

	it("keeps the capture itself under a screenshot directory and names it", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-screenshot-emit-"));
		try {
			const shot = await emit(2730, 1536, { scale: 2 }, { session: { browserScreenshotDir: dir } });

			expect(path.dirname(shot.dest)).toBe(dir);
			// The file is the 2x capture; the model still sees the viewport in CSS pixels.
			expect(shot.stored).toEqual({ width: 2730, height: 1536 });
			expect(shot.screenshots[0]).toMatchObject({ width: 1365, height: 768, mimeType: "image/png" });
			expect(shot.text).toStartWith("Screenshot 1365x768, full size saved to ");
			expect(shot.text).toContain(path.basename(shot.dest));
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("shows a capture it cannot decode as it is, and still maps positions on it", async () => {
		// A PNG header with no image data: its size is readable, its pixels are not.
		const png = Buffer.alloc(33);
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
		png.writeUInt32BE(13, 8);
		png.write("IHDR", 12, "ascii");
		png.writeUInt32BE(1900, 16);
		png.writeUInt32BE(1200, 20);
		png[24] = 8;
		png[25] = 2;
		const output = new RunOutput();
		const pointer = new PointerSpace();
		const dest = await emitScreenshot(
			{ bytes: png, mimeType: "image/png", area: "viewport", scale: 2 },
			{ session: { cwd: os.tmpdir() }, output, screenshots: [], pointer },
		);
		stored.push(dest);

		const text = output
			.finish()
			.flatMap(block => (block.type === "text" ? [block.text] : []))
			.join("\n");
		expect(text).toContain("Screenshot 1900x1200.");
		expect(text).toContain("The image decoder failed");
		expect(pointer.toViewport({ x: 1900, y: 1200 })).toEqual({ x: 950, y: 600 });
	});
});

describe("PointerSpace", () => {
	const frame = { viewport: { width: 1920, height: 1080 }, left: 0, top: 0, width: 1568, height: 882 };

	it("maps through the padding of an image whose viewport does not fill it", () => {
		const pointer = new PointerSpace();
		// A 1000x10 viewport drawn 1568x16 in the middle of a 1568x200 image.
		pointer.use({ viewport: { width: 1000, height: 10 }, left: 0, top: 92, width: 1568, height: 16 });

		expect(pointer.toViewport({ x: 784, y: 100 })).toEqual({ x: 500, y: 5 });
	});

	it("refuses image positions once the viewport is another size, until a new screenshot", () => {
		const pointer = new PointerSpace();
		pointer.use(frame);

		// A pixel of difference is the capture's rounding.
		expect(pointer.toViewport({ x: 784, y: 441 }, { width: 1921, height: 1080 })).toEqual({ x: 960, y: 540 });
		expect(() => pointer.toViewport({ x: 784, y: 441 }, { width: 1280, height: 800 })).toThrow(ToolError);
		// Page-measured positions never depended on the screenshot.
		expect(pointer.toViewport({ x: 640, y: 400, css: true }, { width: 1280, height: 800 })).toEqual({
			x: 640,
			y: 400,
		});

		pointer.resized({ width: 1280, height: 800 });
		expect(() => pointer.toViewport({ x: 784, y: 441 })).toThrow(/new screenshot/);
		pointer.use({ viewport: { width: 1280, height: 800 }, left: 0, top: 0, width: 640, height: 400 });
		expect(pointer.toViewport({ x: 320, y: 200 })).toEqual({ x: 640, y: 400 });
	});
});
