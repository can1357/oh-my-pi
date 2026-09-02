import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

function createSession(cwd: string, sourcePath: string, attachmentCount = 1): ToolSession {
	const image: ImageContent = { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" };
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "images.autoResize": false, "inspect_image.enabled": false }),
		getImageAttachments: () =>
			Array.from({ length: attachmentCount }, (_, index) => ({
				label: `Image #${index + 1}`,
				uri: `attachment://${index + 1}`,
				image,
				sourcePath,
			})),
	};
}

describe("read attachment URLs", () => {
	let testDir: string;
	let imagePath: string;

	beforeEach(() => {
		testDir = fs.mkdtempSync(path.join(os.tmpdir(), "read-attachment-"));
		imagePath = path.join(testDir, "original.png");
		fs.writeFileSync(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));
	});

	afterEach(() => {
		removeSyncWithRetries(testDir);
	});

	it("decodes attachment URLs through the underlying image file path", async () => {
		const tool = new ReadTool(createSession(testDir, imagePath));
		const attachmentResult = await tool.execute("read-attachment", { path: "attachment://1" });
		const fileResult = await tool.execute("read-file", { path: imagePath });

		expect(attachmentResult.content).toEqual(fileResult.content);
		expect(attachmentResult.content).toContainEqual({
			type: "image",
			data: TINY_PNG_BASE64,
			mimeType: "image/png",
		});
	});

	it("reads several attachment URLs from one semicolon-delimited path", async () => {
		const result = await new ReadTool(createSession(testDir, imagePath, 2)).execute("read-attachment-batch", {
			path: "attachment://1;attachment://2",
		});
		const text = result.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n");
		const images = result.content.filter(block => block.type === "image");

		expect(text).toContain("Note: interpreted as 2 paths: attachment://1, attachment://2");
		expect(images).toHaveLength(2);
		expect(result.details?.displayReadTargets).toEqual(["attachment://1", "attachment://2"]);
	});

	it("splits file URL batches before decoding encoded semicolons", async () => {
		const firstPath = path.join(testDir, "first;file.txt");
		const secondPath = path.join(testDir, "second.txt");
		await Bun.write(firstPath, "first file\n");
		await Bun.write(secondPath, "second file\n");
		const firstUrl = url.pathToFileURL(firstPath).href.replace("file:", "FILE:").replace(";", "%3B");
		const secondUrl = url.pathToFileURL(secondPath).href.replace("file:", "FILE:");

		const result = await new ReadTool(createSession(testDir, imagePath)).execute("read-file-url-batch", {
			path: `${firstUrl};${secondUrl}`,
		});
		const text = result.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n");

		expect(text).toContain("first file");
		expect(text).toContain("second file");
		expect(result.details?.displayReadTargets).toEqual([firstUrl, secondUrl]);
	});

	it("preserves one file URL containing a literal semicolon", async () => {
		const filePath = path.join(testDir, "single;file.txt");
		await Bun.write(filePath, "single file\n");
		const fileUrl = url.pathToFileURL(filePath).href;

		const result = await new ReadTool(createSession(testDir, imagePath)).execute("read-single-file-url", {
			path: fileUrl,
		});
		const text = result.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n");

		expect(text).toContain("single file");
		expect(text).not.toContain("interpreted as");
	});

	it("preserves a selected file URL containing a literal semicolon", async () => {
		const filePath = path.join(testDir, "selected;file.txt");
		await Bun.write(filePath, "selected file\nsecond line\n");
		const fileUrl = `${url.pathToFileURL(filePath).href}:1-1`;

		const result = await new ReadTool(createSession(testDir, imagePath)).execute("read-selected-file-url", {
			path: fileUrl,
		});
		const text = result.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n");

		expect(text).toContain("selected file");
		expect(text).toContain("[selected;file.txt#");
		expect(text).not.toContain("interpreted as");
	});

	it("reads a selected URL-shaped local target before URL dispatch in either batch position", async () => {
		await Bun.write(path.join(testDir, "www.example"), "local domain path\n");
		await Bun.write(path.join(testDir, "second.txt"), "second file\n");

		for (const targets of [
			["www.example:1-1", "second.txt"],
			["second.txt", "www.example:1-1"],
		]) {
			const result = await new ReadTool(createSession(testDir, imagePath)).execute("read-local-url-shaped-batch", {
				path: targets.join(";"),
			});
			const text = result.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n");

			expect(text).toContain("local domain path");
			expect(text).toContain("second file");
			expect(result.details?.displayReadTargets).toEqual(targets);
		}
	});

	it("reports unknown attachment URLs with the available URIs", async () => {
		const tool = new ReadTool(createSession(testDir, imagePath));

		await expect(tool.execute("read-missing-attachment", { path: "attachment://2" })).rejects.toThrow(
			"Could not resolve image attachment 'attachment://2'. Available attachment URIs: attachment://1.",
		);
	});
});
