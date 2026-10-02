import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { cfgBareExitOnEmptySession, cfgBareSlashCommands } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { isQueuedMessageList, splitQueuedMessages } from "@oh-my-pi/pi-tui/prompt/queue-input";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

// Drives the real editor submit handler through the builtin slash dispatch
// path. Before #3148 only a handful of commands recorded their text (each
// added it inside its own handler); everything else returned `true` from
// executeBuiltinSlashCommand and the controller returned before any
// addToHistory call. The fix centralizes recording after dispatch, with a
// secret filter (shouldSkipHistory) for credential-bearing commands.
function makeCtx(isStreaming = false, messages: AgentMessage[] = []) {
	const addToHistory = vi.fn();
	const handleMCPCommand = vi.fn(async () => {});
	const followUp = vi.fn(async (_text: string, _images?: ImageContent[]) => {});
	const steer = vi.fn(async (_text: string, _images?: ImageContent[]) => {});
	const prompt = vi.fn(async () => false);
	const onInputCallback = vi.fn();
	const shutdown = vi.fn(async () => {});
	let text = "";
	const editor = {
		onSubmit: undefined as undefined | ((t: string) => Promise<void>),
		getText: () => text,
		setText: (t: string) => {
			text = t;
		},
		setCollapsedText: (t: string) => {
			text = t;
		},
		composerChips: () => [],
		addToHistory,
		pendingImages: [] as ImageContent[],
		pendingImageLinks: [] as (string | undefined)[],
		imageLinks: undefined as (string | undefined)[] | undefined,
		clearDraft(historyText?: string) {
			if (historyText !== undefined) addToHistory(historyText);
			text = "";
			this.imageLinks = undefined;
			this.pendingImages = [];
			this.pendingImageLinks = [];
		},
	};
	// Mirrors the real contract: a pending submission is recorded as a local
	// submission until its canonical user `message_start` lands.
	const locallySubmittedUserSignatures = new Set<string>();
	const sessionManager = { sessionId: "session-a", getSessionId: () => sessionManager.sessionId };
	const ctx = {
		editor,
		sessionManager,
		session: {
			messages,
			maybeStartTitleGeneration: vi.fn(),
			isStreaming,
			isCompacting: false,
			queuedMessageCount: 0,
			extensionRunner: undefined,
			customCommands: [],
			promptTemplates: [],
			followUp,
			steer,
			prompt,
		},
		focusedAgentId: undefined,
		collabGuest: undefined,
		shutdown,
		locallySubmittedUserSignatures,
		flushPendingBashComponents: vi.fn(),
		handleHotkeysCommand: vi.fn(),
		handleMCPCommand,
		showStatus: vi.fn(),
		onInputCallback,
		startPendingSubmission: (input: {
			text: string;
			images?: ImageContent[];
			imageLinks?: (string | undefined)[];
			customType?: string;
			display?: boolean;
			streamingBehavior?: "steer" | "followUp";
		}) => {
			locallySubmittedUserSignatures.add(`${input.text}\u0000${input.images?.length ?? 0}`);
			return { ...input, cancelled: false, started: false };
		},
		ui: { requestRender: vi.fn() },
		compactionQueuedMessages: [],
		skillCommands: new Map(),
		fileSlashCommands: new Set<string>(),
		withLocalSubmission: async (_text: string, fn: () => Promise<unknown>) => fn(),
		updatePendingMessagesDisplay: vi.fn(),
		showWarning: vi.fn(),
		showError: vi.fn(),
	} as unknown as InteractiveModeContext;
	return {
		ctx,
		editor,
		addToHistory,
		followUp,
		steer,
		onInputCallback,
		handleMCPCommand,
		showStatus: ctx.showStatus,
		prompt,
		shutdown,
		sessionManager,
	};
}

function controllerFor(ctx: InteractiveModeContext) {
	const controller = new InputController(ctx);
	controller.setupEditorSubmitHandler();
	ctx.handleQueueCommand = message => controller.handleQueueCommand(message);
	return controller;
}

describe("input controller — slash command history (#3148)", () => {
	it("records a plain handled command (/hotkeys) that has no per-handler history call", async () => {
		const { ctx, editor, addToHistory } = makeCtx();
		controllerFor(ctx);

		await editor.onSubmit?.("/hotkeys");

		expect(addToHistory).toHaveBeenCalledWith("/hotkeys");
	});

	it("records a non-secret /mcp subcommand", async () => {
		const { ctx, editor, addToHistory, handleMCPCommand } = makeCtx();
		controllerFor(ctx);

		await editor.onSubmit?.("/mcp list");

		expect(handleMCPCommand).toHaveBeenCalledWith("/mcp list");
		expect(addToHistory).toHaveBeenCalledWith("/mcp list");
	});

	it("does NOT record /mcp add with a --token (would leak the bearer token)", async () => {
		const { ctx, editor, addToHistory, handleMCPCommand } = makeCtx();
		controllerFor(ctx);

		await editor.onSubmit?.("/mcp add srv --url http://x --token sk-secret123");

		// Command still executes...
		expect(handleMCPCommand).toHaveBeenCalledWith("/mcp add srv --url http://x --token sk-secret123");
		// ...but the secret-bearing text is kept out of recallable history.
		expect(addToHistory).not.toHaveBeenCalled();
	});

	it("executes extension commands without rendering them as user prompts or retaining image drafts", async () => {
		const { ctx, editor, addToHistory, onInputCallback, prompt } = makeCtx();
		Object.defineProperty(ctx.session, "extensionRunner", {
			value: {
				getCommand: (name: string) => (name === "id" ? { name } : undefined),
				hasHandlers: () => false,
			},
		});
		const image: ImageContent = { type: "image", data: "image-data", mimeType: "image/png" };
		editor.pendingImages = [image];
		editor.pendingImageLinks = ["file:///draft.png"];
		controllerFor(ctx);

		await editor.onSubmit?.("/id [Image #1]");

		expect(prompt).toHaveBeenCalledWith("/id [Image #1]", { images: [image] });
		expect(addToHistory).toHaveBeenCalledWith("/id [Image #1]");
		expect(onInputCallback).not.toHaveBeenCalled();
		expect(editor.pendingImages).toEqual([]);
		expect(editor.pendingImageLinks).toEqual([]);
	});

	it("routes /queue through the yield-only follow-up queue while streaming", async () => {
		const { ctx, editor, addToHistory, followUp, showStatus } = makeCtx(true);
		controllerFor(ctx);
		editor.setText("/queue inspect the final result");

		await editor.onSubmit?.("/queue inspect the final result");

		expect(followUp).toHaveBeenCalledWith("inspect the final result", undefined);
		expect(addToHistory).toHaveBeenCalledWith("/queue inspect the final result");
		expect(showStatus).toHaveBeenCalledWith("Queued message for when the agent yields");
	});

	it("starts the first queued item immediately when the session is idle", async () => {
		const { ctx, editor, followUp, steer, onInputCallback, showStatus } = makeCtx();
		controllerFor(ctx);
		const input = "=>\n1. inspect types\n2. run focused tests\n3. summarize failures";
		editor.setText(input);

		await editor.onSubmit?.(input);

		expect(onInputCallback).toHaveBeenCalledWith(
			expect.objectContaining({ text: "inspect types", streamingBehavior: "followUp" }),
		);
		expect(steer).not.toHaveBeenCalled();
		expect(followUp.mock.calls.map(call => call[0])).toEqual(["run focused tests", "summarize failures"]);
		expect(showStatus).toHaveBeenCalledWith("Sent first message; queued 2 for later yields");
	});

	it("queues an enumerated shorthand prompt as separate ordered follow-ups", async () => {
		const { ctx, editor, addToHistory, followUp, showStatus } = makeCtx(true);
		controllerFor(ctx);
		const input = "=>\n1. inspect types\n2. run focused tests\n3. summarize failures";
		editor.setText(input);

		await editor.onSubmit?.(input);

		expect(followUp.mock.calls.map(call => call[0])).toEqual([
			"inspect types",
			"run focused tests",
			"summarize failures",
		]);
		expect(addToHistory).toHaveBeenCalledWith(input);
		expect(showStatus).toHaveBeenCalledWith("Queued 3 messages for when the agent yields");
	});
});

describe("input controller — bare exit on empty session (#3850)", () => {
	afterEach(() => {
		resetSettingsForTest();
	});

	it.each(["exit", "quit", "q", "Exit", "QUIT", "Q"])("quits on exactly %p before the first message", async word => {
		const { ctx, editor, shutdown, onInputCallback } = makeCtx();
		controllerFor(ctx);

		await editor.onSubmit?.(word);

		expect(shutdown).toHaveBeenCalledTimes(1);
		expect(onInputCallback).not.toHaveBeenCalled();
	});

	it.each([" exit", "q ", "exit.", "exit the loop"])(
		"sends %p to the model because the whole input is not exactly the word",
		async input => {
			const { ctx, editor, shutdown, onInputCallback } = makeCtx();
			controllerFor(ctx);

			await editor.onSubmit?.(input);

			expect(shutdown).not.toHaveBeenCalled();
			expect(onInputCallback).toHaveBeenCalledWith(expect.objectContaining({ text: input.trim() }));
		},
	);

	it("sends bare exit to the model once the session has messages", async () => {
		const history: AgentMessage[] = [{ role: "user", content: "hi", timestamp: 0 }];
		const { ctx, editor, shutdown, onInputCallback } = makeCtx(false, history);
		controllerFor(ctx);

		await editor.onSubmit?.("exit");

		expect(shutdown).not.toHaveBeenCalled();
		expect(onInputCallback).toHaveBeenCalledWith(expect.objectContaining({ text: "exit" }));
	});

	it("does not quit while the first prompt is still in flight before reaching history", async () => {
		const { ctx, editor, shutdown, onInputCallback } = makeCtx();
		controllerFor(ctx);

		await editor.onSubmit?.("fix the build");
		await editor.onSubmit?.("exit");

		expect(shutdown).not.toHaveBeenCalled();
		expect(onInputCallback.mock.calls.map(call => call[0].text)).toEqual(["fix the build", "exit"]);
	});

	it("steers bare exit into a streaming first turn instead of quitting", async () => {
		const { ctx, editor, shutdown, prompt } = makeCtx(true);
		controllerFor(ctx);

		await editor.onSubmit?.("exit");

		expect(shutdown).not.toHaveBeenCalled();
		expect(prompt).toHaveBeenCalledWith("exit", expect.objectContaining({ streamingBehavior: "steer" }));
	});

	it("delivers an image attached to exit instead of quitting", async () => {
		const image: ImageContent = { type: "image", data: "aGk=", mimeType: "image/png" };
		const { ctx, editor, shutdown, onInputCallback } = makeCtx();
		controllerFor(ctx);
		editor.pendingImages = [image];
		editor.pendingImageLinks = [undefined];

		await editor.onSubmit?.("exit [Image #1]");

		expect(shutdown).not.toHaveBeenCalled();
		expect(onInputCallback).toHaveBeenCalledWith(
			expect.objectContaining({ text: "exit [Image #1]", images: [image] }),
		);
	});

	it("sends bare exit to the model when input.bareExitOnEmptySession is off", async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		cfgBareExitOnEmptySession.set(Settings.instance, false);
		const { ctx, editor, shutdown, onInputCallback } = makeCtx();
		controllerFor(ctx);

		await editor.onSubmit?.("exit");

		expect(shutdown).not.toHaveBeenCalled();
		expect(onInputCallback).toHaveBeenCalledWith(expect.objectContaining({ text: "exit" }));
	});
});

describe("input controller — bare slash commands opt-in", () => {
	async function enable() {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		cfgBareSlashCommands.set(Settings.instance, true);
	}

	afterEach(() => {
		resetSettingsForTest();
	});

	it.each(["hotkeys", "HotKeys"])("runs builtin %p as its slash command before the first message", async word => {
		await enable();
		const { ctx, editor, addToHistory, onInputCallback } = makeCtx();
		controllerFor(ctx);

		await editor.onSubmit?.(word);

		expect(ctx.handleHotkeysCommand).toHaveBeenCalledTimes(1);
		expect(addToHistory).toHaveBeenCalledWith("/hotkeys");
		expect(onInputCallback).not.toHaveBeenCalled();
	});

	it("runs a bare extension command locally", async () => {
		await enable();
		const { ctx, editor, onInputCallback, prompt } = makeCtx();
		Object.defineProperty(ctx.session, "extensionRunner", {
			value: {
				getCommand: (name: string) => (name === "id" ? { name } : undefined),
				hasHandlers: () => false,
			},
		});
		controllerFor(ctx);

		await editor.onSubmit?.("id");

		expect(prompt).toHaveBeenCalledWith("/id", { images: undefined });
		expect(onInputCallback).not.toHaveBeenCalled();
	});

	describe("once the session has messages", () => {
		const history: AgentMessage[] = [{ role: "user", content: "hi", timestamp: 0 }];

		it("holds the first Enter for confirmation and runs on the second", async () => {
			await enable();
			const { ctx, editor, addToHistory, onInputCallback, showStatus } = makeCtx(false, history);
			controllerFor(ctx);

			await editor.onSubmit?.("hotkeys");

			expect(ctx.handleHotkeysCommand).not.toHaveBeenCalled();
			expect(onInputCallback).not.toHaveBeenCalled();
			expect(editor.getText()).toBe("hotkeys");
			expect(showStatus).toHaveBeenCalledWith(expect.stringContaining("Enter again to run /hotkeys"));

			await editor.onSubmit?.(editor.getText());

			expect(ctx.handleHotkeysCommand).toHaveBeenCalledTimes(1);
			expect(addToHistory).toHaveBeenCalledWith("/hotkeys");
			expect(onInputCallback).not.toHaveBeenCalled();
		});

		it("confirms bare exit instead of sending it to the model", async () => {
			await enable();
			const { ctx, editor, shutdown, onInputCallback } = makeCtx(false, history);
			controllerFor(ctx);

			await editor.onSubmit?.("exit");
			expect(shutdown).not.toHaveBeenCalled();
			await editor.onSubmit?.("exit");

			expect(shutdown).toHaveBeenCalledTimes(1);
			expect(onInputCallback).not.toHaveBeenCalled();
		});

		it("disarms the confirmation when a different submission comes in between", async () => {
			await enable();
			const { ctx, editor, onInputCallback } = makeCtx(false, history);
			controllerFor(ctx);

			await editor.onSubmit?.("hotkeys");
			await editor.onSubmit?.(" hotkeys");
			await editor.onSubmit?.("hotkeys");

			expect(ctx.handleHotkeysCommand).not.toHaveBeenCalled();
			expect(onInputCallback.mock.calls.map(call => call[0].text)).toEqual(["hotkeys"]);
		});

		it("does not let a different command word confirm the armed one", async () => {
			await enable();
			const { ctx, editor, shutdown, showStatus } = makeCtx(false, history);
			controllerFor(ctx);

			await editor.onSubmit?.("hotkeys");
			await editor.onSubmit?.("exit");

			expect(ctx.handleHotkeysCommand).not.toHaveBeenCalled();
			expect(shutdown).not.toHaveBeenCalled();
			expect(showStatus).toHaveBeenLastCalledWith(expect.stringContaining("Enter again to run /exit"));
		});

		it("requires a fresh confirmation after switching sessions", async () => {
			await enable();
			const { ctx, editor, shutdown, onInputCallback, showStatus, sessionManager } = makeCtx(false, history);
			controllerFor(ctx);

			await editor.onSubmit?.("exit");
			// Resume/new/fork swap the session without an editor submission.
			sessionManager.sessionId = "session-b";
			await editor.onSubmit?.("exit");

			expect(shutdown).not.toHaveBeenCalled();
			expect(onInputCallback).not.toHaveBeenCalled();
			expect(showStatus).toHaveBeenCalledTimes(2);

			await editor.onSubmit?.("exit");
			expect(shutdown).toHaveBeenCalledTimes(1);
		});
	});

	it("asks for confirmation while the first prompt is still in flight", async () => {
		await enable();
		const { ctx, editor, onInputCallback } = makeCtx();
		controllerFor(ctx);

		await editor.onSubmit?.("fix the build");
		await editor.onSubmit?.("hotkeys");

		expect(ctx.handleHotkeysCommand).not.toHaveBeenCalled();
		expect(onInputCallback.mock.calls.map(call => call[0].text)).toEqual(["fix the build"]);
		expect(editor.getText()).toBe("hotkeys");
	});

	it.each(["hotkeys please", " hotkeys", "hotkeys.", "notacommand"])(
		"sends %p to the model because it is not exactly a command name",
		async input => {
			await enable();
			const { ctx, editor, onInputCallback } = makeCtx();
			controllerFor(ctx);

			await editor.onSubmit?.(input);

			expect(ctx.handleHotkeysCommand).not.toHaveBeenCalled();
			expect(onInputCallback).toHaveBeenCalledWith(expect.objectContaining({ text: input.trim() }));
		},
	);

	it("delivers an image attached to a command name instead of running it", async () => {
		await enable();
		const image: ImageContent = { type: "image", data: "aGk=", mimeType: "image/png" };
		const { ctx, editor, onInputCallback } = makeCtx();
		controllerFor(ctx);
		editor.pendingImages = [image];
		editor.pendingImageLinks = [undefined];

		await editor.onSubmit?.("hotkeys [Image #1]");

		expect(ctx.handleHotkeysCommand).not.toHaveBeenCalled();
		expect(onInputCallback).toHaveBeenCalledWith(
			expect.objectContaining({ text: "hotkeys [Image #1]", images: [image] }),
		);
	});

	it("sends a bare command name to the model when the setting is off (default)", async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		const { ctx, editor, onInputCallback } = makeCtx();
		controllerFor(ctx);

		await editor.onSubmit?.("hotkeys");

		expect(ctx.handleHotkeysCommand).not.toHaveBeenCalled();
		expect(onInputCallback).toHaveBeenCalledWith(expect.objectContaining({ text: "hotkeys" }));
	});
});

describe("yield queue list parsing", () => {
	it("recognizes numeric, Roman, and alphabetic sequences", () => {
		const expected = ["first", "second", "third"];
		for (const input of [
			"1. first\n2. second\n3. third",
			"I. first\nII. second\nIII. third",
			"i. first\nii. second\niii. third",
			"A. first\nB. second\nC. third",
			"a) first\nb) second\nc) third",
		]) {
			expect(splitQueuedMessages(input)).toEqual(expected);
		}
	});

	it("keeps continuation lines together and rejects non-sequential markers", () => {
		expect(splitQueuedMessages("1. first line\n   more detail\n2. second")).toEqual([
			"first line\n   more detail",
			"second",
		]);
		expect(splitQueuedMessages("1. first\n3. third")).toEqual(["1. first\n3. third"]);
		expect(isQueuedMessageList("1. first\n2. second\n3. third\n4.")).toBe(true);
		expect(splitQueuedMessages("1. first\n2. second\n3. third\n4.")).toEqual(["first", "second", "third"]);
	});
});
