import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import type { ImageContent } from "@pk-nerdsaver-ai/pi-ai";
import { resetSettingsForTest, Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { InputController } from "@pk-nerdsaver-ai/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext, SubmittedUserInput } from "@pk-nerdsaver-ai/pi-coding-agent/modes/types";
import { USER_INTERRUPT_LABEL } from "@pk-nerdsaver-ai/pi-coding-agent/session/messages";

type Spy = Mock<(...args: unknown[]) => unknown>;
type StartPendingSubmissionSpy = Mock<InteractiveModeContext["startPendingSubmission"]>;
type FakeEditor = {
	onEscape?: () => void;
	onSubmit?: (text: string) => Promise<void>;
	onClear?: () => void;
	onExit?: () => void;
	onSuspend?: () => void;
	onCycleThinkingLevel?: () => void;
	onCycleModelForward?: () => void;
	onCycleModelBackward?: () => void;
	onSelectModelTemporary?: () => void;
	onSelectModel?: () => void;
	onLeftAtStart?: () => void;
	onHistorySearch?: () => void;
	onPasteImage?: () => void;
	onCopyPrompt?: () => void;
	onExpandTools?: () => void;
	onToggleThinking?: () => void;
	onExternalEditor?: () => void;
	onDequeue?: () => void;
	onChange?: (text: string) => void;
	setText(text: string): void;
	getText(): string;
	addToHistory(text: string): void;
	setActionKeys(action: string, keys: string[]): void;
	setCustomKeyHandler(key: string, handler: () => void): void;
	clearCustomKeyHandlers(): void;
	pendingImages: ImageContent[];
	pendingImageLinks: (string | undefined)[];
};

function createSubmission(input: {
	text: string;
	images?: ImageContent[];
	imageLinks?: (string | undefined)[];
}): SubmittedUserInput {
	return {
		text: input.text,
		images: input.images,
		imageLinks: input.imageLinks,
		cancelled: false,
		started: false,
	};
}

function createContext(): {
	ctx: InteractiveModeContext;
	editor: FakeEditor;
	spies: {
		abort: Spy;
		abortBash: Spy;
		abortEval: Spy;
		abortHandoff: Spy;
		addMessageToChat: Spy;
		cancelPendingSubmission: Spy;
		clearEditor: Spy;
		clearQueue: Spy;
		flushSync: Spy;
		getQueuedMessages: Spy;
		ensureLoadingAnimation: Spy;
		handleBtwCommand: Spy;
		handleBtwEscape: Spy;
		handleOmfgEscape: Spy;
		hasActiveBtw: Spy;
		hasActiveOmfg: Spy;
		onInputCallback: Spy;
		prompt: Spy;
		requestRender: Spy;
		resetDisplay: Spy;
		shutdown: Spy;
		showStatus: Spy;
		startPendingSubmission: StartPendingSubmissionSpy;
		updatePendingMessagesDisplay: Spy;
	};
	inputListeners: Array<(data: string) => { consume?: boolean; data?: string } | undefined>;
	sessionListeners: Array<(event: { type: string }) => void>;
} {
	let editorText = "";
	const abort = vi.fn();
	const abortBash = vi.fn();
	const abortEval = vi.fn();
	const abortHandoff = vi.fn();
	const addMessageToChat = vi.fn();
	const cancelPendingSubmission = vi.fn(() => false);
	const clearQueue = vi.fn(() => ({ steering: [], followUp: [] }));
	const getQueuedMessages = vi.fn(() => ({ steering: [], followUp: [] }));
	const onInputCallback = vi.fn();
	const requestRender = vi.fn();
	const resetDisplay = vi.fn();
	const showStatus = vi.fn();
	const inputListeners: Array<(data: string) => { consume?: boolean; data?: string } | undefined> = [];
	const sessionListeners: Array<(event: { type: string }) => void> = [];
	const handleBtwCommand = vi.fn(async () => {});
	const handleBtwEscape = vi.fn(() => true);
	const hasActiveBtw = vi.fn(() => false);
	const handleOmfgEscape = vi.fn(() => true);
	const hasActiveOmfg = vi.fn(() => false);
	const updatePendingMessagesDisplay = vi.fn();
	const prompt = vi.fn();
	const startPendingSubmission = vi.fn(
		(input: { text: string; images?: ImageContent[]; imageLinks?: (string | undefined)[] }) => {
			ensureLoadingAnimation();
			return createSubmission(input);
		},
	);
	const editor: FakeEditor = {
		setText(text: string) {
			editorText = text;
		},
		getText() {
			return editorText;
		},
		addToHistory: vi.fn(),
		setActionKeys: vi.fn(),
		setCustomKeyHandler: vi.fn(),
		clearCustomKeyHandlers: vi.fn(),
		pendingImages: [],
		pendingImageLinks: [],
	};

	let ctx!: InteractiveModeContext;
	const ensureLoadingAnimation = vi.fn(() => {
		ctx.loadingAnimation = {} as InteractiveModeContext["loadingAnimation"];
	});

	ctx = {
		editor: editor as unknown as InteractiveModeContext["editor"],
		ui: {
			requestRender,
			resetDisplay,
			addInputListener: vi.fn(listener => {
				inputListeners.push(listener as (data: string) => { consume?: boolean; data?: string } | undefined);
				return () => {};
			}),
			addStartListener: vi.fn(),
		} as unknown as InteractiveModeContext["ui"],
		loadingAnimation: undefined,
		autoCompactionLoader: undefined,
		retryLoader: undefined,
		autoCompactionEscapeHandler: undefined,
		retryEscapeHandler: undefined,
		session: {
			isStreaming: false,
			isCompacting: false,
			isGeneratingHandoff: false,
			isBashRunning: false,
			isEvalRunning: false,
			queuedMessageCount: 0,
			messages: [],
			extensionRunner: undefined,
			abort,
			abortBash,
			abortEval,
			clearQueue,
			getQueuedMessages,
			prompt,
			subscribe: vi.fn((listener: (event: { type: string }) => void) => {
				sessionListeners.push(listener);
				return () => {
					const index = sessionListeners.indexOf(listener);
					if (index >= 0) sessionListeners.splice(index, 1);
				};
			}),
		} as unknown as InteractiveModeContext["session"],
		viewSession: {
			isCompacting: false,
			isGeneratingHandoff: false,
			isRetrying: false,
			abortCompaction: vi.fn(),
			abortHandoff,
			abortRetry: vi.fn(),
		} as unknown as InteractiveModeContext["viewSession"],
		sessionManager: {
			getSessionName: () => "existing session",
			flushSync: vi.fn(),
		} as unknown as InteractiveModeContext["sessionManager"],
		keybindings: {
			getKeys: () => [],
		} as unknown as InteractiveModeContext["keybindings"],
		compactionQueuedMessages: [],
		isBashMode: false,
		isPythonMode: false,
		optimisticUserMessageSignature: undefined,
		locallySubmittedUserSignatures: new Set<string>(),
		onInputCallback,
		addMessageToChat,
		cancelPendingSubmission,
		ensureLoadingAnimation,
		finishPendingSubmission: vi.fn(),
		flushPendingBashComponents: vi.fn(),
		markPendingSubmissionStarted: vi.fn(() => true),
		startPendingSubmission,
		updatePendingMessagesDisplay,
		updateEditorBorderColor: vi.fn(),
		showDebugSelector: vi.fn(),
		toggleTodoExpansion: vi.fn(),
		showAgentHub: vi.fn(),
		unfocusSession: vi.fn(async () => {}),
		focusParentSession: vi.fn(async () => {}),
		handleSTTToggle: vi.fn(),
		handleBtwEscape,
		handleBtwCommand,
		hasActiveBtw,
		handleOmfgEscape,
		hasActiveOmfg,
		showTreeSelector: vi.fn(),
		showUserMessageSelector: vi.fn(),
		showSessionSelector: vi.fn(),
		shutdown: vi.fn(async () => {}),
		clearEditor: vi.fn(),
		showStatus,
	} as unknown as InteractiveModeContext;

	return {
		ctx,
		editor,
		spies: {
			abort,
			abortBash,
			abortEval,
			abortHandoff,
			addMessageToChat,
			cancelPendingSubmission,
			clearQueue,
			clearEditor: ctx.clearEditor as Spy,
			getQueuedMessages,
			ensureLoadingAnimation,
			flushSync: ctx.sessionManager.flushSync as Spy,
			handleBtwCommand,
			handleBtwEscape,
			hasActiveBtw,
			handleOmfgEscape,
			hasActiveOmfg,
			onInputCallback,
			prompt,
			requestRender,
			resetDisplay,
			showStatus,
			shutdown: ctx.shutdown as Spy,
			startPendingSubmission,
			updatePendingMessagesDisplay,
		},
		inputListeners,
		sessionListeners,
	};
}
beforeEach(async () => {
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	vi.restoreAllMocks();
	resetSettingsForTest();
});

describe("InputController escape behavior", () => {
	it("prefers canceling a pending optimistic submission before aborting the session", async () => {
		const { ctx, editor, spies } = createContext();
		const submission = createSubmission({ text: "hello" });
		spies.startPendingSubmission.mockReturnValue(submission);
		spies.cancelPendingSubmission.mockReturnValue(true);
		ctx.loadingAnimation = {} as InteractiveModeContext["loadingAnimation"];
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		controller.setupEditorSubmitHandler();
		await editor.onSubmit?.("hello");

		expect(spies.startPendingSubmission).toHaveBeenCalledWith({
			text: "hello",
			images: undefined,
			imageLinks: undefined,
			streamingBehavior: "steer",
		});
		expect(spies.onInputCallback).toHaveBeenCalledWith(submission);

		editor.onEscape?.();
		expect(spies.cancelPendingSubmission).toHaveBeenCalledTimes(1);
		expect(spies.clearQueue).not.toHaveBeenCalled();
		expect(spies.abort).not.toHaveBeenCalled();
	});

	it("empty-submit with a queued message aborts the active stream and refreshes pending display", async () => {
		const { ctx, editor, spies } = createContext();
		(ctx.session as { isStreaming: boolean; queuedMessageCount: number }).isStreaming = true;
		(ctx.session as { isStreaming: boolean; queuedMessageCount: number }).queuedMessageCount = 1;
		const order: string[] = [];
		spies.abort.mockImplementation(async () => {
			order.push("abort");
		});
		spies.updatePendingMessagesDisplay.mockImplementation(() => {
			order.push("refresh");
		});
		const controller = new InputController(ctx);

		controller.setupEditorSubmitHandler();
		await editor.onSubmit?.("");

		expect(order).toEqual(["abort", "refresh"]);
		expect(spies.abort).toHaveBeenCalledWith({ reason: USER_INTERRUPT_LABEL });
		expect(spies.updatePendingMessagesDisplay).toHaveBeenCalledTimes(1);
		expect(spies.requestRender).toHaveBeenCalledTimes(1);
	});
	it("runs /btw as a builtin side request instead of steering the active stream", async () => {
		const { ctx, editor, spies } = createContext();
		(ctx.session as { isStreaming: boolean }).isStreaming = true;
		const controller = new InputController(ctx);

		controller.setupEditorSubmitHandler();
		editor.setText("/btw why is it doing that?");
		await editor.onSubmit?.("/btw why is it doing that?");

		expect(spies.handleBtwCommand).toHaveBeenCalledWith("why is it doing that?");
		expect(spies.prompt).not.toHaveBeenCalled();
		expect(editor.addToHistory).toHaveBeenCalledWith("/btw why is it doing that?");
		expect(editor.getText()).toBe("");
	});

	it("falls back to aborting the active session when no pending optimistic submission exists", () => {
		const { ctx, editor, spies } = createContext();
		ctx.loadingAnimation = {} as InteractiveModeContext["loadingAnimation"];
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(spies.cancelPendingSubmission).toHaveBeenCalledTimes(1);
		expect(spies.clearQueue).toHaveBeenCalledTimes(1);
		expect(spies.abort).toHaveBeenCalledTimes(1);
		// The Esc interrupt threads a user-facing reason so the aborted turn and its
		// synthetic tool results read as a deliberate interrupt, not "Request was aborted".
		expect(spies.abort).toHaveBeenCalledWith({ reason: USER_INTERRUPT_LABEL });
	});

	it("aborts active handoff generation before default Esc handling", () => {
		const { ctx, editor, spies } = createContext();
		(ctx.viewSession as { isGeneratingHandoff: boolean }).isGeneratingHandoff = true;
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(spies.abortHandoff).toHaveBeenCalledTimes(1);
		expect(ctx.showTreeSelector).not.toHaveBeenCalled();
		expect(spies.abort).not.toHaveBeenCalled();
	});

	it("prefers aborting bash before aborting an overlapping stream", () => {
		const { ctx, editor, spies } = createContext();
		(ctx.session as { isStreaming: boolean; isBashRunning: boolean }).isStreaming = true;
		(ctx.session as { isStreaming: boolean; isBashRunning: boolean }).isBashRunning = true;
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(spies.abortBash).toHaveBeenCalledTimes(1);
		expect(spies.abort).not.toHaveBeenCalled();
	});

	it("prefers aborting python before aborting an overlapping stream", () => {
		const { ctx, editor, spies } = createContext();
		(ctx.session as { isStreaming: boolean; isEvalRunning: boolean }).isStreaming = true;
		(ctx.session as { isStreaming: boolean; isEvalRunning: boolean }).isEvalRunning = true;
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(spies.abortEval).toHaveBeenCalledTimes(1);
		expect(spies.abort).not.toHaveBeenCalled();
	});

	it("dismisses an active /btw panel before aborting the main stream", () => {
		const { ctx, editor, spies } = createContext();
		(ctx.session as { isStreaming: boolean }).isStreaming = true;
		spies.hasActiveBtw.mockReturnValue(true);
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(spies.handleBtwEscape).toHaveBeenCalledTimes(1);
		expect(spies.abort).not.toHaveBeenCalled();
	});

	it("dismisses an active /btw panel before canceling a pending optimistic submission", () => {
		const { ctx, editor, spies } = createContext();
		ctx.loadingAnimation = {} as InteractiveModeContext["loadingAnimation"];
		spies.hasActiveBtw.mockReturnValue(true);
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(spies.handleBtwEscape).toHaveBeenCalledTimes(1);
		expect(spies.cancelPendingSubmission).not.toHaveBeenCalled();
		expect(spies.clearQueue).not.toHaveBeenCalled();
		expect(spies.abort).not.toHaveBeenCalled();
	});

	it("dismisses an active /btw panel before aborting bash", () => {
		const { ctx, editor, spies } = createContext();
		(ctx.session as { isBashRunning: boolean }).isBashRunning = true;
		spies.hasActiveBtw.mockReturnValue(true);
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(spies.handleBtwEscape).toHaveBeenCalledTimes(1);
		expect(spies.abortBash).not.toHaveBeenCalled();
		expect(spies.abort).not.toHaveBeenCalled();
	});

	it("requires a second Esc within two seconds to abort streaming", () => {
		const now = vi.spyOn(Date, "now");
		now.mockReturnValue(1_000);
		const { ctx, editor, spies } = createContext();
		(ctx.session as { isStreaming: boolean }).isStreaming = true;
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(spies.cancelPendingSubmission).not.toHaveBeenCalled();
		expect(spies.clearQueue).not.toHaveBeenCalled();
		expect(spies.abort).not.toHaveBeenCalled();
		expect(spies.showStatus).toHaveBeenCalledWith("Press Esc again within 2s to cancel streaming.");

		now.mockReturnValue(2_500);
		editor.onEscape?.();

		expect(spies.abort).toHaveBeenCalledTimes(1);
		expect(spies.abort).toHaveBeenCalledWith({ reason: USER_INTERRUPT_LABEL });
	});

	it("expires the streaming Esc arm instead of aborting on a late second press", () => {
		const now = vi.spyOn(Date, "now");
		now.mockReturnValue(1_000);
		const { ctx, editor, spies } = createContext();
		(ctx.session as { isStreaming: boolean }).isStreaming = true;
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();
		now.mockReturnValue(3_001);
		editor.onEscape?.();

		expect(spies.abort).not.toHaveBeenCalled();
		expect(spies.showStatus).toHaveBeenCalledTimes(2);
	});

	it("preserves the streaming Esc arm when streamingComponent appears between presses", () => {
		// Pre-`message_start`: first Esc arms on the per-turn sentinel. `message_start`
		// then publishes `ctx.streamingComponent`; the second Esc must still abort the
		// same live turn instead of re-arming on the new component reference.
		const now = vi.spyOn(Date, "now");
		now.mockReturnValue(1_000);
		const { ctx, editor, spies } = createContext();
		(ctx.session as { isStreaming: boolean }).isStreaming = true;
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();
		(ctx as unknown as { streamingComponent: object }).streamingComponent = {};
		now.mockReturnValue(1_500);
		editor.onEscape?.();

		expect(spies.abort).toHaveBeenCalledTimes(1);
		expect(spies.abort).toHaveBeenCalledWith({ reason: USER_INTERRUPT_LABEL });
	});

	it("aborts on the second Esc even when ctx.streamingMessage was replaced by a delta in between", () => {
		// `EventController` replaces `ctx.streamingMessage` with a fresh immutable
		// snapshot on every `message_update`; the per-turn sentinel is unaffected so
		// swapping the message must not invalidate the armed token.
		const now = vi.spyOn(Date, "now");
		now.mockReturnValue(1_000);
		const { ctx, editor, spies } = createContext();
		(ctx.session as { isStreaming: boolean }).isStreaming = true;
		(ctx as unknown as { streamingComponent: object }).streamingComponent = {};
		(ctx as unknown as { streamingMessage: object }).streamingMessage = { content: [] };
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();
		(ctx as unknown as { streamingMessage: object }).streamingMessage = { content: ["delta"] };
		now.mockReturnValue(1_500);
		editor.onEscape?.();

		expect(spies.abort).toHaveBeenCalledTimes(1);
		expect(spies.abort).toHaveBeenCalledWith({ reason: USER_INTERRUPT_LABEL });
	});

	it("clears the streaming Esc arm when the current turn ends", () => {
		const now = vi.spyOn(Date, "now");
		now.mockReturnValue(1_000);
		const { ctx, editor, spies, sessionListeners } = createContext();
		(ctx.session as { isStreaming: boolean }).isStreaming = true;
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		// Fallback arm (no streamingMessage/streamingComponent yet — pre-message_start).
		editor.onEscape?.();
		expect(sessionListeners).toHaveLength(1);

		// Turn 1 ends; a new turn starts. session.subscribe receives both transitions,
		// either of which must invalidate the still-armed fallback token so it cannot
		// fast-abort the new turn's first Esc.
		for (const listener of sessionListeners) {
			listener({ type: "agent_end" });
			listener({ type: "agent_start" });
		}

		now.mockReturnValue(1_500);
		editor.onEscape?.();

		expect(spies.abort).not.toHaveBeenCalled();
		expect(spies.showStatus).toHaveBeenCalledTimes(2);
	});

	it("returns focused subagent view to main on Esc instead of aborting", () => {
		const { ctx, editor, spies } = createContext();
		Object.defineProperty(ctx, "focusedAgentId", { value: "Worker", configurable: true });
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(ctx.unfocusSession).toHaveBeenCalledTimes(1);
		expect(spies.abort).not.toHaveBeenCalled();
	});

	it("returns focused subagent view to main on Esc without aborting its active maintenance (#2819)", () => {
		const { ctx, editor, spies } = createContext();
		Object.defineProperty(ctx, "focusedAgentId", { value: "Worker", configurable: true });
		(ctx.viewSession as { isCompacting: boolean }).isCompacting = true;
		(ctx.viewSession as { isGeneratingHandoff: boolean }).isGeneratingHandoff = true;
		(ctx.viewSession as { isRetrying: boolean }).isRetrying = true;
		(ctx.viewSession as unknown as { abortCompaction: Spy }).abortCompaction = vi.fn();
		(ctx.viewSession as unknown as { abortHandoff: Spy }).abortHandoff = spies.abortHandoff;
		(ctx.viewSession as unknown as { abortRetry: Spy }).abortRetry = vi.fn();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(ctx.unfocusSession).toHaveBeenCalledTimes(1);
		expect(ctx.viewSession.abortCompaction as unknown as Spy).not.toHaveBeenCalled();
		expect(spies.abortHandoff).not.toHaveBeenCalled();
		expect(ctx.viewSession.abortRetry as unknown as Spy).not.toHaveBeenCalled();
	});

	it("aborts main-view maintenance on Esc normally", () => {
		const { ctx, editor, spies } = createContext();
		// Not focused:
		expect(ctx.focusedAgentId).toBeUndefined();
		(ctx.viewSession as { isCompacting: boolean }).isCompacting = true;
		(ctx.viewSession as { isGeneratingHandoff: boolean }).isGeneratingHandoff = true;
		(ctx.viewSession as { isRetrying: boolean }).isRetrying = true;
		(ctx.viewSession as unknown as { abortCompaction: Spy }).abortCompaction = vi.fn();
		(ctx.viewSession as unknown as { abortHandoff: Spy }).abortHandoff = spies.abortHandoff;
		(ctx.viewSession as unknown as { abortRetry: Spy }).abortRetry = vi.fn();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(ctx.unfocusSession).not.toHaveBeenCalled();
		expect(ctx.viewSession.abortCompaction as unknown as Spy).toHaveBeenCalledTimes(1);
		expect(spies.abortHandoff).toHaveBeenCalledTimes(1);
		expect(ctx.viewSession.abortRetry as unknown as Spy).toHaveBeenCalledTimes(1);
	});

	it("routes a focused double-← through the global input listener like Esc", () => {
		const now = vi.spyOn(Date, "now");
		const { ctx, inputListeners } = createContext();
		Object.defineProperty(ctx, "focusedAgentId", { value: "Worker", configurable: true });
		ctx.lastLeftTapTime = 0;
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		now.mockReturnValue(2_000);
		const first = inputListeners[0]("\x1b[D");
		now.mockReturnValue(2_200); // 200ms later — a deliberate second tap
		const second = inputListeners[0]("\x1b[D");

		// Both taps are consumed; only the second completes the gesture.
		expect(first).toEqual({ consume: true });
		expect(second).toEqual({ consume: true });
		expect(ctx.unfocusSession).toHaveBeenCalledTimes(1);
		expect(ctx.focusParentSession).not.toHaveBeenCalled();
	});
	it("opens the tree selector and clears the display on default double-Esc", () => {
		const { ctx, editor, spies } = createContext();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();
		editor.onEscape?.();

		expect(ctx.showTreeSelector).toHaveBeenCalledTimes(1);
		expect(ctx.showUserMessageSelector).not.toHaveBeenCalled();
		expect(spies.resetDisplay).toHaveBeenCalledTimes(1);
	});

	it("opens the message selector and clears the display when double-Esc is configured for branch", () => {
		Settings.instance.override("doubleEscapeAction", "branch");
		const { ctx, editor, spies } = createContext();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();
		editor.onEscape?.();

		expect(ctx.showUserMessageSelector).toHaveBeenCalledTimes(1);
		expect(ctx.showTreeSelector).not.toHaveBeenCalled();
		expect(spies.resetDisplay).toHaveBeenCalledTimes(1);
	});
	it("clears typed editor text on Esc without opening selectors or aborting", () => {
		const { ctx, editor, spies } = createContext();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.setText("draft message");
		editor.onEscape?.();

		expect(editor.getText()).toBe("");
		expect(spies.requestRender).toHaveBeenCalledTimes(1);
		expect(ctx.showTreeSelector).not.toHaveBeenCalled();
		expect(ctx.showUserMessageSelector).not.toHaveBeenCalled();
		expect(spies.resetDisplay).not.toHaveBeenCalled();
		expect(spies.abort).not.toHaveBeenCalled();
	});

	it("does not treat the Esc after a text-clearing Esc as a double-Esc", () => {
		const { ctx, editor } = createContext();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.(); // empty editor: arms double-Esc timer
		editor.setText("draft");
		editor.onEscape?.(); // clears text, must also reset the timer
		editor.onEscape?.(); // empty again: should only re-arm, not trigger

		expect(ctx.showUserMessageSelector).not.toHaveBeenCalled();
	});
});

describe("InputController Ctrl+C behavior", () => {
	it("sync-flushes the session JSONL on first Ctrl+C (editor clear)", () => {
		const { ctx, editor, spies } = createContext();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onClear?.(); // first Ctrl+C: clears editor

		expect(spies.clearEditor).toHaveBeenCalledTimes(1);
		expect(spies.flushSync).toHaveBeenCalledTimes(1);
		expect(spies.shutdown).not.toHaveBeenCalled();
	});

	it("sync-flushes the session JSONL on second Ctrl+C (shutdown)", () => {
		const { ctx, editor, spies } = createContext();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onClear?.(); // first Ctrl+C
		editor.onClear?.(); // second Ctrl+C within 500ms → shutdown

		expect(spies.shutdown).toHaveBeenCalledTimes(1);
		// flushSync fires on both presses; the first-press flush is the
		// guarantee that the JSONL is on disk even if the user closes the
		// terminal before the second press.
		expect(spies.flushSync).toHaveBeenCalledTimes(2);
	});

	it("does not flush when Ctrl+C is not pressed", () => {
		const { ctx, editor, spies } = createContext();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.(); // Esc is a different handler

		expect(spies.flushSync).not.toHaveBeenCalled();
	});
});

describe("InputController double-tap ← gesture", () => {
	function setup(focusedAgentId?: string) {
		const { ctx, editor } = createContext();
		(ctx as { lastLeftTapTime: number }).lastLeftTapTime = 0;
		(ctx as { focusedAgentId?: string }).focusedAgentId = focusedAgentId;
		const controller = new InputController(ctx);
		controller.setupKeyHandlers();
		return {
			ctx,
			showAgentHub: ctx.showAgentHub as Spy,
			unfocusSession: ctx.unfocusSession as Spy,
			tap: () => editor.onLeftAtStart?.(),
		};
	}

	it("opens the Agent Hub on a deliberate double-tap", () => {
		const now = vi.spyOn(Date, "now");
		const { showAgentHub, tap } = setup();
		now.mockReturnValue(1_000);
		tap();
		now.mockReturnValue(1_200); // 200ms later — a human double-tap
		tap();
		expect(showAgentHub).toHaveBeenCalledTimes(1);
	});

	it("ignores a terminal-synthesized burst of ← arrows arriving together", () => {
		const now = vi.spyOn(Date, "now");
		const { showAgentHub, tap } = setup();
		// A "click to move cursor" burst delivers every arrow in one stdin read,
		// so all taps share the same millisecond timestamp.
		now.mockReturnValue(1_000);
		for (let i = 0; i < 6; i++) tap();
		expect(showAgentHub).not.toHaveBeenCalled();
	});

	it("ignores a second tap closer than the human-plausible minimum gap", () => {
		const now = vi.spyOn(Date, "now");
		const { showAgentHub, tap } = setup();
		now.mockReturnValue(1_000);
		tap();
		now.mockReturnValue(1_010); // 10ms later — too fast to be deliberate
		tap();
		expect(showAgentHub).not.toHaveBeenCalled();
	});

	it("returns a focused subagent view to the main session on a deliberate double-tap", () => {
		const now = vi.spyOn(Date, "now");
		const { showAgentHub, unfocusSession, tap } = setup("Agent1");
		now.mockReturnValue(1_000);
		tap();
		now.mockReturnValue(1_200);
		tap();
		expect(unfocusSession).toHaveBeenCalledTimes(1);
		expect(showAgentHub).not.toHaveBeenCalled();
	});
});
