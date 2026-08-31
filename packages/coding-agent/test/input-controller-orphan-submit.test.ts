import { describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * Regression: a submission arriving while the main loop has no input waiter
 * (`onInputCallback === undefined` — post-turn epilogue, retry backoff, or a
 * scheduled continue) and the session is neither streaming nor compacting used
 * to fall through every branch of the submit ladder. The editor clears itself
 * on Enter, so the message vanished without a trace (no queue entry, no error,
 * no transcript message).
 *
 * Contract: such a submission must start a real prompt directly, with steer
 * fallback for a concurrent background turn, and be recorded as a local
 * submission so its eventual delivery does not clobber the editor.
 */

type FakeEditor = {
	onSubmit?: (text: string) => Promise<void>;
	imageLinks?: readonly (string | undefined)[];
	pendingImages: ImageContent[];
	pendingImageLinks: (string | undefined)[];
	setText(text: string): void;
	getText(): string;
	setCollapsedText(text: string): void;
	composerChips(): unknown[];
	addToHistory(text: string): void;
	clearDraft(historyText?: string): void;
	setActionKeys(action: string, keys: string[]): void;
	setCustomKeyHandler(key: string, handler: () => void): void;
	clearCustomKeyHandlers(): void;
};

function createContext(sessionOverride?: InteractiveModeContext["session"]) {
	let editorText = "";
	const steer = vi.fn(async (_text: string, _images?: unknown) => {});
	const prompt = vi.fn(async () => {});
	const updatePendingMessagesDisplay = vi.fn();
	const requestRender = vi.fn();
	const showError = vi.fn();
	const addToHistory = vi.fn();
	const flushPendingBashComponents = vi.fn();

	const editor: FakeEditor = {
		pendingImages: [] as ImageContent[],
		pendingImageLinks: [] as (string | undefined)[],
		setText(text: string) {
			editorText = text;
		},
		getText() {
			return editorText;
		},
		setCollapsedText(text: string) {
			editorText = text;
		},
		composerChips() {
			return [];
		},
		addToHistory,
		clearDraft(historyText?: string) {
			if (historyText !== undefined) addToHistory(historyText);
			editorText = "";
			this.pendingImages = [];
			this.pendingImageLinks = [];
		},
		setActionKeys: vi.fn(),
		setCustomKeyHandler: vi.fn(),
		clearCustomKeyHandlers: vi.fn(),
	};

	const session =
		sessionOverride ??
		({
			isStreaming: false,
			isCompacting: false,
			isBashRunning: false,
			isEvalRunning: false,
			extensionRunner: undefined,
			settings: Settings.isolated({}),
			steer,
			prompt,
			maybeStartTitleGeneration: vi.fn(),
			queuedMessageCount: 0,
			customCommands: [],
			promptTemplates: [],
			getQueuedMessages: () => ({ steering: [], followUp: [] }),
		} as unknown as InteractiveModeContext["session"]);

	const ctx = {
		editor: editor as unknown as InteractiveModeContext["editor"],
		ui: { requestRender } as unknown as InteractiveModeContext["ui"],
		session,
		settings: session.settings,
		sessionManager: { getSessionName: () => "named-session" } as InteractiveModeContext["sessionManager"],
		compactionQueuedMessages: [] as InteractiveModeContext["compactionQueuedMessages"],
		skillCommands: new Map(),
		fileSlashCommands: new Set<string>(),
		locallySubmittedUserSignatures: new Set<string>(),
		isKnownSlashCommand: () => false,
		recordLocalSubmission(this: InteractiveModeContext, text: string, imageCount = 0) {
			const sig = `${text}\u0000${imageCount}`;
			this.locallySubmittedUserSignatures.add(sig);
			return () => {
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
		// No input waiter: the state under test.
		onInputCallback: undefined,
		updatePendingMessagesDisplay,
		flushPendingBashComponents,
		showError,
		isBashMode: false,
		isPythonMode: false,
	} as unknown as InteractiveModeContext;

	return {
		ctx,
		editor,
		spies: { steer, prompt, updatePendingMessagesDisplay, requestRender, showError, addToHistory },
	};
}

describe("InputController orphaned submit", () => {
	it("starts an idle submit with no input waiter instead of queueing it forever", async () => {
		const { ctx, editor, spies } = createContext();
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await editor.onSubmit?.("do not lose me");

		expect(spies.prompt).toHaveBeenCalledWith("do not lose me", {
			streamingBehavior: "steer",
			images: undefined,
		});
		expect(spies.steer).not.toHaveBeenCalled();
		// Delivery protection: the prompted message is marked as locally submitted.
		expect(ctx.locallySubmittedUserSignatures.has("do not lose me\u00000")).toBe(true);
		expect(spies.updatePendingMessagesDisplay).toHaveBeenCalled();
		expect(spies.requestRender).toHaveBeenCalled();
		expect(spies.addToHistory).toHaveBeenCalledWith("do not lose me");
	});

	it("starts a real idle session even when steer drain would be non-resumable", async () => {
		const tempDir = TempDir.createSync("@pi-orphan-submit-");
		let session: AgentSession | undefined;
		let authStorage: AuthStorage | undefined;
		try {
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected built-in anthropic model to exist");
			authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
			authStorage.setRuntimeApiKey("anthropic", "test-key");
			const agent = new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [{ role: "user", content: "stale prompt", timestamp: Date.now() }],
				},
			});
			session = new AgentSession({
				agent,
				sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
				settings: Settings.isolated({}),
				modelRegistry: new ModelRegistry(authStorage),
			});
			const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue();
			const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();
			const { ctx, editor } = createContext(session);
			const controller = new InputController(ctx);
			controller.setupEditorSubmitHandler();

			await editor.onSubmit?.("wake from orphan state");

			expect(promptSpy).toHaveBeenCalledTimes(1);
			expect(continueSpy).not.toHaveBeenCalled();
			expect(session.agent.hasQueuedMessages()).toBe(false);
		} finally {
			await session?.dispose();
			authStorage?.close();
			tempDir.removeSync();
		}
	});

	it("forwards pending images and counts them in the local-submission signature", async () => {
		const { ctx, editor, spies } = createContext();
		const image = { type: "image", data: "abc", mimeType: "image/png" };
		(ctx.editor.pendingImages as unknown[]).push(image);
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await editor.onSubmit?.("look at this [Image #1]");

		expect(spies.prompt).toHaveBeenCalledWith("look at this [Image #1]", {
			streamingBehavior: "steer",
			images: [image],
		});
		expect(ctx.locallySubmittedUserSignatures.has("look at this [Image #1]\u00001")).toBe(true);
		expect(ctx.editor.pendingImages.length).toBe(0);
	});

	it("restores text and images to the editor when prompt dispatch rejects", async () => {
		const { ctx, editor, spies } = createContext();
		const image = { type: "image" as const, data: "abc", mimeType: "image/png" };
		(ctx.editor.pendingImages as unknown[]).push(image);
		spies.prompt.mockImplementationOnce(async () => {
			throw new Error("queue exploded");
		});
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await editor.onSubmit?.("doomed message [Image #1]");

		expect(spies.showError).toHaveBeenCalledWith("queue exploded");
		// The message survives the failure: text and images return to the editor.
		expect(editor.getText()).toBe("doomed message [Image #1]");
		expect(ctx.editor.pendingImages).toEqual([image]);
		// The signature must not leak for a message that never started.
		expect(ctx.locallySubmittedUserSignatures.has("doomed message [Image #1]\u00001")).toBe(false);
	});

	it("returns queued images to the pending-image buffer on queue restore", async () => {
		const { ctx, editor } = createContext();
		const image = { type: "image" as const, data: "abc", mimeType: "image/png" };
		const session = ctx.session as unknown as { clearQueue: () => unknown };
		session.clearQueue = () => ({
			steering: [{ text: "queued with image", images: [image] }],
			followUp: [],
		});
		const controller = new InputController(ctx);

		const restored = controller.restoreQueuedMessagesToEditor();

		expect(restored).toBe(1);
		expect(editor.getText()).toBe("queued with image");
		expect(ctx.editor.pendingImages).toEqual([image]);
		expect(ctx.editor.pendingImageLinks).toEqual([undefined]);
	});
	it("skips automatic titles only for locally consumed extension commands", async () => {
		const previousNoTitle = Bun.env.PI_NO_TITLE;
		delete Bun.env.PI_NO_TITLE;
		const tempDir = TempDir.createSync("@pi-extension-title-");
		let session: AgentSession | undefined;
		let authStorage: AuthStorage | undefined;
		try {
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected built-in anthropic model to exist");
			authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
			const modelRegistry = new ModelRegistry(authStorage);
			const sessionManager = SessionManager.inMemory(tempDir.path());
			const settings = Settings.isolated({
				"compaction.enabled": false,
				"providers.tinyModel": "online",
			});
			const localHandler = vi.fn(async () => {});
			const runtime = new ExtensionRuntime();
			const extension = await loadExtensionFromFactory(
				pi => {
					pi.registerCommand("widget-status", {
						description: "Display local widget status",
						handler: localHandler,
					});
				},
				tempDir.path(),
				new EventBus(),
				runtime,
				"widget-status-test",
			);
			const extensionRunner = new ExtensionRunner(
				[extension],
				runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
				undefined,
				settings,
			);
			const agent = new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			});
			session = new AgentSession({
				agent,
				sessionManager,
				settings,
				modelRegistry,
				extensionRunner,
			});
			const titleSpy = vi.spyOn(session, "generateTitle").mockResolvedValue(null);
			const { ctx, editor } = createContext(session);
			ctx.sessionManager = sessionManager;
			ctx.settings = settings;
			const controller = new InputController(ctx);
			controller.setupEditorSubmitHandler();

			session.maybeStartTitleGeneration("/widget-status");
			expect(titleSpy).not.toHaveBeenCalled();

			await editor.onSubmit?.("/widget-status");

			expect(localHandler).toHaveBeenCalledTimes(1);
			expect(titleSpy).not.toHaveBeenCalled();
			expect(sessionManager.getSessionName()).toBeUndefined();
			expect(session.messages).toEqual([]);

			const promptSpy = vi.spyOn(session, "prompt").mockResolvedValue(true);
			for (const forwardedText of ["inspect the widgets", "/custom-prompt inspect the widgets"]) {
				titleSpy.mockClear();
				promptSpy.mockClear();

				await editor.onSubmit?.(forwardedText);

				expect(promptSpy).toHaveBeenCalledWith(forwardedText, {
					streamingBehavior: "steer",
					images: undefined,
				});
				expect(titleSpy).toHaveBeenCalledWith(forwardedText);
				// Drain the title request's .then/.finally chain so the in-flight
				// latch clears before the next submit; a request still in flight is
				// deliberately deduped (see agent-session-title-generation-dispose).
				// The chain exposes no settlement promise; sleep(0) is a macrotask
				// boundary that deterministically drains all pending microtasks —
				// not a wall-clock wait, so fake timers would not help here.
				await Bun.sleep(0);
			}
		} finally {
			vi.restoreAllMocks();
			await session?.dispose();
			authStorage?.close();
			tempDir.removeSync();
			if (previousNoTitle === undefined) {
				delete Bun.env.PI_NO_TITLE;
			} else {
				Bun.env.PI_NO_TITLE = previousNoTitle;
			}
		}
	});
});
