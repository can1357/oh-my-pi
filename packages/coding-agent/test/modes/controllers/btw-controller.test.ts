import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage, ImageContent, Usage } from "@oh-my-pi/pi-ai";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings/keybindings";
import { BtwHistoryStore } from "@oh-my-pi/pi-coding-agent/session/btw-history";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { BTW_INJECT_LABEL, BTW_INJECTED_LABEL } from "@oh-my-pi/pi-coding-agent/modes/view-model/overlays/btw-inject";
import { BtwController } from "@oh-my-pi/pi-coding-agent/modes/controllers/btw-controller";
import { cfgBtwInject } from "@oh-my-pi/pi-coding-agent/modes/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import * as clipboard from "@oh-my-pi/pi-coding-agent/utils/clipboard";
import { replaceTabs } from "@oh-my-pi/pi-coding-agent/utils/text-width";
import { Shell, type TranscriptBlock } from "@oh-my-pi/pi-coding-agent/ui/shell/index";
import { jsx, type UiNode } from "@oh-my-pi/pi-tui";
import {
	btwShellMembers,
	historySheet,
	inlineText,
	isNoteBlock,
	noteIn,
	notesIn,
	setNative,
} from "../../helpers/btw-ui";
import { nativeShell } from "../../helpers/native-shell";

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

interface RunEphemeralTurnArgs {
	promptText: string;
	promptImages?: ImageContent[];
	onTextDelta?: (delta: string) => void;
	signal?: AbortSignal;
}

interface RunEphemeralTurnResult {
	replyText: string;
	assistantMessage: AssistantMessage;
}

function makeFakeSession(
	runEphemeralTurn: (args: RunEphemeralTurnArgs) => Promise<RunEphemeralTurnResult>,
): InteractiveModeContext["session"] {
	return {
		model: { provider: "anthropic", id: "claude-sonnet-4-5" },
		isStreaming: false,
		messages: [],
		runEphemeralTurn,
	} as unknown as InteractiveModeContext["session"];
}

function makeCtx(
	session: InteractiveModeContext["session"],
	settings: Readonly<Record<string, unknown>> = {},
): InteractiveModeContext & {
	setTestLeafId(nextLeafId: string | null): void;
	setTestSessionId(nextSessionId: string): void;
} {
	let leafId: string | null = "leaf-1";
	let sessionId = "session-1";
	return {
		...btwShellMembers(new Shell()),
		keybindings: KeybindingsManager.inMemory(),
		session,
		settings: Settings.isolated(settings),
		sessionManager: {
			getLeafId: () => leafId,
			getSessionId: () => sessionId,
			getArtifactsDir: () => undefined,
			ensureOnDisk: async () => {},
		} as unknown as InteractiveModeContext["sessionManager"],
		showStatus: vi.fn(),
		showError: vi.fn(),
		handleBtwBranch: vi.fn(async () => {}),
		handleImagePaste: vi.fn(async () => false),
		handleImagePathPaste: vi.fn(async () => {}),
		// Speech-to-text off: the space bar types.
		dictationSpaceHold: () => ({ enabled: () => false, onStart: () => {}, onEnd: () => {} }),
		setTestLeafId(nextLeafId: string | null) {
			leafId = nextLeafId;
		},
		setTestSessionId(nextSessionId: string) {
			sessionId = nextSessionId;
		},
	} as unknown as InteractiveModeContext & {
		setTestLeafId(nextLeafId: string | null): void;
		setTestSessionId(nextSessionId: string): void;
	};
}
afterEach(() => {
	vi.restoreAllMocks();
});

async function drainBtwRequest(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

describe("BtwController under Tern", () => {
	// A native start repaints whatever still listens for it, settings readers included.
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});

	it("mounts BTW history as Tern's titled sheet and closes it on Escape with the draft's focus back", async () => {
		const ctx = makeCtx(makeFakeSession(vi.fn()));
		await using ui = await nativeShell(ctx.shell);
		const controller = new BtwController(ctx);
		const before = ctx.shell.focused();

		await controller.start("");
		const overlay = ui.node("overlay");
		expect(overlay.parent).toBe("layer");
		// Nothing to list yet: the palette-sized sheet.
		expect(overlay.p).toEqual({
			role: "omp.overlay.btwHistory",
			anchor: "center",
			size: "md",
			head: "BTW history",
			modal: true,
		});
		const [sheet] = ui.children(overlay);
		expect(sheet?.k).toBe("col");
		expect(sheet?.p.role).toBeUndefined();

		ui.type("\x1b[27u");
		expect(ctx.shell.overlays.open()).toBe(false);
		expect(ctx.shell.focused()).toBe(before);
		await controller.dispose();
	});
});

describe("BtwController", () => {
	it("returns input to the pending prompt after BTW history closes", async () => {
		const ctx = makeCtx(makeFakeSession(vi.fn()));
		const mountAsk = (): UiNode => {
			ctx.shell.dock.slot("ask").set(() => jsx("col", { role: "omp.overlay.approval" }));
			const node = ctx.shell.dock.slot("ask").view();
			if (!node || typeof node !== "object" || !("kind" in node)) throw new Error("expected the ask node");
			return node;
		};
		const controller = new BtwController(ctx);

		// A prompt that held the keys before the sheet opened gets them back.
		const before = mountAsk();
		ctx.shell.focus(before);
		await controller.start("");
		const first = historySheet(ctx.shell);
		expect(ctx.shell.focused()).toBe(first.overlay);
		first.press("escape");
		expect(first.closed).toBe(true);
		expect(ctx.shell.focused()).toBe(before);

		// A prompt that took the keys while the sheet was open keeps them.
		await controller.start("");
		const second = historySheet(ctx.shell);
		const during = mountAsk();
		ctx.shell.focus(during);
		second.press("escape");
		expect(second.closed).toBe(true);
		expect(ctx.shell.focused()).toBe(during);
		await controller.dispose();
	});

	it("refuses a second question without cancelling a running request viewed in history", async () => {
		const first = Promise.withResolvers<RunEphemeralTurnResult>();
		const runEphemeralTurn = vi.fn((_args: RunEphemeralTurnArgs) => first.promise);
		const ctx = makeCtx(makeFakeSession(runEphemeralTurn));
		const controller = new BtwController(ctx);

		await controller.start("First?");
		await controller.start("");
		await controller.start("Second?");

		expect(runEphemeralTurn).toHaveBeenCalledTimes(1);
		expect(runEphemeralTurn.mock.calls[0]?.[0].signal?.aborted).toBe(false);
		first.resolve({ replyText: "first", assistantMessage: createAssistantMessage("first") });
		await drainBtwRequest();
		await controller.start("Third?");
		expect(runEphemeralTurn).toHaveBeenCalledTimes(2);
		await controller.dispose();
	});

	it("cancels a running answer on Escape and closes its retained panel on the next Escape", async () => {
		const pending = Promise.withResolvers<RunEphemeralTurnResult>();
		const runEphemeralTurn = vi.fn((_args: RunEphemeralTurnArgs) => pending.promise);
		const ctx = makeCtx(makeFakeSession(runEphemeralTurn));
		const controller = new BtwController(ctx);

		await controller.start("Question?");
		expect(ctx.shell.dock.slot("btw").occupied()).toBe(true);
		expect(controller.handleEscape()).toBe(true);
		expect(runEphemeralTurn.mock.calls[0]?.[0].signal?.aborted).toBe(true);
		expect(ctx.shell.dock.slot("btw").occupied()).toBe(true);
		expect(controller.hasActiveRequest()).toBe(true);
		expect(controller.handleEscape()).toBe(true);
		expect(ctx.shell.dock.slot("btw").occupied()).toBe(false);
		expect(controller.hasActiveRequest()).toBe(false);
		pending.resolve({ replyText: "Late answer", assistantMessage: createAssistantMessage("Late answer") });
		await drainBtwRequest();
		await controller.dispose();
	});

	it("in Tern answers in a transcript note; a click points the composer at it, Esc points it back without cancelling", async () => {
		const pending = Promise.withResolvers<RunEphemeralTurnResult>();
		let onTextDelta: ((delta: string) => void) | undefined;
		const runEphemeralTurn = vi.fn((args: RunEphemeralTurnArgs) => {
			onTextDelta = args.onTextDelta;
			return pending.promise;
		});
		const ctx = makeCtx(makeFakeSession(runEphemeralTurn));
		setNative(ctx.shell, true);
		const controller = new BtwController(ctx);

		await controller.start("Why?");
		// Neither the dock panel nor a sheet: the answer streams in the transcript.
		expect(ctx.shell.dock.slot("btw").occupied()).toBe(false);
		expect(ctx.shell.overlays.open()).toBe(false);
		const note = noteIn(ctx.shell);
		onTextDelta?.("Because streaming.");
		expect(note.text()).toContain("Because streaming.");

		expect(controller.hasActiveRequest()).toBe(false);
		note.press("btw-focus");
		expect(controller.isFocused()).toBe(true);
		expect(note.role).toBe("omp.btw.note.active");
		expect(controller.hasActiveRequest()).toBe(true);
		expect(controller.handleEscape()).toBe(true);
		expect(controller.isFocused()).toBe(false);
		expect(note.role).toBe("omp.btw.note");
		expect(runEphemeralTurn.mock.calls[0]?.[0].signal?.aborted).toBe(false);

		// Folding the note it talks to points the composer back too; a click on the line reopens both.
		note.press("btw-focus");
		note.press("btw-fold");
		expect(note.folded).toBe(true);
		expect(controller.isFocused()).toBe(false);
		note.press("btw-expand");
		expect(note.folded).toBe(false);
		expect(controller.isFocused()).toBe(true);

		pending.resolve({ replyText: "Because streaming.", assistantMessage: createAssistantMessage("x") });
		await drainBtwRequest();
		await controller.dispose();
	});

	it("in Tern sends composer drafts to the clicked note as its follow-ups", async () => {
		const runEphemeralTurn = vi.fn(async (args: RunEphemeralTurnArgs) => ({
			replyText: `Answer to ${args.promptText.length}`,
			assistantMessage: createAssistantMessage("Answer"),
		}));
		const ctx = makeCtx(makeFakeSession(runEphemeralTurn));
		setNative(ctx.shell, true);
		const controller = new BtwController(ctx);

		await controller.start("First?");
		await drainBtwRequest();
		const note = noteIn(ctx.shell);
		// Not pointed at the note: nothing to send to.
		expect(await controller.submitFollowUp("More?")).toBe(false);
		note.press("btw-focus");
		expect(await controller.submitFollowUp("More?")).toBe(true);
		await drainBtwRequest();

		expect(runEphemeralTurn).toHaveBeenCalledTimes(2);
		expect(runEphemeralTurn.mock.calls[1]?.[0].promptText).toContain("More?");
		// The same note carries the follow-up; no second note.
		expect(notesIn(ctx.shell).map(each => each.block)).toEqual([note.block]);
		expect(note.text()).toContain("More?");
		await controller.dispose();
	});

	it("in Tern branches a completed answer from its note's menu, leaving plain b to the composer", async () => {
		const runEphemeralTurn = vi.fn(async () => ({
			replyText: "Answer",
			assistantMessage: createAssistantMessage("Answer"),
		}));
		const ctx = makeCtx(makeFakeSession(runEphemeralTurn));
		setNative(ctx.shell, true);
		const controller = new BtwController(ctx);
		const branch = vi.spyOn(controller, "handleBranch");

		await controller.start("Question?");
		await drainBtwRequest();

		expect(controller.handlesBranchKey()).toBe(false);
		const note = noteIn(ctx.shell);
		expect(note.menu).toContain("btw-branch");
		note.press("btw-branch");
		const result = branch.mock.results[0];
		if (result?.type !== "return") throw new Error("expected the branch operation to return a promise");
		expect(await result.value).toBe(true);
		expect(ctx.handleBtwBranch).toHaveBeenCalledTimes(1);

		await controller.dispose();
	});

	it("in Tern puts notes back after a rebuild: folded, before the first newer message, only on the shown branch", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-btw-notes-"));
		const manager = SessionManager.create(directory, directory);
		const ctx = makeCtx(makeFakeSession(vi.fn()));
		setNative(ctx.shell, true);
		ctx.sessionManager = manager;
		const controller = new BtwController(ctx);
		try {
			manager.appendMessage({ role: "user", content: "First", timestamp: 1_000 });
			manager.appendMessage(Object.assign(createAssistantMessage("Reply"), { timestamp: 3_000 }));
			manager.appendMessage({ role: "user", content: "Second", timestamp: 5_000 });
			await manager.ensureOnDisk();
			const blocks = manager.getBranch().flatMap(entry => {
				if (entry.type !== "message") return [];
				const block = ctx.present(() => jsx("text", { text: entry.id }));
				ctx.transcriptBlocks.set(entry.message, block);
				return [block];
			});
			const [first] = manager.getBranch();
			const store = await BtwHistoryStore.open(manager.getArtifactsDir()!);
			const asked = (id: string, leafId: string | null, at: number) =>
				store.upsert({ id, leafId, question: id, answer: id, status: "complete", createdAt: at, updatedAt: at });
			await asked("before-all", null, 500);
			await asked("mid-turn", first!.id, 2_000);
			await asked("elsewhere", "a-rewound-entry", 2_500);
			await asked("latest", manager.getLeafId(), 6_000);

			await controller.placeNotes();

			const notes = new Map(notesIn(ctx.shell).map(note => [note.block, note]));
			const order = ctx.shell.transcript
				.blocks()
				.map((block: TranscriptBlock) =>
					isNoteBlock(block) ? notes.get(block)!.text() : blocks.findIndex(each => each === block),
				);
			expect(order).toEqual([
				expect.stringContaining("before-all"),
				0,
				expect.stringContaining("mid-turn"),
				1,
				2,
				expect.stringContaining("latest"),
			]);
			expect(notesIn(ctx.shell).every(note => note.folded)).toBe(true);
		} finally {
			await controller.dispose();
			await manager.flush();
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	it("opens history without a model request when invoked without a question", async () => {
		const runEphemeralTurn = vi.fn(async () => ({
			replyText: "n/a",
			assistantMessage: createAssistantMessage("n/a"),
		}));
		const ctx = makeCtx(makeFakeSession(runEphemeralTurn));
		const controller = new BtwController(ctx);
		await controller.start("   ");
		expect(runEphemeralTurn).not.toHaveBeenCalled();
		expect(historySheet(ctx.shell).closed).toBe(false);
		expect(controller.hasActiveRequest()).toBe(false);
		await controller.dispose();
	});

	it("sends the images attached to /btw with its side turn", async () => {
		const runEphemeralTurn = vi.fn(async (_args: RunEphemeralTurnArgs) => ({
			replyText: "Red",
			assistantMessage: createAssistantMessage("Red"),
		}));
		const ctx = makeCtx(makeFakeSession(runEphemeralTurn));
		const controller = new BtwController(ctx);
		const screenshot: ImageContent = { type: "image", data: "c2NyZWVuc2hvdA==", mimeType: "image/png" };

		expect(await controller.start("What colour is this? [Image #1]", [screenshot])).toBe(true);
		await drainBtwRequest();

		expect(runEphemeralTurn.mock.calls[0]?.[0]?.promptImages).toEqual([screenshot]);
		await controller.dispose();
	});

	it("shows an error message when no model is configured", async () => {
		const runEphemeralTurn = vi.fn(async () => ({
			replyText: "n/a",
			assistantMessage: createAssistantMessage("n/a"),
		}));
		const session = { model: undefined, runEphemeralTurn } as unknown as InteractiveModeContext["session"];
		const ctx = makeCtx(session);
		const controller = new BtwController(ctx);

		await controller.start("Anything?");
		expect(runEphemeralTurn).not.toHaveBeenCalled();
		expect(ctx.showError).toHaveBeenCalled();
	});

	it("does not allow branch while /btw is still running", async () => {
		const runEphemeralTurn = vi.fn(async () => Promise.withResolvers<RunEphemeralTurnResult>().promise);
		const ctx = makeCtx(makeFakeSession(runEphemeralTurn));
		const controller = new BtwController(ctx);

		await controller.start("Question?");

		expect(controller.canBranch()).toBe(false);
		expect(controller.handlesBranchKey()).toBe(false);
	});

	it("does not allow branch when the completed answer has no originating leaf", async () => {
		const assistantMessage = createAssistantMessage("Answer");
		const runEphemeralTurn = vi.fn(async () => ({ replyText: "Answer", assistantMessage }));
		const ctx = makeCtx(makeFakeSession(runEphemeralTurn)) as InteractiveModeContext & {
			setTestLeafId(nextLeafId: string | null): void;
		};
		ctx.setTestLeafId(null);
		const controller = new BtwController(ctx);

		await controller.start("Question?");
		await drainBtwRequest();

		expect(controller.canBranch()).toBe(false);
		expect(controller.handlesBranchKey()).toBe(true);
	});

	it("asks the focused subagent session and refuses to branch its answer into main", async () => {
		const mainTurn = vi.fn(async () => ({ replyText: "Main", assistantMessage: createAssistantMessage("Main") }));
		const focusedTurn = vi.fn(async () => ({
			replyText: "Worker answer",
			assistantMessage: createAssistantMessage("Worker answer"),
		}));
		const focusedSession = {
			...makeFakeSession(focusedTurn),
			sessionManager: {
				getLeafId: () => "worker-leaf",
				getSessionId: () => "worker-session",
				getArtifactsDir: () => undefined,
				ensureOnDisk: async () => {},
			},
		} as unknown as InteractiveModeContext["session"];
		const ctx = Object.assign(makeCtx(makeFakeSession(mainTurn)), {
			focusedAgentId: "Worker",
			viewSession: focusedSession,
		});
		const controller = new BtwController(ctx);

		await controller.start("What is the worker doing?");
		await drainBtwRequest();

		expect(focusedTurn).toHaveBeenCalledTimes(1);
		expect(mainTurn).not.toHaveBeenCalled();
		expect(controller.canCopy()).toBe(true);
		expect(controller.canBranch()).toBe(false);
		expect(controller.handlesBranchKey()).toBe(false);
		expect(await controller.handleBranch()).toBe(false);
		expect(ctx.handleBtwBranch).not.toHaveBeenCalled();
	});

	it("keeps focused-agent side conversations apart from main history in the shared artifacts directory", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-btw-focused-scope-"));
		const mainTurn = vi.fn(async () => ({
			replyText: "Main answer",
			assistantMessage: createAssistantMessage("Main"),
		}));
		const focusedTurn = vi.fn(async () => ({
			replyText: "Worker answer",
			assistantMessage: createAssistantMessage("Worker answer"),
		}));
		const ctx = makeCtx(makeFakeSession(mainTurn));
		const mainManager = SessionManager.create(directory, directory);
		ctx.sessionManager = mainManager;
		const controller = new BtwController(ctx);
		try {
			await controller.start("Main question?");
			await drainBtwRequest();
			const artifacts = mainManager.getArtifactsDir()!;
			// Subagents adopt the parent's ArtifactManager, so they report the same directory.
			const focusedSession = {
				...makeFakeSession(focusedTurn),
				sessionManager: {
					getLeafId: () => "worker-leaf",
					getSessionId: () => "worker-session",
					getArtifactsDir: () => artifacts,
					ensureOnDisk: async () => {},
				},
			} as unknown as InteractiveModeContext["session"];
			Object.assign(ctx, { focusedAgentId: "Worker", viewSession: focusedSession });

			await controller.start("");
			const panel = historySheet(ctx.shell);
			expect(panel.text(120)).not.toContain("Main question?");

			await controller.start("Worker question?");
			await drainBtwRequest();
			await controller.flush();
			expect((await BtwHistoryStore.open(artifacts)).getRecords().map(record => record.question)).toEqual([
				"Main question?",
			]);
			expect(
				(await BtwHistoryStore.open(artifacts, "worker-session")).getRecords().map(record => record.question),
			).toEqual(["Worker question?"]);
		} finally {
			await controller.dispose();
			await mainManager.flush();
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	it("heads a titled side question with its title while the model answers the full text", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-btw-title-"));
		const runEphemeralTurn = vi.fn(async (_args: RunEphemeralTurnArgs) => ({
			replyText: "Status answer",
			assistantMessage: createAssistantMessage("Status answer"),
		}));
		const ctx = makeCtx(makeFakeSession(runEphemeralTurn));
		const manager = SessionManager.create(directory, directory);
		ctx.sessionManager = manager;
		const controller = new BtwController(ctx);
		const template = "Sitrep template: list milestones and ETAs.";
		try {
			await controller.start(template, undefined, "/sitrep");
			await drainBtwRequest();
			await controller.flush();

			expect(runEphemeralTurn.mock.calls[0]?.[0].promptText).toContain(template);
			const inline = inlineText(ctx.shell, 100);
			expect(inline).toContain("/sitrep");
			expect(inline).not.toContain("Sitrep template");

			const saved = (await BtwHistoryStore.open(manager.getArtifactsDir()!)).getRecords();
			expect(saved.map(record => [record.title, record.question])).toEqual([["/sitrep", template]]);

			await controller.start("");
			const history = historySheet(ctx.shell);
			const rendered = history.text(120);
			expect(rendered).toContain("/sitrep");
			expect(rendered).not.toContain("Sitrep template");
		} finally {
			await controller.dispose();
			await manager.flush();
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	it("keeps rendering a focused answer after returning to main, parking follow-ups until re-focus", async () => {
		const pending = Promise.withResolvers<RunEphemeralTurnResult>();
		const focusedTurn = vi.fn((_args: RunEphemeralTurnArgs) => pending.promise);
		const focusedSession = {
			...makeFakeSession(focusedTurn),
			sessionManager: {
				getLeafId: () => "worker-leaf",
				getSessionId: () => "worker-session",
				getArtifactsDir: () => undefined,
				ensureOnDisk: async () => {},
			},
		} as unknown as InteractiveModeContext["session"];
		const ctx = Object.assign(makeCtx(makeFakeSession(vi.fn())), {
			focusedAgentId: "Worker" as string | undefined,
			viewSession: focusedSession,
		});
		const controller = new BtwController(ctx);

		await controller.start("What is the worker doing?");
		ctx.focusedAgentId = undefined;
		focusedTurn.mock.calls[0]?.[0].onTextDelta?.("Streaming ");
		pending.resolve({
			replyText: "Streaming worker answer",
			assistantMessage: createAssistantMessage("Streaming worker answer"),
		});
		await drainBtwRequest();

		const rendered = inlineText(ctx.shell, 120);
		expect(rendered).toContain("Streaming worker answer");
		expect(controller.canCopy()).toBe(true);
		expect(controller.canFollowUp()).toBe(false);
		expect(controller.canBranch()).toBe(false);
		ctx.focusedAgentId = "Worker";
		expect(controller.canFollowUp()).toBe(true);
		await controller.dispose();
	});

	it("refuses branch when the loaded session changed but the leaf id still matches", async () => {
		const assistantMessage = createAssistantMessage("Answer");
		const runEphemeralTurn = vi.fn(async () => ({ replyText: "Answer", assistantMessage }));
		const ctx = makeCtx(makeFakeSession(runEphemeralTurn)) as InteractiveModeContext & {
			setTestSessionId(nextSessionId: string): void;
		};
		const controller = new BtwController(ctx);

		await controller.start("Question?");
		await drainBtwRequest();
		expect(controller.canBranch()).toBe(true);

		// A resumed/branched session preserves the entry id, so the leaf still matches;
		// the session id must still gate the promotion.
		ctx.setTestSessionId("session-2");

		expect(controller.canBranch()).toBe(false);
		expect(controller.handlesBranchKey()).toBe(true);
		expect(await controller.handleBranch()).toBe(false);
		expect(ctx.handleBtwBranch).not.toHaveBeenCalled();
	});

	it("refuses a completed branch while the main turn is streaming", async () => {
		const assistantMessage = createAssistantMessage("Answer");
		const runEphemeralTurn = vi.fn(async () => ({ replyText: "Answer", assistantMessage }));
		const session = makeFakeSession(runEphemeralTurn);
		Object.defineProperty(session, "isStreaming", { value: true });
		const ctx = makeCtx(session);
		const controller = new BtwController(ctx);

		await controller.start("Question?");
		await drainBtwRequest();

		expect(controller.canBranch()).toBe(false);
		expect(controller.handlesBranchKey()).toBe(true);
		expect(await controller.handleBranch()).toBe(false);
	});

	it("does not allow branch after a complete empty reply", async () => {
		const runEphemeralTurn = vi.fn(async () => ({
			replyText: "   ",
			assistantMessage: createAssistantMessage("   "),
		}));
		const ctx = makeCtx(makeFakeSession(runEphemeralTurn));
		const controller = new BtwController(ctx);

		await controller.start("Question?");
		await drainBtwRequest();

		expect(controller.canBranch()).toBe(false);
		expect(controller.handlesBranchKey()).toBe(false);
	});

	it("does not allow branch after aborted or errored requests", async () => {
		const abortedRun = vi.fn(async () => Promise.withResolvers<RunEphemeralTurnResult>().promise);
		const abortedController = new BtwController(makeCtx(makeFakeSession(abortedRun)));
		await abortedController.start("Question?");
		expect(abortedController.handleEscape()).toBe(true);
		expect(abortedController.canBranch()).toBe(false);

		const erroredRun = vi.fn(async () => {
			throw new Error("boom");
		});
		const erroredController = new BtwController(makeCtx(makeFakeSession(erroredRun)));
		await erroredController.start("Question?");
		await drainBtwRequest();
		expect(erroredController.canBranch()).toBe(false);
	});

	it("keeps a pending branch visible and refuses to dismiss it", async () => {
		const branch = Promise.withResolvers<void>();
		const assistantMessage = createAssistantMessage("Answer");
		const runEphemeralTurn = vi.fn(async () => ({ replyText: "Answer", assistantMessage }));
		const ctx = makeCtx(makeFakeSession(runEphemeralTurn));
		ctx.handleBtwBranch = vi.fn(async () => {
			await branch.promise;
		});
		const controller = new BtwController(ctx);

		await controller.start("Question?");
		await drainBtwRequest();
		const branchPromise = controller.handleBranch();
		await Promise.resolve();
		expect(controller.handlesBranchKey()).toBe(true);

		expect(inlineText(ctx.shell, 120)).toContain("Branching to chat");
		expect(controller.handleEscape()).toBe(true);
		expect(ctx.shell.dock.slot("btw").occupied()).toBe(true);

		branch.resolve();
		await branchPromise;
	});

	it("branches the sanitized reply text and the question's images while preserving non-text assistant content", async () => {
		const assistantMessage: AssistantMessage = {
			...createAssistantMessage("raw repeated repeated repeated"),
			content: [
				{
					type: "thinking",
					thinking: "Keep this reasoning.",
					thinkingSignature: "signed-for-ephemeral-prompt",
					itemId: "item-1",
				},
				{ type: "redactedThinking", data: "encrypted-ephemeral-thinking" },
				{ type: "text", text: "raw repeated repeated repeated" },
				{ type: "text", text: "raw duplicate tail" },
			],
		};
		const runEphemeralTurn = vi.fn(async () => ({ replyText: "sanitized", assistantMessage }));
		const ctx = makeCtx(makeFakeSession(runEphemeralTurn));
		const controller = new BtwController(ctx);

		const screenshot: ImageContent = { type: "image", data: "c2NyZWVuc2hvdA==", mimeType: "image/png" };
		await controller.start("Question?", [screenshot]);
		await drainBtwRequest();

		expect(await controller.handleBranch()).toBe(true);
		expect(ctx.handleBtwBranch).toHaveBeenCalledWith(
			"Question?",
			{
				...assistantMessage,
				content: [
					{ type: "thinking", thinking: "Keep this reasoning." },
					{ type: "text", text: "sanitized" },
				],
			},
			"leaf-1",
			"session-1",
			[screenshot],
		);
	});
	it("copies the sanitized visible reply text after a complete non-empty reply", async () => {
		const copySpy = vi.spyOn(clipboard, "copyToClipboard").mockResolvedValue(undefined);
		const runEphemeralTurn = vi.fn(async (args: RunEphemeralTurnArgs) => {
			args.onTextDelta?.("duplicate streaming draft");
			return {
				replyText: "  Visible\tanswer\n\nfrom /btw  ",
				assistantMessage: createAssistantMessage("raw assistant payload"),
			};
		});
		const ctx = makeCtx(makeFakeSession(runEphemeralTurn));
		const controller = new BtwController(ctx);

		await controller.start("Question?");
		await drainBtwRequest();

		expect(controller.canCopy()).toBe(true);
		expect(await controller.handleCopy()).toBe(true);
		expect(copySpy).toHaveBeenCalledWith(replaceTabs("Visible\tanswer\n\nfrom /btw"));
		expect(inlineText(ctx.shell, 100)).toContain("Copied");
	});
	it("does not confirm a superseded panel when the clipboard settles late", async () => {
		const { promise: copyGate, resolve: releaseCopy } = Promise.withResolvers<void>();
		const copySpy = vi.spyOn(clipboard, "copyToClipboard").mockImplementation(async () => {
			await copyGate;
		});
		const runEphemeralTurn = vi.fn(async () => ({
			replyText: "First answer",
			assistantMessage: createAssistantMessage("First answer"),
		}));
		const ctx = makeCtx(makeFakeSession(runEphemeralTurn));
		const controller = new BtwController(ctx);
		try {
			await controller.start("First?");
			await drainBtwRequest();
			const copyPromise = controller.handleCopy();
			await controller.start("Second?");
			await drainBtwRequest();
			releaseCopy();
			expect(await copyPromise).toBe(true);
			expect(copySpy).toHaveBeenCalledTimes(1);
			expect(inlineText(ctx.shell, 100)).not.toContain("Copied");
		} finally {
			await controller.dispose();
		}
	});

	it("does not copy running, empty, or errored /btw answers", async () => {
		const copySpy = vi.spyOn(clipboard, "copyToClipboard").mockResolvedValue(undefined);

		const runningRun = vi.fn(async () => Promise.withResolvers<RunEphemeralTurnResult>().promise);
		const runningController = new BtwController(makeCtx(makeFakeSession(runningRun)));
		await runningController.start("Question?");
		expect(runningController.canCopy()).toBe(false);
		expect(await runningController.handleCopy()).toBe(false);
		runningController.dispose();

		const emptyRun = vi.fn(async () => ({ replyText: "   ", assistantMessage: createAssistantMessage("   ") }));
		const emptyController = new BtwController(makeCtx(makeFakeSession(emptyRun)));
		await emptyController.start("Question?");
		await drainBtwRequest();
		expect(emptyController.canCopy()).toBe(false);
		expect(await emptyController.handleCopy()).toBe(false);

		const erroredRun = vi.fn(async () => {
			throw new Error("boom");
		});
		const erroredController = new BtwController(makeCtx(makeFakeSession(erroredRun)));
		await erroredController.start("Question?");
		await drainBtwRequest();
		expect(erroredController.canCopy()).toBe(false);
		expect(await erroredController.handleCopy()).toBe(false);

		expect(copySpy).not.toHaveBeenCalled();
	});

	it("branches the sanitized reply text without native replay payload metadata", async () => {
		const providerPayload = {
			type: "openaiResponsesHistory" as const,
			provider: "openai-codex",
			dt: true,
			items: [{ type: "reasoning", encrypted_content: "raw-ephemeral-output" }],
		};
		const assistantMessage: AssistantMessage = {
			...createAssistantMessage("raw ephemeral output"),
			api: "openai-codex-responses",
			provider: "openai-codex",
			model: "gpt-5-codex",
			content: [
				{ type: "thinking", thinking: "reasoning", thinkingSignature: "native-signature", itemId: "rs_1" },
				{ type: "text", text: "raw ephemeral output" },
			],
			providerPayload,
		};
		const runEphemeralTurn = vi.fn(async () => ({ replyText: "sanitized", assistantMessage }));
		const ctx = makeCtx(makeFakeSession(runEphemeralTurn));
		const controller = new BtwController(ctx);

		await controller.start("Question?");
		await drainBtwRequest();

		expect(await controller.handleBranch()).toBe(true);
		expect(ctx.handleBtwBranch).toHaveBeenCalledWith(
			"Question?",
			{
				...assistantMessage,
				content: [
					{ type: "thinking", thinking: "reasoning" },
					{ type: "text", text: "sanitized" },
				],
				providerPayload: undefined,
			},
			"leaf-1",
			"session-1",
			undefined,
		);
	});

	it("ignores duplicate branch requests while branch promotion is in flight", async () => {
		const assistantMessage = createAssistantMessage("Answer");
		const runEphemeralTurn = vi.fn(async () => ({ replyText: "Answer", assistantMessage }));
		const ctx = makeCtx(makeFakeSession(runEphemeralTurn));
		const branchStarted = Promise.withResolvers<void>();
		const releaseBranch = Promise.withResolvers<void>();
		ctx.handleBtwBranch = vi.fn(async () => {
			branchStarted.resolve();
			await releaseBranch.promise;
		});
		const controller = new BtwController(ctx);

		await controller.start("Question?");
		await drainBtwRequest();

		const firstBranch = controller.handleBranch();
		await branchStarted.promise;

		expect(controller.canBranch()).toBe(false);
		expect(await controller.handleBranch()).toBe(false);
		expect(ctx.handleBtwBranch).toHaveBeenCalledTimes(1);

		releaseBranch.resolve();
		expect(await firstBranch).toBe(true);
	});

	it("does not branch a completed answer after the session leaf changes", async () => {
		const assistantMessage = createAssistantMessage("Answer");
		const runEphemeralTurn = vi.fn(async () => ({ replyText: "Answer", assistantMessage }));
		const ctx = makeCtx(makeFakeSession(runEphemeralTurn)) as InteractiveModeContext & {
			setTestLeafId(nextLeafId: string | null): void;
		};
		const controller = new BtwController(ctx);

		await controller.start("Question?");
		await drainBtwRequest();
		expect(controller.canBranch()).toBe(true);

		ctx.setTestLeafId("leaf-2");

		expect(controller.canBranch()).toBe(false);
		expect(await controller.handleBranch()).toBe(false);
		expect(ctx.handleBtwBranch).not.toHaveBeenCalled();
	});

	it("clears stored branch state on escape and dispose", async () => {
		const runEphemeralTurn = vi.fn(async () => ({
			replyText: "Answer",
			assistantMessage: createAssistantMessage("Answer"),
		}));
		const escapeController = new BtwController(makeCtx(makeFakeSession(runEphemeralTurn)));
		await escapeController.start("Question?");
		await drainBtwRequest();
		expect(escapeController.canBranch()).toBe(true);
		expect(escapeController.handleEscape()).toBe(true);
		expect(escapeController.canBranch()).toBe(false);

		const disposeController = new BtwController(makeCtx(makeFakeSession(runEphemeralTurn)));
		await disposeController.start("Question?");
		await drainBtwRequest();
		expect(disposeController.canBranch()).toBe(true);
		disposeController.dispose();
		expect(disposeController.canBranch()).toBe(false);
	});

	it("keeps closed answers across resume without changing the main journal or model context", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-btw-history-controller-"));
		const manager = SessionManager.create(directory, directory);
		const session = makeFakeSession(async () => ({
			replyText: "Saved side answer",
			assistantMessage: createAssistantMessage("Saved side answer"),
		}));
		const ctx = makeCtx(session);
		ctx.sessionManager = manager;
		const controller = new BtwController(ctx);
		try {
			manager.appendMessage({ role: "user", content: "Main task", timestamp: Date.now() });
			await manager.ensureOnDisk();
			const file = manager.getSessionFile()!;
			const before = await Bun.file(file).text();
			const leaf = manager.getLeafId();
			await controller.start("Side question");
			await drainBtwRequest();
			controller.handleEscape();
			await controller.flush();
			expect(await Bun.file(file).text()).toBe(before);
			expect(manager.getLeafId()).toBe(leaf);
			expect(JSON.stringify(manager.buildSessionContext().messages)).not.toContain("Saved side answer");
			await controller.dispose();

			const restored = new BtwController(ctx);
			await restored.start("");
			const panel = historySheet(ctx.shell);
			const copy = vi.spyOn(clipboard, "copyToClipboard").mockResolvedValue(undefined);
			panel.press("c");
			await drainBtwRequest();
			expect(copy).toHaveBeenCalledWith("Saved side answer");
			expect(panel.text(120)).toContain("Copied");
			await restored.dispose();
		} finally {
			await controller.dispose();
			await manager.flush();
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	it("persists cancellation and ignores late output after switching sessions", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-btw-cancel-"));
		const pending = Promise.withResolvers<RunEphemeralTurnResult>();
		const run = vi.fn((_args: RunEphemeralTurnArgs) => pending.promise);
		const ctx = makeCtx(makeFakeSession(run));
		ctx.sessionManager = SessionManager.create(directory, directory);
		const controller = new BtwController(ctx);
		try {
			await controller.start("Cancel this");
			const artifacts = ctx.sessionManager.getArtifactsDir()!;
			run.mock.calls[0]?.[0].onTextDelta?.("Partial answer");
			await controller.dispose();
			ctx.sessionManager = SessionManager.inMemory();
			pending.resolve({ replyText: "Late answer", assistantMessage: createAssistantMessage("Late answer") });
			await drainBtwRequest();
			await controller.flush();
			const saved = (await BtwHistoryStore.open(artifacts)).getRecords();
			expect(saved.map(record => [record.answer, record.status])).toEqual([["Partial answer", "cancelled"]]);
			await controller.start("");
			const panel = historySheet(ctx.shell);
			expect(panel.text(100)).not.toContain("Partial answer");
		} finally {
			await controller.dispose();
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
});

describe("BtwController inject", () => {
	const steeringReply =
		"It keeps retrying the flaky build.\n<inject>\n/stop retrying; run the unit tests first\n</inject>";
	const steeringPrompt = "/stop retrying; run the unit tests first";
	/** The default `app.btw.inject` key. */
	const altI = "alt+i";
	interface InjectPromptOptions {
		expandPromptTemplates?: boolean;
		onPromptAdmitted?: () => void;
	}
	type InjectPrompt = (text: string, options?: InjectPromptOptions) => Promise<boolean>;

	const admitted: InjectPrompt = async (_text, options) => {
		options?.onPromptAdmitted?.();
		return true;
	};

	function steeringTurn() {
		return vi.fn(async (_args: RunEphemeralTurnArgs) => ({
			replyText: steeringReply,
			assistantMessage: createAssistantMessage(steeringReply),
		}));
	}

	function makeInjectSession(
		runEphemeralTurn: (args: RunEphemeralTurnArgs) => Promise<RunEphemeralTurnResult>,
		prompt = vi.fn(admitted),
	) {
		return Object.assign(makeFakeSession(runEphemeralTurn), { prompt });
	}

	const shown = (ctx: InteractiveModeContext) => inlineText(ctx.shell, 100);

	it("with btw.inject on, shows the block and sends it verbatim and unexpanded, exactly once", async () => {
		const runEphemeralTurn = steeringTurn();
		const session = makeInjectSession(runEphemeralTurn);
		const ctx = makeCtx(session, { "btw.inject": true });
		const controller = new BtwController(ctx);

		await controller.start("Write a steering prompt to stop it");
		await drainBtwRequest();

		expect(runEphemeralTurn.mock.calls[0]?.[0].promptText).toContain("<inject>");
		expect(shown(ctx)).toContain(BTW_INJECT_LABEL);
		expect(shown(ctx)).not.toContain("<inject>");

		expect(controller.handleInject()).toBe(true);
		// A leading slash stays text: no slash-command or template expansion.
		expect(session.prompt).toHaveBeenCalledWith(
			steeringPrompt,
			expect.objectContaining({ expandPromptTemplates: false }),
		);
		expect(shown(ctx)).toContain(BTW_INJECTED_LABEL);
		expect(controller.canInject()).toBe(false);
		expect(controller.handleInject()).toBe(false);
		expect(session.prompt).toHaveBeenCalledTimes(1);
	});

	it("ignores the key while a send is in flight and rolls a failed or dropped send back so it can retry", async () => {
		const dropped = Promise.withResolvers<boolean>();
		const refused = Promise.withResolvers<boolean>();
		const prompt = vi
			.fn<InjectPrompt>()
			// Still being admitted when it is dropped.
			.mockImplementationOnce(() => dropped.promise)
			// Admitted, then refused before any turn runs (no model selected).
			.mockImplementationOnce((_text, options) => {
				options?.onPromptAdmitted?.();
				return refused.promise;
			})
			// Dropped by an abort race that resolves without ever admitting the prompt.
			.mockImplementationOnce(async () => true);
		const ctx = makeCtx(makeInjectSession(steeringTurn(), prompt), { "btw.inject": true });
		const controller = new BtwController(ctx);
		await controller.start("Write a steering prompt to stop it");
		await drainBtwRequest();

		expect(controller.handleInject()).toBe(true);
		expect(controller.handleInject()).toBe(false);
		dropped.reject(new Error("The prompt was dropped"));
		await drainBtwRequest();
		expect(controller.canInject()).toBe(true);

		expect(controller.handleInject()).toBe(true);
		expect(shown(ctx)).toContain(BTW_INJECTED_LABEL);
		refused.reject(new Error("No model selected."));
		await drainBtwRequest();
		expect(shown(ctx)).not.toContain(BTW_INJECTED_LABEL);
		expect(controller.canInject()).toBe(true);
		expect(ctx.showError).toHaveBeenCalledWith(expect.stringContaining("No model selected."));
		expect(controller.handleInject()).toBe(true);
		await drainBtwRequest();
		expect(shown(ctx)).not.toContain(BTW_INJECTED_LABEL);
		expect(controller.canInject()).toBe(true);
		expect(ctx.showStatus).toHaveBeenLastCalledWith(expect.stringContaining("not sent"), expect.anything());
		expect(prompt).toHaveBeenCalledTimes(3);
	});

	it("refuses to inject while a branch of the same answer is in flight", async () => {
		const branch = Promise.withResolvers<void>();
		const session = makeInjectSession(steeringTurn());
		const ctx = makeCtx(session, { "btw.inject": true });
		Object.assign(ctx, { handleBtwBranch: vi.fn(() => branch.promise) });
		const controller = new BtwController(ctx);
		await controller.start("Write a steering prompt to stop it");
		await drainBtwRequest();

		const branching = controller.handleBranch();
		expect(controller.canInject()).toBe(false);
		expect(controller.handleInject()).toBe(false);
		branch.resolve();
		await branching;
		expect(session.prompt).not.toHaveBeenCalled();
	});

	it("with btw.inject off, neither asks for a block nor sends one the answer contains", async () => {
		const runEphemeralTurn = steeringTurn();
		const session = makeInjectSession(runEphemeralTurn);
		const controller = new BtwController(makeCtx(session));

		await controller.start("Write a steering prompt to stop it");
		await drainBtwRequest();

		expect(runEphemeralTurn.mock.calls[0]?.[0].promptText).not.toContain("<inject>");
		expect(controller.handleInject()).toBe(false);
		expect(session.prompt).not.toHaveBeenCalled();
	});

	it("gives collab guests neither the instruction nor the block, since their turns run on the host", async () => {
		const runEphemeralTurn = steeringTurn();
		const session = makeInjectSession(runEphemeralTurn);
		const ctx = Object.assign(makeCtx(session, { "btw.inject": true }), { collabGuest: {} });
		const controller = new BtwController(ctx);

		await controller.start("Write a steering prompt to stop it");
		await drainBtwRequest();

		expect(runEphemeralTurn.mock.calls[0]?.[0].promptText).not.toContain("<inject>");
		expect(shown(ctx)).not.toContain(BTW_INJECT_LABEL);
		expect(controller.handleInject()).toBe(false);
		expect(session.prompt).not.toHaveBeenCalled();
	});

	it("never injects a focused subagent's side answer into main", async () => {
		const focusedTurn = steeringTurn();
		const focusedSession = {
			...makeFakeSession(focusedTurn),
			sessionManager: {
				getLeafId: () => "worker-leaf",
				getSessionId: () => "worker-session",
				getArtifactsDir: () => undefined,
				ensureOnDisk: async () => {},
			},
		} as unknown as InteractiveModeContext["session"];
		const main = makeInjectSession(steeringTurn());
		const ctx = Object.assign(makeCtx(main, { "btw.inject": true }), {
			focusedAgentId: "Worker",
			viewSession: focusedSession,
		});
		const controller = new BtwController(ctx);

		await controller.start("What is the worker doing?");
		await drainBtwRequest();

		expect(focusedTurn.mock.calls[0]?.[0].promptText).not.toContain("<inject>");
		expect(controller.handleInject()).toBe(false);
		expect(main.prompt).not.toHaveBeenCalled();
	});

	it("in Tern sends from the history sheet with the inject key, once per answer", async () => {
		const session = makeInjectSession(steeringTurn());
		const ctx = makeCtx(session, { "btw.inject": true });
		setNative(ctx.shell, true);
		const controller = new BtwController(ctx);

		await controller.start("Write a steering prompt to stop it");
		await drainBtwRequest();
		await controller.start("");
		const sheet = historySheet(ctx.shell);

		// A bare letter never sends: only the bound chord does.
		sheet.press("i");
		expect(session.prompt).not.toHaveBeenCalled();
		sheet.press(altI);
		sheet.press(altI);
		expect(session.prompt).toHaveBeenCalledTimes(1);
		expect(session.prompt).toHaveBeenCalledWith(steeringPrompt, expect.anything());
		expect(sheet.text()).toContain(BTW_INJECTED_LABEL);
		// The transcript note shows the block sent and offers it no more.
		const note = noteIn(ctx.shell);
		expect(note.text()).toContain(BTW_INJECTED_LABEL);
		expect(note.menu).not.toContain("btw-inject");
		await controller.dispose();
	});

	it("in Tern sends from the note's menu, once per answer", async () => {
		const session = makeInjectSession(steeringTurn());
		const ctx = makeCtx(session, { "btw.inject": true });
		setNative(ctx.shell, true);
		const controller = new BtwController(ctx);

		await controller.start("Write a steering prompt to stop it");
		await drainBtwRequest();
		const note = noteIn(ctx.shell);
		expect(note.text()).toContain(BTW_INJECT_LABEL);
		expect(note.menu).toContain("btw-inject");
		note.press("btw-inject");
		note.press("btw-inject");
		expect(session.prompt).toHaveBeenCalledTimes(1);
		expect(session.prompt).toHaveBeenCalledWith(steeringPrompt, expect.anything());
		await controller.dispose();
	});

	it("offers no inject for answers saved by an earlier run; their blocks read as plain text", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-btw-inject-stale-"));
		const manager = SessionManager.create(directory, directory);
		const session = makeInjectSession(steeringTurn());
		const ctx = makeCtx(session, { "btw.inject": true });
		ctx.sessionManager = manager;
		const earlier = new BtwController(ctx);
		try {
			manager.appendMessage({ role: "user", content: "Main task", timestamp: Date.now() });
			await manager.ensureOnDisk();
			await earlier.start("Write a steering prompt to stop it");
			await drainBtwRequest();
			earlier.handleEscape();
			await earlier.flush();
			await earlier.dispose();

			const restarted = new BtwController(ctx);
			await restarted.start("");
			const sheet = historySheet(ctx.shell);
			const text = sheet.text(120);
			expect(text).toContain("run the unit tests first");
			expect(text).not.toContain(BTW_INJECT_LABEL);
			sheet.press(altI);
			expect(session.prompt).not.toHaveBeenCalled();
			await restarted.dispose();
		} finally {
			await earlier.dispose();
			await manager.flush();
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	it("waits for startup-deferred extensions before sending, and drops the send if the session switched", async () => {
		let load = Promise.withResolvers<void>();
		const session = Object.assign(makeInjectSession(steeringTurn()), {
			hasPendingDeferredExtensions: true,
			loadDeferredExtensions: vi.fn(() => load.promise),
		});
		const ctx = makeCtx(session, { "btw.inject": true });
		const first = new BtwController(ctx);
		await first.start("Write a steering prompt to stop it");
		await drainBtwRequest();
		expect(first.handleInject()).toBe(true);
		expect(session.prompt).not.toHaveBeenCalled();
		// A branch now would race the pending send.
		expect(first.canBranch()).toBe(false);
		load.resolve();
		await drainBtwRequest();
		expect(session.prompt).toHaveBeenCalledTimes(1);
		expect(first.canBranch()).toBe(true);

		load = Promise.withResolvers<void>();
		const second = new BtwController(ctx);
		await second.start("Write a steering prompt to stop it");
		await drainBtwRequest();
		expect(second.handleInject()).toBe(true);
		// `/new` or a session switch disposes the controller while the extensions still load.
		await second.dispose();
		// The cancelled send no longer blocks branching in the session loaded next.
		await second.start("Write a steering prompt to stop it");
		await drainBtwRequest();
		expect(second.canBranch()).toBe(true);
		load.resolve();
		await drainBtwRequest();
		expect(session.prompt).toHaveBeenCalledTimes(1);
		await second.dispose();

		load = Promise.withResolvers<void>();
		const third = new BtwController(ctx);
		await third.start("Write a steering prompt to stop it");
		await drainBtwRequest();
		expect(third.handleInject()).toBe(true);
		// `/move` or `/wt` starts while the extensions still load; they finish mid-relocation.
		const moved = await third.withSessionMove(async () => {
			load.resolve();
			await drainBtwRequest();
			return false;
		});
		expect(moved).toBe(false);
		expect(session.prompt).toHaveBeenCalledTimes(1);
		expect(third.canInject()).toBe(true);
		await third.dispose();
	});

	it("never offers an answer asked while btw.inject was off, even after turning it on", async () => {
		const session = makeInjectSession(steeringTurn());
		const ctx = makeCtx(session);
		const controller = new BtwController(ctx);
		await controller.start("Write a steering prompt to stop it");
		await drainBtwRequest();

		cfgBtwInject.override(ctx.settings, true);
		await controller.start("");
		const sheet = historySheet(ctx.shell);
		expect(sheet.text(120)).not.toContain(BTW_INJECT_LABEL);
		sheet.press(altI);
		expect(session.prompt).not.toHaveBeenCalled();
	});

	it("takes back a send the session drops, so the key is the one way to retry", async () => {
		let reclaimed: boolean | undefined;
		const prompt = vi.fn<InjectPrompt>(async text => {
			// The session hands a dropped prompt to its drop handler, then rejects (`throwOnDrop`).
			reclaimed = controller.reclaimDroppedPrompt({ text, reason: "Session cost cap reached" });
			throw new Error("Prompt dropped before provider dispatch.");
		});
		const ctx = makeCtx(makeInjectSession(steeringTurn(), prompt), { "btw.inject": true });
		const controller = new BtwController(ctx);
		await controller.start("Write a steering prompt to stop it");
		await drainBtwRequest();

		expect(controller.handleInject()).toBe(true);
		await drainBtwRequest();
		expect(reclaimed).toBe(true);
		expect(ctx.showError).toHaveBeenCalledTimes(1);
		expect(ctx.showError).toHaveBeenCalledWith(expect.stringContaining("Session cost cap reached"));
		expect(shown(ctx)).not.toContain(BTW_INJECTED_LABEL);
		expect(controller.canInject()).toBe(true);
		// Any other dropped prompt still goes back to the editor.
		expect(controller.reclaimDroppedPrompt({ text: "a typed prompt" })).toBe(false);
	});

	it("keeps the mark when the send fails after reaching the transcript, so it is never sent twice", async () => {
		const messages: { role: string }[] = [];
		const prompt = vi.fn<InjectPrompt>(async (_text, options) => {
			options?.onPromptAdmitted?.();
			messages.push({ role: "user" });
			throw new Error("Provider crashed mid-turn");
		});
		const session = Object.assign(makeInjectSession(steeringTurn(), prompt), { messages });
		const ctx = makeCtx(session, { "btw.inject": true });
		const controller = new BtwController(ctx);
		await controller.start("Write a steering prompt to stop it");
		await drainBtwRequest();

		expect(controller.handleInject()).toBe(true);
		await drainBtwRequest();
		expect(shown(ctx)).toContain(BTW_INJECTED_LABEL);
		expect(controller.canInject()).toBe(false);
		expect(ctx.showError).toHaveBeenCalledWith(expect.stringContaining("Provider crashed mid-turn"));
		expect(ctx.showError).not.toHaveBeenCalledWith(expect.stringContaining("Cannot inject"));
		expect(prompt).toHaveBeenCalledTimes(1);
	});
});
