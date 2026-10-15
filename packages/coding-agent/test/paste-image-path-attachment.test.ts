/**
 * `InputController.handleImagePaste` — the clipboard-image chord whose text
 * fallback turns an image-file path into an attachment. Gated by
 * `paste.imagePathAttachment`: on (the default) the path attaches; off it lands
 * as literal text instead. The editor's bracketed-paste handler
 * (`CustomEditor.onPasteImagePath`) is the other gated route, covered in
 * `input-controller-keybindings.test.ts`.
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
	const insertAtom = vi.fn();
	const requestRender = vi.fn();
	const showStatus = vi.fn();
	const pendingImages: ImageContent[] = [];
	const pendingImageLinks: (string | undefined)[] = [];
	const ctx = {
		editor: {
			pasteText,
			insertAtom,
			pendingImages,
			pendingImageLinks,
		} as unknown as InteractiveModeContext["editor"],
		ui: { requestRender, getFocused: () => null } as unknown as InteractiveModeContext["ui"],
		sessionManager: {
			getCwd: () => process.cwd(),
			putBlob: async () => ({ displayPath: "/tmp/blob.png" }),
		} as unknown as InteractiveModeContext["sessionManager"],
		showStatus,
	} as unknown as InteractiveModeContext;
	return { ctx, spies: { pasteText, pendingImages, showStatus } };
}

describe("paste.imagePathAttachment", () => {
	let tmpDir: string;
	let imgPath: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "paste-image-path-"));
		imgPath = path.join(tmpDir, "screenshot.png");
		await fs.writeFile(imgPath, ONE_PX_PNG);
		resetSettingsForTest();
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
		resetSettingsForTest();
		vi.restoreAllMocks();
	});

	it("pastes a clipboard image-file path as text while the setting is off", async () => {
		await Settings.init({
			inMemory: true,
			overrides: { "images.autoResize": false, "paste.imagePathAttachment": false },
		});
		const { ctx, spies } = createCtx();
		const controller = new InputController(ctx, {
			readImage: async () => null,
			readText: async () => imgPath,
			readMacFileUrls: async () => [],
		});

		const result = await controller.handleImagePaste();

		expect(result).toBe(true);
		expect(spies.pasteText).toHaveBeenCalledWith(imgPath);
		expect(spies.pendingImages).toHaveLength(0);
	});

	it("attaches the clipboard image-file path under the default setting", async () => {
		await Settings.init({ inMemory: true, overrides: { "images.autoResize": false } });
		const { ctx, spies } = createCtx();
		const controller = new InputController(ctx, {
			readImage: async () => null,
			readText: async () => imgPath,
			readMacFileUrls: async () => [],
		});

		const result = await controller.handleImagePaste();

		expect(result).toBe(true);
		expect(spies.pasteText).not.toHaveBeenCalled();
		expect(spies.pendingImages).toHaveLength(1);
		expect(spies.pendingImages[0]?.type).toBe("image");
	});
});
