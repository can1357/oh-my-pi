import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readImageMetadata, removeSyncWithRetries } from "@pk-nerdsaver-ai/pi-utils";

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
});
