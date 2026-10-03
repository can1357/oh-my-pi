import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { processFileArguments } from "@oh-my-pi/pi-coding-agent/cli/file-processor";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

// 1x1 red PNG image as base64 (smallest valid PNG)
const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

describe("blockImages setting", () => {
	describe("processFileArguments", () => {
		let testDir: string;

		beforeEach(() => {
			testDir = path.join(os.tmpdir(), `block-images-process-test-${Date.now()}-${Math.random()}`);
			fs.mkdirSync(testDir, { recursive: true });
		});

		afterEach(() => {
			removeSyncWithRetries(testDir);
		});

		it("should always process images (filtering happens at convertToLlm layer)", async () => {
			// Create test image
			const imagePath = path.join(testDir, "test.png");
			fs.writeFileSync(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));

			const result = await processFileArguments([imagePath]);

			expect(result.images).toHaveLength(1);
			expect(result.images[0].type).toBe("image");
		});

		it("should process text files normally", async () => {
			// Create test text file
			const textPath = path.join(testDir, "test.txt");
			fs.writeFileSync(textPath, "Hello, world!");

			const result = await processFileArguments([textPath]);

			expect(result.images).toHaveLength(0);
			expect(result.text).toContain("Hello, world!");
		});
	});
});
