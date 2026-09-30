import { afterEach, describe, expect, it, vi } from "bun:test";
import { getProjectDir, setProjectDir, TempDir } from "@oh-my-pi/pi-utils";
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
const DEFAULT_SESSION_ID = "session-1";

function makeCtx(isStreaming = false, messages: AgentMessage[] = []) {
	const addToHistory = vi.fn();
	const handleMCPCommand = vi.fn(async () => {});
	const followUp = vi.fn(async (_text: string, _images?: ImageContent[]) => {});
	const steer = vi.fn(async (_text: string, _images?: ImageContent[]) => {});
	const prompt = vi.fn(async () => false);
	const onInputCallback = vi.fn();
	const shutdown = vi.fn(async () => {});
	let text = "";
	const isGuidedGoalInterviewActive = vi.fn(() => false);
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
		isGuidedGoalInterviewActive,
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
		// Exposed so tests can drive the /guided-goal interview: `ctx` is cast to
		// `InteractiveModeContext`, which erases the mock type.
		interview: isGuidedGoalInterviewActive,
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
		// One registered skill, so `/skill:probe` reaches the skill branch that records its text.
		harness.ctx.skillCommands.set("skill:probe", { name: "probe" } as unknown as Parameters<
			InteractiveModeContext["skillCommands"]["set"]
		>[1]);
		const controller = controllerFor(harness.ctx);
		return { ...harness, controller };
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

	it("applies the same guard on the follow-up path", async () => {
		// `/new` is consumed and refused by the allowlist, `/skill:probe` is recorded inside
		// `#invokeSkillCommand`, and the rest reach `clearDraft` unconsumed.
		const refused = [
			"/new",
			"/model opus",
			"/hotkeys extra",
			"/skill:probe do the thing",
			"/not-a-builtin do something",
			"/",
		];
		const recorded: string[] = [];
		const prompted: string[] = [];

		for (const command of refused) {
			const { editor, addToHistory, prompt, controller } = guestCtx();
			editor.setText(command);
			await controller.handleFollowUp();
			if (addToHistory.mock.calls.length > 0) recorded.push(command);
			if (prompt.mock.calls.length > 0) prompted.push(command);
		}

		expect(recorded).toEqual([]);
		// Nothing was delivered either: a refused command must not run on the replica.
		expect(prompted).toEqual([]);

		const allowed = guestCtx();
		allowed.editor.setText("/hotkeys");
		await allowed.controller.handleFollowUp();
		expect(allowed.addToHistory).toHaveBeenCalledWith("/hotkeys");
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

	it("files a bare quit word as its command, like a typed slash", async () => {
		// The routed word is recorded under its command form, so recall mirrors what actually
		// ran. A bare word that is only armed for confirmation never reaches this point: the
		// confirm path returns before the slash block, and those tests assert that.
		for (const word of ["exit", "quit", "q", "EXIT"]) {
			const { ctx, editor, addToHistory, shutdown } = makeCtx(false, []);
			controllerFor(ctx);

			await editor.onSubmit?.(word);

			expect(shutdown).toHaveBeenCalledTimes(1);
			expect(addToHistory).toHaveBeenCalledWith(`/${word.toLowerCase()}`);
		}
	});

	it("still files a slash command typed as one", async () => {
		const { ctx, editor, addToHistory } = makeCtx(false, []);
		controllerFor(ctx);

		await editor.onSubmit?.("/hotkeys");

		expect(addToHistory).toHaveBeenCalledWith("/hotkeys");
	});

	it("restores the draft and reports when a detached command throws", async () => {
		// A detached command (plan/vibe/goal/guided-goal) rethrows so the caller owns
		// restoration. Without the catch the submission is swallowed: no error, no prompt,
		// and the draft the user typed is gone.
		const { ctx, editor, prompt } = makeCtx(false, []);
		(ctx as unknown as { handlePlanModeCommand: () => Promise<boolean> }).handlePlanModeCommand = async () => {
			throw new Error("plan mode exploded");
		};
		controllerFor(ctx);

		await editor.onSubmit?.("/plan do the thing");

		expect(prompt).not.toHaveBeenCalled();
		expect(ctx.showError).toHaveBeenCalledWith("plan mode exploded");
	});

	it("files a skill command once, not twice", async () => {
		const { ctx, editor, addToHistory } = makeCtx(false, []);
		ctx.skillCommands.set("skill:probe", {
			name: "probe",
			run: async () => true,
		} as unknown as Parameters<InteractiveModeContext["skillCommands"]["set"]>[1]);
		controllerFor(ctx);

		await editor.onSubmit?.("/skill:probe do the thing");

		expect(addToHistory.mock.calls.filter(call => call[0] === "/skill:probe do the thing")).toHaveLength(1);
	});
	// `c` is the continue shortcut outside a /guided-goal interview, but a plausible
	// answer to its questions inside one. Upstream's guard flips which branch wins, and
	// history filing has to follow: a genuine user answer belongs in `Up` history, while
	// the continue shortcut is a host action that must not masquerade as a message.
	it("files `c` in Up history while a guided interview is active", async () => {
		const { ctx, editor, addToHistory, interview } = makeCtx(false, []);
		interview.mockReturnValue(true);
		controllerFor(ctx);

		await editor.onSubmit?.("c");

		expect(addToHistory).toHaveBeenCalledWith("c");
	});

	it("keeps `c` out of Up history outside a guided interview, where it continues", async () => {
		const { ctx, editor, addToHistory, onInputCallback } = makeCtx(false, []);
		controllerFor(ctx);

		await editor.onSubmit?.("c");

		// The shortcut continues the session: the word is consumed here and never
		// forwarded as if the user had typed `c`, and never filed in Up history.
		expect(onInputCallback).toHaveBeenCalledTimes(1);
		expect(onInputCallback.mock.calls[0]?.[0]).not.toBe("c");
		expect(addToHistory).not.toHaveBeenCalled();
	});

	it("files a context-switching command once, under the context it was typed in", async () => {
		// `/move` changes the cwd, so a second write after the handler ran would re-file the row
		// under the destination — the exact mis-attribution the pre-dispatch record exists to
		// prevent — and bill the same submission twice in `use_count`.
		const origin = getProjectDir();
		const moved = TempDir.createSync("@omp-move-");
		const { ctx, editor, addToHistory } = makeCtx(false, []);
		(ctx as unknown as { handleMoveCommand: (args?: string) => Promise<boolean> }).handleMoveCommand = async () => {
			setProjectDir(moved.path());
			return true;
		};
		controllerFor(ctx);

		try {
			await editor.onSubmit?.("/move elsewhere");
			expect(addToHistory.mock.calls.filter(call => call[0] === "/move elsewhere")).toHaveLength(1);
		} finally {
			setProjectDir(origin);
			await moved.remove().catch(() => {});
		}
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

	// A /guided-goal interview asks questions, and `c` reads as an answer ("option C").
	// Armed as a command it would either wait for a second Enter or, on a fresh session,
	// run `/c` outright and lose the answer with no status line to show for it.
	it("sends `c` as the interview answer even when a command named `c` exists", async () => {
		await enable();
		const { ctx, editor, addToHistory, onInputCallback, interview } = makeCtx();
		interview.mockReturnValue(true);
		ctx.fileSlashCommands.add("c");
		controllerFor(ctx);

		await editor.onSubmit?.("c");

		expect(ctx.showStatus).not.toHaveBeenCalled();
		expect(addToHistory).toHaveBeenCalledWith("c");
		expect(onInputCallback).toHaveBeenCalledTimes(1);
		expect(onInputCallback.mock.calls[0]?.[0]).toMatchObject({ cancelled: false });
	});

	it("still arms another command during a guided interview, so the exemption stays narrow", async () => {
		await enable();
		const { ctx, editor, interview } = makeCtx(false, [{ role: "user", content: "hello" }] as AgentMessage[]);
		interview.mockReturnValue(true);
		ctx.fileSlashCommands.add("alpha");
		controllerFor(ctx);

		await editor.onSubmit?.("alpha");

		expect(ctx.showStatus).toHaveBeenCalledWith(expect.stringContaining("Press Enter again to run /alpha"));
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
			// An armed word has not run yet, so it must not be filed: recording it would put a
			// command the user declined into the recall of every project under `global`. This is the
			// property the whole bare-word model rests on.
			expect(addToHistory).not.toHaveBeenCalled();

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
