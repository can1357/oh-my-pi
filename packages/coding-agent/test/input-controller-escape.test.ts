import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { SpaceHoldGesture } from "@oh-my-pi/pi-tui/space-hold";
import type { InteractiveModeContext, SubmittedUserInput } from "@oh-my-pi/pi-coding-agent/modes/types";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { vocalizer } from "@oh-my-pi/pi-coding-agent/tts/vocalizer";
import * as logger from "@oh-my-pi/pi-utils/logger";
import type { FileSlashCommand } from "@oh-my-pi/pi-coding-agent/extensibility/slash-commands";

import { cfgDoubleEscapeAction } from "@oh-my-pi/pi-coding-agent/modes/settings";

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
	onPasteImage?: () => void;
	onCopyPrompt?: () => void;
	onDequeue?: () => void;
	onChange?: (text: string) => void;
	setText(text: string): void;
	setCollapsedText(text: string): void;
	getText(): string;
	getExpandedText(): string;
	clearDraft(historyText?: string): void;
	addToHistory(text: string): void;
	setActionKeys(action: string, keys: string[]): void;
	setCustomKeyHandler(key: string, handler: () => void): void;
	clearCustomKeyHandlers(): void;
	spaceHold: SpaceHoldGesture;
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
		stopAwaitingAsyncWork: Spy;
		updatePendingMessagesDisplay: Spy;
		isAwaitingAsyncWork: Mock<() => boolean>;
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
	const handleBtwCommand = vi.fn(async () => true);
	const handleBtwEscape = vi.fn(() => true);
	const hasActiveBtw = vi.fn(() => false);
	const handleOmfgEscape = vi.fn(() => true);
	const hasActiveOmfg = vi.fn(() => false);
	const handleCleanseEscape = vi.fn(() => true);
	const hasActiveCleanse = vi.fn(() => false);
	const updatePendingMessagesDisplay = vi.fn();
	const prompt = vi.fn();
	const isAwaitingAsyncWork = vi.fn(() => false);
	const stopAwaitingAsyncWork = vi.fn(async () => {});
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
		setCollapsedText(text: string) {
			editorText = text;
		},
		getText() {
			return editorText;
		},
		getExpandedText() {
			return editorText;
		},
		clearDraft(historyText?: string) {
			if (historyText !== undefined) this.addToHistory(historyText);
			editorText = "";
			this.pendingImages = [];
			this.pendingImageLinks = [];
		},
		addToHistory: vi.fn(),
		setActionKeys: vi.fn(),
		setCustomKeyHandler: vi.fn(),
		clearCustomKeyHandlers: vi.fn(),
		spaceHold: new SpaceHoldGesture(() => {}),
		pendingImages: [],
		pendingImageLinks: [],
	};

	const ensureLoadingAnimation = vi.fn(() => {
		ctx.loadingAnimation = {} as InteractiveModeContext["loadingAnimation"];
	});

	const ctx = {
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
			customCommands: [],
			promptTemplates: [],
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
		eventController: {
			isAwaitingAsyncWork,
			stopAwaitingAsyncWork,
		} as unknown as InteractiveModeContext["eventController"],
		sessionManager: {
			getSessionName: () => "existing session",
			getSessionId: () => "session",
			getLeafId: () => null,
			flushSync: vi.fn(),
		} as unknown as InteractiveModeContext["sessionManager"],
		keybindings: {
			getKeys: () => [],
			matches: () => false,
		} as unknown as InteractiveModeContext["keybindings"],
		compactionQueuedMessages: [],
		mcpTestEscapeHandlers: new Set(),
		skillCommands: new Map(),
		fileSlashCommands: new Set<string>(),
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
		dictationSpaceHold: vi.fn(),
		handleBtwEscape,
		handleBtwCommand,
		hasActiveBtw,
		handleOmfgEscape,
		hasActiveOmfg,
		handleCleanseEscape,
		hasActiveCleanse,
		dismissCommandReport: vi.fn(() => false),
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
			stopAwaitingAsyncWork,
			updatePendingMessagesDisplay,
			isAwaitingAsyncWork,
		},
		inputListeners,
		sessionListeners,
	};
}

type AbortViewSession = {
	isCompacting: boolean;
	isGeneratingHandoff: boolean;
	isRetrying: boolean;
	abortCompaction: Spy;
	abortHandoff: Spy;
	abortRetry: Spy;
};

function abortViewSession(ctx: InteractiveModeContext): AbortViewSession {
	// Test harness installs a mutable fake AgentSession; keep the unchecked cast named
	// so property access is explicit.
	return ctx.viewSession as unknown as AbortViewSession;
}

type MutableSessionState = InteractiveModeContext["session"] & {
	isStreaming: boolean;
};

function mutableSessionState(ctx: InteractiveModeContext): MutableSessionState {
	// Test harness installs a mutable fake AgentSession; keep the unchecked cast named
	// so state mutations are explicit.
	return ctx.session as MutableSessionState;
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

		expect(spies.startPendingSubmission).toHaveBeenCalledWith(
			{
				text: "hello",
				images: undefined,
				imageLinks: undefined,
				streamingBehavior: "steer",
			},
			{ clearEditor: false },
		);
		expect(spies.onInputCallback).toHaveBeenCalledWith(submission);

		editor.onEscape?.();
		expect(spies.cancelPendingSubmission).toHaveBeenCalledTimes(1);
		expect(spies.clearQueue).not.toHaveBeenCalled();
		expect(spies.abort).not.toHaveBeenCalled();
	});

	it("preserves text arriving after Enter while idle submission awaits", async () => {
		const { ctx, editor, spies } = createContext();
		spies.startPendingSubmission.mockImplementation((input, options) => {
			if (!options?.preserveDraft && options?.clearEditor !== false) editor.setText("");
			return createSubmission(input);
		});
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();
		const submission = editor.onSubmit?.("first line");
		editor.setText("paste tail after Enter");
		await submission;
		expect(editor.getText()).toBe("paste tail after Enter");
		expect(spies.onInputCallback).toHaveBeenCalledTimes(1);
	});

	it("empty-submit with a queued message aborts the active stream and refreshes pending display", async () => {
		const { ctx, editor, spies } = createContext();
		// Stubbed session: only the streaming/interrupt gate fields matter here.
		const session = ctx.session as { isStreaming: boolean; hasInterruptibleInput: boolean };
		session.isStreaming = true;
		session.hasInterruptibleInput = true;
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
		await editor.onSubmit?.("/btw why is it doing that?");

		expect(spies.handleBtwCommand).toHaveBeenCalledWith("why is it doing that?", undefined);
		expect(spies.prompt).not.toHaveBeenCalled();
		expect(editor.addToHistory).toHaveBeenCalledWith("/btw why is it doing that?");
	});

	describe("side file commands", () => {
		const sitrep: FileSlashCommand = {
			name: "sitrep",
			description: "Situation report",
			content: "Situation report. Focus: $ARGUMENTS",
			side: true,
			source: "via OMP User",
		};
		const plain: FileSlashCommand = { ...sitrep, name: "plain", side: undefined };

		type SideCommandHarness = {
			fileSlashCommands: Set<string>;
			session: { isStreaming: boolean; slashCommands: FileSlashCommand[]; extensionRunner: unknown };
		};

		function withFileCommands(ctx: InteractiveModeContext, commands: FileSlashCommand[]): SideCommandHarness {
			// Test harness installs a mutable fake context and AgentSession; keep the unchecked cast named.
			const harness = ctx as unknown as SideCommandHarness;
			harness.fileSlashCommands = new Set(commands.map(cmd => cmd.name));
			harness.session.slashCommands = commands;
			return harness;
		}

		it("answers a bare side command as a /btw side question while a turn streams", async () => {
			const { ctx, editor, spies } = createContext();
			withFileCommands(ctx, [sitrep]).session.isStreaming = true;
			const controller = new InputController(ctx);

			controller.setupEditorSubmitHandler();
			editor.setText("/sitrep");
			await editor.onSubmit?.("/sitrep");

			expect(spies.handleBtwCommand).toHaveBeenCalledWith("Situation report. Focus:", undefined, "/sitrep");
			expect(spies.prompt).not.toHaveBeenCalled();
			expect(editor.addToHistory).toHaveBeenCalledWith("/sitrep");
			expect(editor.getText()).toBe("");
		});

		it("passes arguments into the side question", async () => {
			const { ctx, editor, spies } = createContext();
			withFileCommands(ctx, [sitrep]);
			const controller = new InputController(ctx);

			controller.setupEditorSubmitHandler();
			await editor.onSubmit?.("/sitrep the migration");

			expect(spies.handleBtwCommand).toHaveBeenCalledWith(
				"Situation report. Focus: the migration",
				undefined,
				"/sitrep the migration",
			);
			expect(spies.onInputCallback).not.toHaveBeenCalled();
		});

		it("sends a file command without side frontmatter to the main session", async () => {
			const { ctx, editor, spies } = createContext();
			withFileCommands(ctx, [plain]);
			const controller = new InputController(ctx);

			controller.setupEditorSubmitHandler();
			await editor.onSubmit?.("/plain");

			expect(spies.handleBtwCommand).not.toHaveBeenCalled();
			expect(spies.onInputCallback).toHaveBeenCalledTimes(1);
		});

		it("leaves a non-side command with a malformed template to the main session", async () => {
			const { ctx, editor, spies } = createContext();
			withFileCommands(ctx, [{ ...plain, content: "Report {{#if focus}} unclosed" }]);
			const controller = new InputController(ctx);

			controller.setupEditorSubmitHandler();
			await editor.onSubmit?.("/plain");

			expect(spies.handleBtwCommand).not.toHaveBeenCalled();
			expect(spies.onInputCallback).toHaveBeenCalledTimes(1);
		});

		it("reports a malformed side template and hands the submission back on Enter and Ctrl+Enter", async () => {
			const { ctx, editor, spies } = createContext();
			withFileCommands(ctx, [{ ...sitrep, content: "Report {{#if focus}} unclosed" }]);
			const showError = vi.fn();
			Object.assign(ctx, { showError });
			const controller = new InputController(ctx);

			controller.setupEditorSubmitHandler();
			await editor.onSubmit?.("/sitrep the migration");
			expect(editor.getText()).toBe("/sitrep the migration");

			editor.setText("/sitrep again");
			await controller.handleFollowUp();
			expect(editor.getText()).toBe("/sitrep again");

			expect(showError).toHaveBeenCalledTimes(2);
			expect(spies.handleBtwCommand).not.toHaveBeenCalled();
			expect(spies.onInputCallback).not.toHaveBeenCalled();
			expect(editor.addToHistory).not.toHaveBeenCalled();
		});

		it("lets a skill win over a side file command registered under its /skill: name", async () => {
			const { ctx, editor, spies } = createContext();
			withFileCommands(ctx, [{ ...sitrep, name: "skill:foo" }]);
			(ctx.skillCommands as Map<string, unknown>).set("skill:foo", {});
			const queueCompactionMessage = compacting(ctx);
			const controller = new InputController(ctx);

			controller.setupEditorSubmitHandler();
			await editor.onSubmit?.("/skill:foo");
			editor.setText("/skill:foo");
			await controller.handleFollowUp();

			expect(spies.handleBtwCommand).not.toHaveBeenCalled();
			expect(queueCompactionMessage.mock.calls.map(call => call[0])).toEqual(["/skill:foo", "/skill:foo"]);
		});

		it("lets an extension command of the same name win over a side file command", async () => {
			const { ctx, editor, spies } = createContext();
			withFileCommands(ctx, [sitrep]).session.extensionRunner = {
				getCommand: (name: string) => (name === "sitrep" ? { name } : undefined),
				hasHandlers: () => false,
			};
			Object.assign(editor, { clearDraft: vi.fn() });
			const controller = new InputController(ctx);

			controller.setupEditorSubmitHandler();
			await editor.onSubmit?.("/sitrep");

			expect(spies.handleBtwCommand).not.toHaveBeenCalled();
			expect(spies.prompt).toHaveBeenCalledWith("/sitrep", { images: undefined });
		});

		const image: ImageContent = { type: "image", data: "aGk=", mimeType: "image/png" };

		function compacting(ctx: InteractiveModeContext): Spy {
			// Test harness installs a mutable fake context and AgentSession; keep the unchecked cast named.
			const harness = ctx as unknown as { session: { isCompacting: boolean }; queueCompactionMessage: Spy };
			harness.session.isCompacting = true;
			harness.queueCompactionMessage = vi.fn();
			return harness.queueCompactionMessage;
		}

		it("answers a Ctrl+Enter side command during compaction instead of queueing it as a prompt", async () => {
			const { ctx, editor, spies } = createContext();
			withFileCommands(ctx, [sitrep]);
			const queueCompactionMessage = compacting(ctx);
			const controller = new InputController(ctx);

			editor.setText("/sitrep the migration");
			await controller.handleFollowUp();

			expect(spies.handleBtwCommand).toHaveBeenCalledWith(
				"Situation report. Focus: the migration",
				undefined,
				"/sitrep the migration",
			);
			expect(queueCompactionMessage).not.toHaveBeenCalled();
			expect(editor.getText()).toBe("");
		});

		it("still queues Ctrl+Enter non-side and builtin-named commands during compaction", async () => {
			const { ctx, editor, spies } = createContext();
			withFileCommands(ctx, [plain, { ...sitrep, name: "compact" }]);
			const queueCompactionMessage = compacting(ctx);
			const controller = new InputController(ctx);

			editor.setText("/plain");
			await controller.handleFollowUp();
			editor.setText("/compact");
			await controller.handleFollowUp();

			expect(spies.handleBtwCommand).not.toHaveBeenCalled();
			expect(queueCompactionMessage.mock.calls.map(call => call[0])).toEqual(["/plain", "/compact"]);
		});

		it("answers an Enter side command during compaction instead of queueing it", async () => {
			const { ctx, editor, spies } = createContext();
			withFileCommands(ctx, [sitrep]);
			const queueCompactionMessage = compacting(ctx);
			const controller = new InputController(ctx);

			controller.setupEditorSubmitHandler();
			await editor.onSubmit?.("/sitrep");

			expect(spies.handleBtwCommand).toHaveBeenCalledWith("Situation report. Focus:", undefined, "/sitrep");
			expect(queueCompactionMessage).not.toHaveBeenCalled();
		});

		it("routes a namespaced side command by its full name", async () => {
			const { ctx, editor, spies } = createContext();
			withFileCommands(ctx, [{ ...sitrep, name: "acme:sitrep" }]);
			const controller = new InputController(ctx);

			controller.setupEditorSubmitHandler();
			await editor.onSubmit?.("/acme:sitrep the migration");

			expect(spies.handleBtwCommand).toHaveBeenCalledWith(
				"Situation report. Focus: the migration",
				undefined,
				"/acme:sitrep the migration",
			);
			expect(spies.onInputCallback).not.toHaveBeenCalled();
		});

		it("does not carry an Enter side command's attached image into the next submission", async () => {
			const { ctx, editor, spies } = createContext();
			withFileCommands(ctx, [sitrep]);
			editor.pendingImages = [image];
			editor.pendingImageLinks = [undefined];
			const controller = new InputController(ctx);

			controller.setupEditorSubmitHandler();
			await editor.onSubmit?.("/sitrep [Image #1]");
			expect(spies.handleBtwCommand).toHaveBeenCalledTimes(1);
			expect(editor.pendingImages).toEqual([]);

			await editor.onSubmit?.("next message");
			expect(spies.startPendingSubmission).toHaveBeenCalledWith(
				expect.objectContaining({ text: "next message", images: undefined }),
				expect.anything(),
			);
		});

		it("keeps text typed while an input hook delays a side command", async () => {
			const { ctx, editor, spies } = createContext();
			withFileCommands(ctx, [sitrep]).session.extensionRunner = {
				getCommand: () => undefined,
				hasHandlers: (event: string) => event === "input",
				emitInput: vi.fn(async () => {
					editor.setText("typed while the hook ran");
					return undefined;
				}),
			};
			editor.pendingImages = [image];
			editor.pendingImageLinks = [undefined];
			const controller = new InputController(ctx);

			controller.setupEditorSubmitHandler();
			await editor.onSubmit?.("/sitrep [Image #1]");

			expect(spies.handleBtwCommand).toHaveBeenCalledTimes(1);
			expect(editor.getText()).toBe("typed while the hook ran");
			expect(editor.pendingImages).toEqual([]);
		});
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

	it("suspends a streaming loop iteration and pauses the loop", () => {
		const { ctx, editor, spies } = createContext();
		const pauseLoop = vi.fn();
		ctx.loopModeEnabled = true;
		ctx.pauseLoop = pauseLoop;
		mutableSessionState(ctx).isStreaming = true;
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(spies.abort).toHaveBeenCalledWith({ reason: USER_INTERRUPT_LABEL });
		expect(pauseLoop).toHaveBeenCalledTimes(1);
		expect(spies.cancelPendingSubmission).toHaveBeenCalledTimes(1);
	});

	it("pauses an idle loop and cancels its pending submission", () => {
		const { ctx, editor, spies } = createContext();
		const pauseLoop = vi.fn();
		ctx.loopModeEnabled = true;
		ctx.pauseLoop = pauseLoop;
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(pauseLoop).toHaveBeenCalledTimes(1);
		expect(spies.cancelPendingSubmission).toHaveBeenCalledTimes(1);
		expect(spies.abort).not.toHaveBeenCalled();
	});

	it("hands a queued compaction back when Esc cancels a loop iteration still in setup", () => {
		const { ctx, editor } = createContext();
		ctx.loopModeEnabled = true;
		ctx.pauseLoop = vi.fn();
		// Prompt setup: the session counts as streaming, but no agent turn (and so no agent_end) exists yet.
		mutableSessionState(ctx).isStreaming = true;
		ctx.yieldCompaction = { text: "/compact", sessionId: "session", leafId: null };
		ctx.compactionQueuedMessages.push({ text: "held behind it", mode: "followUp" });
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(ctx.yieldCompaction).toBeUndefined();
		expect(ctx.compactionQueuedMessages).toEqual([]);
		expect(editor.getText()).toContain("/compact");
		expect(editor.getText()).toContain("held behind it");
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

	it("keeps every overlapping /mcp test cancellable and consumes ownership on dispatch", () => {
		const { ctx, editor, spies } = createContext();
		mutableSessionState(ctx).isStreaming = true;
		const firstTestEscapeHandler = vi.fn();
		const latestTestEscapeHandler = vi.fn();
		ctx.mcpTestEscapeHandlers.add(firstTestEscapeHandler);
		ctx.mcpTestEscapeHandlers.add(latestTestEscapeHandler);
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(firstTestEscapeHandler).toHaveBeenCalledTimes(1);
		expect(latestTestEscapeHandler).toHaveBeenCalledTimes(1);
		expect(spies.abort).not.toHaveBeenCalled();
		// One press consumes the ownership: the next Esc must reach the stream
		// abort below instead of being swallowed by stale registrations.
		expect(ctx.mcpTestEscapeHandlers.size).toBe(0);

		editor.onEscape?.();

		expect(firstTestEscapeHandler).toHaveBeenCalledTimes(1);
		expect(latestTestEscapeHandler).toHaveBeenCalledTimes(1);
		expect(spies.abort).toHaveBeenCalledTimes(1);
		expect(spies.abort).toHaveBeenCalledWith({ reason: USER_INTERRUPT_LABEL });
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

	it("dismisses an active /btw panel before aborting loop mode", () => {
		const { ctx, editor, spies } = createContext();
		ctx.loopModeEnabled = true;
		mutableSessionState(ctx).isStreaming = true;
		spies.hasActiveBtw.mockReturnValue(true);
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(spies.handleBtwEscape).toHaveBeenCalledTimes(1);
		expect(spies.abort).not.toHaveBeenCalled();
		expect(ctx.loopModeEnabled).toBe(true);
	});

	it("dismisses an active /btw panel before aborting maintenance", () => {
		const { ctx, editor, spies } = createContext();
		abortViewSession(ctx).isGeneratingHandoff = true;
		spies.hasActiveBtw.mockReturnValue(true);
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(spies.handleBtwEscape).toHaveBeenCalledTimes(1);
		expect(spies.abortHandoff).not.toHaveBeenCalled();
		expect(spies.abort).not.toHaveBeenCalled();
	});

	it("aborts an active streaming turn on the first Esc without asking for confirmation", () => {
		const { ctx, editor, spies } = createContext();
		mutableSessionState(ctx).isStreaming = true;
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(spies.abort).toHaveBeenCalledTimes(1);
		expect(spies.abort).toHaveBeenCalledWith({ reason: USER_INTERRUPT_LABEL });
		expect(spies.showStatus).not.toHaveBeenCalledWith("Press Esc again within 2s to cancel streaming.");
	});

	it("aborts the submitted turn on the first Esc once the main session starts streaming", async () => {
		const { ctx, editor, spies } = createContext();
		const submission = createSubmission({ text: "fix issue #4921" });
		spies.startPendingSubmission.mockReturnValue(submission);
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		controller.setupEditorSubmitHandler();
		await editor.onSubmit?.("fix issue #4921");
		mutableSessionState(ctx).isStreaming = true;
		ctx.loadingAnimation = undefined;

		editor.onEscape?.();

		expect(spies.cancelPendingSubmission).not.toHaveBeenCalled();
		expect(spies.abort).toHaveBeenCalledTimes(1);
		expect(spies.abort).toHaveBeenCalledWith({ reason: USER_INTERRUPT_LABEL });
		expect(spies.showStatus).not.toHaveBeenCalledWith("Press Esc again within 2s to cancel streaming.");
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

	it("logs abort failures while treating maintenance Esc as handled", () => {
		const debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => {});
		const { ctx, editor, spies } = createContext();
		const viewSession = abortViewSession(ctx);
		viewSession.isCompacting = true;
		viewSession.isGeneratingHandoff = true;
		viewSession.isRetrying = true;
		viewSession.abortCompaction = vi.fn(() => {
			throw new Error("compaction boom");
		});
		viewSession.abortHandoff = vi.fn(() => {
			throw new Error("handoff boom");
		});
		viewSession.abortRetry = vi.fn(() => {
			throw new Error("retry boom");
		});
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(viewSession.abortCompaction).toHaveBeenCalledTimes(1);
		expect(viewSession.abortHandoff).toHaveBeenCalledTimes(1);
		expect(viewSession.abortRetry).toHaveBeenCalledTimes(1);
		expect(debugSpy).toHaveBeenCalledWith("Failed to abort compaction", { error: "compaction boom" });
		expect(debugSpy).toHaveBeenCalledWith("Failed to abort handoff", { error: "handoff boom" });
		expect(debugSpy).toHaveBeenCalledWith("Failed to abort retry", { error: "retry boom" });
		expect(spies.abort).not.toHaveBeenCalled();
	});

	it("routes a focused double-← through the global input listener like Esc", () => {
		const now = vi.spyOn(Date, "now");
		const { ctx, inputListeners } = createContext();
		Object.defineProperty(ctx, "focusedAgentId", { value: "Worker", configurable: true });
		ctx.lastLeftTapTime = 0;
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		now.mockReturnValue(2_000);
		// Dispatch like the TUI: listeners in registration order until one handles the input.
		const dispatch = (data: string) => {
			for (const listener of inputListeners) {
				const result = listener(data);
				if (result) return result;
			}
			return undefined;
		};
		const first = dispatch("\x1b[D");
		now.mockReturnValue(2_200); // 200ms later — a deliberate second tap
		const second = dispatch("\x1b[D");

		// Both taps are consumed; only the second completes the gesture.
		expect(first).toEqual({ consume: true });
		expect(second).toEqual({ consume: true });
		expect(ctx.unfocusSession).toHaveBeenCalledTimes(1);
		expect(ctx.focusParentSession).not.toHaveBeenCalled();
	});
	it("opens the rewind selector and forces a viewport repaint on default double-Esc", () => {
		const { ctx, editor, spies } = createContext();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();
		editor.onEscape?.();

		expect(ctx.showUserMessageSelector).toHaveBeenCalledTimes(1);
		expect(ctx.showTreeSelector).not.toHaveBeenCalled();
		// Never `resetDisplay()`: that replays the whole transcript and wedges
		// double-Esc on long sessions (invisible selector behind a multi-second
		// scrollback replay).
		expect(spies.requestRender).toHaveBeenCalledWith(true);
		expect(spies.resetDisplay).not.toHaveBeenCalled();
	});

	it("ends a wait on background jobs on the first Esc instead of arming the rewind selector", () => {
		const { ctx, editor, spies } = createContext();
		spies.isAwaitingAsyncWork.mockReturnValue(true);
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(spies.stopAwaitingAsyncWork).toHaveBeenCalledTimes(1);
		expect(ctx.showUserMessageSelector).not.toHaveBeenCalled();

		// The wait is over: Esc goes back to its idle meaning, a fresh double-Esc.
		spies.isAwaitingAsyncWork.mockReturnValue(false);
		editor.onEscape?.();
		expect(ctx.showUserMessageSelector).not.toHaveBeenCalled();
		editor.onEscape?.();
		expect(ctx.showUserMessageSelector).toHaveBeenCalledTimes(1);
		expect(spies.stopAwaitingAsyncWork).toHaveBeenCalledTimes(1);
	});

	it("cancels a prompt submitted during a background-job wait before ending the wait", () => {
		const { ctx, editor, spies } = createContext();
		ctx.loadingAnimation = {} as InteractiveModeContext["loadingAnimation"];
		spies.isAwaitingAsyncWork.mockReturnValue(true);
		spies.cancelPendingSubmission.mockReturnValue(true);
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(spies.cancelPendingSubmission).toHaveBeenCalledTimes(1);
		expect(spies.stopAwaitingAsyncWork).not.toHaveBeenCalled();
		expect(spies.abort).not.toHaveBeenCalled();
	});

	it("aborts a running `!` command before ending a background-job wait", () => {
		const { ctx, editor, spies } = createContext();
		ctx.loadingAnimation = {} as InteractiveModeContext["loadingAnimation"];
		Object.defineProperty(ctx.session, "isBashRunning", { value: true, configurable: true });
		spies.isAwaitingAsyncWork.mockReturnValue(true);
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(spies.abortBash).toHaveBeenCalledTimes(1);
		expect(spies.stopAwaitingAsyncWork).not.toHaveBeenCalled();
		expect(spies.abort).not.toHaveBeenCalled();
	});

	it("ignores double-Esc when the action is disabled", () => {
		cfgDoubleEscapeAction.override(Settings.instance, "none");
		const { ctx, editor, spies } = createContext();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();
		editor.onEscape?.();

		expect(ctx.showUserMessageSelector).not.toHaveBeenCalled();
		expect(ctx.showTreeSelector).not.toHaveBeenCalled();
		expect(spies.resetDisplay).not.toHaveBeenCalled();
	});

	it("opens the session tree on double-Esc when the action is tree", () => {
		cfgDoubleEscapeAction.override(Settings.instance, "tree");
		const { ctx, editor, spies } = createContext();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();
		editor.onEscape?.();

		expect(ctx.showTreeSelector).toHaveBeenCalledTimes(1);
		expect(ctx.showUserMessageSelector).not.toHaveBeenCalled();
		// Same forced viewport repaint as the rewind path: without it the
		// overlay paint is deferred past the escape input grace and double-Esc
		// reads as dead on long sessions.
		expect(spies.requestRender).toHaveBeenCalledWith(true);
		expect(spies.resetDisplay).not.toHaveBeenCalled();
	});
	it("preserves typed editor text on Esc without opening selectors or aborting", () => {
		const { ctx, editor, spies } = createContext();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.setText("draft message");
		editor.onEscape?.();

		expect(editor.getText()).toBe("draft message");
		expect(spies.requestRender).not.toHaveBeenCalled();
		expect(ctx.showTreeSelector).not.toHaveBeenCalled();
		expect(ctx.showUserMessageSelector).not.toHaveBeenCalled();
		expect(spies.resetDisplay).not.toHaveBeenCalled();
		expect(spies.abort).not.toHaveBeenCalled();
	});

	it("does not treat the Esc after a text-preserving Esc as a double-Esc", () => {
		const { ctx, editor } = createContext();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.(); // empty editor: arms double-Esc timer
		editor.setText("draft");
		editor.onEscape?.(); // preserves text, must also reset the timer
		editor.setText("");
		editor.onEscape?.(); // empty again: should only re-arm, not trigger

		expect(ctx.showTreeSelector).not.toHaveBeenCalled();
		expect(ctx.showUserMessageSelector).not.toHaveBeenCalled();
	});

	it("silences TTS before aborting an overlapping agent turn (#6118)", () => {
		const clear = vi.spyOn(vocalizer, "clear").mockImplementation(() => {});
		vi.spyOn(vocalizer, "isSpeaking").mockReturnValue(true);
		const { ctx, editor, spies } = createContext();
		const pauseLoop = vi.fn();
		ctx.loopModeEnabled = true;
		ctx.pauseLoop = pauseLoop;
		mutableSessionState(ctx).isStreaming = true;
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(clear).toHaveBeenCalledTimes(1);
		expect(pauseLoop).not.toHaveBeenCalled();
		expect(spies.abort).not.toHaveBeenCalled();
	});

	it("silences a still-audible vocalizer on Esc instead of opening the tree selector (#4521)", () => {
		const clear = vi.spyOn(vocalizer, "clear").mockImplementation(() => {});
		const isSpeaking = vi.spyOn(vocalizer, "isSpeaking").mockReturnValue(true);
		const { ctx, editor, spies } = createContext();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(clear).toHaveBeenCalledTimes(1);
		expect(ctx.showTreeSelector).not.toHaveBeenCalled();
		expect(ctx.showUserMessageSelector).not.toHaveBeenCalled();
		expect(spies.resetDisplay).not.toHaveBeenCalled();

		// A second Esc after silence must NOT immediately fire the double-Esc
		// gesture — the first press consumed the arm.
		isSpeaking.mockReturnValue(false);
		editor.onEscape?.();
		expect(ctx.showTreeSelector).not.toHaveBeenCalled();
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
