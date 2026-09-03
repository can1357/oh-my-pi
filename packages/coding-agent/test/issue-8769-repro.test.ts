/**
 * Repro for #8769: macOS Finder image paste attaches the generated file icon
 * instead of the copied image's bytes.
 *
 * Current Finder `Cmd+C` pasteboards advertise BOTH a `public.file-url`
 * representation and a generated 1024x1024 file-icon bitmap. `arboard::get_image`
 * succeeds with the icon, so `InputController.handleImagePaste` — which probed
 * the image representation before `readMacFileUrlsFromClipboard` — attached the
 * generic Finder icon and never reached the authoritative file URL. A vision
 * model then saw a white document icon labelled `PNG` instead of the screenshot.
 *
 * Defended contract: when the pasteboard exposes a file URL resolving to a
 * supported image file, `handleImagePaste` MUST attach that file's bytes and
 * NEVER let the co-advertised icon bitmap win. Non-image file URLs and pure
 * bitmap pasteboards (screenshots, browser copies) still fall to the image
 * representation.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

// A real, decodable 1x1 PNG standing in for the copied screenshot's bytes.
const FILE_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
	"base64",
);

// A distinct payload standing in for Finder's generated file-icon bitmap that
// `arboard::get_image` returns. Byte-different from FILE_PNG so the test can
// tell which representation was attached.
const ICON_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR42mP8z8Dwn4EIwDiqEAAmvwPxaR3sQwAAAABJRU5ErkJggg==";

function createCtx() {
	const pasteText = vi.fn();
	const insertText = vi.fn();
	const insertAtom = vi.fn();
	const requestRender = vi.fn();
	const showStatus = vi.fn();
	const pendingImages: ImageContent[] = [];
	const pendingImageLinks: (string | undefined)[] = [];
	const ctx = {
		editor: {
			pasteText,
			insertText,
			insertAtom,
			imageLinks: undefined,
			pendingImages,
			pendingImageLinks,
		} as unknown as InteractiveModeContext["editor"],
		ui: { requestRender, getFocused: () => null } as unknown as InteractiveModeContext["ui"],
		sessionManager: {
			getCwd: () => process.cwd(),
			putBlob: async () => ({ hash: "h", path: "/tmp/h.png", displayPath: "/tmp/h.png" }),
		} as unknown as InteractiveModeContext["sessionManager"],
		showStatus,
	} as unknown as InteractiveModeContext;
	return {
		ctx,
		spies: { pasteText, insertText, insertAtom, requestRender, showStatus, pendingImages, pendingImageLinks },
	};
}

describe("InputController.handleImagePaste (issue #8769)", () => {
	let tmpDir: string;
	let imgPath: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "issue-8769-"));
		imgPath = path.join(tmpDir, "screenshot.png");
		await fs.writeFile(imgPath, FILE_PNG);
		resetSettingsForTest();
		await Settings.init({ inMemory: true, overrides: { "images.autoResize": false } });
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
		resetSettingsForTest();
		vi.restoreAllMocks();
	});

	it("attaches the file bytes, not the co-advertised Finder icon bitmap", async () => {
		const { ctx, spies } = createCtx();
		const readImage = vi.fn(async () => ({
			// Finder's generated file-icon bitmap; arboard::get_image succeeds with this.
			data: Buffer.from(ICON_PNG_BASE64, "base64"),
			mimeType: "image/png",
		}));
		const readMacFileUrls = vi.fn(async () => [imgPath]);
		const controller = new InputController(ctx, {
			readImage: readImage as unknown as never,
			readText: async () => "",
			readMacFileUrls,
		});

		const result = await controller.handleImagePaste();

		expect(result).toBe(true);
		// The authoritative file URL MUST be consulted and win over the icon.
		expect(readMacFileUrls).toHaveBeenCalled();
		expect(spies.pendingImages.length).toBe(1);
		// The attached bytes must be the file's, NOT Finder's icon bitmap.
		expect(spies.pendingImages[0]?.data).toBe(FILE_PNG.toString("base64"));
		expect(spies.pendingImages[0]?.data).not.toBe(ICON_PNG_BASE64);
	});

	it("still attaches a pure bitmap pasteboard (screenshot/browser copy) with no file URL", async () => {
		const { ctx, spies } = createCtx();
		const readMacFileUrls = vi.fn(async () => [] as string[]);
		const controller = new InputController(ctx, {
			readImage: async () =>
				({
					data: Buffer.from(ICON_PNG_BASE64, "base64"),
					mimeType: "image/png",
				}) as unknown as never,
			readText: async () => "",
			readMacFileUrls,
		});

		const result = await controller.handleImagePaste();

		expect(result).toBe(true);
		expect(spies.pendingImages.length).toBe(1);
		// No usable image-file URL → the bitmap representation is attached.
		expect(spies.pendingImages[0]?.data).toBe(ICON_PNG_BASE64);
	});

	it("falls to the bitmap when the file URL is a non-image file", async () => {
		const { ctx, spies } = createCtx();
		const readMacFileUrls = vi.fn(async () => ["/Users/me/Documents/report.pdf"]);
		const controller = new InputController(ctx, {
			readImage: async () =>
				({
					data: Buffer.from(ICON_PNG_BASE64, "base64"),
					mimeType: "image/png",
				}) as unknown as never,
			readText: async () => "",
			readMacFileUrls,
		});

		const result = await controller.handleImagePaste();

		expect(result).toBe(true);
		expect(spies.pendingImages.length).toBe(1);
		expect(spies.pendingImages[0]?.data).toBe(ICON_PNG_BASE64);
	});
});
