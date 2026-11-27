import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { Keybinding } from "@oh-my-pi/pi-coding-agent/config/keybindings/app-keybindings";
import type { KeybindingsConfig } from "@oh-my-pi/pi-coding-agent/config/keybindings/config-file";
import type { KeyId } from "@oh-my-pi/pi-coding-agent/config/keybindings/key-id";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings/keybindings";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { ComposerOwner, InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { imageAttachmentSource } from "@oh-my-pi/pi-coding-agent/utils/image-source";
import { type KeyEvent, UiNode } from "@oh-my-pi/pi-tui";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { InputEvent } from "@oh-my-pi/pi-tui/driver/index";
import type { HtmlFormData } from "../src/tools/html-form/data";
import { parseHtmlForm } from "../src/tools/html-form/parse";
import { Composer } from "../src/ui/composer/composer";
import { HtmlFormModel } from "../src/ui/forms/html-form";
import { type OverlayHandle, Overlays } from "../src/ui/shell";
import { createInputHarness, type InputHarness } from "./helpers/input-harness";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";
import { key, sendKey } from "./ui/composer/harness";

const KEYS: KeybindingsConfig = {
	"app.display.reset": "alt+l",
	"app.stt.pushToTalk": "space",
	"app.thinking.toggle": "ctrl+t",
	"app.history.search": "ctrl+r",
	"app.editor.external": "ctrl+g",
	"app.local.open": "alt+g",
	"app.model.selectTemporary": "ctrl+y",
	"app.model.select": "alt+m",
	"app.retry": "alt+r",
	"app.clipboard.pasteImage": "ctrl+v",
	"app.tools.toggleVisibility": "ctrl+shift+o",
	"app.tools.expand": "ctrl+o",
};

/** A focused node other than the composer; `onKey` stands for the keys it binds itself. */
function fakeNode(kind = "list", onKey?: (key: KeyEvent) => boolean): UiNode {
	return { kind, handlers: { onKey }, children: () => [] } as unknown as UiNode;
}

function createContext() {
	const editor = new Composer();
	vi.spyOn(editor, "addToHistory");
	const insertAtom = vi.spyOn(editor, "insertAtom");
	const input = createInputHarness();
	const keybindings = KeybindingsManager.inMemory({ ...KEYS });
	let focused: UiNode | null = editor.field;
	let overlayVisible = false;
	const writeRaw = vi.fn<(data: string) => void>();
	const shellPaste = vi.fn<(text: string) => boolean>(() => true);
	const replayHistory = vi.fn();
	const refreshAppearance = vi.fn();
	const resetDisplayAfterAppearanceRefresh = vi.fn(() => refreshAppearance());
	const showModelSelector = vi.fn();
	const showError = vi.fn();
	const prompt = vi.fn(async () => {});
	const retry = vi.fn(async () => true);
	const abort = vi.fn(async () => {});
	const session = {
		isStreaming: false,
		isCompacting: false,
		isGeneratingHandoff: false,
		extensionRunner: undefined,
		customCommands: [],
		promptTemplates: [],
		queuedMessageCount: 0,
		prompt,
		abort,
		retry,
		prewarmModelConnection: vi.fn(),
	};
	const updatePendingMessagesDisplay = vi.fn();
	const handleBtwBranchKey = vi.fn(async () => true);
	const handleBtwCopyKey = vi.fn(async () => true);
	const canBranchBtw = vi.fn(() => false);
	const canCopyBtw = vi.fn(() => false);
	const canFollowUpBtw = vi.fn(() => false);
	const handleBtwFollowUpKey = vi.fn(() => true);
	const hasActiveBtw = vi.fn(() => false);
	const handlesBtwBranchKey = vi.fn(() => false);
	const isGuidedGoalInterviewActive = vi.fn(() => false);
	const ctx = {
		composer: editor,
		...input.context,
		shell: {
			focused: () => focused,
			overlays: { open: () => overlayVisible, blocking: () => overlayVisible },
			paste: shellPaste,
			host: { replayHistory, driver: { writeRaw } },
		},
		syncIdleMaintenanceView: vi.fn(),
		resetDisplayAfterAppearanceRefresh,
		session: session as unknown as InteractiveModeContext["session"],
		viewSession: session as unknown as InteractiveModeContext["viewSession"],
		keybindings,
		locallySubmittedUserSignatures: new Set<string>(),
		isKnownSlashCommand: () => false,
		recordLocalSubmission(this: InteractiveModeContext, text: string, imageCount = 0) {
			if (this.isKnownSlashCommand(text)) return () => {};
			const sig = `${text}\u0000${imageCount}`;
			this.locallySubmittedUserSignatures.add(sig);
			let disposed = false;
			return () => {
				if (disposed) return;
				disposed = true;
				this.locallySubmittedUserSignatures.delete(sig);
			};
		},
		async withLocalSubmission<T>(
			this: InteractiveModeContext,
			text: string,
			fn: () => Promise<T>,
			options?: { imageCount?: number },
		): Promise<T> {
			const dispose = this.recordLocalSubmission(text, options?.imageCount ?? 0);
			try {
				return await fn();
			} catch (err) {
				dispose();
				throw err;
			}
		},
		updatePendingMessagesDisplay,
		compactionQueuedMessages: [],
		skillCommands: new Map(),
		fileSlashCommands: new Set<string>(),
		mcpTestEscapeHandlers: new Set<() => void>(),
		isBashMode: false,
		isPythonMode: false,
		isBtwMode: false,
		hideToolActivity: false,
		toolOutputExpanded: false,
		settings: Settings.isolated(),
		handleHotkeysCommand: vi.fn(),
		handlePlanModeCommand: vi.fn(),
		handleNewCommand: vi.fn(),
		showTreeSelector: vi.fn(),
		showUserMessageSelector: vi.fn(),
		showSessionSelector: vi.fn(),
		handleSTTToggle: vi.fn(),
		dictationSpaceHold: vi.fn(),
		showDebugSelector: vi.fn(),
		showHistorySearch: vi.fn(),
		toggleThinkingBlockVisibility: vi.fn(),
		showModelSelector,
		updateEditorBorderColor: vi.fn(),
		hasActiveBtw,
		handlesBtwBranchKey,
		handleBtwBranchKey,
		canBranchBtw,
		canCopyBtw,
		handleBtwCopyKey,
		canFollowUpBtw,
		handleBtwFollowUpKey,
		showError,
		showStatus: vi.fn(),
		isGuidedGoalInterviewActive,
		sessionManager: { getSessionId: () => "session", getLeafId: () => null },
	} as unknown as InteractiveModeContext;

	return {
		ctx,
		editor,
		input,
		/** Press `id` through the shell's dispatch order. */
		press: (id: string) => input.press(ctx, id),
		setFocused(target: UiNode | null) {
			focused = target;
		},
		setOverlayVisible(visible: boolean) {
			overlayVisible = visible;
		},
		setKeybinding(action: Keybinding, keys: KeyId[]) {
			keybindings.setUserBindings({ ...KEYS, [action]: keys });
		},
		spies: {
			showModelSelector,
			prompt,
			updatePendingMessagesDisplay,
			retry,
			abort,
			replayHistory,
			refreshAppearance,
			resetDisplayAfterAppearanceRefresh,
			handleBtwBranchKey,
			canBranchBtw,
			hasActiveBtw,
			handlesBtwBranchKey,
			handleBtwCopyKey,
			canCopyBtw,
			canFollowUpBtw,
			handleBtwFollowUpKey,
			showError,
			isGuidedGoalInterviewActive,
			insertAtom,
			shellPaste,
			writeRaw,
		},
	};
}

// 1x1 PNG.
const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD3sAAAAASUVORK5CYII=";

const PNG_CLIPBOARD = {
	readImage: async () => ({ data: Buffer.from(TINY_PNG, "base64"), mimeType: "image/png" }),
	readText: async () => "",
	readMacFileUrls: async (): Promise<string[]> => [],
};

/** One kitty OSC 5522 clipboard packet. */
const packet = (metadata: string, payload?: string) =>
	`\x1b]5522;${metadata}${payload === undefined ? "" : `;${payload}`}\x1b\\`;
const base64 = (value: string) => Buffer.from(value).toString("base64");

type Dispatcher = { ctx: InteractiveModeContext; input: InputHarness };

function dispatchOsc({ ctx, input }: Dispatcher, raw: string): void {
	input.dispatch(ctx, { type: "osc", raw });
}

/** Replay a kitty OSC 5522 enhanced paste that offers text and PNG and delivers `png` bytes. */
function dispatchEnhancedImagePaste(target: Dispatcher, png: Uint8Array): void {
	const imageMime = base64("image/png");
	const textMime = base64("text/plain");
	for (const raw of [
		packet("type=read:status=OK:pw=secret"),
		packet(`type=read:status=DATA:mime=${textMime}`),
		packet(`type=read:status=DATA:mime=${imageMime}`),
		packet("type=read:status=DONE"),
		packet("type=read:status=OK"),
		packet(`type=read:status=DATA:mime=${imageMime}`, Buffer.from(png).toString("base64")),
		packet("type=read:status=DONE"),
	]) {
		dispatchOsc(target, raw);
	}
}

/** Replay a kitty OSC 5522 enhanced paste that offers and delivers plain `text`. */
function dispatchEnhancedTextPaste(target: Dispatcher, text: string): void {
	const textMime = base64("text/plain");
	for (const raw of [
		packet("type=read:status=OK:pw=secret"),
		packet(`type=read:status=DATA:mime=${textMime}`),
		packet("type=read:status=DONE"),
		packet("type=read:status=OK"),
		packet(`type=read:status=DATA:mime=${textMime}`, base64(text)),
		packet("type=read:status=DONE"),
	]) {
		dispatchOsc(target, raw);
	}
}

/** Make `shellPaste` deliver to the focused `composer` as the shell does: past the interceptors, to its field. */
function deliverPastesToComposer(shellPaste: Mock<(text: string) => boolean>, composer: Composer): void {
	shellPaste.mockImplementation(text => composer.field.handlers.onPaste?.({ text }) ?? false);
}

/** Replay a kitty OSC 5522 listing that offers plain text and HTML; the controller then requests one of them. */
function offerTextAndHtml(target: Dispatcher): void {
	dispatchOsc(target, packet("type=read:status=OK"));
	dispatchOsc(target, packet(`type=read:status=DATA:mime=${base64(".")}`, base64("text/plain text/html")));
	dispatchOsc(target, packet("type=read:status=DONE"));
}

/** Deliver `body` as the `mime` the controller requested. */
function deliverEnhancedPaste(target: Dispatcher, mime: string, body: string): void {
	dispatchOsc(target, packet("type=read:status=OK"));
	dispatchOsc(target, packet(`type=read:status=DATA:mime=${base64(mime)}`, base64(body)));
	dispatchOsc(target, packet("type=read:status=DONE"));
}

/** Resolves on the next call to `mock`; the call still runs its current implementation. */
function nextCall<Args extends unknown[], R>(mock: Mock<(...args: Args) => R>): Promise<void> {
	const called = Promise.withResolvers<void>();
	const current = mock.getMockImplementation();
	mock.mockImplementation(function (this: unknown, ...args: Args) {
		called.resolve();
		return current?.apply(this, args);
	} as (...args: Args) => R);
	return called.promise;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("InputController keybinding setup", () => {
	it("an exit key that also deletes edits even whitespace, before a lower-priority submit binding", () => {
		const { ctx, editor } = createContext();
		ctx.keybindings.setUserBindings({ "app.exit": "enter", "tui.editor.deleteCharForward": "enter" });
		new InputController(ctx).setupKeyHandlers();
		editor.setText(" draft");
		sendKey(editor.node, editor.field, key("\x01"));
		sendKey(editor.node, editor.field, key("\r"));
		expect(editor.text()).toBe("draft");
		editor.setText(" ");
		sendKey(editor.node, editor.field, key("\x01"));
		sendKey(editor.node, editor.field, key("\r"));
		expect(editor.text()).toBe("");
	});
	it("routes model selector and display reset keys to separate actions", () => {
		const { ctx, press, spies } = createContext();
		new InputController(ctx).setupKeyHandlers();

		expect(press("alt+l")).toBe("composer");
		expect(press("ctrl+y")).toBe("composer");
		expect(press("alt+m")).toBe("composer");

		expect(spies.showModelSelector).toHaveBeenNthCalledWith(1, { temporaryOnly: true });
		expect(spies.showModelSelector).toHaveBeenNthCalledWith(2);
		expect(spies.resetDisplayAfterAppearanceRefresh).toHaveBeenCalledTimes(1);
	});

	it("enters Python mode only once whitespace follows a typed sigil", () => {
		const { ctx, editor } = createContext();
		new InputController(ctx).setupKeyHandlers();

		for (const draft of ["$", "$H", "$$", "$$a"]) {
			editor.setText(draft);
			expect(ctx.isPythonMode).toBe(false);
		}
		expect(ctx.updateEditorBorderColor).not.toHaveBeenCalled();

		editor.setText("$$ ");
		expect(ctx.isPythonMode).toBe(true);
		editor.setText("$$ a");
		expect(ctx.isPythonMode).toBe(true);
		expect(ctx.updateEditorBorderColor).toHaveBeenCalledTimes(1);
	});

	it("does not mark pasted shell prompts as Python mode while editing", () => {
		const { ctx, editor } = createContext();
		new InputController(ctx).setupKeyHandlers();

		editor.setText("$ cd ~/project && sudo ./build-and-push.sh o5.7 2>&1 | tail -4");

		expect(ctx.isPythonMode).toBe(false);
		expect(ctx.updateEditorBorderColor).not.toHaveBeenCalled();

		editor.setText("$ print(1)");

		expect(ctx.isPythonMode).toBe(true);
		expect(ctx.updateEditorBorderColor).toHaveBeenCalledTimes(1);
	});

	it("routes the retry key and retries the failed turn", async () => {
		const { ctx, editor, press, spies } = createContext();
		new InputController(ctx).setupKeyHandlers();

		editor.setText("draft that should survive retry");
		expect(press("alt+r")).toBe("composer");
		await Promise.resolve();

		expect(spies.retry).toHaveBeenCalledTimes(1);
		expect(spies.prompt).not.toHaveBeenCalled();
		expect(editor.text()).toBe("draft that should survive retry");
	});

	it("retries the focused view session instead of the main session", async () => {
		const { ctx, press, spies } = createContext();
		const focusedRetry = vi.fn(async () => true);
		Object.assign(ctx, { focusedAgentId: "worker", viewSession: { retry: focusedRetry } });
		new InputController(ctx).setupKeyHandlers();

		press("alt+r");
		await Promise.resolve();

		expect(focusedRetry).toHaveBeenCalledTimes(1);
		expect(spies.retry).not.toHaveBeenCalled();
	});

	it("keeps retry host-only for collab guests", async () => {
		const { ctx, editor, press, spies } = createContext();
		Object.assign(ctx, { collabGuest: { readOnly: true } });
		new InputController(ctx).setupKeyHandlers();

		editor.setText("guest draft");
		press("alt+r");
		await Promise.resolve();

		expect(spies.retry).not.toHaveBeenCalled();
		expect(ctx.showStatus).toHaveBeenCalledWith("/retry is host-only during a collab session");
		expect(editor.text()).toBe("guest draft");
	});

	it("keeps the draft when there is nothing to retry", async () => {
		const { ctx, editor, press, spies } = createContext();
		spies.retry.mockResolvedValueOnce(false);
		new InputController(ctx).setupKeyHandlers();

		editor.setText("draft that should survive");
		press("alt+r");
		await Promise.resolve();

		expect(ctx.showStatus).toHaveBeenCalledWith("Nothing to retry");
		expect(editor.text()).toBe("draft that should survive");
	});

	it("keeps retry draft attachments after retry starts", async () => {
		const { ctx, editor, press, spies } = createContext();
		const image: ImageContent = { type: "image", mimeType: "image/png", data: "abc" };
		new InputController(ctx).setupKeyHandlers();

		editor.pendingImages.push(image);
		editor.pendingImageLinks.push("local://draft.png");
		editor.setText("draft with image");
		press("alt+r");
		await Promise.resolve();

		expect(spies.retry).toHaveBeenCalledTimes(1);
		expect(editor.pendingImages).toEqual([image]);
		expect(editor.pendingImageLinks).toEqual(["local://draft.png"]);
		expect(editor.text()).toBe("draft with image");
	});

	it("routes b to branch a branchable /btw panel", () => {
		const { ctx, press, spies } = createContext();
		spies.handlesBtwBranchKey.mockReturnValue(true);
		new InputController(ctx).setupKeyHandlers();

		expect(press("b")).toBe("composer");
		expect(spies.handleBtwBranchKey).toHaveBeenCalledTimes(1);
	});

	it("lets b fall through while the editor has draft text", () => {
		const { ctx, editor, press, spies } = createContext();
		spies.handlesBtwBranchKey.mockReturnValue(true);
		editor.setText("build a branch");
		new InputController(ctx).setupKeyHandlers();

		expect(press("b")).toBe("unhandled");
		expect(spies.handleBtwBranchKey).not.toHaveBeenCalled();
	});

	it("lets b reach the composer before an active /btw answer is branchable", () => {
		const { ctx, press, spies } = createContext();
		spies.hasActiveBtw.mockReturnValue(true);
		new InputController(ctx).setupKeyHandlers();

		expect(press("b")).toBe("unhandled");
		expect(spies.handleBtwBranchKey).not.toHaveBeenCalled();
	});

	it("lets b fall through while another input is focused", () => {
		const { ctx, press, setFocused, spies } = createContext();
		spies.handlesBtwBranchKey.mockReturnValue(true);
		setFocused(fakeNode("input"));
		new InputController(ctx).setupKeyHandlers();

		expect(press("b")).toBe("unhandled");
		expect(spies.handleBtwBranchKey).not.toHaveBeenCalled();
	});

	it("leaves ← to an overlay open over a focused subagent's view", () => {
		const { ctx, press, setFocused } = createContext();
		Object.assign(ctx, { focusedAgentId: "Worker", lastLeftTapTime: 0, unfocusSession: vi.fn(async () => {}) });
		new InputController(ctx).setupKeyHandlers();

		// The empty composer owns the ←← back-to-main gesture.
		expect(press("left")).toBe("composer");
		// The model picker's thinking slider steps on ←; the gesture must not swallow it.
		const slider = vi.fn((key: KeyEvent) => key.id === "left");
		setFocused(fakeNode("list", slider));
		expect(press("left")).toBe("focused");
		expect(slider).toHaveBeenCalledTimes(1);
	});

	it("routes the smart-paste shortcut to a focused login input", async () => {
		const { ctx, press, setFocused, spies } = createContext();
		const pasted = nextCall(spies.shellPaste);
		setFocused(fakeNode("input"));
		new InputController(ctx, {
			readImage: async () => null,
			readText: async () => "sk-test-key",
		}).setupKeyHandlers();

		expect(press("ctrl+v")).toBe("global");
		await pasted;
		expect(spies.shellPaste).toHaveBeenCalledWith("sk-test-key");
	});

	it("delivers an enhanced text paste to a focused dialog as a bracketed paste", async () => {
		const context = createContext();
		const pasted = nextCall(context.spies.shellPaste);
		context.setFocused(fakeNode("list"));
		new InputController(context.ctx).setupKeyHandlers();

		dispatchEnhancedTextPaste(context, "sk-test-key");

		await pasted;
		expect(context.spies.shellPaste).toHaveBeenCalledWith("sk-test-key");
		expect(context.editor.text()).toBe("");
	});

	it("attaches an image path an enhanced text paste delivers to the composer", async () => {
		const context = createContext();
		deliverPastesToComposer(context.spies.shellPaste, context.editor);
		const pasted = nextCall(context.spies.shellPaste);
		const controller = new InputController(context.ctx);
		const attach = vi.spyOn(controller, "handleImagePathPaste").mockResolvedValue();
		controller.setupKeyHandlers();

		dispatchEnhancedTextPaste(context, "/tmp/Screenshot\\ 2026-10-19\\ at\\ 14.25.32.png");

		await pasted;
		expect(attach).toHaveBeenCalledWith("/tmp/Screenshot 2026-10-19 at 14.25.32.png");
		expect(context.editor.text()).toBe("");
	});

	it("collapses a large enhanced text paste into the chip a bracketed paste makes", async () => {
		const text = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n");
		const bracketed = createContext();
		new InputController(bracketed.ctx).setupKeyHandlers();
		bracketed.input.paste(bracketed.ctx, text);

		const enhanced = createContext();
		deliverPastesToComposer(enhanced.spies.shellPaste, enhanced.editor);
		const pasted = nextCall(enhanced.spies.shellPaste);
		new InputController(enhanced.ctx).setupKeyHandlers();
		dispatchEnhancedTextPaste(enhanced, text);
		await pasted;

		expect(enhanced.editor.text()).toBe(bracketed.editor.text());
		expect(enhanced.editor.chips().map(chip => chip.kind)).toEqual(["paste"]);
		expect(enhanced.editor.expandedText()).toBe(`${text} `);
	});

	it("enables enhanced paste on the terminal once input is wired", () => {
		const { ctx, spies } = createContext();
		new InputController(ctx).setupKeyHandlers();
		expect(spies.writeRaw).toHaveBeenCalledWith("\x1b[?5522h");
	});

	it("rejects image smart-paste while a login input is focused instead of mutating the hidden editor", async () => {
		const { ctx, editor, press, setFocused, spies } = createContext();
		setFocused(fakeNode("input"));
		const rejected = nextCall(ctx.showStatus as unknown as Mock<(message: string) => void>);
		new InputController(ctx, {
			readImage: async () => ({ data: new Uint8Array([0x89, 0x50]), mimeType: "image/png" }),
			readText: async () => "sk-test-key",
		}).setupKeyHandlers();

		expect(press("ctrl+v")).toBe("global");
		await rejected;
		expect(ctx.showStatus).toHaveBeenCalledWith("Image paste is not supported in this prompt");
		expect(spies.shellPaste).not.toHaveBeenCalled();
		expect(editor.pendingImages).toHaveLength(0);
		expect(editor.text()).toBe("");
	});

	it("opens inline follow-up only with an empty focused editor and a ready BTW answer", () => {
		const { ctx, editor, press, setFocused, spies } = createContext();
		new InputController(ctx).setupKeyHandlers();

		expect(press("f")).toBe("unhandled");
		spies.canFollowUpBtw.mockReturnValue(true);
		editor.setText("finish this draft");
		expect(press("f")).toBe("unhandled");
		editor.setText("");
		setFocused(fakeNode("input"));
		expect(press("f")).toBe("unhandled");
		expect(spies.handleBtwFollowUpKey).not.toHaveBeenCalled();

		setFocused(editor.field);
		expect(press("f")).toBe("composer");
		expect(spies.handleBtwFollowUpKey).toHaveBeenCalledTimes(1);
	});

	it("leaves x as ordinary input while a BTW panel is active", () => {
		const { ctx, press, spies } = createContext();
		spies.hasActiveBtw.mockReturnValue(true);
		new InputController(ctx).setupKeyHandlers();
		expect(press("x")).toBe("unhandled");
	});

	it("routes c to copy a copyable /btw panel when the editor is empty", () => {
		const { ctx, press, spies } = createContext();
		spies.canCopyBtw.mockReturnValue(true);
		new InputController(ctx).setupKeyHandlers();

		expect(press("c")).toBe("composer");
		expect(spies.handleBtwCopyKey).toHaveBeenCalledTimes(1);
	});

	it("lets c fall through while the editor has draft text", () => {
		const { ctx, editor, press, spies } = createContext();
		spies.canCopyBtw.mockReturnValue(true);
		editor.setText("continue this draft");
		new InputController(ctx).setupKeyHandlers();

		expect(press("c")).toBe("unhandled");
		expect(spies.handleBtwCopyKey).not.toHaveBeenCalled();
	});

	it("lets c fall through when /btw is not copyable", () => {
		const { ctx, press, spies } = createContext();
		new InputController(ctx).setupKeyHandlers();

		expect(press("c")).toBe("unhandled");
		expect(spies.handleBtwCopyKey).not.toHaveBeenCalled();
	});

	it("lets c fall through while another input is focused", () => {
		const { ctx, press, setFocused, spies } = createContext();
		spies.canCopyBtw.mockReturnValue(true);
		setFocused(fakeNode("input"));
		new InputController(ctx).setupKeyHandlers();

		expect(press("c")).toBe("unhandled");
		expect(spies.handleBtwCopyKey).not.toHaveBeenCalled();
	});

	it("routes extension shortcuts by their canonical key id", () => {
		const { ctx, press } = createContext();
		const handler = vi.fn();
		const runner = {
			getShortcuts: () => new Map([["shift+ctrl+k", { extensionPath: "ext", handler }]]),
			isExtensionActive: () => true,
			createCommandContext: () => ({}),
			runScoped: (fn: () => void) => fn(),
			emitError: vi.fn(),
		};
		Object.assign(ctx.session, { extensionRunner: runner });
		new InputController(ctx).setupKeyHandlers();

		expect(press("ctrl+shift+k")).toBe("composer");
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it("marks streaming follow-up submissions as local", async () => {
		const { ctx, editor, spies } = createContext();
		const session = ctx.session as unknown as { isStreaming: boolean };
		session.isStreaming = true;
		editor.setText("follow up after current response");
		const controller = new InputController(ctx);

		await controller.handleFollowUp();

		expect(ctx.locallySubmittedUserSignatures.has("follow up after current response\u00000")).toBe(true);
		expect(spies.prompt).toHaveBeenCalledWith("follow up after current response", {
			streamingBehavior: "followUp",
		});
		expect(spies.updatePendingMessagesDisplay).toHaveBeenCalledTimes(1);
	});

	it("marks idle follow-up submissions as local", async () => {
		const { ctx, editor, spies } = createContext();
		// Default fake session is idle.
		editor.setText("plain idle submit");
		const controller = new InputController(ctx);

		await controller.handleFollowUp();

		expect(ctx.locallySubmittedUserSignatures.has("plain idle submit\u00000")).toBe(true);
		// Idle submit calls prompt() with no streamingBehavior (images forwarded, undefined here).
		expect(spies.prompt).toHaveBeenCalledWith("plain idle submit", { images: undefined });
	});

	it("surfaces and recovers from an idle follow-up dispatch failure", async () => {
		const { ctx, editor, spies } = createContext();
		spies.prompt.mockImplementationOnce(async () => {
			throw new Error("boom");
		});
		editor.setText("doomed submit");
		const controller = new InputController(ctx);

		// Dispatch failures are caught and surfaced (mirroring the main/focused
		// submit paths), not rethrown, so the keybinding's fire-and-forget call
		// never raises an unhandled rejection.
		await controller.handleFollowUp();

		expect(spies.showError).toHaveBeenCalledWith("boom");
		// Draft handed back so the user can retry.
		expect(editor.text()).toBe("doomed submit");
		// Contract: a failed delivery must not leave a stale signature behind,
		// otherwise the next attempt with the same text would silently suppress
		// the editor-clear protection that was meant for the failed call.
		expect(ctx.locallySubmittedUserSignatures.has("doomed submit\u00000")).toBe(false);
	});

	it("surfaces and recovers from a streaming follow-up dispatch failure", async () => {
		const { ctx, editor, spies } = createContext();
		const session = ctx.session as unknown as { isStreaming: boolean };
		session.isStreaming = true;
		spies.prompt.mockImplementationOnce(async () => {
			throw new Error("queue full");
		});
		editor.setText("queued during stream");
		const controller = new InputController(ctx);

		await controller.handleFollowUp();

		expect(spies.showError).toHaveBeenCalledWith("queue full");
		expect(editor.text()).toBe("queued during stream");
		expect(ctx.locallySubmittedUserSignatures.has("queued during stream\u00000")).toBe(false);
	});

	function withCompactionQueue(ctx: InteractiveModeContext) {
		const handleCompactCommand = vi.fn(async () => "ok" as const);
		const queueCompactionMessage = vi.fn((text: string, mode: "steer" | "followUp") => {
			ctx.compactionQueuedMessages.push({ text, mode });
		});
		Object.assign(ctx, {
			compactionQueuedMessages: [],
			yieldCompaction: undefined,
			handleCompactCommand,
			queueCompactionMessage,
			runYieldCompaction: vi.fn(),
			sessionManager: {
				getSessionId: () => "session-1",
				getLeafId: () => "entry-7",
				getBranch: () => [{ id: "entry-7" }],
			},
		});
		return { handleCompactCommand, queueCompactionMessage };
	}

	it("queues a follow-up /compact for the next yield instead of interrupting the run", async () => {
		const { ctx, editor, spies } = createContext();
		const { handleCompactCommand, queueCompactionMessage } = withCompactionQueue(ctx);
		// Session queues popped like `AgentSession.popLastQueuedMessage`: steering first, then follow-ups.
		const steering: string[] = [];
		const followUp = ["sent before the compaction"];
		Object.assign(ctx.session, {
			isStreaming: true,
			getQueuedMessages: () => ({ steering: [...steering], followUp: [...followUp], liveSteered: 0 }),
			popLastQueuedMessage: () => {
				const text = steering.pop() ?? followUp.pop();
				return text === undefined ? undefined : { text };
			},
		});
		const controller = new InputController(ctx);

		editor.setText("/compact keep the API notes");
		await controller.handleFollowUp();
		expect(handleCompactCommand).not.toHaveBeenCalled();
		expect(spies.showError).not.toHaveBeenCalled();
		expect(ctx.yieldCompaction).toEqual({
			text: "/compact keep the API notes",
			sessionId: "session-1",
			leafId: "entry-7",
			instructions: "keep the API notes",
			mode: undefined,
		});

		// A follow-up sent after the queued compaction waits for it.
		editor.setText("now continue");
		await controller.handleFollowUp();
		expect(spies.prompt).not.toHaveBeenCalled();
		expect(queueCompactionMessage).toHaveBeenCalledWith("now continue", "followUp", undefined, {
			preserveDraft: true,
		});

		// A steer sent after the compaction lands before the yield.
		steering.push("steer mid-run");

		// Dequeue: the steer, then the held follow-up (as queue shorthand, so Enter holds it again), then the
		// request (as typed: Enter compacts now), then what was queued before it.
		const restored: string[] = [];
		for (let i = 0; i < 4; i++) {
			editor.setText("");
			controller.handleDequeue();
			restored.push(editor.text());
		}
		expect(restored).toEqual([
			"steer mid-run",
			"=> now continue",
			"/compact keep the API notes",
			"sent before the compaction",
		]);
		expect(ctx.yieldCompaction).toBeUndefined();
	});

	it("still compacts at once for a follow-up /compact while idle", async () => {
		const { ctx, editor } = createContext();
		const { handleCompactCommand } = withCompactionQueue(ctx);
		editor.setText("/compact");

		await new InputController(ctx).handleFollowUp();

		expect(handleCompactCommand).toHaveBeenCalledWith(undefined, undefined);
		expect(ctx.yieldCompaction).toBeUndefined();
	});

	it("keeps submission order when an input hook delays a follow-up /compact", async () => {
		const { ctx, editor, spies } = createContext();
		const { queueCompactionMessage } = withCompactionQueue(ctx);
		const compactHook = Promise.withResolvers<void>();
		Object.assign(ctx.session, {
			isStreaming: true,
			extensionRunner: {
				hasHandlers: (event: string) => event === "input",
				// Slow for the `/compact`, instant for the message sent after it.
				emitInput: async (text: string) => {
					if (text.startsWith("/compact")) await compactHook.promise;
					return undefined;
				},
			},
		});
		const controller = new InputController(ctx);

		editor.setText("/compact");
		const compact = controller.handleFollowUp();
		editor.setText("after the compaction");
		const message = controller.handleFollowUp();
		compactHook.resolve();
		await Promise.all([compact, message]);

		expect(ctx.yieldCompaction?.text).toBe("/compact");
		expect(spies.prompt).not.toHaveBeenCalled();
		expect(queueCompactionMessage).toHaveBeenCalledWith("after the compaction", "followUp", undefined, {
			preserveDraft: true,
		});
	});

	it("holds an Enter queue shorthand behind a follow-up /compact whose input hook is slower", async () => {
		const { ctx, editor } = createContext();
		withCompactionQueue(ctx);
		const compactHook = Promise.withResolvers<void>();
		const followUp = vi.fn(async () => {});
		Object.assign(ctx.session, {
			isStreaming: true,
			followUp,
			extensionRunner: {
				hasHandlers: (event: string) => event === "input",
				emitInput: async (text: string) => {
					if (text.startsWith("/compact")) await compactHook.promise;
					return undefined;
				},
			},
		});
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		editor.setText("/compact");
		const compact = controller.handleFollowUp();
		const queued = editor.onSubmit?.("=> later");
		compactHook.resolve();
		await Promise.all([compact, queued]);

		expect(ctx.yieldCompaction?.text).toBe("/compact");
		expect(followUp).not.toHaveBeenCalled();
		expect(ctx.compactionQueuedMessages.map(entry => entry.text)).toEqual(["later"]);
	});

	it("returns a follow-up /compact to the editor when the conversation changed during its input hook", async () => {
		const { ctx, editor } = createContext();
		const { handleCompactCommand } = withCompactionQueue(ctx);
		const showWarning = vi.fn();
		const sessionManager = {
			sessionId: "session-1",
			getSessionId: () => sessionManager.sessionId,
			getLeafId: () => null,
		};
		Object.assign(ctx, { showWarning, sessionManager });
		Object.assign(ctx.session, {
			isStreaming: true,
			extensionRunner: {
				hasHandlers: (event: string) => event === "input",
				// The user resumes another session while the hook runs.
				emitInput: async () => {
					sessionManager.sessionId = "session-2";
					return undefined;
				},
			},
		});

		editor.setText("/compact");
		await new InputController(ctx).handleFollowUp();

		expect(handleCompactCommand).not.toHaveBeenCalled();
		expect(ctx.yieldCompaction).toBeUndefined();
		expect(editor.text()).toBe("/compact");
		expect(showWarning).toHaveBeenCalledTimes(1);
	});

	it("hands input queued during a compaction back to the editor on a session reset", async () => {
		const { ctx, editor } = createContext();
		withCompactionQueue(ctx);
		ctx.compactionQueuedMessages.push({ text: "typed while compacting", mode: "followUp" });

		new InputController(ctx).restoreCompactionQueueToEditor();

		expect(editor.text()).toBe("typed while compacting");
		expect(ctx.compactionQueuedMessages).toEqual([]);
	});

	it("counts a follow-up as dispatched once the session admits it", async () => {
		const { ctx, editor, spies } = createContext();
		Object.assign(ctx.session, { isStreaming: true });
		// Queued follow-ups resolve with the run; admission is what a queued `/compact` waits for.
		spies.prompt.mockImplementation(() => new Promise(() => {}));
		const controller = new InputController(ctx);

		editor.setText("sent before the compaction");
		void controller.handleFollowUp();
		await controller.waitForSubmissionDispatches();

		expect(spies.prompt).toHaveBeenCalledTimes(1);
	});

	it("empty Enter interrupts a streaming turn to deliver queued input", async () => {
		const { ctx, editor, spies } = createContext();
		Object.assign(ctx.session, { isStreaming: true, queuedMessageCount: 1, hasInterruptibleInput: true });
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();
		sendKey(editor.node, editor.field, key("\r"));
		await controller.waitForSubmissionDispatches();
		expect(spies.abort).toHaveBeenCalledWith(expect.objectContaining({ deliverQueuedMessages: true }));
		expect(spies.updatePendingMessagesDisplay).toHaveBeenCalled();
	});

	it("tracks an Enter submission until it reaches the session", async () => {
		const { ctx, editor } = createContext();
		withCompactionQueue(ctx);
		const hook = Promise.withResolvers<void>();
		Object.assign(ctx.session, {
			isStreaming: true,
			followUp: vi.fn(async () => {}),
			extensionRunner: {
				hasHandlers: (event: string) => event === "input",
				emitInput: async () => {
					await hook.promise;
					return undefined;
				},
			},
		});
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		const submitted = editor.onSubmit?.("=> sent with Enter");
		let dispatched = false;
		const waiting = controller.waitForSubmissionDispatches().then(() => {
			dispatched = true;
		});
		for (let i = 0; i < 20; i++) await Promise.resolve();
		expect(dispatched).toBe(false);

		hook.resolve();
		await Promise.all([submitted, waiting]);
		expect(dispatched).toBe(true);
	});

	it("returns a request stranded by a switch to the editor before routing new input", async () => {
		const { ctx, editor, spies } = createContext();
		withCompactionQueue(ctx);
		Object.assign(ctx.session, { isStreaming: true, isSessionTransitioning: false });
		// Queued in another conversation; an extension switch replayed nothing to release it.
		ctx.yieldCompaction = { text: "/compact", sessionId: "previous-session", leafId: null };

		editor.setText("for the new conversation");
		await new InputController(ctx).handleFollowUp();

		expect(ctx.yieldCompaction).toBeUndefined();
		expect(spies.prompt).toHaveBeenCalledWith("for the new conversation", {
			streamingBehavior: "followUp",
			images: undefined,
		});
		expect(editor.text()).toBe("/compact");
	});

	it("continue shortcuts submit a resume instead of a prompt", async () => {
		for (const shortcut of [".", "c"]) {
			const { ctx, editor } = createContext();
			const onInput = vi.fn();
			ctx.onInputCallback = onInput;
			const controller = new InputController(ctx);

			controller.setupEditorSubmitHandler();
			await editor.onSubmit?.(shortcut);

			expect(onInput, `shortcut ${shortcut}`).toHaveBeenCalledWith({
				text: shortcut,
				cancelled: false,
				started: true,
				resume: true,
			});
		}
	});

	it("sends a bare 'c' as a normal reply during a guided-goal interview", async () => {
		const { ctx, editor, spies } = createContext();
		spies.isGuidedGoalInterviewActive.mockReturnValue(true);
		// Streaming path: dispatches straight through session.prompt as a steer.
		const session: { isStreaming: boolean } = ctx.session;
		session.isStreaming = true;
		const onInput = vi.fn();
		ctx.onInputCallback = onInput;
		const controller = new InputController(ctx);

		controller.setupEditorSubmitHandler();
		await editor.onSubmit?.("c");

		expect(onInput).not.toHaveBeenCalled();
		expect(spies.prompt).toHaveBeenCalledWith("c", { streamingBehavior: "steer", images: undefined });
	});
});

describe("InputController image paste into an image-accepting prompt", () => {
	let settingsState: SettingsTestState | undefined;
	let tempDir: TempDir;

	beforeEach(async () => {
		settingsState = beginSettingsTest();
		await Settings.init({ inMemory: true });
		tempDir = await TempDir.create("@omp-prompt-image-");
	});

	afterEach(async () => {
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
		await tempDir.remove();
	});

	/** Controller context whose session commits pasted images under the test's temp dir. */
	function createPromptContext() {
		const context = createContext();
		Object.assign(context.ctx, {
			sessionManager: {
				getCwd: () => tempDir.path(),
				getArtifactsDir: () => tempDir.path(),
				getSessionId: () => "session",
				putBlob: async () => ({ hash: "h", path: "/tmp/h.png", displayPath: "/tmp/h.png" }),
			},
		});
		return context;
	}

	/** A focused prompt; with `acceptImages` it registers as the context's image paste target. */
	function createPrompt(context: ReturnType<typeof createPromptContext>, options: { acceptImages?: boolean } = {}) {
		const node = fakeNode("editor");
		const attachImage = vi.fn<(image: ImageContent) => void>();
		if (options.acceptImages)
			Object.assign(context.ctx, { promptPasteTarget: { node, attachImage, setText: vi.fn() } });
		context.setFocused(node);
		return { node, attachImage };
	}

	/** The source path of the single image the prompt received. */
	function attachedSource(attachImage: Mock<(image: ImageContent) => void>): string | undefined {
		expect(attachImage).toHaveBeenCalledTimes(1);
		const image = attachImage.mock.calls[0]?.[0];
		if (!image) throw new Error("prompt received no image");
		return imageAttachmentSource(image)?.path;
	}

	async function writePng(name: string, data = TINY_PNG): Promise<string> {
		const file = tempDir.join(name);
		await Bun.write(file, Buffer.from(data, "base64"));
		return file;
	}

	it("attaches a smart-pasted clipboard image to the prompt", async () => {
		const context = createPromptContext();
		const { attachImage } = createPrompt(context, { acceptImages: true });
		const controller = new InputController(context.ctx, PNG_CLIPBOARD);

		expect(await controller.handleImagePaste()).toBe(true);

		expect(attachedSource(attachImage)).toMatch(/^local:\/\/pasted-image-[0-9a-f]+\.png$/);
		expect(context.editor.pendingImages).toHaveLength(0);
		expect(context.editor.text()).toBe("");
	});

	it("attaches a pasted image path to the prompt", async () => {
		const imagePath = await writePng("shot.png");
		const context = createPromptContext();
		const { attachImage } = createPrompt(context, { acceptImages: true });

		await new InputController(context.ctx).handleImagePathPaste(imagePath);

		expect(attachedSource(attachImage)).toBe(imagePath);
		expect(context.editor.pendingImages).toHaveLength(0);
	});

	it("attaches an enhanced (OSC 5522) image paste to the prompt", async () => {
		const context = createPromptContext();
		const { attachImage } = createPrompt(context, { acceptImages: true });
		const attached = nextCall(attachImage);
		new InputController(context.ctx).setupKeyHandlers();

		dispatchEnhancedImagePaste(context, Buffer.from(TINY_PNG, "base64"));
		await attached;

		expect(context.editor.pendingImages).toHaveLength(0);
	});

	it("pastes a TIFF-only enhanced (OSC 5522) listing through the native clipboard reader (#17696)", async () => {
		const context = createPromptContext();
		const { attachImage } = createPrompt(context, { acceptImages: true });
		const attached = nextCall(attachImage);
		const readImage = vi.fn(PNG_CLIPBOARD.readImage);
		new InputController(context.ctx, { ...PNG_CLIPBOARD, readImage }).setupKeyHandlers();

		// macOS `⌃⌘⇧4` screenshots reach the pasteboard as TIFF only.
		for (const raw of [
			packet("type=read:status=OK:pw=secret"),
			packet(`type=read:status=DATA:mime=${base64("image/tiff")}`),
			packet("type=read:status=DONE"),
		]) {
			dispatchOsc(context, raw);
		}
		await attached;

		expect(readImage).toHaveBeenCalledTimes(1);
		expect(context.ctx.showStatus).not.toHaveBeenCalledWith("Clipboard paste has no supported text or image data");
	});

	it("prefers a Finder file URL over the co-advertised icon bitmap (#8769)", async () => {
		const imagePath = await writePng("finder.png");
		const context = createPromptContext();
		const { attachImage } = createPrompt(context, { acceptImages: true });
		const readImage = vi.fn(PNG_CLIPBOARD.readImage);
		const controller = new InputController(context.ctx, {
			readImage,
			readText: async () => "",
			readMacFileUrls: async () => [imagePath],
		});

		expect(await controller.handleImagePaste()).toBe(true);

		expect(attachedSource(attachImage)).toBe(imagePath);
		expect(readImage).not.toHaveBeenCalled();
		expect(context.editor.pendingImages).toHaveLength(0);
	});

	it("attaches the image file named by smart-pasted clipboard text (#3506)", async () => {
		const imagePath = await writePng("clipboard-image.png");
		const context = createPromptContext();
		const { attachImage } = createPrompt(context, { acceptImages: true });
		const controller = new InputController(context.ctx, {
			readImage: async () => null,
			readText: async () => imagePath,
			readMacFileUrls: async () => [],
		});

		expect(await controller.handleImagePaste()).toBe(true);

		expect(attachedSource(attachImage)).toBe(imagePath);
		expect(context.editor.text()).toBe("");
	});

	it("recovers the clipboard bitmap for a vanished path and reports a missing one like the main editor (#2375)", async () => {
		const context = createPromptContext();
		const { attachImage } = createPrompt(context, { acceptImages: true });
		let clipboardImage: { data: Uint8Array; mimeType: string } | null = {
			data: Buffer.from(TINY_PNG, "base64"),
			mimeType: "image/png",
		};
		const controller = new InputController(context.ctx, {
			readImage: async () => clipboardImage,
			readText: async () => "",
		});

		// Windows 11 Win+Shift+S: the pasted TempState path is already gone; the bitmap is on the clipboard.
		await controller.handleImagePathPaste(tempDir.join("TempState", "gone.png"));
		clipboardImage = null;
		await controller.handleImagePathPaste(tempDir.join("missing.png"));

		expect(attachedSource(attachImage)).toMatch(/^local:\/\/pasted-image-[0-9a-f]+\.png$/);
		// The status shortens and truncates the path; the missing path is never pasted as text.
		expect(context.ctx.showStatus).toHaveBeenCalledWith(expect.stringMatching(/^Image not found at /));
		expect(context.spies.shellPaste).not.toHaveBeenCalled();
		expect(context.editor.pendingImages).toHaveLength(0);
	});

	it("keeps a pasted video path as text and says why in an image-accepting prompt", async () => {
		const context = createPromptContext();
		const { attachImage } = createPrompt(context, { acceptImages: true });
		const videoPath = tempDir.join("clip.mp4");

		await new InputController(context.ctx).handleImagePathPaste(videoPath);

		expect(context.ctx.showStatus).toHaveBeenCalledWith("Video paste is not supported in this prompt");
		expect(context.spies.shellPaste).toHaveBeenCalledWith(videoPath);
		expect(attachImage).not.toHaveBeenCalled();
	});

	it("refuses a clipboard image in a prompt that did not opt in", async () => {
		const context = createPromptContext();
		createPrompt(context);
		const controller = new InputController(context.ctx, PNG_CLIPBOARD);

		expect(await controller.handleImagePaste()).toBe(false);

		expect(context.ctx.showStatus).toHaveBeenCalledWith("Image paste is not supported in this prompt");
		expect(context.editor.pendingImages).toHaveLength(0);
	});

	it("refuses an image-path paste in a prompt that did not opt in", async () => {
		const imagePath = await writePng("shot.png");
		const context = createPromptContext();
		createPrompt(context);

		await new InputController(context.ctx).handleImagePathPaste(imagePath);

		expect(context.ctx.showStatus).toHaveBeenCalledWith("Image paste is not supported in this prompt");
		expect(context.editor.pendingImages).toHaveLength(0);
		expect(context.editor.text()).toBe("");
	});

	it("refuses an enhanced (OSC 5522) image paste in a prompt that did not opt in", async () => {
		const context = createPromptContext();
		createPrompt(context);
		const refused = nextCall(context.ctx.showStatus as unknown as Mock<(message: string) => void>);
		new InputController(context.ctx).setupKeyHandlers();

		dispatchEnhancedImagePaste(context, Buffer.from(TINY_PNG, "base64"));
		await refused;

		expect(context.ctx.showStatus).toHaveBeenCalledWith("Image paste is not supported in this prompt");
		expect(context.editor.pendingImages).toHaveLength(0);
		expect(context.editor.text()).toBe("");
	});

	function mountComposerOwner(
		context: ReturnType<typeof createPromptContext>,
		dialog: UiNode,
		owner: ComposerOwner | undefined,
	): void {
		Object.assign(context.ctx, { composerOwner: owner });
		context.setFocused(dialog);
	}

	it("sends an enhanced image paste to the main editor only for the dialog the composer owner owns", async () => {
		const rows: { name: string; owner?: (dialog: UiNode) => ComposerOwner; toEditor: boolean }[] = [
			{ name: "owned", owner: node => ({ node, owns: () => true }), toEditor: true },
			{ name: "no owner registered", toEditor: false },
			{ name: "owner declines", owner: node => ({ node, owns: () => false }), toEditor: false },
			{ name: "owner of another node", owner: () => ({ node: fakeNode(), owns: () => true }), toEditor: false },
		];
		for (const row of rows) {
			const context = createPromptContext();
			const dialog = fakeNode();
			mountComposerOwner(context, dialog, row.owner?.(dialog));
			new InputController(context.ctx).setupKeyHandlers();
			const showStatus = context.ctx.showStatus as unknown as Mock<(message: string) => void>;
			const settled = Promise.race([nextCall(context.spies.insertAtom), nextCall(showStatus)]);

			dispatchEnhancedImagePaste(context, Buffer.from(TINY_PNG, "base64"));
			await settled;

			expect(context.spies.insertAtom.mock.calls.length, row.name).toBe(row.toEditor ? 1 : 0);
			expect(showStatus.mock.calls.length > 0, row.name).toBe(!row.toEditor);
		}
	});

	it("reads an HTML clipboard paste only for a dialog the composer owner owns", async () => {
		const html = `<p>see</p><img src="data:image/png;base64,${TINY_PNG}">`;
		for (const owns of [true, false]) {
			const context = createPromptContext();
			const dialog = fakeNode();
			mountComposerOwner(context, dialog, { node: dialog, owns: () => owns });
			new InputController(context.ctx).setupKeyHandlers();
			const mime = owns ? "text/html" : "text/plain";

			offerTextAndHtml(context);
			expect(
				context.spies.writeRaw.mock.calls.some(([data]) => data.includes(`type=read;${base64(mime)}`)),
				`requests ${mime}`,
			).toBe(true);

			if (owns) {
				const attached = nextCall(context.spies.insertAtom);
				deliverEnhancedPaste(context, mime, html);
				await attached;
				expect(context.spies.insertAtom).toHaveBeenCalledTimes(1);
			} else {
				deliverEnhancedPaste(context, mime, "see");
				expect(context.spies.shellPaste).toHaveBeenCalledWith("see");
			}
		}
	});

	it("attaches a clipboard image to the main editor when the composer owns the focused dialog", async () => {
		const context = createPromptContext();
		const dialog = fakeNode();
		mountComposerOwner(context, dialog, { node: dialog, owns: () => true });
		const controller = new InputController(context.ctx, PNG_CLIPBOARD);

		expect(await controller.handleImagePaste()).toBe(true);

		expect(context.editor.pendingImages).toHaveLength(1);
		expect(context.spies.shellPaste).not.toHaveBeenCalled();
	});

	it("refuses a clipboard image in a focused dialog the composer does not own", async () => {
		const imagePath = await writePng("finder.png");
		const context = createPromptContext();
		context.setFocused(fakeNode());
		// A Finder file URL must not attach either.
		const controller = new InputController(context.ctx, {
			...PNG_CLIPBOARD,
			readMacFileUrls: async () => [`file://${imagePath}`],
		});

		expect(await controller.handleImagePaste()).toBe(false);

		expect(context.ctx.showStatus).toHaveBeenCalledWith("Image paste is not supported in this prompt");
		expect(context.spies.shellPaste).not.toHaveBeenCalled();
		expect(context.editor.pendingImages).toHaveLength(0);
	});

	it("delivers clipboard text to a focused dialog as a bracketed paste", async () => {
		const context = createPromptContext();
		context.setFocused(fakeNode());
		const controller = new InputController(context.ctx, {
			readImage: async () => null,
			readText: async () => "sk-test-key",
			readMacFileUrls: async () => [],
		});

		expect(await controller.handleImagePaste()).toBe(true);

		expect(context.spies.shellPaste).toHaveBeenCalledWith("sk-test-key");
		expect(context.editor.text()).toBe("");
	});
});

describe("InputController paste into an ask form", () => {
	const TEXT_FORM = `<form><label>Answer <input name="answer"></label></form>`;
	let settingsState: SettingsTestState | undefined;

	beforeEach(async () => {
		settingsState = beginSettingsTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
	});

	/** A focused one-field form wired like the extension UI controller's, its pastes routed through the shell. */
	function mountForm(
		clipboard: { image?: { data: Uint8Array; mimeType: string } | null; text?: string },
		onSubmit: (data: HtmlFormData) => void = () => {},
	) {
		const context = createContext();
		const controller = new InputController(context.ctx, {
			readImage: async () => clipboard.image ?? null,
			readText: async () => clipboard.text ?? "",
			readMacFileUrls: async () => [],
		});
		const model = new HtmlFormModel(parseHtmlForm(TEXT_FORM), {
			onSubmit,
			onCancel: () => {},
			onPasteClipboard: () => controller.handleImagePaste(),
		});
		const node = {
			kind: "col",
			handlers: {
				onKey: (key: KeyEvent) => model.key(key),
				onPaste: (paste: { text: string }) => {
					model.paste(paste.text);
					return true;
				},
			},
			children: () => [],
		} as unknown as UiNode;
		context.setFocused(node);
		context.spies.shellPaste.mockImplementation(text => node.handlers.onPaste!({ text }));
		// Held input replays through the shell, as the real one does.
		Object.assign(context.ctx.shell, { input: (event: InputEvent) => context.input.dispatch(context.ctx, event) });
		controller.setupKeyHandlers();
		return { context, model };
	}

	it("pastes clipboard text with Ctrl+V into the focused field", async () => {
		const { context, model } = mountForm({ text: "from clipboard" });
		const pasted = nextCall(context.spies.shellPaste);

		expect(context.press("ctrl+v")).toBe("focused");
		await pasted;

		expect(model.data()).toEqual({ answer: "from clipboard" });
		expect(context.editor.text()).toBe("");
	});

	it("holds Ctrl+V followed by Enter until the clipboard text arrives", async () => {
		const submitted = Promise.withResolvers<HtmlFormData>();
		const { context } = mountForm({ text: "from clipboard" }, data => submitted.resolve(data));

		context.press("ctrl+v");
		context.press("enter");

		expect(await submitted.promise).toEqual({ answer: "from clipboard" });
		expect(context.editor.text()).toBe("");
	});

	it("refuses a Ctrl+V image while no note is open", async () => {
		const { context, model } = mountForm({ image: { data: Buffer.from(TINY_PNG, "base64"), mimeType: "image/png" } });
		const showStatus = context.ctx.showStatus as unknown as Mock<(message: string) => void>;
		const refused = nextCall(showStatus);

		context.press("ctrl+v");
		await refused;

		expect(showStatus).toHaveBeenCalledWith("Image paste is not supported in this prompt");
		expect(context.editor.pendingImages).toHaveLength(0);
		expect(model.data()).toEqual({ answer: "" });
	});
});

describe("InputController global editor actions", () => {
	it("routes shortcuts while a dialog that does not bind them holds focus", () => {
		const context = createContext();
		const controller = new InputController(context.ctx);
		const openExternalEditor = vi.spyOn(controller, "openExternalEditor").mockResolvedValue();
		const toggleThinking = vi.spyOn(controller, "toggleThinkingBlockVisibility").mockImplementation(() => {});
		controller.setupKeyHandlers();
		context.setFocused(fakeNode("list", () => false));

		expect(context.press("ctrl+t")).toBe("global");
		expect(toggleThinking).toHaveBeenCalledTimes(1);
		expect(context.press("ctrl+r")).toBe("global");
		expect(context.ctx.showHistorySearch).toHaveBeenCalledTimes(1);
		expect(context.press("ctrl+g")).toBe("global");
		expect(openExternalEditor).toHaveBeenCalledTimes(1);
		expect(context.press("ctrl+shift+o")).toBe("global");
		expect(context.ctx.hideToolActivity).toBe(true);
		expect(context.press("alt+l")).toBe("global");
		expect(context.spies.resetDisplayAfterAppearanceRefresh).toHaveBeenCalledTimes(1);
	});

	it("still routes transcript actions when the composer holds focus", () => {
		const context = createContext();
		const controller = new InputController(context.ctx);
		const toggle = vi.spyOn(controller, "toggleThinkingBlockVisibility").mockImplementation(() => {});
		controller.setupKeyHandlers();

		expect(context.press("ctrl+t")).toBe("global");
		expect(toggle).toHaveBeenCalledTimes(1);
	});

	it("keeps history search and link hints available under passive overlays but defers to active overlays", () => {
		const context = createContext();
		const overlays = new Overlays({
			focused: context.ctx.shell.focused,
			focus: context.setFocused,
			fallback: () => context.editor.field,
		});
		let hintsActive = false;
		const startLinkHints = vi.fn(() => {
			hintsActive = true;
			return true;
		});
		const cancelLinkHints = vi.fn(() => {
			hintsActive = false;
		});
		const ctx = {
			...context.ctx,
			shell: { ...context.ctx.shell, overlays },
			get linkHintsActive() {
				return hintsActive;
			},
			startLinkHints,
			cancelLinkHints,
		} as InteractiveModeContext;
		context.setKeybinding("app.links.hint", ["alt+h"]);
		new InputController(ctx).setupKeyHandlers();
		overlays.show(() => new UiNode("overlay", { modal: false }), { focus: false });
		try {
			expect(overlays.open()).toBe(true);
			expect(ctx.shell.focused()).toBe(context.editor.field);
			expect(context.input.press(ctx, "ctrl+r")).toBe("global");
			expect(ctx.showHistorySearch).toHaveBeenCalledTimes(1);
			expect(context.input.press(ctx, "alt+h")).toBe("intercepted");
			expect(startLinkHints).toHaveBeenCalledTimes(1);

			const active = overlays.show(() => new UiNode("overlay", { modal: true }));
			expect(context.input.press(ctx, "ctrl+r")).toBe("unhandled");
			expect(cancelLinkHints).toHaveBeenCalledTimes(1);
			expect(ctx.showHistorySearch).toHaveBeenCalledTimes(1);
			expect(context.input.press(ctx, "alt+h")).toBe("unhandled");
			expect(startLinkHints).toHaveBeenCalledTimes(1);
			active.close();

			expect(context.input.press(ctx, "alt+h")).toBe("intercepted");
			expect(startLinkHints).toHaveBeenCalledTimes(2);
		} finally {
			overlays.closeAll();
		}
	});

	it("defers while an overlay owns the active surface", () => {
		const context = createContext();
		const controller = new InputController(context.ctx);
		const toggle = vi.spyOn(controller, "toggleThinkingBlockVisibility").mockImplementation(() => {});
		controller.setupKeyHandlers();
		context.setOverlayVisible(true);
		context.setFocused(fakeNode());

		expect(context.press("ctrl+t")).toBe("unhandled");
		expect(toggle).not.toHaveBeenCalled();
		expect(context.press("alt+l")).toBe("unhandled");
		expect(context.spies.resetDisplayAfterAppearanceRefresh).not.toHaveBeenCalled();
	});

	it("leaves keys a focused view binds itself (the tree selector's Alt+L, Ctrl+Shift+O) to it", () => {
		const context = createContext();
		new InputController(context.ctx).setupKeyHandlers();
		const tree = vi.fn((key: KeyEvent) => key.id === "alt+l" || key.id === "ctrl+shift+o");
		context.setFocused(fakeNode("list", tree));

		expect(context.press("alt+l")).toBe("focused");
		expect(context.press("ctrl+shift+o")).toBe("focused");
		expect(context.spies.resetDisplayAfterAppearanceRefresh).not.toHaveBeenCalled();
		expect(context.ctx.hideToolActivity).toBe(false);

		// A remapped display reset reaches the app again.
		context.setKeybinding("app.display.reset", ["ctrl+l"]);
		expect(context.press("ctrl+l")).toBe("global");
		expect(context.spies.resetDisplayAfterAppearanceRefresh).toHaveBeenCalledTimes(1);
	});

	it("defers external editing and the local picker while an extension dialog holds focus", () => {
		const context = createContext();
		const controller = new InputController(context.ctx);
		const openExternalEditor = vi.spyOn(controller, "openExternalEditor").mockResolvedValue();
		const openLocalFilePicker = vi.spyOn(controller, "openLocalFilePicker").mockResolvedValue();
		controller.setupKeyHandlers();

		expect(context.press("alt+g")).toBe("global");
		expect(openLocalFilePicker).toHaveBeenCalledTimes(1);

		// A second Alt+G while the picker is up must not stack another picker.
		const field = fakeNode("input");
		const dialog = { kind: "col", handlers: {}, children: () => [field] } as unknown as UiNode;
		const handle: OverlayHandle = { node: dialog, closed: false, close: vi.fn() };
		Object.assign(context.ctx, { hookSelector: handle });
		context.setFocused(field);
		expect(context.press("alt+g")).toBe("unhandled");
		expect(context.press("ctrl+g")).toBe("unhandled");
		expect(openLocalFilePicker).toHaveBeenCalledTimes(1);
		expect(openExternalEditor).not.toHaveBeenCalled();
	});

	it("refuses Alt+G when collabGuest is active", async () => {
		const context = createContext();
		Object.assign(context.ctx, { collabGuest: {} });
		new InputController(context.ctx).setupKeyHandlers();

		expect(context.press("alt+g")).toBe("global");
		await Promise.resolve();
		expect(context.ctx.showStatus).toHaveBeenCalledWith("/local is host-only during a collab session");
	});

	it("opens the debug selector on Ctrl+Shift+D from any focus", () => {
		const context = createContext();
		new InputController(context.ctx).setupKeyHandlers();
		context.setFocused(fakeNode());

		expect(context.press("ctrl+shift+d")).toBe("global");
		expect(context.ctx.showDebugSelector).toHaveBeenCalledTimes(1);
	});
});

describe("InputController global tool-output expand (ctrl+o)", () => {
	function setup() {
		const context = createContext();
		new InputController(context.ctx).setupKeyHandlers();
		return context;
	}

	it("toggles tool-output expansion when a non-editor prompt holds focus (#7837)", () => {
		const { ctx, press, setFocused } = setup();
		// An approval / select prompt owns keyboard focus, not the editor.
		setFocused(fakeNode());
		expect(ctx.toolOutputExpanded).toBe(false);

		expect(press("ctrl+o")).toBe("global");
		expect(ctx.toolOutputExpanded).toBe(true);
	});

	it("lets a focused prompt that reveals details take ctrl+o before the transcript", () => {
		const { ctx, press, setFocused } = setup();
		const reveal = vi.fn((key: KeyEvent) => key.id === "ctrl+o");
		setFocused(fakeNode("col", reveal));

		expect(press("ctrl+o")).toBe("focused");
		expect(ctx.toolOutputExpanded).toBe(false);
	});

	it("still toggles when the editor holds focus", () => {
		const { ctx, press } = setup();
		expect(press("ctrl+o")).toBe("global");
		expect(ctx.toolOutputExpanded).toBe(true);
	});

	it("defers while a fullscreen/anchored overlay owns the surface", () => {
		const { ctx, press, setOverlayVisible, setFocused } = setup();
		setOverlayVisible(true);
		setFocused(fakeNode());

		expect(press("ctrl+o")).toBe("unhandled");
		expect(ctx.toolOutputExpanded).toBe(false);
	});

	it("honors a remapped expand key while a view that binds ctrl+o has focus", () => {
		const context = createContext();
		context.setKeybinding("app.tools.expand", ["ctrl+x"]);
		new InputController(context.ctx).setupKeyHandlers();
		context.setFocused(fakeNode("list", key => key.id === "ctrl+o"));

		expect(context.press("ctrl+x")).toBe("global");
		expect(context.ctx.toolOutputExpanded).toBe(true);
	});
});
