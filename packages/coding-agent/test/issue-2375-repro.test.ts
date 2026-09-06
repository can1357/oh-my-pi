/**
 * Repro for #2375: remote (SSH) image attachment surfaces only the local path.
 *
 * When a user attaches an image in their LOCAL terminal (e.g. drag/drop into
 * iTerm2 on macOS) while the omp process actually runs on a remote host (Pi
 * over SSH), the terminal forwards a bracketed-paste containing the local
 * macOS path. The remote `handleImagePathPaste` tries to read that path on
 * the remote filesystem, fails (ENOENT), then falls through to pasting the
 * unresolvable path as plain text — making it look like the image was
 * "attached as a local path" when in fact nothing was sent.
 *
 * Defended contract: an unreachable image path NEVER degrades to a silent
 * text paste; the user must see an SSH-aware diagnostic so they know to
 * paste image bytes directly instead.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

// A clipboard with no image on it — the deterministic default for the
// not-found assertions so a real screenshot on the dev's clipboard cannot
// flip the new fallback path and break them.
const EMPTY_CLIPBOARD = {
	readImage: async () => null,
	readText: async () => "",
};

// Minimal 1x1 PNG used to stand in for a Win+Shift+S bitmap on the clipboard.
const ONE_PX_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
	"base64",
);

function createContext() {
	const pasteText = vi.fn();
	const insertText = vi.fn();
	const insertAtom = vi.fn();
	const requestRender = vi.fn();
	const showStatus = vi.fn();
	const ctx = {
		editor: {
			pasteText,
			insertText,
			insertAtom,
			imageLinks: undefined,
			pendingImages: [] as ImageContent[],
			pendingImageLinks: [] as (string | undefined)[],
		} as unknown as InteractiveModeContext["editor"],
		ui: { requestRender, getFocused: () => null } as unknown as InteractiveModeContext["ui"],
		sessionManager: {
			getCwd: () => process.cwd(),
			putBlob: async () => ({ hash: "h", path: "/tmp/h.png", displayPath: "/tmp/h.png" }),
		} as unknown as InteractiveModeContext["sessionManager"],
		showStatus,
	} as unknown as InteractiveModeContext;
	return { ctx, spies: { pasteText, insertText, insertAtom, requestRender, showStatus } };
}

describe("InputController.handleImagePathPaste (issue #2375)", () => {
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
		vi.restoreAllMocks();
	});

	it("over SSH: never pastes the unreachable path as text and surfaces an SSH-aware status", async () => {
		process.env.SSH_CONNECTION = "10.0.0.2 50000 10.0.0.1 22";
		const { ctx, spies } = createContext();
		const controller = new InputController(ctx);
		const missing = "/Users/someone/Pictures/local-only.png";

		await controller.handleImagePathPaste(missing);

		expect(spies.pasteText).not.toHaveBeenCalled();
		expect(spies.showStatus).toHaveBeenCalledTimes(1);
		const status = String(spies.showStatus.mock.calls[0]?.[0] ?? "");
		expect(status).toMatch(/SSH/i);
		// The diagnostic must point at the actual remediation: paste the bytes.
		expect(status.toLowerCase()).toContain("paste");
	});

	it("locally: still avoids the misleading path-as-text fallback when the file is unreachable", async () => {
		const { ctx, spies } = createContext();
		const controller = new InputController(ctx, EMPTY_CLIPBOARD);
		const missing = "/tmp/definitely-does-not-exist-omp-2375.png";

		await controller.handleImagePathPaste(missing);

		expect(spies.pasteText).not.toHaveBeenCalled();
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

		expect(spies.pasteText).not.toHaveBeenCalled();
		expect(spies.showStatus).toHaveBeenCalledTimes(1);
		const status = String(spies.showStatus.mock.calls[0]?.[0] ?? "");
		// No ANSI escape, no raw control bytes, no embedded newlines/tabs.
		expect(status).not.toMatch(/\x1b/);
		expect(status).not.toMatch(/[\x00-\x08\x0B-\x1F\x7F]/);
		expect(status).not.toContain("\n");
		expect(status).not.toContain("\t");
		// The hostile path runs well past the status truncation budget; the
		// displayed path must be clamped strictly inside that budget.
		expect(status.length).toBeLessThan(hostile.length);
	});

	it("locally: attaches the clipboard image when the pasted path is a stale transient file (Win+Shift+S)", async () => {
		// Windows 11 Win+Shift+S leaves the bitmap on the clipboard, but the
		// terminal pastes the snip's packaged-app TempState path, which is
		// already gone by the time omp reads it. The bytes are still on the
		// clipboard, so the paste must succeed from there instead of dead-ending
		// on "Image not found".
		const { ctx, spies } = createContext();
		const controller = new InputController(ctx, {
			readImage: async () => ({ data: ONE_PX_PNG, mimeType: "image/png" }),
			readText: async () => "",
		});
		const stale =
			"C:\\Users\\u\\AppData\\Local\\Packages\\MicrosoftWindows.Client.Core_cw5n1h2txyewy\\TempState\\gone.png";

		await controller.handleImagePathPaste(stale);

		expect(spies.pasteText).not.toHaveBeenCalled();
		expect(spies.showStatus).not.toHaveBeenCalled();
		expect(ctx.editor.pendingImages.length).toBe(1);
		expect(ctx.editor.pendingImages[0]?.mimeType).toBe("image/png");
	});

	it("locally: attaches the clipboard image when the pasted path resolves to a non-image file", async () => {
		// The bracketed paste can resolve to an existing file that is not a
		// decodable image (zero-byte/locked transient snip), which surfaces as a
		// null load result rather than ENOENT. The clipboard bytes must still win
		// over a degraded text paste.
		const { ctx, spies } = createContext();
		const controller = new InputController(ctx, {
			readImage: async () => ({ data: ONE_PX_PNG, mimeType: "image/png" }),
			readText: async () => "",
		});
		// This test file itself: resolvable, readable, but not an image.
		const nonImage = path.join(os.tmpdir(), `issue-2375-not-png-${Math.random().toString(36).slice(2)}.png`);
		await Bun.write(nonImage, "not really a png");
		try {
			await controller.handleImagePathPaste(nonImage);
		} finally {
			await Bun.file(nonImage).delete();
		}

		expect(spies.pasteText).not.toHaveBeenCalled();
		expect(ctx.editor.pendingImages.length).toBe(1);
		expect(ctx.editor.pendingImages[0]?.mimeType).toBe("image/png");
	});
});
