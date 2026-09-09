import { describe, expect, it, vi } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

type FakeEditor = {
	onSubmit?: (text: string) => Promise<void>;
	imageLinks?: readonly (string | undefined)[];
	setText(text: string): void;
	getText(): string;
	addToHistory(text: string): void;
	setActionKeys(action: string, keys: string[]): void;
	setCustomKeyHandler(key: string, handler: () => void): void;
	clearCustomKeyHandlers(): void;
	pendingImages: ImageContent[];
	pendingImageLinks: (string | undefined)[];
};

function createContext() {
	let editorText = "";
	const submitted: unknown[] = [];
	const handlePythonCommand = vi.fn(async (_code: string, _isExcluded: boolean) => {});
	const handleBashCommand = vi.fn(async (_command: string, _isExcluded: boolean) => {});
	const startPendingSubmission = vi.fn((submission: unknown) => submission);
	const onInputCallback = vi.fn((submission: unknown) => submitted.push(submission));
	const prompt = vi.fn(async (_text: string, _options?: unknown) => {});

	const editor: FakeEditor = {
		setText(text) {
			editorText = text;
		},
		getText() {
			return editorText;
		},
		addToHistory: vi.fn(),
		setActionKeys: vi.fn(),
		setCustomKeyHandler: vi.fn(),
		clearCustomKeyHandlers: vi.fn(),
		pendingImages: [] as ImageContent[],
		pendingImageLinks: [] as (string | undefined)[],
	};

	const ctx = {
		editor: editor as unknown as InteractiveModeContext["editor"],
		ui: { requestRender: vi.fn() } as unknown as InteractiveModeContext["ui"],
		session: {
			isStreaming: false,
			isCompacting: false,
			isBashRunning: false,
			isEvalRunning: false,
			extensionRunner: undefined,
			maybeStartTitleGeneration: vi.fn(),
			prompt,
			queuedMessageCount: 0,
			getQueuedMessages: () => ({ steering: [], followUp: [] }),
		} as unknown as InteractiveModeContext["session"],
		sessionManager: { getSessionName: () => "named-session" } as unknown as InteractiveModeContext["sessionManager"],
		compactionQueuedMessages: [] as InteractiveModeContext["compactionQueuedMessages"],
		locallySubmittedUserSignatures: new Set<string>(),
		onInputCallback,
		startPendingSubmission,
		updatePendingMessagesDisplay: vi.fn(),
		flushPendingBashComponents: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		showError: vi.fn(),
		showWarning: vi.fn(),
		showStatus: vi.fn(),
		isBashMode: false,
		isPythonMode: false,
		fileSlashCommands: new Set<string>(),
		isKnownSlashCommand: () => false,
		handlePythonCommand,
		handleBashCommand,
		withLocalSubmission: async (_text: string, fn: () => Promise<unknown>) => fn(),
	} as unknown as InteractiveModeContext;

	return {
		ctx,
		editor,
		handlePythonCommand,
		onInputCallback,
		startPendingSubmission,
		submitted,
	};
}

describe("InputController Python prompt prefix", () => {
	it("submits leading shell-variable prose as a normal prompt", async () => {
		const { ctx, editor, handlePythonCommand, onInputCallback, startPendingSubmission, submitted } = createContext();
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await editor.onSubmit?.("$HOME is home");

		expect(handlePythonCommand).not.toHaveBeenCalled();
		expect(startPendingSubmission).toHaveBeenCalledWith({
			text: "$HOME is home",
			images: undefined,
			imageLinks: undefined,
			streamingBehavior: "steer",
		});
		expect(onInputCallback).toHaveBeenCalledTimes(1);
		expect(submitted).toEqual([
			{
				text: "$HOME is home",
				images: undefined,
				imageLinks: undefined,
				streamingBehavior: "steer",
			},
		]);
	});

	it("submits pasted shell-prompt transcripts with OMP chrome as a normal prompt", async () => {
		const transcript =
			"$ cd ~/project && sudo ./build-and-push.sh o5.7 2>&1 | tail -4\n" +
			" |\n" +
			" in: 282  out: 152  cache 344K  t: 3.3s  tok/s: 351.9/s\n" +
			" is this command stuck in limbo";
		const { ctx, editor, handlePythonCommand, onInputCallback, startPendingSubmission, submitted } = createContext();
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await editor.onSubmit?.(transcript);

		expect(handlePythonCommand).not.toHaveBeenCalled();
		expect(startPendingSubmission).toHaveBeenCalledWith({
			text: transcript,
			images: undefined,
			imageLinks: undefined,
			streamingBehavior: "steer",
		});
		expect(onInputCallback).toHaveBeenCalledTimes(1);
		expect(submitted).toEqual([
			{
				text: transcript,
				images: undefined,
				imageLinks: undefined,
				streamingBehavior: "steer",
			},
		]);
	});

	it("keeps space-separated Python shortcuts available", async () => {
		const { ctx, editor, handlePythonCommand, onInputCallback } = createContext();
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await editor.onSubmit?.("$ print(1)");

		expect(handlePythonCommand).toHaveBeenCalledWith("print(1)", false);
		expect(onInputCallback).not.toHaveBeenCalled();
	});

	it("keeps excluded Python shortcuts space-separated too", async () => {
		const { ctx, editor, handlePythonCommand, onInputCallback } = createContext();
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await editor.onSubmit?.("$$ print(1)");

		expect(handlePythonCommand).toHaveBeenCalledWith("print(1)", true);
		expect(onInputCallback).not.toHaveBeenCalled();
	});
});
