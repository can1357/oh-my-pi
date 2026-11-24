import { describe, expect, it, vi } from "bun:test";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { Composer } from "../src/ui/composer/composer";

function createContext() {
	const submitted: unknown[] = [];
	const handlePythonCommand = vi.fn(async (_code: string, _isExcluded: boolean) => {});
	const handleBashCommand = vi.fn(async (_command: string, _isExcluded: boolean) => {});
	const startPendingSubmission = vi.fn((submission: unknown) => submission);
	const onInputCallback = vi.fn((submission: unknown) => submitted.push(submission));
	const prompt = vi.fn(async (_text: string, _options?: unknown) => {});
	const handleBtwCommand = vi.fn(async (_question: string) => true);

	const editor = new Composer();

	const ctx = {
		composer: editor,
		session: {
			isStreaming: false,
			isCompacting: false,
			isBashRunning: false,
			isEvalRunning: false,
			extensionRunner: undefined,
			prompt,
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
		flushPendingExecRuns: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		showError: vi.fn(),
		showWarning: vi.fn(),
		showStatus: vi.fn(),
		isBashMode: false,
		isPythonMode: false,
		fileSlashCommands: new Set<string>(),
		skillCommands: new Map(),
		isKnownSlashCommand: () => false,
		handlePythonCommand,
		handleBashCommand,
		handleBtwCommand,
		withLocalSubmission: async (_text: string, fn: () => Promise<unknown>) => fn(),
	} as unknown as InteractiveModeContext;

	return {
		ctx,
		editor,
		handlePythonCommand,
		handleBtwCommand,
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

		editor.onSubmit?.("$HOME is home");

		await controller.waitForSubmissionDispatches();

		expect(handlePythonCommand).not.toHaveBeenCalled();
		expect(startPendingSubmission).toHaveBeenCalledWith(
			{
				text: "$HOME is home",
				images: undefined,
				imageLinks: undefined,
				streamingBehavior: "steer",
			},
			{ clearEditor: false },
		);
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

		editor.onSubmit?.(transcript);

		await controller.waitForSubmissionDispatches();

		expect(handlePythonCommand).not.toHaveBeenCalled();
		expect(startPendingSubmission).toHaveBeenCalledWith(
			{
				text: transcript,
				images: undefined,
				imageLinks: undefined,
				streamingBehavior: "steer",
			},
			{ clearEditor: false },
		);
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

		editor.onSubmit?.("$ print(1)");

		await controller.waitForSubmissionDispatches();

		expect(handlePythonCommand).toHaveBeenCalledWith("print(1)", false);
		expect(onInputCallback).not.toHaveBeenCalled();
	});

	it("keeps excluded Python shortcuts space-separated too", async () => {
		const { ctx, editor, handlePythonCommand, onInputCallback } = createContext();
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		editor.onSubmit?.("$$ print(1)");

		await controller.waitForSubmissionDispatches();

		expect(handlePythonCommand).toHaveBeenCalledWith("print(1)", true);
		expect(onInputCallback).not.toHaveBeenCalled();
	});

	it("runs a `?` draft as the /btw side question it stands for", async () => {
		const { ctx, editor, handleBtwCommand, handlePythonCommand, onInputCallback } = createContext();
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		editor.onSubmit?.("? what does this do");

		await controller.waitForSubmissionDispatches();

		expect(handleBtwCommand).toHaveBeenCalledTimes(1);
		expect(handleBtwCommand.mock.calls[0]?.[0]).toBe("what does this do");
		expect(handlePythonCommand).not.toHaveBeenCalled();
		expect(onInputCallback).not.toHaveBeenCalled();
	});

	it.each(["?", "?? why did this change?"])("submits %j as a normal prompt", async text => {
		const { ctx, editor, handleBtwCommand, submitted } = createContext();
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		editor.onSubmit?.(text);

		await controller.waitForSubmissionDispatches();

		expect(handleBtwCommand).not.toHaveBeenCalled();
		expect(submitted).toEqual([{ text, images: undefined, imageLinks: undefined, streamingBehavior: "steer" }]);
	});

	it("submits a draft starting with two or more question marks as a normal prompt", async () => {
		const { ctx, editor, handleBtwCommand, handlePythonCommand, startPendingSubmission, submitted } = createContext();
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await editor.onSubmit?.("?? is this valid syntax");

		expect(handleBtwCommand).not.toHaveBeenCalled();
		expect(handlePythonCommand).not.toHaveBeenCalled();
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
});
