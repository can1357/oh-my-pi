/**
 * Repro for #3601: macOS `Cmd+V` is silently dropped for image-only clipboards.
 *
 * Follow-up to #3506 — that fix covered the case where the terminal forwards
 * the clipboard's text (a file path) verbatim. The remaining symptom is the
 * macOS screenshot path (Cmd+Shift+5 → "save to clipboard"): the pasteboard
 * holds raw image bytes with no text representation, so a terminal that
 * intercepts `Cmd+V` and reads `NSPasteboardTypeString` first (iTerm2,
 * Terminal.app, Warp, Ghostty without OSC 5522, …) sends an EMPTY bracketed
 * paste — `\x1b[200~\x1b[201~` — to the app. Without a fallback, the editor
 * inserts the empty payload and the keystroke disappears. The user has to
 * fall back to `Ctrl+V`, which is delivered as a normal keypress and routes
 * through `app.clipboard.pasteImage` → `InputController.handleImagePaste` →
 * `clipboard.readImage()`.
 *
 * Defended contract: a complete, empty bracketed paste into the composer MUST
 * invoke the same smart-paste reader the configured keybind triggers, so
 * the keystroke either attaches the clipboard image or falls back to the
 * text-paste / "clipboard is empty" diagnostics — never to silent nothing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings/keybindings";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { Composer } from "../src/ui/composer/composer";
import { createInputHarness } from "./helpers/input-harness";

const ONE_PX_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
	"base64",
);

function createCtx(clipboard?: ConstructorParameters<typeof InputController>[1], blobPath = "/tmp/h.png") {
	const composer = new Composer();
	const input = createInputHarness();
	const showStatus = vi.fn();
	const ctx = {
		composer,
		...input.context,
		shell: { focused: () => composer.field, host: undefined, overlays: { open: () => false, blocking: () => false } },
		keybindings: KeybindingsManager.inMemory(),
		session: { extensionRunner: undefined, prewarmModelConnection: vi.fn() },
		dictationSpaceHold: () => undefined,
		syncIdleMaintenanceView: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		sessionManager: {
			getCwd: () => process.cwd(),
			putBlob: async () => ({ hash: "h", path: blobPath, displayPath: blobPath }),
		} as unknown as InteractiveModeContext["sessionManager"],
		showStatus,
	} as unknown as InteractiveModeContext;
	const controller = new InputController(ctx, clipboard);
	const handleImagePaste = vi.spyOn(controller, "handleImagePaste");
	const handleImagePathPaste = vi.spyOn(controller, "handleImagePathPaste");
	controller.setupKeyHandlers();
	return {
		ctx,
		composer,
		paste: (text: string) => input.paste(ctx, text),
		spies: { handleImagePaste, handleImagePathPaste, showStatus },
	};
}

describe("Composer empty bracketed paste (issue #3601)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("runs the smart reader for an empty bracketed paste so Cmd+V on image-only clipboards reaches it", () => {
		const { composer, paste, spies } = createCtx({ readImage: async () => null, readText: async () => "" });
		spies.handleImagePaste.mockResolvedValue(true);

		paste("");

		expect(spies.handleImagePaste).toHaveBeenCalledTimes(1);
		// The empty payload must not also reach the editor (a literal empty paste / undo entry).
		expect(composer.text()).toBe("");
	});

	it("preserves a real whitespace-only bracketed paste (must NOT hijack indentation copies)", () => {
		// A whitespace paste carries real user content; routing it to the clipboard reader would
		// replace the bytes the terminal delivered with the host clipboard (often empty over SSH).
		const { composer, paste, spies } = createCtx();

		paste("   ");

		expect(spies.handleImagePaste).not.toHaveBeenCalled();
		expect(composer.text()).toBe("   ");
	});

	it("does not hijack a bracketed paste that carries real text (Ctrl+V text fallback)", () => {
		const { composer, paste, spies } = createCtx();

		paste("hello world");

		expect(spies.handleImagePaste).not.toHaveBeenCalled();
		expect(composer.text()).toBe("hello world");
	});

	it("routes an explicit image-file path to the image-path paste (existing #3506 path)", () => {
		const { paste, spies } = createCtx();
		spies.handleImagePathPaste.mockResolvedValue();

		paste("/tmp/screenshot.png");

		expect(spies.handleImagePathPaste).toHaveBeenCalledWith("/tmp/screenshot.png");
		expect(spies.handleImagePaste).not.toHaveBeenCalled();
	});
});

describe("InputController + empty bracketed paste end-to-end (issue #3601)", () => {
	let tmpDir: string;
	let imgPath: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "issue-3601-"));
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

	it("end-to-end: empty bracketed paste attaches the clipboard image bytes (image-only macOS screenshot scenario)", async () => {
		const { composer, paste, spies } = createCtx(
			{
				readImage: async () => ({ data: ONE_PX_PNG, mimeType: "image/png" }),
				readText: async () => "", // pbpaste returns empty for image-only pasteboards
			},
			imgPath,
		);

		paste("");
		await spies.handleImagePaste.mock.results[0]?.value;

		expect(spies.showStatus).not.toHaveBeenCalled();
		expect(composer.pendingImages.length).toBe(1);
		expect(composer.pendingImages[0]?.mimeType).toBe("image/png");
	});
});
