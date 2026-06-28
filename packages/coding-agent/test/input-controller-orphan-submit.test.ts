import { describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@pk-nerdsaver-ai/pi-agent-core";
import type { ImageContent } from "@pk-nerdsaver-ai/pi-ai";
import { getBundledModel } from "@pk-nerdsaver-ai/pi-catalog/models";
import { ModelRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/config/model-registry";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { InputController } from "@pk-nerdsaver-ai/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@pk-nerdsaver-ai/pi-coding-agent/modes/types";
import { AgentSession } from "@pk-nerdsaver-ai/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@pk-nerdsaver-ai/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@pk-nerdsaver-ai/pi-coding-agent/session/session-manager";
import { TempDir } from "@pk-nerdsaver-ai/pi-utils";

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
	addToHistory(text: string): void;
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
		addToHistory,
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
			steer,
			prompt,
			queuedMessageCount: 0,
			getQueuedMessages: () => ({ steering: [], followUp: [] }),
		} as unknown as InteractiveModeContext["session"]);

	const ctx = {
		editor: editor as unknown as InteractiveModeContext["editor"],
		ui: { requestRender } as unknown as InteractiveModeContext["ui"],
		session,
		sessionManager: { getSessionName: () => "named-session" } as InteractiveModeContext["sessionManager"],
		compactionQueuedMessages: [] as InteractiveModeContext["compactionQueuedMessages"],
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

		await editor.onSubmit?.("look at this");

		expect(spies.prompt).toHaveBeenCalledWith("look at this", { streamingBehavior: "steer", images: [image] });
		expect(ctx.locallySubmittedUserSignatures.has("look at this\u00001")).toBe(true);
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

		await editor.onSubmit?.("doomed message");

		expect(spies.showError).toHaveBeenCalledWith("queue exploded");
		// The message survives the failure: text and images return to the editor.
		expect(editor.getText()).toBe("doomed message");
		expect(ctx.editor.pendingImages).toEqual([image]);
		// The signature must not leak for a message that never started.
		expect(ctx.locallySubmittedUserSignatures.has("doomed message\u00001")).toBe(false);
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
});
