import { describe, expect, it, vi } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";

function createContext(options?: {
	queuedMessageCount?: number;
	pendingImages?: ImageContent[];
	pendingImageLinks?: (string | undefined)[];
}) {
	let editorText = "";
	const abort = vi.fn(async () => {});
	const prompt = vi.fn(async () => {});
	const updatePendingMessagesDisplay = vi.fn();
	const requestRender = vi.fn();
	const showError = vi.fn();
	const ctx = {
		editor: {
			imageLinks: undefined as (string | undefined)[] | undefined,
			setText(text: string) {
				editorText = text;
			},
			// The stub skips chip collapsing so assertions read the wire-format text.
			setCollapsedText(text: string) {
				editorText = text;
			},
			getText() {
				return editorText;
			},
			addToHistory: vi.fn(),
			pendingImages: options?.pendingImages ? [...options.pendingImages] : ([] as ImageContent[]),
			pendingImageLinks:
				options?.pendingImageLinks ??
				options?.pendingImages?.map(() => undefined) ??
				([] as (string | undefined)[]),
		},
		ui: { requestRender },
		session: {
			isStreaming: true,
			isCompacting: false,
			isBashRunning: false,
			isEvalRunning: false,
			queuedMessageCount: options?.queuedMessageCount ?? 1,
			extensionRunner: undefined,
			abort,
			prompt,
		},
		get viewSession() {
			return (this as typeof ctx).session;
		},
		compactionQueuedMessages: [],
		locallySubmittedUserSignatures: new Set<string>(),
		isBashMode: false,
		isPythonMode: false,
		loopModeEnabled: false,
		updatePendingMessagesDisplay,
		showError,
		hasActiveBtw: () => false,
		withLocalSubmission: async (_text: string, fn: () => Promise<unknown>) => fn(),
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

	it("queues an image-only steer while streaming", async () => {
		// An image-only draft is a bare marker: the composer always stages the
		// chip token, which expands to `[Image #1]` at submit time.
		const image: ImageContent = { type: "image", mimeType: "image/png", data: "aW1hZ2U=" };
		const { ctx, abort, prompt, updatePendingMessagesDisplay, requestRender } = createContext({
			queuedMessageCount: 0,
			pendingImages: [image],
		});
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await ctx.editor.onSubmit?.("[Image #1]");

		expect(abort).not.toHaveBeenCalled();
		expect(prompt).toHaveBeenCalledWith("[Image #1]", { streamingBehavior: "steer", images: [image] });
		expect(ctx.editor.pendingImages).toEqual([]);
		expect(ctx.editor.pendingImageLinks).toEqual([]);
		expect(updatePendingMessagesDisplay).toHaveBeenCalledTimes(1);
		expect(requestRender).toHaveBeenCalledTimes(1);
	});

	it("restores an image-only steer when streaming dispatch rejects", async () => {
		const image: ImageContent = { type: "image", mimeType: "image/png", data: "aW1hZ2U=" };
		const { ctx, abort, prompt, showError, updatePendingMessagesDisplay, requestRender } = createContext({
			queuedMessageCount: 0,
			pendingImages: [image],
			pendingImageLinks: ["local://draft.png"],
		});
		prompt.mockImplementationOnce(async () => {
			throw new Error("queue rejected");
		});
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await ctx.editor.onSubmit?.("[Image #1]");

		expect(abort).not.toHaveBeenCalled();
		expect(showError).toHaveBeenCalledWith("queue rejected");
		expect(ctx.editor.getText()).toBe("[Image #1]");
		expect(ctx.editor.pendingImages).toEqual([image]);
		expect(ctx.editor.pendingImageLinks).toEqual(["local://draft.png"]);
		expect(ctx.editor.imageLinks).toEqual(["local://draft.png"]);
		expect(updatePendingMessagesDisplay).toHaveBeenCalledTimes(1);
		expect(requestRender).toHaveBeenCalledTimes(1);
	});

	it("queues an image-only steer instead of aborting when messages are already queued", async () => {
		const image: ImageContent = { type: "image", mimeType: "image/png", data: "aW1hZ2U=" };
		const { ctx, abort, prompt } = createContext({ queuedMessageCount: 1, pendingImages: [image] });
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await ctx.editor.onSubmit?.("[Image #1]");

		expect(abort).not.toHaveBeenCalled();
		expect(prompt).toHaveBeenCalledWith("[Image #1]", { streamingBehavior: "steer", images: [image] });
	});

	it("drops a pending image whose marker was deleted and aborts as an empty submit", async () => {
		// Deleting the chip token removes the attachment: an empty submit with a
		// token-less pending image behaves like a plain empty submit (abort path).
		const image: ImageContent = { type: "image", mimeType: "image/png", data: "aW1hZ2U=" };
		const { ctx, abort, prompt } = createContext({ queuedMessageCount: 1, pendingImages: [image] });
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await ctx.editor.onSubmit?.("");

		expect(prompt).not.toHaveBeenCalled();
		expect(abort).toHaveBeenCalledWith({ reason: USER_INTERRUPT_LABEL });
		expect(ctx.editor.pendingImages).toEqual([]);
	});
});
