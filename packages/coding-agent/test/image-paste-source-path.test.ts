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
 * Issue #14927: chip links must target existing files, even after `/move`.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { imageContent } from "@oh-my-pi/pi-tui/chat/transcript-entry";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { imageReferenceHyperlink } from "@oh-my-pi/pi-tui/prompt/image-references";
import { imageAttachmentSource } from "@oh-my-pi/pi-tui/prompt/image-source";
import { applyHyperlinkSetting } from "@oh-my-pi/pi-tui/render/hyperlink";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { getEditorTheme, initTheme } from "@oh-my-pi/pi-tui/theme";
import { ADVISOR_RENDER_OPTIONS } from "@oh-my-pi/pi-coding-agent/advisor/delta-split";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls/local-protocol";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { materializeImageChipLinks, UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { formatSessionHistoryMarkdown } from "@oh-my-pi/pi-coding-agent/session/session-history-format";
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

function chipPath(link: string): string {
	const chip = imageReferenceHyperlink("[Image #1]", 1, [link], text => text);
	const target = chip.match(/\x1b\]8;[^;]*;(file:[^\x1b]*)/)?.[1];
	if (!target) throw new Error("Expected a clickable image chip");
	return url.fileURLToPath(target);
}

describe("path-pasted image source path (#12244)", () => {
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;
	let settingsState: SettingsTestState | undefined;
	let tmpDir: string;

	beforeAll(async () => {
		await initTheme(false);
	});

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
		applyHyperlinkSetting("auto");
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

	it("names the pasted file in the advisor's session update, where the image itself is only `[image]`", async () => {
		if (!session) throw new Error("Session was not initialized");
		const { editor, imagePath } = await pasteImageFile();

		await session.prompt("What is in [Image #1]?", { images: [...editor.pendingImages] });

		// The advisor sees a text-only transcript; without the full path it cannot `read` the image.
		const advisorView = formatSessionHistoryMarkdown(session.messages, ADVISOR_RENDER_OPTIONS);
		expect(advisorView).toContain("[image]");
		expect(advisorView).toContain(`[image-attachment] Image #1: ${imagePath}`);
	});

	it("names the pasted file for notices persisted before they carried structured details", async () => {
		if (!session) throw new Error("Session was not initialized");
		const { editor, imagePath } = await pasteImageFile();

		await session.prompt("What is in [Image #1]?", { images: [...editor.pendingImages] });

		// Sessions written by older builds stored only the rendered notice text.
		const legacyMessages = session.messages.map(message =>
			message.role === "custom" && message.customType === "image-attachment"
				? { ...message, details: undefined }
				: message,
		);
		const advisorView = formatSessionHistoryMarkdown(legacyMessages, ADVISOR_RENDER_OPTIONS);
		expect(advisorView).toContain(`[image-attachment] Image #1: ${imagePath}`);
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

		const source = imageAttachmentSource(editor.pendingImages[0]!)?.path;
		if (!source) throw new Error("Expected a saved clipboard image source");
		expect(source).toMatch(/^local:\/\/pasted-image-[0-9a-f]+\.png$/);
		const savedPath = resolveLocalUrlToPath(source, localOptions(sessionManager));
		expect(savedPath.startsWith(artifactsDir)).toBe(true);
		expect(Buffer.from(await Bun.file(savedPath).arrayBuffer()).toBase64()).toBe(TINY_PNG);
		const link = editor.pendingImageLinks[0];
		if (!link) throw new Error("Expected a clickable pasted image");
		applyHyperlinkSetting("always");
		expect(Buffer.from(await Bun.file(chipPath(link)).arrayBuffer()).toBase64()).toBe(editor.pendingImages[0]?.data);

		await session.prompt("What is in [Image #1]?", { images: [...editor.pendingImages] });
		expect(modelVisibleText(session)).toContain(source);
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
			const source = imageAttachmentSource(editor.pendingImages[0]!)?.path;
			const link = editor.pendingImageLinks[0];
			if (!source || !link) throw new Error("Expected a linked saved clipboard image");
			await moving.prompt("What is in [Image #1]?", { images: [...editor.pendingImages] });
			await sessionManager.ensureOnDisk();
			const pathBeforeMove = resolveLocalUrlToPath(source, localOptions(sessionManager));

			await sessionManager.moveTo(cwdB);

			// The persisted notice names the relocation-safe URL, not the old absolute path.
			expect(modelVisibleText(moving)).toContain(source);
			expect(modelVisibleText(moving)).not.toContain(pathBeforeMove);
			const pathAfterMove = resolveLocalUrlToPath(source, localOptions(sessionManager));
			expect(pathAfterMove).not.toBe(pathBeforeMove);
			expect(Buffer.from(await Bun.file(pathAfterMove).arrayBuffer()).toBase64()).toBe(TINY_PNG);
			applyHyperlinkSetting("always");
			expect(Buffer.from(await Bun.file(chipPath(link)).arrayBuffer()).toBase64()).toBe(
				editor.pendingImages[0]?.data,
			);
			// A transcript rebuilt from session images must also link to a file.
			const { ctx } = createPasteContext(sessionManager);
			const viewCtx: InteractiveModeContext = {
				...ctx,
				chatContainer: new TranscriptContainer(),
				transcriptMessageComponents: new WeakMap(),
				viewSession: moving,
			};
			const user = moving.messages.find(message => message.role === "user");
			if (!user) throw new Error("Expected the sent image message");
			expect(imageAttachmentSource(imageContent(user.content)[0]!)?.path).toBe(source);
			new UiHelpers(viewCtx).addMessageToChat(user);
			const rendered = viewCtx.chatContainer.children[0]?.render(100).join("\n");
			const transcriptTarget = rendered?.match(/\x1b\]8;[^;]*;(file:[^\x1b]*)/)?.[1];
			if (!transcriptTarget) throw new Error("Expected a linked transcript image chip");
			expect(Buffer.from(await Bun.file(url.fileURLToPath(transcriptTarget)).arrayBuffer()).toBase64()).toBe(
				editor.pendingImages[0]?.data,
			);
			// A draft restored with the image (/tree, rewind, branch) must also link to a file.
			const restored = new CustomEditor(getEditorTheme());
			let restoredLinks: Promise<(string | undefined)[]> | undefined;
			restored.draftImageLinkMaterializer = images => {
				restoredLinks = materializeImageChipLinks(images, sessionManager.putBlob.bind(sessionManager));
				return restoredLinks;
			};
			restored.setDraft("What is in [Image #1]?", [...editor.pendingImages]);
			await restoredLinks;
			const restoredLink = restored.imageLinks?.[0];
			if (!restoredLink) throw new Error("Expected a linked restored draft image");
			expect(Buffer.from(await Bun.file(chipPath(restoredLink)).arrayBuffer()).toBase64()).toBe(
				editor.pendingImages[0]?.data,
			);
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

		const source = imageAttachmentSource(editor.pendingImages[0]!)?.path;
		if (!source) throw new Error("Expected a saved clipboard image source");
		const savedPath = resolveLocalUrlToPath(source, localOptions(sessionManager));
		expect(Buffer.from(await Bun.file(savedPath).arrayBuffer()).toBase64()).toBe(TINY_PNG);

		await session.prompt("What is in [Image #1]?", { images: [...editor.pendingImages] });
		expect(modelVisibleText(session)).toContain(source);
	});

	for (const dequeue of ["popLastQueuedMessage", "clearQueue"] as const) {
		it(`drops a queued image's hidden path notice with its prompt on ${dequeue}`, async () => {
			if (!session) throw new Error("Session was not initialized");
			const { editor } = await pasteImageFile();
			const text = "What is in [Image #1]?";
			await session.followUp(text, [...editor.pendingImages]);
			expect(
				session.agent
					.peekFollowUpQueue()
					.map(message => (message.role === "custom" ? message.customType : message.role)),
			).toEqual(["image-attachment", "user"]);

			if (dequeue === "clearQueue")
				expect(session.clearQueue().followUp.map(message => message.text)).toEqual([text]);
			else expect(session.popLastQueuedMessage()?.text).toBe(text);

			// A notice left behind would be delivered later as its own orphaned turn.
			expect(session.agent.peekFollowUpQueue()).toEqual([]);
		});
	}
});
