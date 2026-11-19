/**
 * Regression: when an image-only or text+image submission is delivered to a
 * focused subagent (`#submitToFocusedSession`) and `viewSession.prompt`
 * rejects, the controller must restore both `text` AND `pendingImages` /
 * `pendingImageLinks`. Previously only `text` was handed back, so the pasted
 * image silently disappeared from the composer on retry.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

function createContext(opts: { pendingImages: ImageContent[]; pendingImageLinks?: (string | undefined)[] }) {
	let editorText = "";
	const prompt = vi.fn(async () => {
		throw new Error("focused dispatch rejected");
	});
	const showError = vi.fn();
	const updatePendingMessagesDisplay = vi.fn();
	const requestRender = vi.fn();

	const editor = {
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
		addToHistory: vi.fn(),
		imageLinks: undefined as (string | undefined)[] | undefined,
		pendingImages: [...opts.pendingImages],
		pendingImageLinks:
			opts.pendingImageLinks !== undefined ? [...opts.pendingImageLinks] : opts.pendingImages.map(() => undefined),
		clearDraft(historyText?: string) {
			if (historyText !== undefined) this.addToHistory(historyText);
			editorText = "";
			this.imageLinks = undefined;
			this.pendingImages = [];
			this.pendingImageLinks = [];
		},
	};

	const ctx = {
		editor,
		ui: { requestRender },
		session: { isStreaming: true, isCompacting: false, extensionRunner: undefined, queuedMessageCount: 0 },
		viewSession: { isStreaming: true, queuedMessageCount: 0, prompt, abort: vi.fn(async () => {}) },
		focusedAgentId: "Worker",
		compactionQueuedMessages: [],
		locallySubmittedUserSignatures: new Set<string>(),
		showError,
		updatePendingMessagesDisplay,
		withLocalSubmission: async <T>(_text: string, fn: () => Promise<T>) => fn(),
	} as unknown as InteractiveModeContext;

	return { ctx, editor, prompt, showError };
}

describe("InputController focused submit restore-on-error", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("restores text and pending images when focused prompt rejects", async () => {
		const image: ImageContent = { type: "image", mimeType: "image/png", data: "aW1hZ2U=" };
		const { ctx, editor, prompt, showError } = createContext({
			pendingImages: [image],
			pendingImageLinks: ["local://draft.png"],
		});
		editor.setText("look at this [Image #1]");

		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();
		await ctx.editor.onSubmit?.("look at this [Image #1]");

		expect(prompt).toHaveBeenCalledTimes(1);
		expect(showError).toHaveBeenCalledWith("focused dispatch rejected");
		expect(editor.getText()).toBe("look at this [Image #1]");
		expect(ctx.editor.pendingImages).toEqual([image]);
		expect(ctx.editor.pendingImageLinks).toEqual(["local://draft.png"]);
		expect(ctx.editor.imageLinks).toEqual(["local://draft.png"]);
	});

	it("restores image-only drafts when focused prompt rejects", async () => {
		const image: ImageContent = { type: "image", mimeType: "image/png", data: "aW1hZ2U=" };
		const { ctx, editor, prompt, showError } = createContext({ pendingImages: [image] });
		editor.setText("[Image #1]");

		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();
		await ctx.editor.onSubmit?.("[Image #1]");

		expect(prompt).toHaveBeenCalledTimes(1);
		expect(showError).toHaveBeenCalledWith("focused dispatch rejected");
		expect(editor.getText()).toBe("[Image #1]");
		expect(ctx.editor.pendingImages).toEqual([image]);
		expect(ctx.editor.pendingImageLinks).toEqual([undefined]);
		expect(ctx.editor.imageLinks).toEqual([undefined]);
	});
});
