/**
 * Issue #12244: an image attached FROM A FILESYSTEM PATH (bracketed path
 * paste, drag-and-drop, macOS file-url pasteboard) must deliver the original
 * absolute path to the model — mirroring how video contact sheets carry their
 * source path via a hidden companion message — so the agent can use the file
 * with read/other tools. Clipboard-bitmap pastes have no source file, so they
 * are committed to the session's `local://` root and that relocation-safe URL
 * is delivered the same way.
 *
 * Failure mode if this regresses: the model receives the image bytes but no
 * usable reference — or one that `/move` invalidates — so it cannot open, copy,
 * or upload the user's image (e.g. attach a pasted screenshot to an issue tracker).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls/local-protocol";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { setAgentDir } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

interface StubEditor {
	pendingImages: ImageContent[];
	pendingImageLinks: (string | undefined)[];
	imageLinks?: (string | undefined)[];
	insertAtom: (label: string, expansion: string) => void;
	pasteText: (text: string) => void;
}

function createPasteContext(sessionManager: SessionManager) {
	const editor: StubEditor = {
		pendingImages: [],
		pendingImageLinks: [],
		imageLinks: undefined,
		insertAtom: vi.fn(),
		pasteText: vi.fn(),
	};
	const showStatus = vi.fn();
	const ctx = {
		editor,
		ui: { requestRender: vi.fn(), getFocused: () => null },
		showStatus,
		sessionManager,
	} as unknown as InteractiveModeContext;
	return { ctx, editor, showStatus };
}

/** All text blocks the model would see for the session's non-assistant messages. */
function modelVisibleText(session: AgentSession): string {
	const parts: string[] = [];
	for (const message of convertToLlm(session.messages.filter(message => message.role !== "assistant"))) {
		if (typeof message.content === "string") {
			parts.push(message.content);
			continue;
		}
		for (const block of message.content) {
			if (block.type === "text") parts.push(block.text);
		}
	}
	return parts.join("\n");
}

describe("path-pasted image source path (#12244)", () => {
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;
	let settingsState: SettingsTestState | undefined;
	let tmpDir: string;

	beforeEach(async () => {
		settingsState = beginSettingsTest();
		await Settings.init({ inMemory: true });
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-image-paste-"));
		// Keep blob materialization for clipboard payloads inside the temp dir.
		setAgentDir(tmpDir);
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: createMockModel({ responses: [{ content: ["Done"] }] }).stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		authStorage?.close();
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
	});

	async function pasteImageFile(): Promise<{ editor: StubEditor; imagePath: string }> {
		if (!session) throw new Error("Session was not initialized");
		const imagePath = path.join(tmpDir, "screenshot.png");
		await Bun.write(imagePath, Buffer.from(TINY_PNG, "base64"));
		const { ctx, editor } = createPasteContext(SessionManager.inMemory(tmpDir));
		const controller = new InputController(ctx);
		await controller.handleImagePathPaste(imagePath);
		expect(editor.pendingImages.length).toBe(1);
		return { editor, imagePath };
	}

	it("delivers the original file path into the submitted model-visible content", async () => {
		if (!session) throw new Error("Session was not initialized");
		const { editor, imagePath } = await pasteImageFile();

		await session.prompt("What is in [Image #1]?", { images: [...editor.pendingImages] });

		// The path rides in a hidden user-attributed companion, mirroring the
		// video-attachment mechanism; the visible bubble stays path-free.
		const hidden = session.messages.find(
			message => message.role === "custom" && message.customType === "image-attachment",
		);
		expect(hidden?.role).toBe("custom");
		if (hidden?.role !== "custom") throw new Error("Expected hidden image-attachment context");
		expect(hidden.display).toBe(false);
		expect(hidden.attribution).toBe("user");
		expect(hidden.content).toContain(imagePath);

		const user = session.messages.find(message => message.role === "user");
		if (user?.role !== "user" || typeof user.content === "string") throw new Error("Expected user content blocks");
		const visibleText = user.content
			.filter(block => block.type === "text")
			.map(block => block.text)
			.join("\n");
		expect(visibleText).toBe("What is in [Image #1]?");

		expect(modelVisibleText(session)).toContain(imagePath);
	});

	it("links the draft image to the original file instead of a materialized blob copy", async () => {
		const { editor, imagePath } = await pasteImageFile();
		expect(editor.pendingImageLinks[0]).toBe(imagePath);
	});

	async function pasteClipboardBitmap(sessionManager: SessionManager): Promise<StubEditor> {
		const { ctx, editor } = createPasteContext(sessionManager);
		const controller = new InputController(ctx, {
			readImage: async () => ({ data: Buffer.from(TINY_PNG, "base64"), mimeType: "image/png" }),
			readText: async () => "",
		});
		expect(await controller.handleImagePaste()).toBe(true);
		expect(editor.pendingImages.length).toBe(1);
		return editor;
	}

	function localOptions(sessionManager: SessionManager) {
		return {
			getArtifactsDir: () => sessionManager.getArtifactsDir(),
			getSessionId: () => sessionManager.getSessionId(),
		};
	}

	function createSession(sessionManager: SessionManager): AgentSession {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model || !authStorage) throw new Error("Expected test model and auth storage");
		return new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
				streamFn: createMockModel({ responses: [{ content: ["Done"] }] }).stream,
			}),
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});
	}

	it("commits clipboard-bitmap pastes to the session artifact directory and delivers a local:// reference", async () => {
		if (!session) throw new Error("Session was not initialized");
		const sessionManager = SessionManager.create(tmpDir, path.join(tmpDir, "sessions"));
		const artifactsDir = sessionManager.getArtifactsDir();
		if (!artifactsDir) throw new Error("Expected a file-backed session artifact directory");
		const editor = await pasteClipboardBitmap(sessionManager);

		const url = editor.pendingImageLinks[0];
		if (!url) throw new Error("Expected the pasted image to link to its saved file");
		expect(url).toMatch(/^local:\/\/pasted-image-[0-9a-f]+\.png$/);
		const savedPath = resolveLocalUrlToPath(url, localOptions(sessionManager));
		expect(savedPath.startsWith(artifactsDir)).toBe(true);
		expect(Buffer.from(await Bun.file(savedPath).arrayBuffer()).toBase64()).toBe(TINY_PNG);

		await session.prompt("What is in [Image #1]?", { images: [...editor.pendingImages] });
		expect(modelVisibleText(session)).toContain(url);
	});

	it("keeps a pasted image readable after /move relocates the session", async () => {
		const cwdA = path.join(tmpDir, "a");
		const cwdB = path.join(tmpDir, "b");
		await fs.mkdir(cwdA, { recursive: true });
		await fs.mkdir(cwdB, { recursive: true });
		const sessionManager = SessionManager.create(cwdA, path.join(tmpDir, "sessions"));
		const moving = createSession(sessionManager);
		try {
			const editor = await pasteClipboardBitmap(sessionManager);
			const url = editor.pendingImageLinks[0];
			if (!url) throw new Error("Expected the pasted image to link to its saved file");
			await moving.prompt("What is in [Image #1]?", { images: [...editor.pendingImages] });
			await sessionManager.ensureOnDisk();
			const pathBeforeMove = resolveLocalUrlToPath(url, localOptions(sessionManager));

			await sessionManager.moveTo(cwdB);

			// The persisted notice names the relocation-safe URL, not the old absolute path.
			expect(modelVisibleText(moving)).toContain(url);
			expect(modelVisibleText(moving)).not.toContain(pathBeforeMove);
			const pathAfterMove = resolveLocalUrlToPath(url, localOptions(sessionManager));
			expect(pathAfterMove).not.toBe(pathBeforeMove);
			expect(Buffer.from(await Bun.file(pathAfterMove).arrayBuffer()).toBase64()).toBe(TINY_PNG);
			// Tools addressing `attachment://1` get the post-move filesystem path.
			expect(moving.getImageAttachments()[0]?.sourcePath).toBe(pathAfterMove);
		} finally {
			await moving.dispose();
		}
	});

	it("commits clipboard pastes in sessions without an artifact directory to the temp local:// root", async () => {
		if (!session) throw new Error("Session was not initialized");
		const sessionManager = SessionManager.inMemory(tmpDir);
		const editor = await pasteClipboardBitmap(sessionManager);

		const url = editor.pendingImageLinks[0];
		if (!url) throw new Error("Expected the pasted image to link to its saved file");
		const savedPath = resolveLocalUrlToPath(url, localOptions(sessionManager));
		expect(Buffer.from(await Bun.file(savedPath).arrayBuffer()).toBase64()).toBe(TINY_PNG);

		await session.prompt("What is in [Image #1]?", { images: [...editor.pendingImages] });
		expect(modelVisibleText(session)).toContain(url);
	});
});
