/**
 * Repro for #3506: macOS image-file clipboard pasted as literal text.
 *
 * When a user copies an image file via Finder `Cmd+C` (or any flow that puts
 * a file URL on the pasteboard with no raw image bytes), `arboard::get_image`
 * returns `ContentNotAvailable`. Before the fix, the smart-paste fallback in
 * `InputController.handleImagePaste` then dumped the clipboard text — the
 * file path — verbatim into the editor instead of attaching the image, so
 * the user saw "text pasted, image lost". The terminal-mediated `Cmd+V` path
 * (bracketed paste → `extractBracketedImagePastePaths` → `handleImagePathPaste`)
 * already attached the image, which produced the asymmetric "for image I need
 * control+v which is very odd" symptom.
 *
 * Defended contract: when the clipboard text is an explicit image file path,
 * `handleImagePaste` MUST load and attach the image, NEVER paste the path as
 * text. Non-image text falls through to the existing #1628 text-paste
 * behavior.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

const ONE_PX_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
	"base64",
);

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

describe("InputController.handleImagePaste (issue #3506)", () => {
	let tmpDir: string;
	let imgPath: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "issue-3506-"));
		imgPath = path.join(tmpDir, "screenshot.png");
		await fs.writeFile(imgPath, ONE_PX_PNG);
		resetSettingsForTest();
		await Settings.init({ inMemory: true, overrides: { "images.autoResize": false } });
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
		resetSettingsForTest();
		vi.restoreAllMocks();
	});

	it("attaches the image when the clipboard exposes only its file path (Finder Cmd+C)", async () => {
		const { ctx, spies } = createCtx();
		const controller = new InputController(ctx, {
			readImage: async () => null, // arboard returns ContentNotAvailable when only a file URL is on the pasteboard
			readText: async () => imgPath,
		});

		const result = await controller.handleImagePaste();

		expect(result).toBe(true);
		// The path MUST NOT land in the editor as literal text — that's the user-visible bug.
		expect(spies.pasteText).not.toHaveBeenCalled();
		expect(spies.insertAtom).toHaveBeenCalled();
		// The image is attached to the draft.
		expect(spies.pendingImages.length).toBe(1);
		expect(spies.pendingImages[0]?.type).toBe("image");
	});

	it("attaches the image when the clipboard exposes a `file://` URL (Codex parity)", async () => {
		const { ctx, spies } = createCtx();
		const fileUrl = new URL(`file://${imgPath}`).href;
		const controller = new InputController(ctx, {
			readImage: async () => null,
			readText: async () => fileUrl,
		});

		const result = await controller.handleImagePaste();

		expect(result).toBe(true);
		// Neither the bare URL nor the decoded path may land in the editor as text.
		expect(spies.pasteText).not.toHaveBeenCalled();
		expect(spies.pendingImages.length).toBe(1);
		expect(spies.pendingImages[0]?.type).toBe("image");
	});

	it("attaches the image when the clipboard text is a single anchored path containing spaces", async () => {
		// macOS screenshots default to filenames like
		// `Screenshot 2026-06-25 at 1.23.45 PM.png` — unescaped spaces. The
		// bracketed-paste splitter shreds the path on whitespace, so the
		// keybind text fallback MUST try the trimmed text as a single
		// candidate before splitting.
		const { ctx, spies } = createCtx();
		const spaced = path.join(tmpDir, "Screenshot 2026-06-25 at 1.23.45 PM.png");
		await fs.writeFile(spaced, ONE_PX_PNG);
		const controller = new InputController(ctx, {
			readImage: async () => null,
			readText: async () => spaced,
		});

		const result = await controller.handleImagePaste();

		expect(result).toBe(true);
		expect(spies.pasteText).not.toHaveBeenCalled();
		expect(spies.pendingImages.length).toBe(1);
	});

	it("attaches the image via the macOS file-URL pasteboard when readText is empty (pbpaste limitation)", async () => {
		// macOS `Cmd+C` on a file in Finder puts only a `public.file-url`
		// pasteboard item; `pbpaste(1)` (the backing call for `readText` on
		// Darwin) only surfaces plain text / RTF / EPS, so it returns empty.
		// The Darwin-only `readMacFileUrls` AppleScript bridge reaches the
		// file-URL representation and the controller MUST route it through
		// `handleImagePathPaste` instead of bailing with "Clipboard is empty".
		const { ctx, spies } = createCtx();
		const readText = vi.fn(async () => ""); // pbpaste output
		const readMacFileUrls = vi.fn(async () => [imgPath]);
		const controller = new InputController(ctx, {
			readImage: async () => null,
			readText,
			readMacFileUrls,
		});

		const result = await controller.handleImagePaste();

		expect(result).toBe(true);
		expect(readMacFileUrls).toHaveBeenCalled();
		// "Clipboard is empty" MUST NOT fire — the file URL recovered the image.
		expect(spies.showStatus).not.toHaveBeenCalledWith("Clipboard is empty");
		expect(spies.pasteText).not.toHaveBeenCalled();
		expect(spies.pendingImages.length).toBe(1);
	});

	it("attaches every image-shaped file URL from a multi-file Finder selection", async () => {
		// Cmd+C on multiple image files in Finder hands the AppleScript bridge
		// back the whole `public.file-url` list. The controller MUST attach
		// every image in the list, not stop after the first — matches the
		// bracketed-paste handler in `CustomEditor.handleInput`.
		const { ctx, spies } = createCtx();
		const secondImg = path.join(tmpDir, "second.jpg");
		const thirdImg = path.join(tmpDir, "third.png");
		await fs.writeFile(secondImg, ONE_PX_PNG);
		await fs.writeFile(thirdImg, ONE_PX_PNG);
		const readMacFileUrls = vi.fn(async () => [imgPath, secondImg, thirdImg]);
		const controller = new InputController(ctx, {
			readImage: async () => null,
			readText: async () => "",
			readMacFileUrls,
		});

		const result = await controller.handleImagePaste();

		expect(result).toBe(true);
		expect(readMacFileUrls).toHaveBeenCalled();
		expect(spies.pendingImages.length).toBe(3);
		expect(spies.pasteText).not.toHaveBeenCalled();
	});

	it("skips non-image URLs in a mixed Finder selection but still attaches the image siblings", async () => {
		const { ctx, spies } = createCtx();
		const readMacFileUrls = vi.fn(async () => [
			"/Users/me/Documents/report.pdf",
			imgPath,
			"/Users/me/Documents/notes.txt",
		]);
		const controller = new InputController(ctx, {
			readImage: async () => null,
			readText: async () => "should-not-be-pasted",
			readMacFileUrls,
		});

		const result = await controller.handleImagePaste();

		expect(result).toBe(true);
		expect(spies.pendingImages.length).toBe(1);
		// File-URL fallback owned the outcome — text fallback MUST NOT run.
		expect(spies.pasteText).not.toHaveBeenCalled();
	});

	it("ignores non-image macOS file URLs and falls through to the text fallback", async () => {
		const { ctx, spies } = createCtx();
		const readMacFileUrls = vi.fn(async () => ["/Users/me/Documents/report.pdf"]);
		const controller = new InputController(ctx, {
			readImage: async () => null,
			readText: async () => "fallback text",
			readMacFileUrls,
		});

		const result = await controller.handleImagePaste();

		expect(result).toBe(true);
		expect(readMacFileUrls).toHaveBeenCalled();
		expect(spies.pendingImages.length).toBe(0);
		expect(spies.pasteText).toHaveBeenCalledWith("fallback text");
	});

	it("preserves #1628 smart-paste behavior for non-image text", async () => {
		const { ctx, spies } = createCtx();
		const controller = new InputController(ctx, {
			readImage: async () => null,
			readText: async () => "just some plain text, no path here",
		});

		const result = await controller.handleImagePaste();

		expect(result).toBe(true);
		expect(spies.pasteText).toHaveBeenCalledWith("just some plain text, no path here");
		expect(spies.pendingImages.length).toBe(0);
	});

	it("still pastes text for a path-shaped but non-image extension (e.g. /tmp/report.csv)", async () => {
		const { ctx, spies } = createCtx();
		const csvPath = "/tmp/report.csv";
		const controller = new InputController(ctx, {
			readImage: async () => null,
			readText: async () => csvPath,
		});

		const result = await controller.handleImagePaste();

		expect(result).toBe(true);
		expect(spies.pasteText).toHaveBeenCalledWith(csvPath);
		expect(spies.pendingImages.length).toBe(0);
	});
});
