import { describe, expect, it, vi } from "bun:test";
import { getProjectDir, setProjectDir, TempDir } from "@oh-my-pi/pi-utils";
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
const DEFAULT_SESSION_ID = "session-1";
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
		getExpandedText: () => text,
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
		sessionManager: { getSessionId: () => DEFAULT_SESSION_ID },
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

	it("records a switching command before it moves the context, keeping it in the source list", async () => {
		const moved = TempDir.createSync("@omp-slash-origin-");
		const origin = getProjectDir();
		let sessionId = "source-session";
		const { ctx, editor } = makeCtx();
		ctx.sessionManager = {
			getSessionId: () => sessionId,
		} as unknown as InteractiveModeContext["sessionManager"];
		// `/hotkeys` rides the shared dispatch path; its handler stands in for `/new`,
		// `/resume` or `/move`, which switch the conversation and the directory while they run.
		ctx.handleHotkeysCommand = () => {
			sessionId = "destination-session";
			setProjectDir(moved.path());
		};
		// The editor files an entry in the list of the scope active at the call and stamps the
		// database write with the context live at the call, so both are observed while recording.
		const recorded: Array<{ text: string; session: string; cwd: string }> = [];
		editor.addToHistory = vi.fn((text: string) => {
			recorded.push({ text, session: sessionId, cwd: getProjectDir() });
		});
		controllerFor(ctx);

		try {
			await editor.onSubmit?.("/hotkeys");
			// Exactly one record, made while the source context was still the live one.
			expect(recorded).toEqual([{ text: "/hotkeys", session: "source-session", cwd: origin }]);
		} finally {
			setProjectDir(origin);
			await moved.remove().catch(() => {});
		}
	});

	it("records a switching follow-up command before it moves the context too", async () => {
		let sessionId = "source-session";
		const { ctx, editor } = makeCtx();
		ctx.sessionManager = {
			getSessionId: () => sessionId,
		} as unknown as InteractiveModeContext["sessionManager"];
		ctx.handleHotkeysCommand = () => {
			sessionId = "destination-session";
		};
		const recorded: Array<{ text: string; session: string }> = [];
		editor.setText("/hotkeys");
		editor.addToHistory = vi.fn((text: string) => {
			recorded.push({ text, session: sessionId });
		});
		const controller = controllerFor(ctx);

		await controller.handleFollowUp();

		expect(recorded).toEqual([{ text: "/hotkeys", session: "source-session" }]);
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

describe("input controller — collab guest history", () => {
	/** A guest replica: the real dispatcher gates and the real guest branch both run. */
	function guestCtx() {
		const harness = makeCtx();
		harness.ctx.collabGuest = {
			readOnly: false,
			sendPrompt: vi.fn(),
		} as unknown as InteractiveModeContext["collabGuest"];
		harness.ctx.shutdown = vi.fn(async () => {});
		controllerFor(harness.ctx);
		return harness;
	}

	it("keeps a command the guest gates refuse out of history", async () => {
		// `/new` and `/mcp list` are refused by the guest allowlist, `/hotkeys extra` by the
		// argument gate, and the rest by the guest branch that rejects unhandled slash text.
		const refused = ["/new", "/mcp list", "/hotkeys extra", "/model opus", "/not-a-builtin do something", "/"];
		const recorded: string[] = [];

		for (const command of refused) {
			const { editor, addToHistory } = guestCtx();
			await editor.onSubmit?.(command);
			if (addToHistory.mock.calls.length > 0) recorded.push(command);
		}

		expect(recorded).toEqual([]);
	});

	it("records a command the guest may run locally, alias included", async () => {
		const direct = guestCtx();
		await direct.editor.onSubmit?.("/hotkeys");
		expect(direct.addToHistory).toHaveBeenCalledWith("/hotkeys");

		// `/q` reaches its allowlisted spec through the alias, so the guard has to resolve the
		// canonical name rather than trust the token that was typed.
		const aliased = guestCtx();
		await aliased.editor.onSubmit?.("/q");
		expect(aliased.addToHistory).toHaveBeenCalledWith("/q");
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
