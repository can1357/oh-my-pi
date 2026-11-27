/**
 * Clipboard paste into the composer.
 *
 * Smart paste (#1628): `app.clipboard.pasteImage` must fall back to pasting
 * clipboard text when no image is available, instead of dead-ending with
 * "No image in clipboard". Hosts that deliver only this one chord (VS Code's
 * integrated terminal forwarding Ctrl+V, Windows clipboard history via Win+V)
 * rely on the fallback to cover both payload kinds.
 *
 * Image files: when the clipboard names an image file (a path or `file://` URL
 * in its text, or macOS `public.file-url` entries), the file's bytes attach —
 * never the path as text, never Finder's co-advertised icon bitmap. Terminals
 * that read only the pasteboard's string deliver an image-only clipboard as an
 * empty bracketed paste, which must run the same smart reader.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings/keybindings";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { $which } from "@oh-my-pi/pi-utils";
import { chipLabel } from "../src/ui/composer/attachments";
import { Composer } from "../src/ui/composer/composer";
import { createInputHarness } from "./helpers/input-harness";

const ONE_PX_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
	"base64",
);

// A distinct payload standing in for Finder's generated file-icon bitmap that
// `arboard::get_image` returns. Byte-different from ONE_PX_PNG so a test can
// tell which representation was attached.
const ICON_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR42mP8z8Dwn4EIwDiqEAAmvwPxaR3sQwAAAABJRU5ErkJggg==";

// A clipboard with no image on it, so a real screenshot on the dev's clipboard
// cannot flip the clipboard-image fallback.
const EMPTY_CLIPBOARD = {
	readImage: async () => null,
	readText: async () => "",
};

const hasFfmpeg = Boolean($which("ffmpeg") && $which("ffprobe"));

function createContext(options?: { focused?: object }) {
	const composer = new Composer();
	const insertText = vi.spyOn(composer, "insertText");
	const insertAtom = vi.spyOn(composer, "insertAtom");
	const shellPaste = vi.fn(() => true);
	const showStatus = vi.fn();
	const ctx = {
		composer,
		shell: { focused: () => options?.focused ?? composer.field, paste: shellPaste },
		sessionManager: {
			getCwd: () => process.cwd(),
			putBlob: async () => ({ hash: "h", path: "/tmp/h.png", displayPath: "/tmp/h.png" }),
		},
		showStatus,
	} as unknown as InteractiveModeContext;
	return { ctx, composer, spies: { insertText, insertAtom, shellPaste, showStatus } };
}

/** A composer-focused context with the controller's input hooks installed, so bracketed pastes route as in the app. */
function createWiredContext(clipboard?: ConstructorParameters<typeof InputController>[1]) {
	const { ctx, composer, spies } = createContext();
	const input = createInputHarness();
	Object.assign(ctx, {
		...input.context,
		shell: { focused: () => composer.field, host: undefined, overlays: { open: () => false } },
		keybindings: KeybindingsManager.inMemory(),
		session: { extensionRunner: undefined, prewarmModelConnection: vi.fn() },
		dictationSpaceHold: () => undefined,
		syncIdleMaintenanceView: vi.fn(),
		updateEditorBorderColor: vi.fn(),
	});
	const controller = new InputController(ctx, clipboard);
	const handleImagePaste = vi.spyOn(controller, "handleImagePaste");
	const handleImagePathPaste = vi.spyOn(controller, "handleImagePathPaste");
	controller.setupKeyHandlers();
	return {
		composer,
		paste: (text: string) => input.paste(ctx, text),
		spies: { ...spies, handleImagePaste, handleImagePathPaste },
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

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
		expect(spies.insertText).not.toHaveBeenCalled();
		expect(spies.showStatus).toHaveBeenCalledWith("Unsupported clipboard image format: image/tiff");
	});

	it("starts the text read without waiting for the image read", async () => {
		const { ctx, composer } = createContext();
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
		expect(composer.text()).toBe("copied text");
	});

	it("attaches nothing and pastes clipboard text when no image is present", async () => {
		const { ctx, composer, spies } = createContext();
		const controller = new InputController(ctx, {
			readImage: async () => null,
			readText: async () => "copied text\nsecond line",
		});

		const result = await controller.handleImagePaste();

		expect(result).toBe(true);
		expect(composer.text()).toBe("copied text\nsecond line");
		expect(spies.insertAtom).not.toHaveBeenCalled();
		expect(spies.showStatus).not.toHaveBeenCalled();
	});

	it("routes the text fallback to the focused prompt, never the hidden composer (#2127 contract)", async () => {
		const { ctx, composer, spies } = createContext({ focused: { kind: "input" } });
		const controller = new InputController(ctx, {
			readImage: async () => null,
			readText: async () => "api-key-123",
		});

		const result = await controller.handleImagePaste();

		expect(result).toBe(true);
		expect(spies.shellPaste).toHaveBeenCalledWith("api-key-123");
		expect(composer.text()).toBe("");
	});

	it("reports an empty clipboard when neither image nor text is available", async () => {
		const { ctx, spies } = createContext();
		const controller = new InputController(ctx, {
			readImage: async () => null,
			readText: async () => "",
		});

		const result = await controller.handleImagePaste();

		expect(result).toBe(false);
		expect(spies.insertText).not.toHaveBeenCalled();
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
		expect(spies.insertText).not.toHaveBeenCalled();
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

describe("InputController paste over SSH", () => {
	it("never pastes the SSH host's clipboard when the terminal forwards the paste key", async () => {
		const { ctx, spies } = createContext();
		const readImage = vi.fn(async () => null);
		const readText = vi.fn(async () => "server clipboard");
		const controller = new InputController(ctx, { readImage, readText, isTerminalLocal: () => false });

		expect(await controller.handleImagePaste()).toBe(false);
		await controller.handleClipboardTextRawPaste();

		expect(readImage).not.toHaveBeenCalled();
		expect(readText).not.toHaveBeenCalled();
		expect(spies.insertText).not.toHaveBeenCalled();
		expect(spies.insertText).not.toHaveBeenCalled();
		expect(spies.showStatus).toHaveBeenCalledTimes(2);
	});
});

describe("InputController.handleImagePaste image files on the clipboard", () => {
	let tmpDir: string;
	let imgPath: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-clipboard-image-"));
		imgPath = path.join(tmpDir, "screenshot.png");
		await fs.writeFile(imgPath, ONE_PX_PNG);
		resetSettingsForTest();
		await Settings.init({ inMemory: true, overrides: { "images.autoResize": false } });
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
		resetSettingsForTest();
	});

	it("attaches the image when the clipboard exposes only its file path (Finder Cmd+C)", async () => {
		const { ctx, composer, spies } = createContext();
		const controller = new InputController(ctx, {
			readImage: async () => null, // arboard returns ContentNotAvailable when only a file URL is on the pasteboard
			readText: async () => imgPath,
		});

		const result = await controller.handleImagePaste();

		expect(result).toBe(true);
		// The path MUST NOT land in the editor as literal text.
		expect(spies.insertText).not.toHaveBeenCalled();
		expect(spies.insertAtom).toHaveBeenCalled();
		expect(composer.pendingImages.length).toBe(1);
		expect(composer.pendingImages[0]?.type).toBe("image");
	});

	it("attaches the image when the clipboard exposes a `file://` URL", async () => {
		const { ctx, composer, spies } = createContext();
		const fileUrl = new URL(`file://${imgPath}`).href;
		const controller = new InputController(ctx, {
			readImage: async () => null,
			readText: async () => fileUrl,
		});

		const result = await controller.handleImagePaste();

		expect(result).toBe(true);
		// Neither the bare URL nor the decoded path may land in the editor as text.
		expect(spies.insertText).not.toHaveBeenCalled();
		expect(composer.pendingImages.length).toBe(1);
		expect(composer.pendingImages[0]?.type).toBe("image");
	});

	it("attaches the image when the clipboard text is a single anchored path containing spaces", async () => {
		// macOS screenshots default to filenames like
		// `Screenshot 2026-06-25 at 1.23.45 PM.png` — unescaped spaces. The
		// bracketed-paste splitter shreds the path on whitespace, so the
		// keybind text fallback MUST try the trimmed text as a single
		// candidate before splitting.
		const { ctx, composer, spies } = createContext();
		const spaced = path.join(tmpDir, "Screenshot 2026-06-25 at 1.23.45 PM.png");
		await fs.writeFile(spaced, ONE_PX_PNG);
		const controller = new InputController(ctx, {
			readImage: async () => null,
			readText: async () => spaced,
		});

		const result = await controller.handleImagePaste();

		expect(result).toBe(true);
		expect(spies.insertText).not.toHaveBeenCalled();
		expect(composer.pendingImages.length).toBe(1);
	});

	it("attaches the image via the macOS file-URL pasteboard when readText is empty (pbpaste limitation)", async () => {
		// macOS `Cmd+C` on a file in Finder puts only a `public.file-url`
		// pasteboard item; `pbpaste(1)` (the backing call for `readText` on
		// Darwin) only surfaces plain text / RTF / EPS, so it returns empty.
		// The Darwin-only `readMacFileUrls` AppleScript bridge reaches the
		// file-URL representation and the controller MUST route it through
		// `handleImagePathPaste` instead of bailing with "Clipboard is empty".
		const { ctx, composer, spies } = createContext();
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
		expect(spies.showStatus).not.toHaveBeenCalledWith("Clipboard is empty");
		expect(spies.insertText).not.toHaveBeenCalled();
		expect(composer.pendingImages.length).toBe(1);
	});

	it("attaches every image-shaped file URL from a multi-file Finder selection", async () => {
		// The AppleScript bridge hands back the whole `public.file-url` list;
		// every image in it attaches, matching the bracketed-paste handler.
		const { ctx, composer, spies } = createContext();
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
		expect(composer.pendingImages.length).toBe(3);
		expect(spies.insertText).not.toHaveBeenCalled();
	});

	it("skips non-image URLs in a mixed Finder selection but still attaches the image siblings", async () => {
		const { ctx, composer, spies } = createContext();
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
		expect(composer.pendingImages.length).toBe(1);
		// File-URL fallback owned the outcome — text fallback MUST NOT run.
		expect(spies.insertText).not.toHaveBeenCalled();
	});

	it("ignores non-image macOS file URLs and falls through to the text fallback", async () => {
		const { ctx, composer, spies } = createContext();
		const readMacFileUrls = vi.fn(async () => ["/Users/me/Documents/report.pdf"]);
		const controller = new InputController(ctx, {
			readImage: async () => null,
			readText: async () => "fallback text",
			readMacFileUrls,
		});

		const result = await controller.handleImagePaste();

		expect(result).toBe(true);
		expect(readMacFileUrls).toHaveBeenCalled();
		expect(composer.pendingImages.length).toBe(0);
		expect(spies.insertText).toHaveBeenCalledWith("fallback text");
	});

	it("attaches the file bytes, not the co-advertised Finder icon bitmap", async () => {
		// Finder `Cmd+C` advertises both a `public.file-url` and a generated
		// file-icon bitmap that `arboard::get_image` succeeds with.
		const { ctx, composer } = createContext();
		const readImage = vi.fn(async () => ({
			data: Buffer.from(ICON_PNG_BASE64, "base64"),
			mimeType: "image/png",
		}));
		const readMacFileUrls = vi.fn(async () => [imgPath]);
		const controller = new InputController(ctx, {
			readImage,
			readText: async () => "",
			readMacFileUrls,
		});

		const result = await controller.handleImagePaste();

		expect(result).toBe(true);
		// The authoritative file URL MUST be consulted and win over the icon.
		expect(readMacFileUrls).toHaveBeenCalled();
		expect(composer.pendingImages.length).toBe(1);
		expect(composer.pendingImages[0]?.data).toBe(ONE_PX_PNG.toString("base64"));
		expect(composer.pendingImages[0]?.data).not.toBe(ICON_PNG_BASE64);
	});

	it("falls to the bitmap when the file URL is a non-image file", async () => {
		const { ctx, composer } = createContext();
		const readMacFileUrls = vi.fn(async () => ["/Users/me/Documents/report.pdf"]);
		const controller = new InputController(ctx, {
			readImage: async () => ({
				data: Buffer.from(ICON_PNG_BASE64, "base64"),
				mimeType: "image/png",
			}),
			readText: async () => "",
			readMacFileUrls,
		});

		const result = await controller.handleImagePaste();

		expect(result).toBe(true);
		expect(composer.pendingImages.length).toBe(1);
		expect(composer.pendingImages[0]?.data).toBe(ICON_PNG_BASE64);
	});

	it("still pastes text for a path-shaped but non-image extension (e.g. /tmp/report.csv)", async () => {
		const { ctx, composer, spies } = createContext();
		const csvPath = "/tmp/report.csv";
		const controller = new InputController(ctx, {
			readImage: async () => null,
			readText: async () => csvPath,
		});

		const result = await controller.handleImagePaste();

		expect(result).toBe(true);
		expect(spies.insertText).toHaveBeenCalledWith(csvPath);
		expect(composer.pendingImages.length).toBe(0);
	});
});

describe("InputController.handleImagePathPaste unreachable and non-image paths", () => {
	const originalSshConnection = process.env.SSH_CONNECTION;
	const originalSshTty = process.env.SSH_TTY;
	const originalSshClient = process.env.SSH_CLIENT;

	beforeEach(async () => {
		delete process.env.SSH_CONNECTION;
		delete process.env.SSH_TTY;
		delete process.env.SSH_CLIENT;
		resetSettingsForTest();
		await Settings.init({ inMemory: true, overrides: { "images.autoResize": false } });
	});

	afterEach(() => {
		if (originalSshConnection === undefined) delete process.env.SSH_CONNECTION;
		else process.env.SSH_CONNECTION = originalSshConnection;
		if (originalSshTty === undefined) delete process.env.SSH_TTY;
		else process.env.SSH_TTY = originalSshTty;
		if (originalSshClient === undefined) delete process.env.SSH_CLIENT;
		else process.env.SSH_CLIENT = originalSshClient;
		resetSettingsForTest();
	});

	it("over SSH: never pastes the unreachable path as text and surfaces an SSH-aware status", async () => {
		process.env.SSH_CONNECTION = "10.0.0.2 50000 10.0.0.1 22";
		const { ctx, spies } = createContext();
		const controller = new InputController(ctx);
		const missing = "/Users/someone/Pictures/local-only.png";

		await controller.handleImagePathPaste(missing);

		expect(spies.insertText).not.toHaveBeenCalled();
		expect(spies.showStatus).toHaveBeenCalledTimes(1);
		const status = String(spies.showStatus.mock.calls[0]?.[0] ?? "");
		expect(status).toMatch(/SSH/i);
		// The diagnostic must point at the actual remediation: paste the bytes.
		expect(status.toLowerCase()).toContain("paste");
	});

	it("locally: still avoids the misleading path-as-text fallback when the file is unreachable", async () => {
		const { ctx, spies } = createContext();
		const controller = new InputController(ctx, EMPTY_CLIPBOARD);
		const missing = "/tmp/definitely-does-not-exist-omp-image-paste.png";

		await controller.handleImagePathPaste(missing);

		expect(spies.insertText).not.toHaveBeenCalled();
		expect(spies.showStatus).toHaveBeenCalledTimes(1);
		const status = String(spies.showStatus.mock.calls[0]?.[0] ?? "");
		expect(status).toMatch(/not found|could not|unreadable/i);
	});

	it("sanitizes untrusted pasted-path characters and bounds length before splicing into status", async () => {
		const { ctx, spies } = createContext();
		const controller = new InputController(ctx, EMPTY_CLIPBOARD);
		// Path carrying ANSI, control chars, a CR/LF, and a tab — all of which
		// would corrupt the TUI status line if interpolated verbatim. Long
		// enough to exceed the status-line truncation budget (TRUNCATE_LENGTHS
		// .CONTENT = 80) without tripping ENAMETOOLONG so the ENOENT branch
		// keeps firing.
		const hostile = `/tmp/\x1b[31mevil\x1b[0m\r\nname\twith-${"x".repeat(100)}.png`;

		await controller.handleImagePathPaste(hostile);

		expect(spies.insertText).not.toHaveBeenCalled();
		expect(spies.showStatus).toHaveBeenCalledTimes(1);
		const status = String(spies.showStatus.mock.calls[0]?.[0] ?? "");
		// No ANSI escape, no raw control bytes, no embedded newlines/tabs.
		expect(status).not.toMatch(/\x1b/);
		expect(status).not.toMatch(/[\x00-\x08\x0B-\x1F\x7F]/);
		expect(status).not.toContain("\n");
		expect(status).not.toContain("\t");
		// The displayed path must be clamped strictly inside the truncation budget.
		expect(status.length).toBeLessThan(hostile.length);
	});

	it("locally: attaches the clipboard image when the pasted path is a stale transient file (Win+Shift+S)", async () => {
		// Windows 11 Win+Shift+S leaves the bitmap on the clipboard, but the
		// terminal pastes the snip's packaged-app TempState path, which is
		// already gone by the time omp reads it. The bytes are still on the
		// clipboard, so the paste must succeed from there instead of dead-ending
		// on "Image not found".
		const { ctx, composer, spies } = createContext();
		const controller = new InputController(ctx, {
			readImage: async () => ({ data: ONE_PX_PNG, mimeType: "image/png" }),
			readText: async () => "",
		});
		const stale =
			"C:\\Users\\u\\AppData\\Local\\Packages\\MicrosoftWindows.Client.Core_cw5n1h2txyewy\\TempState\\gone.png";

		await controller.handleImagePathPaste(stale);

		expect(spies.insertText).not.toHaveBeenCalled();
		expect(spies.showStatus).not.toHaveBeenCalled();
		expect(composer.pendingImages.length).toBe(1);
		expect(composer.pendingImages[0]?.mimeType).toBe("image/png");
	});

	it("locally: attaches the clipboard image when the pasted path resolves to a non-image file", async () => {
		// The bracketed paste can resolve to an existing file that is not a
		// decodable image (zero-byte/locked transient snip), which surfaces as a
		// null load result rather than ENOENT. The clipboard bytes must still win
		// over a degraded text paste.
		const { ctx, composer, spies } = createContext();
		const controller = new InputController(ctx, {
			readImage: async () => ({ data: ONE_PX_PNG, mimeType: "image/png" }),
			readText: async () => "",
		});
		const nonImage = path.join(os.tmpdir(), `omp-not-png-${Math.random().toString(36).slice(2)}.png`);
		await Bun.write(nonImage, "not really a png");
		try {
			await controller.handleImagePathPaste(nonImage);
		} finally {
			await Bun.file(nonImage).delete();
		}

		expect(spies.insertText).not.toHaveBeenCalled();
		expect(composer.pendingImages.length).toBe(1);
		expect(composer.pendingImages[0]?.mimeType).toBe("image/png");
	});

	it.skipIf(!hasFfmpeg)("locally: attaches a pasted video as a preview image", async () => {
		const { ctx, composer, spies } = createContext();
		const controller = new InputController(ctx, EMPTY_CLIPBOARD);
		const video = path.join(os.tmpdir(), `omp-pasted-video-${Math.random().toString(36).slice(2)}.mp4`);
		const ffmpeg = Bun.spawn([
			"ffmpeg",
			"-hide_banner",
			"-loglevel",
			"error",
			"-y",
			"-f",
			"lavfi",
			"-i",
			"testsrc=duration=1:size=320x240:rate=30",
			"-pix_fmt",
			"yuv420p",
			"-c:v",
			"libx264",
			video,
		]);
		try {
			expect(await ffmpeg.exited).toBe(0);

			await controller.handleImagePathPaste(video);
		} finally {
			await Bun.file(video)
				.delete()
				.catch(() => {});
		}

		expect(spies.insertText).not.toHaveBeenCalled();
		expect(spies.showStatus).not.toHaveBeenCalled();
		expect(composer.pendingImages).toHaveLength(1);
		expect(composer.pendingImages[0]?.mimeType).toBe("image/png");
		expect(spies.insertAtom).toHaveBeenCalledWith(chipLabel("video", 1), "[Video #1, 960x480]", expect.anything());
	});
});

describe("bracketed paste into the composer", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, overrides: { "images.autoResize": false } });
	});

	afterEach(() => {
		resetSettingsForTest();
	});

	it("runs the smart reader for an empty bracketed paste so Cmd+V on image-only clipboards reaches it", () => {
		const { composer, paste, spies } = createWiredContext({ readImage: async () => null, readText: async () => "" });
		spies.handleImagePaste.mockResolvedValue(true);

		paste("");

		expect(spies.handleImagePaste).toHaveBeenCalledTimes(1);
		// The empty payload must not also reach the editor (a literal empty paste / undo entry).
		expect(composer.text()).toBe("");
	});

	it("attaches the clipboard image bytes for an empty bracketed paste of an image-only clipboard", async () => {
		const { composer, paste, spies } = createWiredContext({
			readImage: async () => ({ data: ONE_PX_PNG, mimeType: "image/png" }),
			readText: async () => "", // pbpaste returns empty for image-only pasteboards
		});

		paste("");
		await spies.handleImagePaste.mock.results[0]?.value;

		expect(spies.showStatus).not.toHaveBeenCalled();
		expect(composer.pendingImages.length).toBe(1);
		expect(composer.pendingImages[0]?.mimeType).toBe("image/png");
	});

	it("preserves a real whitespace-only bracketed paste (must NOT hijack indentation copies)", () => {
		// A whitespace paste carries real user content; routing it to the clipboard reader would
		// replace the bytes the terminal delivered with the host clipboard (often empty over SSH).
		const { composer, paste, spies } = createWiredContext();

		paste("   ");

		expect(spies.handleImagePaste).not.toHaveBeenCalled();
		expect(composer.text()).toBe("   ");
	});

	it("does not hijack a bracketed paste that carries real text (Ctrl+V text fallback)", () => {
		const { composer, paste, spies } = createWiredContext();

		paste("hello world");

		expect(spies.handleImagePaste).not.toHaveBeenCalled();
		expect(composer.text()).toBe("hello world");
	});

	it("routes an explicit image-file path to the image-path paste", () => {
		const { paste, spies } = createWiredContext();
		spies.handleImagePathPaste.mockResolvedValue();

		paste("/tmp/screenshot.png");

		expect(spies.handleImagePathPaste).toHaveBeenCalledWith("/tmp/screenshot.png");
		expect(spies.handleImagePaste).not.toHaveBeenCalled();
	});
});
