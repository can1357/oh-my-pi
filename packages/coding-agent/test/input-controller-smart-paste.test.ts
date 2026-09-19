/**
 * Smart paste (#1628): `app.clipboard.pasteImage` must fall back to pasting
 * clipboard text when no image is available, instead of dead-ending with
 * "No image in clipboard". Hosts that deliver only this one chord (VS Code's
 * integrated terminal forwarding Ctrl+V, Windows clipboard history via Win+V)
 * rely on the fallback to cover both payload kinds.
 */

import { describe, expect, it, vi } from "bun:test";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

function createContext(options?: { focused?: { pasteText(text: string): void } }) {
	const pasteText = vi.fn();
	const insertText = vi.fn();
	const insertAtom = vi.fn();
	const requestRender = vi.fn();
	const showStatus = vi.fn();
	const ctx = {
		editor: { pasteText, insertText, insertAtom } as unknown as InteractiveModeContext["editor"],
		ui: { requestRender, getFocused: () => options?.focused ?? null } as unknown as InteractiveModeContext["ui"],
		showStatus,
	} as unknown as InteractiveModeContext;
	return { ctx, spies: { pasteText, insertText, insertAtom, requestRender, showStatus } };
}

describe("InputController.handleImagePaste smart-paste fallback", () => {
	it("prefers the clipboard image and discards text when an image is present", async () => {
		const { ctx, spies } = createContext();
		const readText = vi.fn(async () => "text that must not be pasted");
		const controller = new InputController(ctx, {
			// Unsupported/undecodable payload keeps the test off the full image
			// pipeline; the contract under test is image precedence, and that an
			// image failure must NOT silently degrade into a text paste. The
			// text bridge now starts alongside the image bridge (empty-clipboard
			// stall fix), so readText may be consulted — its payload must
			// never reach the editor when an image wins.
			readImage: async () => ({ data: Buffer.from("not an image"), mimeType: "image/tiff" }),
			readText,
		});

		const result = await controller.handleImagePaste();

		expect(result).toBe(false);
		expect(spies.pasteText).not.toHaveBeenCalled();
		expect(spies.showStatus).toHaveBeenCalledWith("Unsupported clipboard image format: image/tiff");
	});

	it("starts the text read without waiting for the image read", async () => {
		const { ctx, spies } = createContext();
		const { promise: imageGate, resolve: resolveImage } = Promise.withResolvers<null>();
		const { promise: textStarted, resolve: markTextStarted } = Promise.withResolvers<void>();
		const readText = vi.fn(async () => {
			markTextStarted();
			return "copied text";
		});
		const controller = new InputController(ctx, {
			readImage: () => imageGate,
			readText,
		});

		const pending = controller.handleImagePaste();
		// Let the image read stay pending: the text bridge must already be
		// in flight rather than queued behind it (serial awaits stalled an
		// empty clipboard by the sum of both bridges).
		await textStarted;
		expect(readText).toHaveBeenCalled();
		resolveImage(null);

		expect(await pending).toBe(true);
		expect(spies.pasteText).toHaveBeenCalledWith("copied text");
	});

	it("attaches nothing and pastes clipboard text when no image is present", async () => {
		const { ctx, spies } = createContext();
		const controller = new InputController(ctx, {
			readImage: async () => null,
			readText: async () => "copied text\nsecond line",
		});

		const result = await controller.handleImagePaste();

		expect(result).toBe(true);
		expect(spies.pasteText).toHaveBeenCalledWith("copied text\nsecond line");
		expect(spies.requestRender).toHaveBeenCalled();
		expect(spies.showStatus).not.toHaveBeenCalled();
	});

	it("routes the text fallback to a focused paste-capable component (#2127 contract)", async () => {
		const focusedPasteText = vi.fn();
		const { ctx, spies } = createContext({ focused: { pasteText: focusedPasteText } });
		const controller = new InputController(ctx, {
			readImage: async () => null,
			readText: async () => "api-key-123",
		});

		const result = await controller.handleImagePaste();

		expect(result).toBe(true);
		expect(focusedPasteText).toHaveBeenCalledWith("api-key-123");
		expect(spies.pasteText).not.toHaveBeenCalled();
	});

	it("reports an empty clipboard when neither image nor text is available", async () => {
		const { ctx, spies } = createContext();
		const controller = new InputController(ctx, {
			readImage: async () => null,
			readText: async () => "",
		});

		const result = await controller.handleImagePaste();

		expect(result).toBe(false);
		expect(spies.pasteText).not.toHaveBeenCalled();
		expect(spies.showStatus).toHaveBeenCalledWith("Clipboard is empty");
	});

	it("surfaces a read failure without pasting", async () => {
		const { ctx, spies } = createContext();
		const controller = new InputController(ctx, {
			readImage: async () => {
				throw new Error("clipboard unavailable");
			},
			readText: async () => "should never be used",
		});

		const result = await controller.handleImagePaste();

		expect(result).toBe(false);
		expect(spies.pasteText).not.toHaveBeenCalled();
		expect(spies.showStatus).toHaveBeenCalledWith("Failed to read clipboard");
	});
});

describe("InputController.handleClipboardTextRawPaste", () => {
	it("inserts clipboard text verbatim", async () => {
		const { ctx, spies } = createContext();
		const controller = new InputController(ctx, {
			readImage: async () => null,
			readText: async () => "raw $TEXT",
		});

		await controller.handleClipboardTextRawPaste();

		expect(spies.insertText).toHaveBeenCalledWith("raw $TEXT");
		expect(spies.showStatus).not.toHaveBeenCalled();
	});

	it("shows the empty-clipboard status only when there is no text", async () => {
		const { ctx, spies } = createContext();
		const controller = new InputController(ctx, {
			readImage: async () => null,
			readText: async () => "",
		});

		await controller.handleClipboardTextRawPaste();

		expect(spies.insertText).not.toHaveBeenCalled();
		expect(spies.showStatus).toHaveBeenCalledWith("No text in clipboard to paste raw");
	});
});
