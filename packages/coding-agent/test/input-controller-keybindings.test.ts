import { afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { AskDialogComponent } from "@oh-my-pi/pi-tui/overlays/ask-dialog";
import { HookEditorComponent } from "@oh-my-pi/pi-tui/overlays/hook-editor";
import { TreeSelectorComponent } from "@oh-my-pi/pi-tui/overlays/tree-selector";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { SpaceHoldGesture } from "@oh-my-pi/pi-tui/space-hold";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { SessionTreeNode } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { RestoredQueuedMessage } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { type KeyId, matchesKey } from "@oh-my-pi/pi-tui";
import { TempDir } from "@oh-my-pi/pi-utils";
import manualContinuePrompt from "../src/prompts/system/manual-continue.md" with { type: "text" };
import { imageAttachmentSource } from "@oh-my-pi/pi-tui/prompt/image-source";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

type FakeEditor = {
	onEscape?: () => void;
	onClear?: () => void;
	onExit?: () => void;
	onDisplayReset?: () => void;
	onSuspend?: () => void;
	onCycleThinkingLevel?: () => void;
	onCycleModelForward?: () => void;
	onCycleModelBackward?: () => void;
	onSelectModelTemporary?: () => void;
	onSelectModel?: () => void;
	onPasteImage?: () => Promise<boolean>;
	onCopyPrompt?: () => void;
	onRetry?: () => void;
	onDequeue?: () => void;
	onChange?: (text: string) => void;
	onSubmit?: (text: string) => Promise<void>;
	setText(text: string): void;
	getText(): string;
	textRevision: number;
	getExpandedText(): string;
	setCollapsedText(text: string): void;
	composerChips(): unknown[];
	captureComposerDraft(): { editor: { text: string }; images: ImageContent[]; links: (string | undefined)[] };
	restoreComposerDraft(snapshot: {
		editor: { text: string };
		images: ImageContent[];
		links: (string | undefined)[];
	}): void;
	addToHistory(text: string): void;
	setActionKeys(action: string, keys: string[]): void;
	setCustomKeyHandler(key: string, handler: () => void): void;
	clearCustomKeyHandlers(): void;
	spaceHold: SpaceHoldGesture;
	pasteText(text: string): void;
	imageLinks?: (string | undefined)[];
	pendingImages: ImageContent[];
	pendingImageLinks: (string | undefined)[];
	clearDraft(historyText?: string): void;
};

type InputListenerResult = { consume: boolean } | undefined;
type InputListener = (data: string) => InputListenerResult;

function dispatchInput(listeners: InputListener[], data: string): InputListenerResult {
	for (const listener of listeners) {
		const result = listener(data);
		if (result) return result;
	}
	return undefined;
}

function registeredInputListeners(addInputListener: Mock<(listener: InputListener) => void>): InputListener[] {
	return addInputListener.mock.calls.map(call => call[0]);
}

async function createContext() {
	let editorText = "";
	const keyMap: Record<string, KeyId[]> = {
		"app.display.reset": ["alt+l"],
		"app.stt.pushToTalk": ["space"],
		"app.thinking.toggle": ["ctrl+t"],
		"app.history.search": ["ctrl+r"],
		"app.editor.external": ["ctrl+g"],
		"app.editor.stash": ["ctrl+s"],
		"app.agents.hub": ["alt+a"],
		"app.model.selectTemporary": ["ctrl+y"],
		"app.model.select": ["alt+m"],
		"app.retry": ["alt+r"],
		"app.clipboard.pasteImage": ["ctrl+v"],
		"app.tools.toggleVisibility": ["ctrl+shift+o"],
		"app.tools.expand": ["ctrl+o"],
	};
	const customHandlers = new Map<string, () => void>();
	const setActionKeys = vi.fn();
	const setCustomKeyHandler = vi.fn((key: string, handler: () => void) => {
		customHandlers.set(key, handler);
	});
	const clearCustomKeyHandlers = vi.fn(() => {
		customHandlers.clear();
	});
	const resetDisplay = vi.fn();
	const clearInlineImages = vi.fn();
	const showModelSelector = vi.fn();
	const requestRender = vi.fn();
	const showError = vi.fn();
	const notifyComposerStash = vi.fn();
	const cancelComposerStashNotice = vi.fn();
	let focused: unknown;
	let focusedAgentId: string | undefined;
	let overlayVisible = false;
	const addInputListener = vi.fn((listener: InputListener) => {
		void listener;
	});
	const addStartListener = vi.fn();
	const terminalWrite = vi.fn();
	const refreshAppearance = vi.fn();
	const resetDisplayAfterAppearanceRefresh = vi.fn(() => {
		refreshAppearance();
		resetDisplay();
	});
	const prompt = vi.fn(async (_text: string, options?: { onAccepted?: () => void }) => {
		options?.onAccepted?.();
		return true;
	});
	const retry = vi.fn(async () => true);
	const abort = vi.fn(async () => {});
	const session = {
		messages: [],
		isStreaming: false,
		isCompacting: false,
		isGeneratingHandoff: false,
		isBashRunning: false,
		isEvalRunning: false,
		extensionRunner: undefined,
		customCommands: [],
		promptTemplates: [],
		prompt,
		queuedMessageCount: 0,
		maybeStartTitleGeneration: vi.fn(),
		subscribe: vi.fn(() => () => {}),
		abort,
		retry,
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
	const editor: FakeEditor = {
		setText(text: string) {
			editorText = text;
			this.textRevision++;
		},
		getText() {
			return editorText;
		},
		getExpandedText() {
			return editorText;
		},
		setCollapsedText(text: string) {
			editorText = text;
			this.textRevision++;
		},
		composerChips() {
			return [];
		},
		captureComposerDraft() {
			return { editor: { text: editorText }, images: [...this.pendingImages], links: [...this.pendingImageLinks] };
		},
		restoreComposerDraft(snapshot) {
			this.pendingImages = [...snapshot.images];
			this.pendingImageLinks = [...snapshot.links];
			this.imageLinks = this.pendingImageLinks;
			this.setText(snapshot.editor.text);
		},
		addToHistory: vi.fn(),
		pasteText(text: string) {
			editorText += text;
			this.textRevision++;
		},
		setActionKeys,
		setCustomKeyHandler,
		clearCustomKeyHandlers,
		spaceHold: new SpaceHoldGesture(() => {}),
		textRevision: 0,
		pendingImages: [],
		pendingImageLinks: [],
		clearDraft(historyText?: string) {
			if (historyText !== undefined) this.addToHistory(historyText);
			this.setText("");
			this.imageLinks = undefined;
			this.pendingImages = [];
			this.pendingImageLinks = [];
		},
	};
	focused = editor;
	const ctx = {
		editor: editor as unknown as InteractiveModeContext["editor"],
		get focusedAgentId() {
			return focusedAgentId;
		},
		resetDisplayAfterAppearanceRefresh,
		ui: {
			requestRender,
			resetDisplay,
			clearInlineImages,
			addInputListener,
			addStartListener,
			getFocused: vi.fn(() => focused),
			hasOverlay: vi.fn(() => overlayVisible),
			terminal: { write: terminalWrite, refreshAppearance },
		} as unknown as InteractiveModeContext["ui"],
		loadingAnimation: undefined,
		autoCompactionLoader: undefined,
		retryLoader: undefined,
		autoCompactionEscapeHandler: undefined,
		retryEscapeHandler: undefined,
		session: session as unknown as InteractiveModeContext["session"],
		skillCommands: new Map(),
		fileSlashCommands: new Map(),
		viewSession: session as unknown as InteractiveModeContext["viewSession"],
		keybindings: {
			getKeys(action: string) {
				return keyMap[action] ? [...keyMap[action]] : [];
			},
			matches(data: string, action: string) {
				return keyMap[action]?.some(key => matchesKey(data, key)) ?? false;
			},
		} as InteractiveModeContext["keybindings"],
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
		isBashMode: false,
		isPythonMode: false,
		hideToolActivity: false,
		toolOutputExpanded: false,
		settings: Settings.isolated(),
		chatContainer: { children: [], setToolActivityVisible: vi.fn() },
		handleHotkeysCommand: vi.fn(),
		handlePlanModeCommand: vi.fn(),
		flushPendingBashComponents: vi.fn(),
		handleClearCommand: vi.fn(),
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
		notifyComposerStash,
		cancelComposerStashNotice,
	} as unknown as InteractiveModeContext;

	return {
		InputController,
		ctx,
		editor,
		customHandlers,
		setFocused(target: unknown) {
			focused = target;
		},
		setFocusedAgent(id: string | undefined) {
			focusedAgentId = id;
		},
		setOverlayVisible(visible: boolean) {
			overlayVisible = visible;
		},
		setKeybinding(action: string, keys: KeyId[]) {
			keyMap[action] = keys;
		},
		spies: {
			setActionKeys,
			showModelSelector,
			prompt,
			updatePendingMessagesDisplay,
			requestRender,
			retry,
			abort,
			resetDisplay,
			clearInlineImages,
			refreshAppearance,
			resetDisplayAfterAppearanceRefresh,
			handleBtwBranchKey,
			addStartListener,
			addInputListener,
			canBranchBtw,
			hasActiveBtw,
			handlesBtwBranchKey,
			handleBtwCopyKey,
			canCopyBtw,
			canFollowUpBtw,
			handleBtwFollowUpKey,
			showError,
			isGuidedGoalInterviewActive,
			notifyComposerStash,
			cancelComposerStashNotice,
		},
	};
}

// 1x1 PNG.
const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD3sAAAAASUVORK5CYII=";

/** Replay a kitty OSC 5522 enhanced paste that offers text and PNG and delivers `png` bytes. */
function dispatchEnhancedImagePaste(listeners: InputListener[], png: Uint8Array): void {
	const packet = (metadata: string, payload?: string) =>
		`\x1b]5522;${metadata}${payload === undefined ? "" : `;${payload}`}\x1b\\`;
	const imageMime = Buffer.from("image/png").toString("base64");
	const textMime = Buffer.from("text/plain").toString("base64");
	for (const input of [
		packet("type=read:status=OK:pw=secret"),
		packet(`type=read:status=DATA:mime=${textMime}`),
		packet(`type=read:status=DATA:mime=${imageMime}`),
		packet("type=read:status=DONE"),
		packet("type=read:status=OK"),
		packet(`type=read:status=DATA:mime=${imageMime}`, Buffer.from(png).toString("base64")),
		packet("type=read:status=DONE"),
	]) {
		dispatchInput(listeners, input);
	}
}

describe("InputController keybinding setup", () => {
	it("registers model selector and display reset actions separately", async () => {
		const { InputController, ctx, editor, spies } = await createContext();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();

		expect(spies.setActionKeys).toHaveBeenCalledWith("app.display.reset", ["alt+l"]);
		expect(spies.setActionKeys).toHaveBeenCalledWith("app.model.selectTemporary", ["ctrl+y"]);
		expect(spies.setActionKeys).toHaveBeenCalledWith("app.model.select", ["alt+m"]);
		expect(editor.onDisplayReset).toBeDefined();
		expect(editor.onSelectModelTemporary).toBeDefined();
		expect(editor.onSelectModel).toBeDefined();
		expect(editor.onSelectModelTemporary).not.toBe(editor.onSelectModel);

		editor.onDisplayReset?.();
		editor.onSelectModelTemporary?.();
		editor.onSelectModel?.();

		expect(spies.showModelSelector).toHaveBeenNthCalledWith(1, { temporaryOnly: true });
		expect(spies.showModelSelector).toHaveBeenNthCalledWith(2);
		expect(spies.resetDisplayAfterAppearanceRefresh).toHaveBeenCalledTimes(1);
	});

	it("enters Python mode only once whitespace follows a typed sigil", async () => {
		const { InputController, ctx, editor } = await createContext();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();

		for (const draft of ["$", "$H", "$$", "$$a"]) {
			editor.onChange?.(draft);
			expect(ctx.isPythonMode).toBe(false);
		}
		expect(ctx.updateEditorBorderColor).not.toHaveBeenCalled();

		editor.onChange?.("$$ ");
		expect(ctx.isPythonMode).toBe(true);
		editor.onChange?.("$$ a");
		expect(ctx.isPythonMode).toBe(true);
		expect(ctx.updateEditorBorderColor).toHaveBeenCalledTimes(1);
	});

	it("does not mark pasted shell prompts as Python mode while editing", async () => {
		const { InputController, ctx, editor } = await createContext();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();

		editor.onChange?.("$ cd ~/project && sudo ./build-and-push.sh o5.7 2>&1 | tail -4");

		expect(ctx.isPythonMode).toBe(false);
		expect(ctx.updateEditorBorderColor).not.toHaveBeenCalled();

		editor.onChange?.("$ print(1)");

		expect(ctx.isPythonMode).toBe(true);
		expect(ctx.updateEditorBorderColor).toHaveBeenCalledTimes(1);
	});

	it("registers retry as an editor action and retries the failed turn", async () => {
		const { InputController, ctx, editor, spies } = await createContext();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();

		expect(spies.setActionKeys).toHaveBeenCalledWith("app.retry", ["alt+r"]);
		expect(editor.onRetry).toBeDefined();

		editor.setText("draft that should clear after retry");
		editor.onRetry?.();
		await Promise.resolve();

		expect(spies.retry).toHaveBeenCalledTimes(1);
		expect(editor.getText()).toBe("");
	});

	it("retries the focused view session instead of the main session", async () => {
		const { InputController, ctx, editor, spies, setFocusedAgent } = await createContext();
		const focusedRetry = vi.fn(async () => true);
		setFocusedAgent("worker");
		(ctx as unknown as { viewSession: { retry: typeof focusedRetry } }).viewSession = { retry: focusedRetry };
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onRetry?.();
		await Promise.resolve();

		expect(focusedRetry).toHaveBeenCalledTimes(1);
		expect(spies.retry).not.toHaveBeenCalled();
	});

	it("keeps retry host-only for collab guests", async () => {
		const { InputController, ctx, editor, spies } = await createContext();
		const showStatus = ctx.showStatus as unknown as Mock<(message: string) => void>;
		(ctx as unknown as { collabGuest: { readOnly: boolean } }).collabGuest = { readOnly: true };
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.setText("guest draft");
		editor.onRetry?.();
		await Promise.resolve();

		expect(spies.retry).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith("/retry is host-only during a collab session");
		expect(editor.getText()).toBe("guest draft");
	});

	it("keeps the draft when there is nothing to retry", async () => {
		const { InputController, ctx, editor, spies } = await createContext();
		spies.retry.mockResolvedValueOnce(false);
		const showStatus = ctx.showStatus as unknown as Mock<(message: string) => void>;
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.setText("draft that should survive");
		editor.onRetry?.();
		await Promise.resolve();

		expect(showStatus).toHaveBeenCalledWith("Nothing to retry");
		expect(editor.getText()).toBe("draft that should survive");
	});

	it("clears retry draft attachments only after retry starts", async () => {
		const { InputController, ctx, editor } = await createContext();
		const image: ImageContent = { type: "image", mimeType: "image/png", data: "abc" };
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		ctx.editor.pendingImages = [image];
		ctx.editor.pendingImageLinks = ["local://draft.png"];
		editor.imageLinks = ctx.editor.pendingImageLinks;
		editor.setText("draft with image");
		editor.onRetry?.();
		await Promise.resolve();

		expect(ctx.editor.pendingImages).toEqual([]);
		expect(ctx.editor.pendingImageLinks).toEqual([]);
		expect(editor.imageLinks).toBeUndefined();
		expect(editor.getText()).toBe("");
	});

	it("routes b to branch a branchable /btw panel", async () => {
		const { InputController, ctx, spies } = await createContext();
		spies.handlesBtwBranchKey.mockReturnValue(true);
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		const listener = spies.addInputListener.mock.calls[1]?.[0];
		expect(listener).toBeDefined();
		const result = listener?.("b");

		expect(result).toEqual({ consume: true });
		expect(spies.handleBtwBranchKey).toHaveBeenCalledTimes(1);
	});

	it("lets b fall through while the editor has draft text", async () => {
		const { InputController, ctx, editor, spies } = await createContext();
		spies.handlesBtwBranchKey.mockReturnValue(true);
		editor.setText("build a branch");
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		const listener = spies.addInputListener.mock.calls[1]?.[0];
		expect(listener).toBeDefined();
		const result = listener?.("b");

		expect(result).toBeUndefined();
		expect(spies.handleBtwBranchKey).not.toHaveBeenCalled();
	});

	it("lets b reach the composer before an active /btw answer is branchable", async () => {
		const { InputController, ctx, spies } = await createContext();
		spies.hasActiveBtw.mockReturnValue(true);
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		const listener = spies.addInputListener.mock.calls[1]?.[0];
		expect(listener).toBeDefined();
		const result = listener?.("b");

		expect(result).toBeUndefined();
		expect(spies.handleBtwBranchKey).not.toHaveBeenCalled();
	});

	it("lets b fall through while another input is focused", async () => {
		const { InputController, ctx, setFocused, spies } = await createContext();
		spies.handlesBtwBranchKey.mockReturnValue(true);
		setFocused({ pasteText: vi.fn() });
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		const result = dispatchInput(registeredInputListeners(spies.addInputListener), "b");

		expect(result).toBeUndefined();
		expect(spies.handleBtwBranchKey).not.toHaveBeenCalled();
	});

	it("routes the smart-paste shortcut to a focused login input", async () => {
		const { promise: pasted, resolve: resolvePaste } = Promise.withResolvers<string>();
		const focusedPasteText = vi.fn((text: string) => {
			resolvePaste(text);
		});
		const { InputController, ctx, setFocused, spies } = await createContext();
		setFocused({ pasteText: focusedPasteText });
		const controller = new InputController(ctx, {
			readImage: async () => null,
			readText: async () => "sk-test-key",
		});

		controller.setupKeyHandlers();
		const result = dispatchInput(registeredInputListeners(spies.addInputListener), "\x16");

		expect(result).toEqual({ consume: true });
		expect(await pasted).toBe("sk-test-key");
		expect(focusedPasteText).toHaveBeenCalledWith("sk-test-key");
	});

	it("rejects image smart-paste while a login input is focused instead of mutating the hidden editor", async () => {
		const focusedPasteText = vi.fn();
		const { InputController, ctx, editor, setFocused, spies } = await createContext();
		setFocused({ pasteText: focusedPasteText });
		const { promise: rejected, resolve: resolveRejected } = Promise.withResolvers<string>();
		(ctx.showStatus as unknown as Mock<(message: string) => void>).mockImplementation(message => {
			resolveRejected(message);
		});
		const controller = new InputController(ctx, {
			readImage: async () => ({ data: new Uint8Array([0x89, 0x50]), mimeType: "image/png" }),
			readText: async () => "sk-test-key",
		});

		controller.setupKeyHandlers();
		const result = dispatchInput(registeredInputListeners(spies.addInputListener), "\x16");

		expect(result).toEqual({ consume: true });
		expect(await rejected).toBe("Image paste is not supported in this prompt");
		expect(focusedPasteText).not.toHaveBeenCalled();
		expect(editor.pendingImages).toHaveLength(0);
		expect(editor.getText()).toBe("");
	});

	it("opens inline follow-up only with an empty focused editor and a ready BTW answer", async () => {
		const { InputController, ctx, editor, setFocused, spies } = await createContext();
		const controller = new InputController(ctx);
		controller.setupKeyHandlers();
		const listeners = registeredInputListeners(spies.addInputListener);

		expect(dispatchInput(listeners, "f")).toBeUndefined();
		spies.canFollowUpBtw.mockReturnValue(true);
		editor.setText("finish this draft");
		expect(dispatchInput(listeners, "f")).toBeUndefined();
		editor.setText("");
		setFocused({ pasteText: vi.fn() });
		expect(dispatchInput(listeners, "f")).toBeUndefined();
		expect(spies.handleBtwFollowUpKey).not.toHaveBeenCalled();

		setFocused(ctx.editor);
		expect(dispatchInput(listeners, "f")).toEqual({ consume: true });
		expect(spies.handleBtwFollowUpKey).toHaveBeenCalledTimes(1);
	});

	it("leaves x as ordinary input while a BTW panel is active", async () => {
		const { InputController, ctx, spies } = await createContext();
		spies.hasActiveBtw.mockReturnValue(true);
		const controller = new InputController(ctx);
		controller.setupKeyHandlers();
		expect(dispatchInput(registeredInputListeners(spies.addInputListener), "x")).toBeUndefined();
	});

	it("routes c to copy a copyable /btw panel when the editor is empty", async () => {
		const { InputController, ctx, spies } = await createContext();
		(ctx.canCopyBtw as unknown as { mockReturnValue(value: boolean): void }).mockReturnValue(true);
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		const result = dispatchInput(registeredInputListeners(spies.addInputListener), "c");

		expect(result).toEqual({ consume: true });
		expect(spies.handleBtwCopyKey).toHaveBeenCalledTimes(1);
	});

	it("lets c fall through while the editor has draft text", async () => {
		const { InputController, ctx, editor, spies } = await createContext();
		(ctx.canCopyBtw as unknown as { mockReturnValue(value: boolean): void }).mockReturnValue(true);
		editor.setText("continue this draft");
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		const result = dispatchInput(registeredInputListeners(spies.addInputListener), "c");

		expect(result).toBeUndefined();
		expect(spies.handleBtwCopyKey).not.toHaveBeenCalled();
	});

	it("lets c fall through when /btw is not copyable", async () => {
		const { InputController, ctx, spies } = await createContext();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		const result = dispatchInput(registeredInputListeners(spies.addInputListener), "c");

		expect(result).toBeUndefined();
		expect(spies.handleBtwCopyKey).not.toHaveBeenCalled();
	});

	it("lets c fall through while another input is focused", async () => {
		const { InputController, ctx, setFocused, spies } = await createContext();
		(ctx.canCopyBtw as unknown as { mockReturnValue(value: boolean): void }).mockReturnValue(true);
		setFocused({ pasteText: vi.fn() });
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		const result = dispatchInput(registeredInputListeners(spies.addInputListener), "c");

		expect(result).toBeUndefined();
		expect(spies.handleBtwCopyKey).not.toHaveBeenCalled();
	});

	it("marks streaming follow-up submissions as local", async () => {
		const { InputController, ctx, editor, spies } = await createContext();
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
		const { InputController, ctx, editor, spies } = await createContext();
		// Default fake session is idle.
		editor.setText("plain idle submit");
		const controller = new InputController(ctx);

		await controller.handleFollowUp();

		expect(ctx.locallySubmittedUserSignatures.has("plain idle submit\u00000")).toBe(true);
		// Idle submit calls prompt() with no streamingBehavior (images forwarded, undefined here).
		expect(spies.prompt).toHaveBeenCalledWith("plain idle submit", { images: undefined });
	});

	it("surfaces and recovers from an idle follow-up dispatch failure", async () => {
		const { InputController, ctx, editor, spies } = await createContext();
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
		expect(editor.getText()).toBe("doomed submit");
		// Contract: a failed delivery must not leave a stale signature behind,
		// otherwise the next attempt with the same text would silently suppress
		// the editor-clear protection that was meant for the failed call.
		expect(ctx.locallySubmittedUserSignatures.has("doomed submit\u00000")).toBe(false);
	});

	it("surfaces and recovers from a streaming follow-up dispatch failure", async () => {
		const { InputController, ctx, editor, spies } = await createContext();
		const session = ctx.session as unknown as { isStreaming: boolean };
		session.isStreaming = true;
		spies.prompt.mockImplementationOnce(async () => {
			throw new Error("queue full");
		});
		editor.setText("queued during stream");
		const controller = new InputController(ctx);

		await controller.handleFollowUp();

		expect(spies.showError).toHaveBeenCalledWith("queue full");
		expect(editor.getText()).toBe("queued during stream");
		expect(ctx.locallySubmittedUserSignatures.has("queued during stream\u00000")).toBe(false);
	});

	it("continue shortcuts submit a hidden synthetic developer directive", async () => {
		for (const shortcut of [".", "c"]) {
			const { InputController, ctx, editor } = await createContext();
			const onInput = vi.fn();
			ctx.onInputCallback = onInput;
			const controller = new InputController(ctx);

			controller.setupEditorSubmitHandler();
			await editor.onSubmit?.(shortcut);

			expect(onInput, `shortcut ${shortcut}`).toHaveBeenCalledWith({
				text: manualContinuePrompt,
				cancelled: false,
				started: true,
				synthetic: true,
				userInitiated: true,
			});
		}
	});

	it("sends a bare 'c' as a normal reply during a guided-goal interview", async () => {
		const { InputController, ctx, editor, spies } = await createContext();
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

	beforeAll(async () => {
		await initTheme(false);
	});

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
	async function createPromptContext() {
		const context = await createContext();
		Object.assign(context.ctx, {
			sessionManager: {
				getCwd: () => tempDir.path(),
				getArtifactsDir: () => tempDir.path(),
				getSessionId: () => "session",
			},
		});
		return context;
	}

	/** A real ask-style prompt editor; `acceptImages` is the opt-in under test. */
	function createPrompt(
		context: { ctx: InteractiveModeContext; setFocused(target: unknown): void },
		options: { acceptImages?: boolean; prefill?: string } = {},
	) {
		const onSubmit = vi.fn<(text: string, images?: ImageContent[]) => void>();
		const prompt = new HookEditorComponent(context.ctx.ui, "Answer", options.prefill, onSubmit, vi.fn(), {
			promptStyle: true,
			acceptImages: options.acceptImages,
		});
		context.setFocused(prompt);
		return { prompt, onSubmit };
	}

	/** The single image the prompt submitted, with its marker text. */
	function submittedImage(onSubmit: Mock<(text: string, images?: ImageContent[]) => void>) {
		expect(onSubmit).toHaveBeenCalledTimes(1);
		const [text, images] = onSubmit.mock.calls[0] ?? [];
		const image = images?.[0];
		if (text === undefined || !image || images.length !== 1) throw new Error("prompt did not submit one image");
		return { text, source: imageAttachmentSource(image)?.path };
	}

	async function writePng(name: string, data = TINY_PNG): Promise<string> {
		const file = tempDir.join(name);
		await Bun.write(file, Buffer.from(data, "base64"));
		return file;
	}

	it("submits a smart-pasted clipboard image after Enter arrives mid-paste", async () => {
		const context = await createPromptContext();
		const { prompt, onSubmit } = createPrompt(context, { acceptImages: true, prefill: "see " });
		const controller = new InputController(context.ctx, {
			readImage: async () => ({ data: Buffer.from(TINY_PNG, "base64"), mimeType: "image/png" }),
			readText: async () => "",
			readMacFileUrls: async () => [],
		});

		const paste = controller.handleImagePaste();
		prompt.handleInput("\r");
		expect(onSubmit).not.toHaveBeenCalled();
		expect(await paste).toBe(true);

		const submitted = submittedImage(onSubmit);
		expect(submitted.text).toMatch(/^see \[Image #1, \d+x\d+\]$/);
		expect(submitted.source).toMatch(/^local:\/\/pasted-image-[0-9a-f]+\.png$/);
		expect(context.editor.pendingImages).toHaveLength(0);
		expect(context.editor.getText()).toBe("");
	});

	it("submits a bracketed image-path paste after Enter arrives mid-paste", async () => {
		const imagePath = await writePng("shot.png");
		const context = await createPromptContext();
		const controller = new InputController(context.ctx);
		const pasted: Promise<void>[] = [];
		const onSubmit = vi.fn<(text: string, images?: ImageContent[]) => void>();
		const prompt = new HookEditorComponent(context.ctx.ui, "Answer", "see ", onSubmit, vi.fn(), {
			promptStyle: true,
			acceptImages: true,
			onPasteImagePath: pastedPath => {
				const paste = controller.handleImagePathPaste(pastedPath);
				pasted.push(paste);
				return paste;
			},
		});
		context.setFocused(prompt);

		prompt.handleInput(`\x1b[200~${imagePath}\x1b[201~\r`);
		expect(onSubmit).not.toHaveBeenCalled();
		await Promise.all(pasted);

		const submitted = submittedImage(onSubmit);
		expect(submitted.text).toMatch(/^see \[Image #1, \d+x\d+\]$/);
		expect(submitted.source).toBe(imagePath);
		expect(context.editor.pendingImages).toHaveLength(0);
	});

	it("submits an enhanced (OSC 5522) image paste after Enter arrives mid-paste", async () => {
		const context = await createPromptContext();
		const submittedOnce = Promise.withResolvers<void>();
		const onSubmit = vi.fn<(text: string, images?: ImageContent[]) => void>(() => submittedOnce.resolve());
		const prompt = new HookEditorComponent(context.ctx.ui, "Answer", "see ", onSubmit, vi.fn(), {
			promptStyle: true,
			acceptImages: true,
		});
		context.setFocused(prompt);
		new InputController(context.ctx).setupKeyHandlers();
		const listeners = registeredInputListeners(context.spies.addInputListener);
		context.spies.addStartListener.mock.calls[0]?.[0]();

		dispatchEnhancedImagePaste(listeners, Buffer.from(TINY_PNG, "base64"));
		prompt.handleInput("\r");
		expect(onSubmit).not.toHaveBeenCalled();
		await submittedOnce.promise;

		const submitted = submittedImage(onSubmit);
		expect(submitted.text).toMatch(/^see \[Image #1, \d+x\d+\]$/);
		expect(submitted.source).toMatch(/^local:\/\/pasted-image-[0-9a-f]+\.png$/);
		expect(context.editor.pendingImages).toHaveLength(0);
	});

	it("prefers a Finder file URL over the co-advertised icon bitmap (#8769)", async () => {
		const imagePath = await writePng("finder.png");
		const context = await createPromptContext();
		const { prompt, onSubmit } = createPrompt(context, { acceptImages: true });
		const readImage = vi.fn(async () => ({ data: Buffer.from(TINY_PNG, "base64"), mimeType: "image/png" }));
		const controller = new InputController(context.ctx, {
			readImage,
			readText: async () => "",
			readMacFileUrls: async () => [imagePath],
		});

		expect(await controller.handleImagePaste()).toBe(true);
		prompt.handleInput("\r");

		expect(submittedImage(onSubmit).source).toBe(imagePath);
		expect(readImage).not.toHaveBeenCalled();
		expect(context.editor.pendingImages).toHaveLength(0);
	});

	it("attaches the image file named by smart-pasted clipboard text (#3506)", async () => {
		const imagePath = await writePng("clipboard-image.png");
		const context = await createPromptContext();
		const { prompt, onSubmit } = createPrompt(context, { acceptImages: true });
		const controller = new InputController(context.ctx, {
			readImage: async () => null,
			readText: async () => imagePath,
			readMacFileUrls: async () => [],
		});

		expect(await controller.handleImagePaste()).toBe(true);
		prompt.handleInput("\r");

		expect(submittedImage(onSubmit).source).toBe(imagePath);
		expect(context.editor.getText()).toBe("");
	});

	it("recovers the clipboard bitmap for a vanished path and reports a missing one like the main editor (#2375)", async () => {
		const context = await createPromptContext();
		const delivered: (string | undefined)[] = [];
		const attached: ImageContent[] = [];
		context.setFocused({
			pasteText: vi.fn(),
			acceptsImages: true,
			attachImage: (image: ImageContent) => {
				attached.push(image);
				return `[Image #${attached.length}]`;
			},
			beginPaste: () => (text: string | undefined) => {
				delivered.push(text);
				return true;
			},
		});
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

		expect(delivered).toEqual(["[Image #1]"]);
		expect(attached.map(image => imageAttachmentSource(image)?.path)).toEqual([
			expect.stringMatching(/^local:\/\/pasted-image-[0-9a-f]+\.png$/),
		]);
		// The status shortens and truncates the path; the missing path is never pasted as text.
		expect(context.ctx.showStatus).toHaveBeenCalledWith(expect.stringMatching(/^Image not found at /));
		expect(context.editor.pendingImages).toHaveLength(0);
	});

	it("keeps a pasted video path as text and says why in an image-accepting prompt", async () => {
		const context = await createPromptContext();
		const { prompt, onSubmit } = createPrompt(context, { acceptImages: true });
		const videoPath = tempDir.join("clip.mp4");

		await new InputController(context.ctx).handleImagePathPaste(videoPath);
		prompt.handleInput("\r");

		expect(context.ctx.showStatus).toHaveBeenCalledWith("Video paste is not supported in this prompt");
		expect(onSubmit).toHaveBeenCalledWith(videoPath);
	});

	it("refuses a clipboard image in a prompt that did not opt in", async () => {
		const context = await createPromptContext();
		const { prompt, onSubmit } = createPrompt(context);
		const controller = new InputController(context.ctx, {
			readImage: async () => ({ data: Buffer.from(TINY_PNG, "base64"), mimeType: "image/png" }),
			readText: async () => "",
		});

		expect(await controller.handleImagePaste()).toBe(false);
		prompt.handleInput("\r");

		expect(context.ctx.showStatus).toHaveBeenCalledWith("Image paste is not supported in this prompt");
		expect(onSubmit).toHaveBeenCalledWith("");
		expect(context.editor.pendingImages).toHaveLength(0);
	});

	it("refuses an image-path paste in a prompt that did not opt in", async () => {
		const imagePath = await writePng("shot.png");
		const context = await createPromptContext();
		const { prompt, onSubmit } = createPrompt(context);

		await new InputController(context.ctx).handleImagePathPaste(imagePath);
		prompt.handleInput("\r");

		expect(context.ctx.showStatus).toHaveBeenCalledWith("Image paste is not supported in this prompt");
		expect(onSubmit).toHaveBeenCalledWith("");
		expect(context.editor.pendingImages).toHaveLength(0);
		expect(context.editor.getText()).toBe("");
	});

	it("refuses an enhanced (OSC 5522) image paste in a prompt that did not opt in", async () => {
		const context = await createPromptContext();
		createPrompt(context);
		new InputController(context.ctx).setupKeyHandlers();
		const listeners = registeredInputListeners(context.spies.addInputListener);
		context.spies.addStartListener.mock.calls[0]?.[0]();

		dispatchEnhancedImagePaste(listeners, Buffer.from(TINY_PNG, "base64"));

		expect(context.ctx.showStatus).toHaveBeenCalledWith("Image paste is not supported in this prompt");
		expect(context.editor.pendingImages).toHaveLength(0);
		expect(context.editor.getText()).toBe("");
	});
});

describe("InputController global editor actions", () => {
	const CTRL_T = "\x14";
	const CTRL_R = "\x12";
	const CTRL_G = "\x07";
	const CTRL_SHIFT_O = "\x1b[111;6u";
	const ALT_L = "\x1bl";

	beforeAll(async () => {
		await initTheme(false);
	});

	it("routes shortcuts while an ask dialog holds focus", async () => {
		const context = await createContext();
		const controller = new context.InputController(context.ctx);
		const openExternalEditor = vi.spyOn(controller, "openExternalEditor").mockResolvedValue();
		controller.setupKeyHandlers();
		const listeners = registeredInputListeners(context.spies.addInputListener);
		const dialog = new AskDialogComponent([{ id: "q1", question: "Choose one?", options: [{ label: "Option A" }] }], {
			onSubmit: () => {},
			onCancel: () => {},
			onPrompt: async () => undefined,
		});
		context.setFocused(dialog);

		expect(dispatchInput(listeners, CTRL_T)).toEqual({ consume: true });
		expect(context.ctx.toggleThinkingBlockVisibility).toHaveBeenCalledTimes(1);
		expect(dispatchInput(listeners, CTRL_R)).toEqual({ consume: true });
		expect(context.ctx.showHistorySearch).toHaveBeenCalledTimes(1);
		expect(dispatchInput(listeners, CTRL_G)).toEqual({ consume: true });
		expect(openExternalEditor).toHaveBeenCalledTimes(1);
		expect(dispatchInput(listeners, CTRL_SHIFT_O)).toEqual({ consume: true });
		expect(context.ctx.hideToolActivity).toBe(true);
		expect(dispatchInput(listeners, ALT_L)).toEqual({ consume: true });
		expect(context.spies.resetDisplayAfterAppearanceRefresh).toHaveBeenCalledTimes(1);
	});

	it("still routes transcript actions when the main editor holds focus", async () => {
		const context = await createContext();
		const controller = new context.InputController(context.ctx);
		controller.setupKeyHandlers();
		const listeners = registeredInputListeners(context.spies.addInputListener);

		expect(dispatchInput(listeners, CTRL_T)).toEqual({ consume: true });
		expect(context.ctx.toggleThinkingBlockVisibility).toHaveBeenCalledTimes(1);
	});

	it("defers while an overlay owns the active surface", async () => {
		const context = await createContext();
		const controller = new context.InputController(context.ctx);
		controller.setupKeyHandlers();
		context.setOverlayVisible(true);
		const listeners = registeredInputListeners(context.spies.addInputListener);

		expect(dispatchInput(listeners, CTRL_T)).toBeUndefined();
		expect(context.ctx.toggleThinkingBlockVisibility).not.toHaveBeenCalled();
		expect(dispatchInput(listeners, ALT_L)).toBeUndefined();
		expect(context.spies.resetDisplayAfterAppearanceRefresh).not.toHaveBeenCalled();
	});

	it("defers display reset to the tree selector's own Alt+L labeled-only filter", async () => {
		const context = await createContext();
		const controller = new context.InputController(context.ctx);
		controller.setupKeyHandlers();
		const listeners = registeredInputListeners(context.spies.addInputListener);
		const tree = [
			{
				entry: { id: "root", type: "message", parentId: null, message: { role: "user", content: "hi" } },
				children: [],
			},
		] as unknown as SessionTreeNode[];
		context.setFocused(
			new TreeSelectorComponent(
				tree,
				"root",
				20,
				() => {},
				() => {},
			),
		);

		expect(dispatchInput(listeners, ALT_L)).toBeUndefined();
		expect(context.spies.resetDisplayAfterAppearanceRefresh).not.toHaveBeenCalled();
		context.setKeybinding("app.display.reset", ["ctrl+l"]);
		expect(dispatchInput(listeners, "\x0c")).toEqual({ consume: true });
		expect(context.spies.resetDisplayAfterAppearanceRefresh).toHaveBeenCalledTimes(1);
	});

	it("defers external editing to a focused ask-dialog prompt editor untracked by ctx.hookEditor", async () => {
		const context = await createContext();
		const controller = new context.InputController(context.ctx);
		const openExternalEditor = vi.spyOn(controller, "openExternalEditor").mockResolvedValue();
		controller.setupKeyHandlers();
		const hookEditor = new HookEditorComponent(
			context.ctx.ui,
			"Edit",
			undefined,
			() => {},
			() => {},
		);
		// The ask dialog's "Other" prompt focuses a HookEditorComponent without
		// assigning ctx.hookEditor; the defer must recognize it structurally.
		context.setFocused(hookEditor);
		const listeners = registeredInputListeners(context.spies.addInputListener);

		expect(dispatchInput(listeners, CTRL_G)).toBeUndefined();
		expect(openExternalEditor).not.toHaveBeenCalled();
	});

	it("defers the tree selector's Ctrl+Shift+O filter binding", async () => {
		const context = await createContext();
		const controller = new context.InputController(context.ctx);
		controller.setupKeyHandlers();
		const tree = [
			{
				entry: { id: "root", type: "message", parentId: null, message: { role: "user", content: "hi" } },
				children: [],
			},
		] as unknown as SessionTreeNode[];
		context.setFocused(
			new TreeSelectorComponent(
				tree,
				"root",
				20,
				() => {},
				() => {},
			),
		);
		const listeners = registeredInputListeners(context.spies.addInputListener);

		expect(dispatchInput(listeners, CTRL_SHIFT_O)).toBeUndefined();
		expect(context.ctx.hideToolActivity).toBe(false);
	});
});

describe("InputController global tool-output expand (ctrl+o)", () => {
	const CTRL_O = "\x0f";

	beforeAll(async () => {
		await initTheme(false);
	});

	async function setup() {
		const context = await createContext();
		const controller = new context.InputController(context.ctx);
		controller.setupKeyHandlers();
		return { ...context, listeners: registeredInputListeners(context.spies.addInputListener) };
	}

	it("toggles tool-output expansion when a non-editor prompt holds focus (#7837)", async () => {
		const { ctx, listeners, setFocused } = await setup();
		// An approval / select prompt owns keyboard focus, not the editor.
		setFocused({ handleInput() {} });
		expect(ctx.toolOutputExpanded).toBe(false);

		expect(dispatchInput(listeners, CTRL_O)).toEqual({ consume: true });
		expect(ctx.toolOutputExpanded).toBe(true);
	});

	it("still toggles when the editor holds focus", async () => {
		const { ctx, listeners } = await setup();
		// The editor is the default focus target in the harness.
		expect(dispatchInput(listeners, CTRL_O)).toEqual({ consume: true });
		expect(ctx.toolOutputExpanded).toBe(true);
	});

	it("defers while a fullscreen/anchored overlay owns the surface", async () => {
		const { ctx, listeners, setOverlayVisible } = await setup();
		setOverlayVisible(true);

		expect(dispatchInput(listeners, CTRL_O)).toBeUndefined();
		expect(ctx.toolOutputExpanded).toBe(false);
	});

	it("defers to the tree selector's own ctrl+o filter cycle", async () => {
		const { ctx, listeners, setFocused } = await setup();
		const tree = [
			{
				entry: { id: "root", type: "message", parentId: null, message: { role: "user", content: "hi" } },
				children: [],
			},
		] as unknown as SessionTreeNode[];
		setFocused(
			new TreeSelectorComponent(
				tree,
				"root",
				20,
				() => {},
				() => {},
			),
		);

		expect(dispatchInput(listeners, CTRL_O)).toBeUndefined();
		expect(ctx.toolOutputExpanded).toBe(false);
	});

	it("honors a remapped expand key while the tree selector has focus", async () => {
		const context = await createContext();
		context.setKeybinding("app.tools.expand", ["ctrl+x"]);
		const controller = new context.InputController(context.ctx);
		controller.setupKeyHandlers();
		const listeners = registeredInputListeners(context.spies.addInputListener);
		const tree = [
			{
				entry: { id: "root", type: "message", parentId: null, message: { role: "user", content: "hi" } },
				children: [],
			},
		] as unknown as SessionTreeNode[];
		context.setFocused(
			new TreeSelectorComponent(
				tree,
				"root",
				20,
				() => {},
				() => {},
			),
		);

		expect(dispatchInput(listeners, "\x18")).toEqual({ consume: true });
		expect(context.ctx.toolOutputExpanded).toBe(true);
	});

	it("expands a truncated ask question instead of tool output when the ask dialog is focused", async () => {
		const { ctx, listeners, setFocused } = await setup();
		const dialog = new AskDialogComponent(
			[
				{
					id: "q1",
					question: "This is a very long question ".repeat(30),
					options: [{ label: "Option A" }, { label: "Option B" }],
				},
			],
			{ onSubmit: () => {}, onCancel: () => {}, onPrompt: async () => undefined },
		);
		const collapsed = dialog.render(80).join("\n");
		setFocused(dialog);

		expect(dispatchInput(listeners, "\x0f")).toEqual({ consume: true });
		expect(ctx.toolOutputExpanded).toBe(false);
		const expanded = dialog.render(80).join("\n");
		const collapsedCount = collapsed.match(/This is a very long question/g)?.length ?? 0;
		const expandedCount = expanded.match(/This is a very long question/g)?.length ?? 0;
		expect(collapsedCount).toBeLessThan(10);
		expect(expandedCount).toBeGreaterThan(collapsedCount);
	});

	it("still expands tool output when a short ask question has nothing to reveal", async () => {
		const { ctx, listeners, setFocused } = await setup();
		const dialog = new AskDialogComponent([{ id: "q1", question: "Choose one?", options: [{ label: "Option A" }] }], {
			onSubmit: () => {},
			onCancel: () => {},
			onPrompt: async () => undefined,
		});
		dialog.render(80);
		setFocused(dialog);

		expect(dispatchInput(listeners, "\x0f")).toEqual({ consume: true });
		expect(ctx.toolOutputExpanded).toBe(true);
	});
});

describe("Ctrl+S prompt stash", () => {
	it("keeps an empty submit from consuming the stash, then restores after a separate prompt", async () => {
		const { ctx, editor, customHandlers, spies } = await createContext();
		const controller = new InputController(ctx);
		controller.setupKeyHandlers();
		controller.setupEditorSubmitHandler();
		const stash = customHandlers.get("ctrl+s");
		expect(stash).toBeDefined();
		expect(customHandlers.get("alt+a")).toBeDefined();
		const image: ImageContent = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
		editor.pendingImages = [image];
		editor.pendingImageLinks = ["/tmp/attached.png"];
		editor.setText("original [Image #1]");
		stash?.();
		expect(editor.getText()).toBe("");
		expect(editor.pendingImages).toEqual([]);
		await editor.onSubmit?.("");
		expect(editor.getText()).toBe("");
		editor.setText("intervening prompt");
		editor.setText(""); // Editor clears before invoking onSubmit.
		await editor.onSubmit?.("intervening prompt");
		expect(spies.prompt).toHaveBeenCalledWith("intervening prompt", {
			streamingBehavior: "steer",
			images: undefined,
			onAccepted: expect.any(Function),
		});
		expect(editor.getText()).toBe("original [Image #1]");
		expect(editor.pendingImages).toEqual([image]);
		expect(editor.pendingImageLinks).toEqual(["/tmp/attached.png"]);
	});

	it("keeps the stash available when another prompt fails, then restores on an empty Ctrl+S", async () => {
		const { ctx, editor, customHandlers, spies } = await createContext();
		const controller = new InputController(ctx);
		controller.setupKeyHandlers();
		controller.setupEditorSubmitHandler();
		editor.setText("original");
		customHandlers.get("ctrl+s")?.();
		spies.prompt.mockRejectedValueOnce(new Error("dispatch failed"));
		await editor.onSubmit?.("other");
		expect(editor.getText()).toBe("other");
		expect(spies.showError).toHaveBeenCalled();
		editor.setText("");
		customHandlers.get("ctrl+s")?.();
		expect(editor.getText()).toBe("original");
	});

	it("restores after a focused submission, and explicit Ctrl+S swaps drafts", async () => {
		const { ctx, editor, customHandlers, spies, setFocusedAgent } = await createContext();
		const controller = new InputController(ctx);
		controller.setupKeyHandlers();
		controller.setupEditorSubmitHandler();
		editor.setText("first");
		customHandlers.get("ctrl+s")?.();
		editor.setText("replacement");
		customHandlers.get("ctrl+s")?.();
		customHandlers.get("ctrl+s")?.();
		expect(editor.getText()).toBe("replacement");
		customHandlers.get("ctrl+s")?.();
		setFocusedAgent("agent");
		await editor.onSubmit?.("ask focused agent");
		expect(spies.prompt).toHaveBeenCalledWith("ask focused agent", {
			streamingBehavior: "steer",
			images: undefined,
			onAccepted: expect.any(Function),
		});
		expect(editor.getText()).toBe("replacement");
	});

	it("swaps both rich drafts instead of overwriting an existing stash", async () => {
		const { ctx, editor, customHandlers } = await createContext();
		const controller = new InputController(ctx);
		controller.setupKeyHandlers();
		const first: ImageContent = { type: "image", data: "Zmlyc3Q=", mimeType: "image/png" };
		const second: ImageContent = { type: "image", data: "c2Vjb25k", mimeType: "image/png" };
		editor.setText("first [Image #1]");
		editor.pendingImages = [first];
		editor.pendingImageLinks = ["file:///first.png"];
		customHandlers.get("ctrl+s")?.();
		editor.setText("second [Image #1]");
		editor.pendingImages = [second];
		editor.pendingImageLinks = ["file:///second.png"];
		customHandlers.get("ctrl+s")?.();
		expect(editor.getText()).toBe("first [Image #1]");
		expect(editor.pendingImages).toEqual([first]);
		expect(editor.pendingImageLinks).toEqual(["file:///first.png"]);
		customHandlers.get("ctrl+s")?.();
		expect(editor.getText()).toBe("second [Image #1]");
		expect(editor.pendingImages).toEqual([second]);
		expect(editor.pendingImageLinks).toEqual(["file:///second.png"]);
		editor.clearDraft();
		customHandlers.get("ctrl+s")?.();
		expect(editor.getText()).toBe("first [Image #1]");
		expect(editor.pendingImages).toEqual([first]);
	});

	it("restores a rich draft on acceptance of a canonicalized prompt before its model turn finishes", async () => {
		const { ctx, editor, customHandlers, spies, setFocusedAgent } = await createContext();
		const controller = new InputController(ctx);
		controller.setupKeyHandlers();
		controller.setupEditorSubmitHandler();
		const image: ImageContent = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
		editor.pendingImages = [image];
		editor.pendingImageLinks = ["/tmp/attached.png"];
		editor.setText("long draft [Image #1]");
		customHandlers.get("ctrl+s")?.();
		setFocusedAgent("agent");
		let finishTurn!: () => void;
		const turn = new Promise<void>(resolve => {
			finishTurn = resolve;
		});
		spies.prompt.mockImplementationOnce(async (_text, options) => {
			expect(editor.getText()).toBe("");
			// The session expands the submitted text before delivering the user message.
			// Restoration follows acceptance, not exact message text.
			options?.onAccepted?.();
			await turn;
			return true;
		});
		const submission = editor.onSubmit?.("typed @mention");
		await Promise.resolve();
		expect(editor.getText()).toBe("long draft [Image #1]");
		expect(editor.pendingImages).toEqual([image]);
		finishTurn();
		await submission;
	});
	it("keeps a single-Ctrl+S stash separate from a queued steering edit", async () => {
		const { ctx, editor, customHandlers, spies } = await createContext();
		const controller = new InputController(ctx);
		controller.setupKeyHandlers();
		controller.setupEditorSubmitHandler();
		const image: ImageContent = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
		editor.pendingImages = [image];
		editor.pendingImageLinks = ["file:///stash.png"];
		editor.setText("saved draft [Image #1]");
		customHandlers.get("ctrl+s")?.();
		expect(spies.notifyComposerStash).toHaveBeenCalledTimes(1);

		const queued: RestoredQueuedMessage[] = [];
		const session = ctx.session as InteractiveModeContext["session"] & {
			popLastQueuedMessage: () => RestoredQueuedMessage | undefined;
		};
		Object.assign(session, { popLastQueuedMessage: () => queued.pop() });
		let acceptFirstPrompt: (() => void) | undefined;
		let finishFirstTurn!: () => void;
		const firstTurn = new Promise<void>(resolve => {
			finishFirstTurn = resolve;
		});
		spies.prompt.mockImplementation(async (text, options) => {
			if (text === "first prompt") {
				acceptFirstPrompt = () => options?.onAccepted?.();
				await firstTurn;
				return true;
			}
			queued.push({ text });
			options?.onAccepted?.();
			return true;
		});

		editor.setText("first prompt");
		editor.clearDraft(); // The editor clears before calling onSubmit.
		const firstSubmission = editor.onSubmit?.("first prompt");
		if (!firstSubmission) throw new Error("Expected the first prompt to start");
		await Promise.resolve();
		expect(acceptFirstPrompt).toBeDefined();
		expect(editor.getText()).toBe("");

		// The first turn is running while its acceptance callback is still pending.
		// Submit steering before that callback can consume the only stashed draft.
		Object.assign(session, { isStreaming: true });
		editor.setText("steering prompt");
		editor.clearDraft();
		await editor.onSubmit?.("steering prompt");
		expect(queued).toEqual([{ text: "steering prompt" }]);
		expect(editor.getText()).toBe("saved draft [Image #1]");
		expect(editor.pendingImages).toEqual([image]);

		expect(spies.notifyComposerStash).toHaveBeenCalledTimes(1);

		// Alt+Up recalls the steering prompt alone. Accepting its edit restores
		// the parked stash instead of folding it into the submitted prompt.
		expect(editor.onDequeue).toBeDefined();
		editor.onDequeue?.();
		expect(editor.getText()).toBe("steering prompt");
		expect(editor.pendingImages).toEqual([]);
		editor.setText("steering prompt revised");
		editor.clearDraft();
		// The delayed first-prompt acceptance cannot consume the fresh stash parked by Alt+Up.
		acceptFirstPrompt?.();
		expect(editor.getText()).toBe("");
		expect(editor.pendingImages).toEqual([]);
		await editor.onSubmit?.("steering prompt revised");
		expect(queued).toEqual([{ text: "steering prompt revised" }]);
		expect(editor.getText()).toBe("saved draft [Image #1]");
		expect(editor.pendingImages).toEqual([image]);
		expect(editor.pendingImageLinks).toEqual(["file:///stash.png"]);

		finishFirstTurn();
		await firstSubmission;
	});

	it("keeps a rich stash separate when Esc restores all queued messages", async () => {
		const { ctx, editor, customHandlers, spies } = await createContext();
		const controller = new InputController(ctx);
		controller.setupKeyHandlers();
		controller.setupEditorSubmitHandler();
		const image: ImageContent = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
		editor.pendingImages = [image];
		editor.pendingImageLinks = ["file:///stash.png"];
		editor.setText("saved draft [Image #1]");
		customHandlers.get("ctrl+s")?.();

		editor.setText("first prompt");
		editor.clearDraft();
		await editor.onSubmit?.("first prompt");
		expect(editor.getText()).toBe("saved draft [Image #1]");
		expect(editor.pendingImages).toEqual([image]);

		const session = ctx.session as InteractiveModeContext["session"] & {
			clearQueue: () => { steering: RestoredQueuedMessage[]; followUp: RestoredQueuedMessage[] };
		};
		const clearQueue = vi.fn(() => ({ steering: [{ text: "queued prompt" }], followUp: [] }));
		Object.assign(session, { clearQueue });
		Object.assign(ctx, {
			compactionQueuedMessages: [],
			mcpTestEscapeHandlers: new Set(),
			hasActiveOmfg: () => false,
			hasActiveCleanse: () => false,
			dismissCommandReport: () => false,
			loadingAnimation: {},
			cancelPendingSubmission: vi.fn(() => false),
		});
		editor.onEscape?.();
		expect(clearQueue).toHaveBeenCalledWith({ forInterrupt: true });
		expect(editor.getText()).toBe("queued prompt");
		expect(editor.pendingImages).toEqual([]);
		expect(editor.pendingImageLinks).toEqual([]);

		Object.assign(session, { isStreaming: true });
		editor.setText("queued prompt revised");
		editor.clearDraft();
		await editor.onSubmit?.("queued prompt revised");
		expect(spies.prompt).toHaveBeenCalledWith("queued prompt revised", {
			streamingBehavior: "steer",
			images: undefined,
			onAccepted: expect.any(Function),
		});
		expect(editor.getText()).toBe("saved draft [Image #1]");
		expect(editor.pendingImages).toEqual([image]);
		expect(editor.pendingImageLinks).toEqual(["file:///stash.png"]);
	});

	it("does not consume a newer stash when an older submission is accepted", async () => {
		const { ctx, editor, customHandlers, spies } = await createContext();
		const controller = new InputController(ctx);
		controller.setupKeyHandlers();
		controller.setupEditorSubmitHandler();
		editor.setText("old draft");
		customHandlers.get("ctrl+s")?.();
		let accept!: () => void;
		spies.prompt.mockImplementationOnce(async (_text, options) => {
			accept = () => options?.onAccepted?.();
			return true;
		});
		await editor.onSubmit?.("separate prompt");
		editor.setText("new draft");
		customHandlers.get("ctrl+s")?.();
		accept();
		expect(editor.getText()).toBe("old draft");
		customHandlers.get("ctrl+s")?.();
		expect(editor.getText()).toBe("new draft");
	});

	it("restores a stash as soon as a long-running local command starts", async () => {
		const { ctx, editor, customHandlers } = await createContext();
		const controller = new InputController(ctx);
		controller.setupKeyHandlers();
		controller.setupEditorSubmitHandler();
		editor.setText("unfinished draft");
		customHandlers.get("ctrl+s")?.();
		const { promise: started, resolve: startCommand } = Promise.withResolvers<void>();
		const { promise: running, resolve: finishCommand } = Promise.withResolvers<void>();
		ctx.handleBashCommand = vi.fn(async () => {
			startCommand();
			return running;
		});
		const submission = editor.onSubmit?.("! sleep 30");
		await started;
		expect(editor.getText()).toBe("unfinished draft");
		finishCommand();
		await submission;
	});

	for (const [command, handler] of [
		["/plan prepare", "handlePlanModeCommand"],
		["/vibe delegate", "handleVibeModeCommand"],
		["/goal ship", "handleGoalModeCommand"],
		["/guided-goal discuss", "handleGuidedGoalCommand"],
	] as const) {
		it(`restores a stashed draft only when ${command} is accepted`, async () => {
			const { ctx, editor, customHandlers } = await createContext();
			const controller = new InputController(ctx);
			controller.setupKeyHandlers();
			controller.setupEditorSubmitHandler();
			const image: ImageContent = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
			editor.pendingImages = [image];
			editor.pendingImageLinks = ["file:///stash.png"];
			editor.setText("stashed [Image #1]");
			customHandlers.get("ctrl+s")?.();
			editor.setText(command);
			let accept: (() => void) | undefined;
			(ctx as unknown as Record<string, unknown>)[handler] = vi.fn(
				async (_args: string | undefined, input?: { onAccepted?: () => void }) => {
					accept = input?.onAccepted;
					return true;
				},
			);

			editor.setText(""); // Enter removes submitted text before calling onSubmit.
			await editor.onSubmit?.(command);
			expect(editor.getText()).toBe("");
			expect(editor.pendingImages).toEqual([]);
			expect(accept).toBeDefined();
			// The handler merely scheduled a prompt; it may still fail preflight.
			accept?.();
			expect(editor.getText()).toBe("stashed [Image #1]");
			expect(editor.pendingImages).toEqual([image]);
			expect(editor.pendingImageLinks).toEqual(["file:///stash.png"]);
		});
	}

	it("keeps the stash when a scheduled slash prompt is dropped before acceptance", async () => {
		const { ctx, editor, customHandlers } = await createContext();
		const controller = new InputController(ctx);
		controller.setupKeyHandlers();
		controller.setupEditorSubmitHandler();
		editor.setText("safe draft");
		customHandlers.get("ctrl+s")?.();
		editor.setText("/plan try this");
		ctx.handlePlanModeCommand = vi.fn(async () => true);
		editor.setText(""); // Enter removes submitted text before calling onSubmit.
		await editor.onSubmit?.("/plan try this");
		expect(editor.getText()).toBe("");
		// Simulate the pending submission's preflight failure: it never called
		// onAccepted, so the stashed draft remains available to restore manually.
		customHandlers.get("ctrl+s")?.();
		expect(editor.getText()).toBe("safe draft");
	});

	it("restores a stash for /queue only when the scheduled message is accepted", async () => {
		const { ctx, editor, customHandlers } = await createContext();
		const controller = new InputController(ctx);
		controller.setupKeyHandlers();
		controller.setupEditorSubmitHandler();
		editor.setText("stash");
		customHandlers.get("ctrl+s")?.();
		let accept: (() => void) | undefined;
		ctx.startPendingSubmission = vi.fn((input: Parameters<InteractiveModeContext["startPendingSubmission"]>[0]) => {
			accept = input.onAccepted;
			return { ...input, cancelled: false, started: false };
		});
		ctx.onInputCallback = vi.fn();
		ctx.handleQueueCommand = (text, input) => controller.handleQueueCommand(text, input);
		editor.setText("/queue later");
		await editor.onSubmit?.("/queue later");
		expect(editor.getText()).toBe("");
		expect(accept).toBeDefined();
		accept?.();
		expect(editor.getText()).toBe("stash");
	});

	it("preserves the restored rich stash when a later queued message fails", async () => {
		const { ctx, editor, customHandlers } = await createContext();
		const controller = new InputController(ctx);
		controller.setupKeyHandlers();
		const image: ImageContent = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
		editor.pendingImages = [image];
		editor.pendingImageLinks = ["file:///stash.png"];
		editor.setText("draft [Image #1]");
		customHandlers.get("ctrl+s")?.();
		Object.assign(ctx.session, {
			isStreaming: true,
			followUp: vi.fn(async (text: string) => {
				if (text === "second") throw new Error("queue failed");
			}),
		});
		await controller.handleQueueCommand("1. first\n2. second");
		expect(editor.getText()).toBe("draft [Image #1]\n\n=> second");
		expect(editor.pendingImages).toEqual([image]);
		expect(editor.pendingImageLinks).toEqual(["file:///stash.png"]);
	});

	it("retains legacy no-stash queue failure replacement rather than merging a new draft", async () => {
		const { ctx, editor } = await createContext();
		const controller = new InputController(ctx);
		Object.assign(ctx.session, {
			isStreaming: true,
			followUp: vi.fn(async (text: string) => {
				if (text === "second") {
					editor.setText("newly typed");
					throw new Error("queue failed");
				}
			}),
		});
		await controller.handleQueueCommand("1. first\n2. second");
		expect(editor.getText()).toBe("=> second");
	});

	it("restores the stash alongside an unsent queue entry when first acceptance arrives after the error", async () => {
		const { ctx, editor, customHandlers } = await createContext();
		const controller = new InputController(ctx);
		controller.setupKeyHandlers();
		const image: ImageContent = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
		editor.pendingImages = [image];
		editor.pendingImageLinks = ["file:///stash.png"];
		editor.setText("draft [Image #1]");
		customHandlers.get("ctrl+s")?.();
		let accept: (() => void) | undefined;
		ctx.startPendingSubmission = vi.fn((input: Parameters<InteractiveModeContext["startPendingSubmission"]>[0]) => {
			accept = input.onAccepted;
			return { ...input, cancelled: false, started: false };
		});
		ctx.onInputCallback = vi.fn();
		Object.assign(ctx.session, {
			followUp: vi.fn(async () => {
				throw new Error("queue failed");
			}),
		});

		await controller.handleQueueCommand("1. first\n2. second");
		expect(editor.getText()).toBe("=>\n1. first\n2. second");
		accept?.();
		expect(editor.getText()).toBe("draft [Image #1]\n\n=> second");
		expect(editor.pendingImages).toEqual([image]);
		expect(editor.pendingImageLinks).toEqual(["file:///stash.png"]);
	});

	it("drops an accepted first queued entry and its images from a no-stash recovery preview", async () => {
		const { ctx, editor } = await createContext();
		const controller = new InputController(ctx);
		const image: ImageContent = { type: "image", data: "Zmlyc3Q=", mimeType: "image/png" };
		editor.pendingImages = [image];
		editor.pendingImageLinks = ["file:///first.png"];
		let accept: (() => void) | undefined;
		ctx.startPendingSubmission = vi.fn((input: Parameters<InteractiveModeContext["startPendingSubmission"]>[0]) => {
			accept = input.onAccepted;
			return { ...input, cancelled: false, started: false };
		});
		ctx.onInputCallback = vi.fn();
		Object.assign(ctx.session, {
			followUp: vi.fn(async () => {
				throw new Error("queue failed");
			}),
		});

		await controller.handleQueueCommand("1. first [Image #1]\n2. second");
		expect(editor.getText()).toBe("=>\n1. first [Image #1]\n2. second");
		expect(editor.pendingImages).toEqual([image]);
		expect(editor.pendingImageLinks).toEqual(["file:///first.png"]);
		accept?.();
		expect(editor.getText()).toBe("=> second");
		expect(editor.pendingImages).toEqual([]);
		expect(editor.pendingImageLinks).toEqual([]);
	});

	for (const [label, submittedText] of [
		["Enter", "=>\n1. first [Image #1]\n2. second"],
		["detached Ctrl+Enter", "/queue 1. first [Image #1]\n2. second"],
	] as const) {
		it(`${label} preserves a newer image draft while a pending first queue entry awaits acceptance`, async () => {
			const { ctx, editor } = await createContext();
			const controller = new InputController(ctx);
			controller.setupEditorSubmitHandler();
			ctx.handleQueueCommand = (text, input) => controller.handleQueueCommand(text, input);
			const firstImage: ImageContent = { type: "image", data: "Zmlyc3Q=", mimeType: "image/png" };
			const newerImage: ImageContent = { type: "image", data: "bmV3ZXI=", mimeType: "image/jpeg" };
			let accept: (() => void) | undefined;
			ctx.startPendingSubmission = vi.fn(
				(input: Parameters<InteractiveModeContext["startPendingSubmission"]>[0]) => {
					accept = input.onAccepted;
					return { ...input, cancelled: false, started: false };
				},
			);
			ctx.onInputCallback = vi.fn();
			const secondStarted = Promise.withResolvers<void>();
			const failSecond = Promise.withResolvers<void>();
			const followUp = vi.fn(async (text: string) => {
				if (text === "second") {
					secondStarted.resolve();
					await failSecond.promise;
					throw new Error("queue failed");
				}
			});
			Object.assign(ctx.session, { followUp });
			editor.pendingImages = [firstImage];
			editor.pendingImageLinks = ["file:///first.png"];
			editor.imageLinks = editor.pendingImageLinks;
			editor.setText(submittedText);
			// The real editor clears submitted Enter text before calling onSubmit;
			// Ctrl+Enter detaches text and images inside handleFollowUp.
			let submitting: Promise<void> | undefined;
			if (label === "Enter") {
				editor.setText("");
				submitting = editor.onSubmit?.(submittedText);
			} else {
				submitting = controller.handleFollowUp();
			}
			if (!submitting) throw new Error("submission handler missing");
			await secondStarted.promise;
			editor.pendingImages = [newerImage];
			editor.pendingImageLinks = ["file:///newer.jpg"];
			editor.imageLinks = editor.pendingImageLinks;
			editor.setText("newer [Image #1]");
			failSecond.resolve();
			await submitting;

			// If pending first fails preflight, it and its own image must still
			// be retriable; neither image marker may refer to the other image.
			expect(accept).toBeDefined();
			expect(followUp).toHaveBeenCalledWith("second", undefined);
			expect(editor.getText()).toBe("=>\n1. first [Image #2]\n2. second\n\nnewer [Image #1]");
			expect(editor.pendingImages).toEqual([newerImage, firstImage]);
			expect(editor.pendingImageLinks).toEqual(["file:///newer.jpg", "file:///first.png"]);

			accept?.();
			expect(editor.getText()).toBe("newer [Image #1]\n\n=> second");
			expect(editor.pendingImages).toEqual([newerImage]);
			expect(editor.pendingImageLinks).toEqual(["file:///newer.jpg"]);
			expect(editor.imageLinks).toEqual(["file:///newer.jpg"]);
		});
	}

	it("does not replace a re-edited queue recovery draft when delayed acceptance arrives", async () => {
		const { ctx, editor, customHandlers } = await createContext();
		const controller = new InputController(ctx);
		controller.setupKeyHandlers();
		const image: ImageContent = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
		editor.pendingImages = [image];
		editor.pendingImageLinks = ["file:///stash.png"];
		editor.setText("draft [Image #1]");
		customHandlers.get("ctrl+s")?.();
		let accept: (() => void) | undefined;
		ctx.startPendingSubmission = vi.fn((input: Parameters<InteractiveModeContext["startPendingSubmission"]>[0]) => {
			accept = input.onAccepted;
			return { ...input, cancelled: false, started: false };
		});
		ctx.onInputCallback = vi.fn();
		Object.assign(ctx.session, {
			followUp: vi.fn(async () => {
				throw new Error("queue failed");
			}),
		});

		await controller.handleQueueCommand("1. first\n2. second");
		const recoveryDraft = editor.getText();
		expect(recoveryDraft).toBe("=>\n1. first\n2. second");
		// Re-editing to identical text must still be treated as a new user draft.
		editor.setText(recoveryDraft);
		accept?.();
		expect(editor.getText()).toBe(recoveryDraft);

		customHandlers.get("ctrl+s")?.();
		expect(editor.getText()).toBe("draft [Image #1]");
		expect(editor.pendingImages).toEqual([image]);
		expect(editor.pendingImageLinks).toEqual(["file:///stash.png"]);
	});
});
