import { afterEach, beforeAll, describe, expect, it, type Mock, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ImageContent } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/assistant-message";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import * as clipboard from "@oh-my-pi/pi-coding-agent/utils/clipboard";
import { type KeyId, matchesKey } from "@oh-my-pi/pi-tui";

const ALT_Y = "\x1by";
const ALT_SHIFT_Y = "\x1bY";

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
	onHistorySearch?: () => void;
	onPasteImage?: () => Promise<boolean>;
	onCopyPrompt?: () => void;
	onExpandTools?: () => void;
	onToggleToolActivity?: () => void;
	onToggleThinking?: () => void;
	onExternalEditor?: () => void;
	onRetry?: () => void;
	onDequeue?: () => void;
	onChange?: (text: string) => void;
	onSubmit?: (text: string) => Promise<void>;
	onLeftAtStart?: () => void;
	setText(text: string): void;
	getText(): string;
	getExpandedText(): string;
	setCollapsedText(text: string): void;
	composerChips(): unknown[];
	addToHistory(text: string): void;
	setActionKeys(action: string, keys: string[]): void;
	setCustomKeyHandler(key: string, handler: () => void): void;
	clearCustomKeyHandlers(): void;
	pasteText(text: string): void;
	sttHoldEnabled?: () => boolean;
	onSpaceHoldStart?: () => void;
	onSpaceHoldEnd?: () => void;
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

function assistantText(text: string): AgentMessage {
	return { role: "assistant", content: [{ type: "text", text }] } as unknown as AgentMessage;
}

async function createContext() {
	const messages: AgentMessage[] = [];
	let editorText = "";
	const keyMap: Record<string, KeyId[]> = {
		"app.clipboard.copyCodeBlock": ["alt+y"],
		"app.clipboard.copyCodeBlockPrev": ["alt+shift+y"],
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
	const showWarning = vi.fn();
	const showStatus = vi.fn();
	const setTranscriptReveal = vi.fn();
	const hasTranscriptReveal = vi.fn(() => false);
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
	const prompt = vi.fn(async () => {});
	const retry = vi.fn(async () => true);
	const abort = vi.fn(async () => {});
	const session = {
		isStreaming: false,
		isCompacting: false,
		isGeneratingHandoff: false,
		isBashRunning: false,
		isEvalRunning: false,
		extensionRunner: undefined,
		prompt,
		queuedMessageCount: 0,
		abort,
		retry,
	};
	const updatePendingMessagesDisplay = vi.fn();
	const handleBtwBranchKey = vi.fn(async () => true);
	const handleBtwCopyKey = vi.fn(async () => true);
	const canBranchBtw = vi.fn(() => false);
	const canCopyBtw = vi.fn(() => false);
	const hasActiveBtw = vi.fn(() => false);
	const handlesBtwBranchKey = vi.fn(() => false);
	const editor: FakeEditor = {
		setText(text: string) {
			editorText = text;
		},
		getText() {
			return editorText;
		},
		getExpandedText() {
			return editorText;
		},
		setCollapsedText(text: string) {
			editorText = text;
		},
		composerChips() {
			return [];
		},
		addToHistory: vi.fn(),
		pasteText(text: string) {
			editorText += text;
		},
		setActionKeys,
		setCustomKeyHandler,
		clearCustomKeyHandlers,
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
	const focused: unknown = editor;
	const overlayVisible = false;
	const ctx = {
		editor: editor as unknown as InteractiveModeContext["editor"],
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
		viewSession: { messages } as unknown as InteractiveModeContext["viewSession"],
		transcriptMessageComponents: new WeakMap<AgentMessage, unknown>(),
		streamingMessage: undefined,
		streamingComponent: undefined,
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
		settings: { set: vi.fn() },
		chatContainer: { children: [], setToolActivityVisible: vi.fn() },
		handleHotkeysCommand: vi.fn(),
		handlePlanModeCommand: vi.fn(),
		handleClearCommand: vi.fn(),
		showTreeSelector: vi.fn(),
		showUserMessageSelector: vi.fn(),
		showSessionSelector: vi.fn(),
		handleSTTToggle: vi.fn(),
		handleLiveCommand: vi.fn(),
		showAgentHub: vi.fn(),
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
		showError,
		showWarning,
		showStatus,
		setTranscriptReveal,
		hasTranscriptReveal,
	} as unknown as InteractiveModeContext;

	return {
		InputController,
		ctx,
		editor,
		messages,
		setKeybinding(action: string, keys: KeyId[]) {
			keyMap[action] = keys;
		},
		spies: {
			addInputListener,
			requestRender,
			showStatus,
			showWarning,
			setTranscriptReveal,
			hasTranscriptReveal,
		},
	};
}

beforeAll(async () => {
	await initTheme(false);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("copy code block hotkeys", () => {
	it("copies the newest block on Alt+Y and consumes the input", async () => {
		const { InputController, ctx, messages, spies } = await createContext();
		messages.push(assistantText("older\n```ts\nconst oldValue = 1;\n```"));
		messages.push(assistantText("newer\n```py\nprint(1)\n```"));
		const copySpy = vi.spyOn(clipboard, "copyToClipboard").mockResolvedValue(undefined);
		const controller = new InputController(ctx);
		controller.setupKeyHandlers();

		const result = dispatchInput(registeredInputListeners(spies.addInputListener), ALT_Y);

		expect(result).toEqual({ consume: true });
		expect(copySpy).toHaveBeenCalledTimes(1);
		expect(copySpy).toHaveBeenCalledWith("print(1)");
	});

	it("walks to older blocks on repeated presses and wraps to the newest", async () => {
		const { InputController, ctx, messages, spies } = await createContext();
		messages.push(assistantText("A\n```\nblockA\n```"));
		messages.push(assistantText("B\n```\nblockB\n```"));
		messages.push(assistantText("C\n```\nblockC\n```"));
		const copySpy = vi.spyOn(clipboard, "copyToClipboard").mockResolvedValue(undefined);
		const controller = new InputController(ctx);
		controller.setupKeyHandlers();
		const listeners = registeredInputListeners(spies.addInputListener);

		// Newest first: blockC (index 0), blockB (index 1), blockA (index 2).
		for (const expected of ["blockC", "blockB", "blockA", "blockC"]) {
			dispatchInput(listeners, ALT_Y);
			expect(copySpy).toHaveBeenLastCalledWith(expected);
		}
	});

	it("Alt+Shift+Y walks back toward newer and wraps newest to oldest", async () => {
		const { InputController, ctx, messages, spies } = await createContext();
		messages.push(assistantText("A\n```\nblockA\n```"));
		messages.push(assistantText("B\n```\nblockB\n```"));
		messages.push(assistantText("C\n```\nblockC\n```"));
		const copySpy = vi.spyOn(clipboard, "copyToClipboard").mockResolvedValue(undefined);
		const controller = new InputController(ctx);
		controller.setupKeyHandlers();
		const listeners = registeredInputListeners(spies.addInputListener);

		// Alt+Shift+Y backs up: A (the previously copied block), then B, then C (newest).
		for (const expected of ["blockA", "blockB", "blockC"]) {
			dispatchInput(listeners, ALT_SHIFT_Y);
			expect(copySpy).toHaveBeenLastCalledWith(expected);
		}
		// Wraps: from the newest, Alt+Shift+Y lands on the oldest.
		dispatchInput(listeners, ALT_SHIFT_Y);
		expect(copySpy).toHaveBeenLastCalledWith("blockA");
	});

	it("moves on direction changes instead of repeating the selected block", async () => {
		// Regression: the stored index used to mean "next older after a forward
		// copy" but "current after a reverse copy", so switching direction
		// re-copied the same block. The stored index is now always the last
		// copied block and the direction is applied before each selection.
		const { InputController, ctx, messages, spies } = await createContext();
		messages.push(assistantText("A\n```\nblockA\n```"));
		messages.push(assistantText("B\n```\nblockB\n```"));
		messages.push(assistantText("C\n```\nblockC\n```"));
		const copySpy = vi.spyOn(clipboard, "copyToClipboard").mockResolvedValue(undefined);
		const controller = new InputController(ctx);
		controller.setupKeyHandlers();
		const listeners = registeredInputListeners(spies.addInputListener);

		// [newest, middle, oldest] = [blockC, blockB, blockA].
		dispatchInput(listeners, ALT_Y); // newest
		expect(copySpy).toHaveBeenLastCalledWith("blockC");
		dispatchInput(listeners, ALT_Y); // older
		expect(copySpy).toHaveBeenLastCalledWith("blockB");
		// Reversing must move toward newer, not re-copy the block just shown.
		dispatchInput(listeners, ALT_SHIFT_Y);
		expect(copySpy).toHaveBeenLastCalledWith("blockC");
		// From the newest, toward newer wraps to the oldest.
		dispatchInput(listeners, ALT_SHIFT_Y);
		expect(copySpy).toHaveBeenLastCalledWith("blockA");
		// From the oldest, toward older wraps to the newest.
		dispatchInput(listeners, ALT_Y);
		expect(copySpy).toHaveBeenLastCalledWith("blockC");
		// Every press moved; nothing repeated.
		expect(copySpy).toHaveBeenCalledTimes(5);
	});

	it("resets to the newest when new code blocks arrive between presses", async () => {
		const { InputController, ctx, messages, spies } = await createContext();
		messages.push(assistantText("first\n```\nfirstBlock\n```"));
		const copySpy = vi.spyOn(clipboard, "copyToClipboard").mockResolvedValue(undefined);
		const controller = new InputController(ctx);
		controller.setupKeyHandlers();
		const listeners = registeredInputListeners(spies.addInputListener);

		dispatchInput(listeners, ALT_Y);
		expect(copySpy).toHaveBeenLastCalledWith("firstBlock");

		// A newer message with a block arrives; the next press copies it.
		messages.push(assistantText("second\n```\nsecondBlock\n```"));
		dispatchInput(listeners, ALT_Y);
		expect(copySpy).toHaveBeenLastCalledWith("secondBlock");
	});

	it("shows No code block found and leaves the clipboard untouched for an empty transcript", async () => {
		const { InputController, ctx, spies } = await createContext();
		const copySpy = vi.spyOn(clipboard, "copyToClipboard").mockResolvedValue(undefined);
		const controller = new InputController(ctx);
		controller.setupKeyHandlers();

		const result = dispatchInput(registeredInputListeners(spies.addInputListener), ALT_Y);

		expect(result).toEqual({ consume: true });
		expect(spies.showStatus).toHaveBeenCalledWith("No code block found", { autoDismissMs: 2500 });
		expect(copySpy).not.toHaveBeenCalled();
	});

	it("reports the copied position with a single vs. multiple blocks", async () => {
		const { InputController, ctx, messages, spies } = await createContext();
		messages.push(assistantText("```\nonly\n```"));
		const copySpy = vi.spyOn(clipboard, "copyToClipboard").mockResolvedValue(undefined);
		const controller = new InputController(ctx);
		controller.setupKeyHandlers();
		const listeners = registeredInputListeners(spies.addInputListener);

		dispatchInput(listeners, ALT_Y);
		expect(spies.showStatus).toHaveBeenCalledWith("Copied code block", { autoDismissMs: 2500 });

		spies.showStatus.mockClear();
		messages.push(assistantText("one\n```\nfirst\n```"), assistantText("two\n```\nsecond\n```"));
		dispatchInput(listeners, ALT_Y);
		expect(copySpy).toHaveBeenLastCalledWith("second");
		dispatchInput(listeners, ALT_Y);
		expect(copySpy).toHaveBeenLastCalledWith("first");
		expect(spies.showStatus).toHaveBeenCalledWith("Copied code block (2 of 3) — press again for previous", {
			autoDismissMs: 2500,
		});
		expect(copySpy).toHaveBeenCalledTimes(3);
	});

	it("copies the dedented block body", async () => {
		const { InputController, ctx, messages, spies } = await createContext();
		messages.push(assistantText("```\n    def f():\n        return 1\n    x = 2\n```"));
		const copySpy = vi.spyOn(clipboard, "copyToClipboard").mockResolvedValue(undefined);
		const controller = new InputController(ctx);
		controller.setupKeyHandlers();

		dispatchInput(registeredInputListeners(spies.addInputListener), ALT_Y);

		expect(copySpy).toHaveBeenCalledWith("def f():\n    return 1\nx = 2");
	});

	it("honors a user rebind for the copy action", async () => {
		const { InputController, ctx, messages, setKeybinding, spies } = await createContext();
		messages.push(assistantText("```\nrebound\n```"));
		setKeybinding("app.clipboard.copyCodeBlock", ["alt+k"]);
		const copySpy = vi.spyOn(clipboard, "copyToClipboard").mockResolvedValue(undefined);
		const controller = new InputController(ctx);
		controller.setupKeyHandlers();

		const result = dispatchInput(registeredInputListeners(spies.addInputListener), "\x1bk");

		expect(result).toEqual({ consume: true });
		expect(copySpy).toHaveBeenCalledWith("rebound");
	});
	it("reveals the copied block with a background highlight on the message component", async () => {
		const { InputController, ctx, messages, spies } = await createContext();
		const message = assistantText("```\nhighlighted\n```");
		messages.push(message);
		const component = new AssistantMessageComponent(message as AssistantMessage);
		(ctx.transcriptMessageComponents as WeakMap<AgentMessage, unknown>).set(message, component);
		const copySpy = vi.spyOn(clipboard, "copyToClipboard").mockResolvedValue(undefined);
		const controller = new InputController(ctx);
		controller.setupKeyHandlers();

		dispatchInput(registeredInputListeners(spies.addInputListener), ALT_Y);

		expect(copySpy).toHaveBeenCalledWith("highlighted");
		const rendered = component.render(120).join("\n");
		// The accent marker under the message…
		expect(rendered).toContain("❯ Copied code block 1 of 1");
		// …and the accent bar prepended to the block's rows.
		expect(rendered).toContain("│");
		expect(spies.setTranscriptReveal).toHaveBeenCalledWith({
			component,
			label: "Copied code block 1 of 1",
		});
	});

	it("dismisses an active transcript reveal on any key", async () => {
		const { InputController, ctx, spies } = await createContext();
		spies.hasTranscriptReveal.mockReturnValue(true);
		const controller = new InputController(ctx);
		controller.setupKeyHandlers();

		const result = dispatchInput(registeredInputListeners(spies.addInputListener), "x");

		expect(result).toEqual({ consume: true });
		expect(spies.setTranscriptReveal).toHaveBeenCalledWith(undefined);
	});

	it("leaves unrelated keys alone when no reveal is active", async () => {
		const { InputController, ctx, spies } = await createContext();
		const controller = new InputController(ctx);
		controller.setupKeyHandlers();

		const result = dispatchInput(registeredInputListeners(spies.addInputListener), "x");

		expect(result).toBeUndefined();
		expect(spies.setTranscriptReveal).not.toHaveBeenCalled();
	});

	it("registers the copy listener exactly once across repeated setup calls", async () => {
		const { InputController, ctx, messages, spies } = await createContext();
		messages.push(assistantText("```\ncode\n```"));
		vi.spyOn(clipboard, "copyToClipboard").mockResolvedValue(undefined);
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		const first = registeredInputListeners(spies.addInputListener);
		controller.setupKeyHandlers();
		const second = registeredInputListeners(spies.addInputListener);

		expect(second).toHaveLength(first.length);
		expect(first.filter(listener => listener(ALT_Y)?.consume === true)).toHaveLength(1);
		expect(second.filter(listener => listener(ALT_Y)?.consume === true)).toHaveLength(1);
	});
});
