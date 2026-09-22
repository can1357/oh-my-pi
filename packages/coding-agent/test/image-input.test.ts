import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ANTHROPIC_IMAGE_MAX_DIMENSION } from "@oh-my-pi/pi-ai/providers/anthropic";
import { readImageMetadata, removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import { loadImageInput } from "../src/utils/image-loading";
import { InvalidImageDataError } from "@oh-my-pi/pi-tui/chat/image-loading";

const RED_1X1_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

describe("readImageMetadata", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-image-input-"));
	});

	afterEach(() => {
		removeSyncWithRetries(testDir);
	});

	it("reads PNG metadata from header", async () => {
		const pngHeader = Buffer.from([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00,
			0x00, 0x04, 0x00, 0x00, 0x00, 0x03, 0x08, 0x06, 0x00, 0x00, 0x00,
		]);
		const imagePath = path.join(testDir, "header-only.png");
		fs.writeFileSync(imagePath, pngHeader);

		const metadata = await readImageMetadata(imagePath);
		expect(metadata).not.toBeNull();
		expect(metadata?.mimeType).toBe("image/png");
		expect(metadata?.width).toBe(4);
		expect(metadata?.height).toBe(3);
		expect(metadata?.channels).toBe(4);
		expect(metadata?.hasAlpha).toBe(true);
	});

	it("reads JPEG metadata from header", async () => {
		const jpegHeader = Buffer.from([
			0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x02, 0x00, 0x03, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00,
			0x03, 0x11, 0x00, 0xff, 0xd9,
		]);
		const imagePath = path.join(testDir, "header-only.jpg");
		fs.writeFileSync(imagePath, jpegHeader);

		const metadata = await readImageMetadata(imagePath);
		expect(metadata).not.toBeNull();
		expect(metadata?.mimeType).toBe("image/jpeg");
		expect(metadata?.width).toBe(3);
		expect(metadata?.height).toBe(2);
		expect(metadata?.channels).toBe(3);
		expect(metadata?.hasAlpha).toBe(false);
	});

	it("returns null for non-image content", async () => {
		const textPath = path.join(testDir, "not-image.bin");
		fs.writeFileSync(textPath, "plain text");

		const metadata = await readImageMetadata(textPath);
		expect(metadata).toBeNull();
	});

	it("rejects a PNG whose compressed stream is missing bytes", async () => {
		const whole = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
			"base64",
		);
		const imagePath = path.join(testDir, "middle-elided.png");
		fs.writeFileSync(imagePath, Buffer.concat([whole.subarray(0, 20), whole.subarray(40)]));

		const loading = loadImageInput({ path: imagePath, cwd: testDir, autoResize: false });
		await expect(loading).rejects.toBeInstanceOf(InvalidImageDataError);
	});

	it("downscales an oversized image to the shared long-edge cap when reading it for the model", async () => {
		const seed = Buffer.from(RED_1X1_PNG_BASE64, "base64");
		const png = await new Bun.Image(seed).resize(3000, 1800, { filter: "nearest" }).png().bytes();
		const imagePath = path.join(testDir, "screenshot.png");
		fs.writeFileSync(imagePath, png);

		const loaded = await loadImageInput({ path: imagePath, cwd: testDir, autoResize: true });

		expect(loaded).toBeDefined();
		const { width, height } = await new Bun.Image(Buffer.from(loaded!.data, "base64")).metadata();
		expect(width).toBe(ANTHROPIC_IMAGE_MAX_DIMENSION);
		expect(height).toBe(Math.round((1800 * ANTHROPIC_IMAGE_MAX_DIMENSION) / 3000));
		expect(loaded!.dimensionNote).toContain("original 3000x1800");
	});

	it("keeps an image under the cap byte-identical", async () => {
		const seed = Buffer.from(RED_1X1_PNG_BASE64, "base64");
		const png = await new Bun.Image(seed).resize(400, 300, { filter: "nearest" }).png().bytes();
		const imagePath = path.join(testDir, "small.png");
		fs.writeFileSync(imagePath, png);

		const loaded = await loadImageInput({ path: imagePath, cwd: testDir, autoResize: true });

		expect(loaded?.data).toBe(Buffer.from(png).toString("base64"));
		expect(loaded?.dimensionNote).toBeUndefined();
	});
});
