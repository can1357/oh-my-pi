import { describe, expect, it, vi } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { isQueuedMessageList, splitQueuedMessages } from "@oh-my-pi/pi-coding-agent/modes/queue-input";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

// Drives the real editor submit handler through the builtin slash dispatch
// path. Before #3148 only a handful of commands recorded their text (each
// added it inside its own handler); everything else returned `true` from
// executeBuiltinSlashCommand and the controller returned before any
// addToHistory call. The fix centralizes recording after dispatch, with a
// secret filter (shouldSkipHistory) for credential-bearing commands.
function makeCtx(isStreaming = false) {
	const addToHistory = vi.fn();
	const handleMCPCommand = vi.fn(async () => {});
	const followUp = vi.fn(async (_text: string, _images?: ImageContent[]) => {});
	const steer = vi.fn(async (_text: string, _images?: ImageContent[]) => {});
	const prompt = vi.fn(async () => false);
	const onInputCallback = vi.fn();
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
	const ctx = {
		editor,
		session: {
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
		}) => ({ ...input, cancelled: false, started: false }),
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
