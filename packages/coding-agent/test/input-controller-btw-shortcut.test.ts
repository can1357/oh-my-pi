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
	const handleBtwCommand = vi.fn(async (_question: string) => true);
	const startPendingSubmission = vi.fn((submission: unknown) => submission);
	const onInputCallback = vi.fn((submission: unknown) => submitted.push(submission));

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
			messages: [],
			customCommands: [],
			promptTemplates: [],
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
		skillCommands: new Map(),
		isKnownSlashCommand: () => false,
		handleBtwCommand,
		withLocalSubmission: async (_text: string, fn: () => Promise<unknown>) => fn(),
	} as unknown as InteractiveModeContext;

	return { ctx, editor, handleBtwCommand, onInputCallback, startPendingSubmission, submitted };
}

describe("InputController /btw `?` shortcut", () => {
	it("routes a `?` draft to the /btw handler", async () => {
		const { ctx, editor, handleBtwCommand, startPendingSubmission, submitted } = createContext();
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await editor.onSubmit?.("? what is this file");

		expect(handleBtwCommand).toHaveBeenCalledWith("what is this file", undefined);
		expect(startPendingSubmission).not.toHaveBeenCalled();
		expect(submitted).toEqual([]);
	});

	it("sends a draft starting with two question marks as a normal prompt", async () => {
		const { ctx, editor, handleBtwCommand, startPendingSubmission, submitted } = createContext();
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await editor.onSubmit?.("?? is this valid syntax");

		expect(handleBtwCommand).not.toHaveBeenCalled();
		expect(startPendingSubmission).toHaveBeenCalledWith(
			{
				text: "?? is this valid syntax",
				images: undefined,
				imageLinks: undefined,
				streamingBehavior: "steer",
			},
			{ clearEditor: false },
		);
		expect(submitted).toEqual([
			{
				text: "?? is this valid syntax",
				images: undefined,
				imageLinks: undefined,
				streamingBehavior: "steer",
			},
		]);
	});

	it("sends a run of three or more question marks as a normal prompt", async () => {
		const { ctx, editor, handleBtwCommand, startPendingSubmission } = createContext();
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await editor.onSubmit?.("??? what");

		expect(handleBtwCommand).not.toHaveBeenCalled();
		expect(startPendingSubmission).toHaveBeenCalledWith(
			{
				text: "??? what",
				images: undefined,
				imageLinks: undefined,
				streamingBehavior: "steer",
			},
			{ clearEditor: false },
		);
	});
});
