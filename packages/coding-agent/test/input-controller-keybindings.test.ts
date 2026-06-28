import { describe, expect, it, type Mock, vi } from "bun:test";
import type { ImageContent } from "@pk-nerdsaver-ai/pi-ai";
import { InputController } from "@pk-nerdsaver-ai/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@pk-nerdsaver-ai/pi-coding-agent/modes/types";
import manualContinuePrompt from "../src/prompts/system/manual-continue.md" with { type: "text" };

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
	onToggleThinking?: () => void;
	onExternalEditor?: () => void;
	onRetry?: () => void;
	onChange?: (text: string) => void;
	onSubmit?: (text: string) => Promise<void>;
	setText(text: string): void;
	getText(): string;
	addToHistory(text: string): void;
	setActionKeys(action: string, keys: string[]): void;
	setCustomKeyHandler(key: string, handler: () => void): void;
	clearCustomKeyHandlers(): void;
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
	const keyMap: Record<string, string[]> = {
		"app.display.reset": ["ctrl+l"],
		"app.model.selectTemporary": ["ctrl+y"],
		"app.model.select": ["alt+m"],
		"app.retry": ["alt+r"],
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
	const showModelSelector = vi.fn();
	const requestRender = vi.fn();
	const showError = vi.fn();
	let focused: unknown;
	const addInputListener = vi.fn((listener: InputListener) => {
		void listener;
	});
	const addStartListener = vi.fn();
	const terminalWrite = vi.fn();
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
	const editor: FakeEditor = {
		setText(text: string) {
			editorText = text;
		},
		getText() {
			return editorText;
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
	focused = editor;
	const ctx = {
		editor: editor as unknown as InteractiveModeContext["editor"],
		ui: {
			requestRender,
			resetDisplay,
			addInputListener,
			addStartListener,
			getFocused: vi.fn(() => focused),
			terminal: { write: terminalWrite },
		} as unknown as InteractiveModeContext["ui"],
		loadingAnimation: undefined,
		autoCompactionLoader: undefined,
		retryLoader: undefined,
		autoCompactionEscapeHandler: undefined,
		retryEscapeHandler: undefined,
		session: session as unknown as InteractiveModeContext["session"],
		viewSession: session as unknown as InteractiveModeContext["viewSession"],
		keybindings: {
			getKeys(action: string) {
				return keyMap[action] ? [...keyMap[action]] : [];
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
		handleHotkeysCommand: vi.fn(),
		handlePlanModeCommand: vi.fn(),
		handleClearCommand: vi.fn(),
		showTreeSelector: vi.fn(),
		showUserMessageSelector: vi.fn(),
		showSessionSelector: vi.fn(),
		handleSTTToggle: vi.fn(),
		showDebugSelector: vi.fn(),
		showHistorySearch: vi.fn(),
		toggleThinkingBlockVisibility: vi.fn(),
		showModelSelector,
		updateEditorBorderColor: vi.fn(),
		hasActiveBtw: vi.fn(() => false),
		handleBtwBranchKey,
		canBranchBtw,
		canCopyBtw,
		handleBtwCopyKey,
		showError,
		showStatus: vi.fn(),
	} as unknown as InteractiveModeContext;

	return {
		InputController,
		ctx,
		editor,
		customHandlers,
		setFocused(target: unknown) {
			focused = target;
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
			handleBtwBranchKey,
			addInputListener,
			canBranchBtw,
			handleBtwCopyKey,
			canCopyBtw,
			showError,
		},
	};
}

describe("InputController keybinding setup", () => {
	it("registers model selector and display reset actions separately", async () => {
		const { InputController, ctx, editor, spies } = await createContext();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();

		expect(spies.setActionKeys).toHaveBeenCalledWith("app.display.reset", ["ctrl+l"]);
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
		expect(spies.resetDisplay).toHaveBeenCalledTimes(1);
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
		const { InputController, ctx, editor, spies } = await createContext();
		const focusedRetry = vi.fn(async () => true);
		(ctx as unknown as { focusedAgentId: string; viewSession: { retry: typeof focusedRetry } }).focusedAgentId =
			"worker";
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
		(ctx.canBranchBtw as unknown as { mockReturnValue(value: boolean): void }).mockReturnValue(true);
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
		(ctx.canBranchBtw as unknown as { mockReturnValue(value: boolean): void }).mockReturnValue(true);
		editor.setText("build a branch");
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		const listener = spies.addInputListener.mock.calls[1]?.[0];
		expect(listener).toBeDefined();
		const result = listener?.("b");

		expect(result).toBeUndefined();
		expect(spies.handleBtwBranchKey).not.toHaveBeenCalled();
	});

	it("lets b fall through when /btw is not branchable", async () => {
		const { InputController, ctx, spies } = await createContext();
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
		(ctx.canBranchBtw as unknown as { mockReturnValue(value: boolean): void }).mockReturnValue(true);
		setFocused({ pasteText: vi.fn() });
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		const result = dispatchInput(registeredInputListeners(spies.addInputListener), "b");

		expect(result).toBeUndefined();
		expect(spies.handleBtwBranchKey).not.toHaveBeenCalled();
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

	it("empty Enter aborts the active stream when queued messages are pending", async () => {
		const { InputController, ctx, editor, spies } = await createContext();
		const session = ctx.session as unknown as { isStreaming: boolean; queuedMessageCount: number };
		session.isStreaming = true;
		session.queuedMessageCount = 1;
		const controller = new InputController(ctx);

		controller.setupEditorSubmitHandler();
		await editor.onSubmit?.("");

		expect(spies.abort).toHaveBeenCalledWith({ reason: "Interrupted by user" });
		expect(spies.updatePendingMessagesDisplay).toHaveBeenCalledTimes(1);
		expect(spies.requestRender).toHaveBeenCalledTimes(1);
		expect(spies.prompt).not.toHaveBeenCalled();
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
});
