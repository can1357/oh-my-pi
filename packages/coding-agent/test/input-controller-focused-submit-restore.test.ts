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
import { Composer } from "../src/ui/composer/composer";

function createContext(opts: { pendingImages: ImageContent[]; pendingImageLinks?: (string | undefined)[] }) {
	const prompt = vi.fn(async () => {
		throw new Error("focused dispatch rejected");
	});
	const showError = vi.fn();
	const updatePendingMessagesDisplay = vi.fn();

	const composer = new Composer();
	composer.pendingImages.push(...opts.pendingImages);
	composer.pendingImageLinks.push(...(opts.pendingImageLinks ?? opts.pendingImages.map(() => undefined)));

	const ctx = {
		composer,
		session: { isStreaming: true, isCompacting: false, extensionRunner: undefined, queuedMessageCount: 0 },
		viewSession: { isStreaming: true, queuedMessageCount: 0, prompt, abort: vi.fn(async () => {}) },
		focusedAgentId: "Worker",
		compactionQueuedMessages: [],
		locallySubmittedUserSignatures: new Set<string>(),
		showError,
		updatePendingMessagesDisplay,
		withLocalSubmission: async <T>(_text: string, fn: () => Promise<T>) => fn(),
	} as unknown as InteractiveModeContext;

	return { ctx, composer, prompt, showError };
}

describe("InputController focused submit restore-on-error", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("restores text and pending images when focused prompt rejects", async () => {
		const image: ImageContent = { type: "image", mimeType: "image/png", data: "aW1hZ2U=" };
		const { ctx, composer, prompt, showError } = createContext({
			pendingImages: [image],
			pendingImageLinks: ["local://draft.png"],
		});
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();
		// Enter took the text; the images stay for the submit handler.
		ctx.composer.onSubmit?.("look at this [Image #1]");
		await controller.waitForSubmissionDispatches();

		expect(prompt).toHaveBeenCalledTimes(1);
		expect(showError).toHaveBeenCalledWith("focused dispatch rejected");
		expect(composer.expandedText()).toBe("look at this [Image #1]");
		expect(composer.pendingImages).toEqual([image]);
		expect(composer.pendingImageLinks).toEqual(["local://draft.png"]);
	});

	it("restores image-only drafts when focused prompt rejects", async () => {
		const image: ImageContent = { type: "image", mimeType: "image/png", data: "aW1hZ2U=" };
		const { ctx, composer, prompt, showError } = createContext({ pendingImages: [image] });
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();
		ctx.composer.onSubmit?.("[Image #1]");
		await controller.waitForSubmissionDispatches();

		expect(prompt).toHaveBeenCalledTimes(1);
		expect(showError).toHaveBeenCalledWith("focused dispatch rejected");
		expect(composer.expandedText()).toBe("[Image #1]");
		expect(composer.pendingImages).toEqual([image]);
		expect(composer.pendingImageLinks).toEqual([undefined]);
	});
});
