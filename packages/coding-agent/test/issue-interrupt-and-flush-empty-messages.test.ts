import { describe, expect, it, vi } from "bun:test";
import { InputController } from "@pk-nerdsaver-ai/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@pk-nerdsaver-ai/pi-coding-agent/modes/types";
import { USER_INTERRUPT_LABEL } from "@pk-nerdsaver-ai/pi-coding-agent/session/messages";

function createContext() {
	let editorText = "";
	const abort = vi.fn(async () => {});
	const prompt = vi.fn(async () => {});
	const updatePendingMessagesDisplay = vi.fn();
	const requestRender = vi.fn();
	const showError = vi.fn();
	const ctx = {
		editor: {
			setText(text: string) {
				editorText = text;
			},
			getText() {
				return editorText;
			},
			addToHistory: vi.fn(),
		},
		ui: { requestRender },
		session: {
			isStreaming: true,
			isCompacting: false,
			isBashRunning: false,
			isEvalRunning: false,
			queuedMessageCount: 1,
			extensionRunner: undefined,
			abort,
			prompt,
		},
		get viewSession() {
			return (this as typeof ctx).session;
		},
		pendingImages: [],
		pendingImageLinks: [],
		compactionQueuedMessages: [],
		locallySubmittedUserSignatures: new Set<string>(),
		isBashMode: false,
		isPythonMode: false,
		loopModeEnabled: false,
		updatePendingMessagesDisplay,
		showError,
		hasActiveBtw: () => false,
		hasActiveOmfg: () => false,
	} as unknown as InteractiveModeContext;
	return { ctx, abort, prompt, updatePendingMessagesDisplay, requestRender, showError };
}

describe("empty submit with queued messages", () => {
	it("aborts the active stream instead of eagerly prompting a drained queue", async () => {
		const { ctx, abort, prompt, updatePendingMessagesDisplay, requestRender, showError } = createContext();
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await ctx.editor.onSubmit?.("");

		expect(abort).toHaveBeenCalledWith({ reason: USER_INTERRUPT_LABEL });
		expect(prompt).not.toHaveBeenCalled();
		expect(showError).not.toHaveBeenCalled();
		expect(updatePendingMessagesDisplay).toHaveBeenCalledTimes(1);
		expect(requestRender).toHaveBeenCalledTimes(1);
	});

	it("serializes concurrent submits so a fast second Enter can't race the first", async () => {
		// editor.onSubmit is fire-and-forget: a fast double-Enter dispatches two
		// handlers. They must run strictly sequentially, otherwise a second (empty)
		// Enter could read queuedMessageCount before a first steer submit finished
		// registering it. We prove non-interleaving via a slow, instrumented abort.
		const { ctx, abort } = createContext();
		let release!: () => void;
		const firstAbort = new Promise<void>(r => {
			release = r;
		});
		let inFlight = 0;
		let maxInFlight = 0;
		let calls = 0;
		abort.mockImplementation(async () => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			calls++;
			if (calls === 1) await firstAbort;
			inFlight--;
		});
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		const first = ctx.editor.onSubmit?.("");
		const second = ctx.editor.onSubmit?.("");
		// The second handler must be queued behind the first, not running alongside it.
		await Promise.resolve();
		expect(maxInFlight).toBe(1);
		release();
		await Promise.all([first, second]);

		expect(maxInFlight).toBe(1);
		expect(calls).toBe(2);
	});
});
