import { beforeAll, describe, expect, it, vi } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

/**
 * An inline `/loop <duration> <prompt>` goes out through the normal submit path
 * even while a turn is streaming, so it is steered in *with its attachments*.
 *
 * Withholding it for the first interval tick instead would consume the command
 * and strand its images in the composer, where `/loop` has already cleared the
 * `[Image #N]` markers that keep them alive (InputController#compactDraftImages
 * drops images no marker references). This covers the dispatcher → controller
 * hop; the returned-prompt contract itself is covered in the mode's own tests.
 */
function createContext(opts: { isStreaming: boolean }) {
	let editorText = "";
	const prompt = vi.fn(async (_text: string, _options?: unknown) => {});
	const handleLoopCommand = vi.fn(
		async (args?: string) =>
			// Mirrors InteractiveMode: the residual after the limit token is handed
			// back for a normal first submission.
			args?.split(" ").slice(1).join(" ") || undefined,
	);
	const setLoopPrompt = vi.fn();
	const editor = {
		setText(text: string) {
			editorText = text;
		},
		setCollapsedText(text: string) {
			editorText = text;
		},
		getText: () => editorText,
		getExpandedText: () => editorText,
		clearDraft: vi.fn(),
		addToHistory: vi.fn(),
		pendingImages: [] as ImageContent[],
		pendingImageLinks: [] as (string | undefined)[],
		imageLinks: undefined as (string | undefined)[] | undefined,
	};
	const ctx = {
		editor,
		ui: { requestRender: vi.fn() },
		skillCommands: new Map(),
		fileSlashCommands: new Set<string>(),
		session: {
			isStreaming: opts.isStreaming,
			isCompacting: false,
			isBashRunning: false,
			isEvalRunning: false,
			extensionRunner: undefined,
			customCommands: [],
			promptTemplates: [],
			prompt,
			maybeStartTitleGeneration: vi.fn(),
		},
		get viewSession() {
			return (this as typeof ctx).session;
		},
		handleLoopCommand,
		setLoopPrompt,
		loopModeEnabled: false,
		isBashMode: false,
		isPythonMode: false,
		compactionQueuedMessages: [],
		locallySubmittedUserSignatures: new Set<string>(),
		withLocalSubmission: async (_text: string, run: () => Promise<unknown>) => {
			await run();
		},
		updateEditorBorderColor: vi.fn(),
		updatePendingMessagesDisplay: vi.fn(),
		showError: vi.fn(),
		showWarning: vi.fn(),
		queueCompactionMessage: vi.fn(),
	} as unknown as InteractiveModeContext;
	return { ctx, editor, prompt, handleLoopCommand, setLoopPrompt };
}

beforeAll(async () => {
	await Settings.init({ inMemory: true });
});

describe("inline /loop submission", () => {
	it("steers a busy inline /loop's prompt in with its attachment", async () => {
		const { ctx, editor, prompt, handleLoopCommand } = createContext({
			isStreaming: true,
		});
		const image = {
			type: "image",
			data: "aGk=",
			mimeType: "image/png",
		} as unknown as ImageContent;
		editor.pendingImages = [image];
		editor.pendingImageLinks = [undefined];
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();
		// The composer puts an `[Image #N]` marker in the text when an image is
		// attached; that marker is what keeps the image alive through
		// #compactDraftImages at submit time.
		await (
			editor as unknown as { onSubmit?: (text: string) => Promise<void> }
		).onSubmit?.("/loop 30s look at this [Image #1]");

		expect(handleLoopCommand).toHaveBeenCalledWith(
			"30s look at this [Image #1]",
		);
		// The prompt reaches the live turn as a steer, carrying the image that was
		// submitted with the command — not text-only, and not withheld.
		expect(prompt).toHaveBeenCalledTimes(1);
		expect(prompt.mock.calls[0]?.[0]).toBe("look at this [Image #1]");
		expect(prompt.mock.calls[0]?.[1]).toMatchObject({
			streamingBehavior: "steer",
			images: [image],
		});
		// Consumed from the composer by that submission.
		expect(editor.pendingImages).toEqual([]);
	});
});
