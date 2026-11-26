import { describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { Composer } from "../src/ui/composer/composer";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
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

function createContext(sessionOverride?: InteractiveModeContext["session"]) {
	const steer = vi.fn(async (_text: string, _images?: unknown) => {});
	const prompt = vi.fn(async () => {});
	const updatePendingMessagesDisplay = vi.fn();
	const showError = vi.fn();
	const flushPendingExecRuns = vi.fn();

	const editor = new Composer();
	const addToHistory = vi.spyOn(editor, "addToHistory");

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
			queuedMessageCount: 0,
			customCommands: [],
			promptTemplates: [],
			getQueuedMessages: () => ({ steering: [], followUp: [] }),
		} as unknown as InteractiveModeContext["session"]);

	const ctx = {
		composer: editor,
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
		flushPendingExecRuns,
		showError,
		isBashMode: false,
		isPythonMode: false,
	} as unknown as InteractiveModeContext;

	return {
		ctx,
		editor,
		spies: { steer, prompt, updatePendingMessagesDisplay, showError, addToHistory },
	};
}

describe("InputController orphaned submit", () => {
	it("starts an idle submit with no input waiter instead of queueing it forever", async () => {
		const { ctx, editor, spies } = createContext();
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		editor.onSubmit?.("do not lose me");

		await controller.waitForSubmissionDispatches();

		expect(spies.prompt).toHaveBeenCalledWith("do not lose me", {
			streamingBehavior: "steer",
			images: undefined,
		});
		expect(spies.steer).not.toHaveBeenCalled();
		// Delivery protection: the prompted message is marked as locally submitted.
		expect(ctx.locallySubmittedUserSignatures.has("do not lose me\u00000")).toBe(true);
		expect(spies.updatePendingMessagesDisplay).toHaveBeenCalled();
		expect(spies.addToHistory).toHaveBeenCalledWith("do not lose me");
	});

	it("reports a dispatch exception in the UI, preserves the draft and accepts the next Enter", async () => {
		const { ctx, editor, spies } = createContext();
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();
		vi.spyOn(ctx, "flushPendingExecRuns").mockImplementationOnce(() => {
			throw new Error("Could not flush pending commands");
		});
		editor.setText("check my draft");
		editor.submit();
		await controller.waitForSubmissionDispatches();

		expect(editor.text()).toBe("check my draft");
		expect(spies.showError).toHaveBeenCalledWith("Could not flush pending commands");
		expect(spies.prompt).not.toHaveBeenCalled();
		editor.submit();
		await controller.waitForSubmissionDispatches();
		expect(spies.prompt).toHaveBeenCalledTimes(1);
		expect(editor.text()).toBe("");
	});

	it("starts a real idle session even when steer drain would be non-resumable", async () => {
		const tempDir = TempDir.createSync("@pi-orphan-submit-");
		let session: AgentSession | undefined;
		let authStorage: AuthStorage | undefined;
		try {
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected built-in anthropic model to exist");
			authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
			authStorage.keys.setRuntime("anthropic", "test-key");
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

			editor.onSubmit?.("wake from orphan state");

			await controller.waitForSubmissionDispatches();

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
		(ctx.composer.pendingImages as unknown[]).push(image);
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		editor.onSubmit?.("look at this [Image #1]");

		await controller.waitForSubmissionDispatches();

		expect(spies.prompt).toHaveBeenCalledWith("look at this [Image #1]", {
			streamingBehavior: "steer",
			images: [image],
		});
		expect(ctx.locallySubmittedUserSignatures.has("look at this [Image #1]\u00001")).toBe(true);
		expect(ctx.composer.pendingImages.length).toBe(0);
	});

	it("restores text and images to the editor when prompt dispatch rejects", async () => {
		const { ctx, editor, spies } = createContext();
		const image = { type: "image" as const, data: "abc", mimeType: "image/png" };
		(ctx.composer.pendingImages as unknown[]).push(image);
		spies.prompt.mockImplementationOnce(async () => {
			throw new Error("queue exploded");
		});
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		editor.onSubmit?.("doomed message [Image #1]");

		await controller.waitForSubmissionDispatches();

		expect(spies.showError).toHaveBeenCalledWith("queue exploded");
		// The message survives the failure: text and images return to the editor.
		expect(editor.expandedText()).toBe("doomed message [Image #1]");
		expect(ctx.composer.pendingImages).toEqual([image]);
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
		expect(editor.expandedText()).toBe("queued with image");
		expect(ctx.composer.pendingImages).toEqual([image]);
		expect(ctx.composer.pendingImageLinks).toEqual([undefined]);
	});
});
