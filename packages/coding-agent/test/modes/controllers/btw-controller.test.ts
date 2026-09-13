import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage, Usage } from "@oh-my-pi/pi-ai";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { BtwHistoryPanel } from "@oh-my-pi/pi-coding-agent/modes/components/btw-history-panel";
import { BtwHistoryStore } from "@oh-my-pi/pi-coding-agent/session/btw-history";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { BtwPanelComponent } from "@oh-my-pi/pi-coding-agent/modes/components/btw-panel";
import { BtwController } from "@oh-my-pi/pi-coding-agent/modes/controllers/btw-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import * as clipboard from "@oh-my-pi/pi-coding-agent/utils/clipboard";
import { Container, replaceTabs, type TUI } from "@oh-my-pi/pi-tui";

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
		runEphemeralTurn,
	} as unknown as InteractiveModeContext["session"];
}

function makeCtx(session: InteractiveModeContext["session"], btwContainer = new Container()): InteractiveModeContext {
	let leafId: string | null = "leaf-1";
	let sessionId = "session-1";
	return {
		ui: {
			requestRender: vi.fn(),
			requestComponentRender: vi.fn(),
			showOverlay: vi.fn(() => ({ hide: vi.fn() })),
			setFocus: vi.fn(),
			terminal: { rows: 30 },
		} as unknown as TUI,
		btwContainer,
		session,
		sessionManager: {
			getLeafId: () => leafId,
			getSessionId: () => sessionId,
			getArtifactsDir: () => undefined,
			ensureOnDisk: async () => {},
		} as unknown as InteractiveModeContext["sessionManager"],
		showStatus: vi.fn(),
		showError: vi.fn(),
		handleBtwBranch: vi.fn(async () => {}),
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

beforeAll(async () => {
	await initTheme();
});
async function drainBtwRequest(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

describe("BtwPanelComponent", () => {
	it("is branchable only after a complete non-empty answer", () => {
		const ui = { requestRender: vi.fn(), requestComponentRender: vi.fn() } as unknown as TUI;
		const panel = new BtwPanelComponent({ question: "Question?", tui: ui });

		expect(panel.isBranchable()).toBe(false);
		panel.setAnswer("   ");
		panel.markComplete();
		expect(panel.isBranchable()).toBe(false);
		panel.setAnswer("Answer");
		expect(panel.isBranchable()).toBe(true);
	});
});

describe("BtwController", () => {
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
		const btwContainer = new Container();
		const ctx = makeCtx(makeFakeSession(runEphemeralTurn), btwContainer);
		const controller = new BtwController(ctx);

		await controller.start("Question?");
		expect(btwContainer.children).toHaveLength(1);
		expect(controller.handleEscape()).toBe(true);
		expect(runEphemeralTurn.mock.calls[0]?.[0].signal?.aborted).toBe(true);
		expect(btwContainer.children).toHaveLength(1);
		expect(controller.hasActiveRequest()).toBe(true);
		expect(controller.handleEscape()).toBe(true);
		expect(btwContainer.children).toHaveLength(0);
		expect(controller.hasActiveRequest()).toBe(false);
		pending.resolve({ replyText: "Late answer", assistantMessage: createAssistantMessage("Late answer") });
		await drainBtwRequest();
		await controller.dispose();
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
		expect(ctx.ui.showOverlay).toHaveBeenCalledTimes(1);
		expect(controller.hasActiveRequest()).toBe(false);
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

	it("allows branch after a complete non-empty reply", async () => {
		const assistantMessage = createAssistantMessage("Answer");
		const runEphemeralTurn = vi.fn(async () => ({ replyText: "Answer", assistantMessage }));
		const ctx = makeCtx(makeFakeSession(runEphemeralTurn));
		const controller = new BtwController(ctx);

		await controller.start("Question?");
		await drainBtwRequest();

		expect(controller.canBranch()).toBe(true);
		expect(controller.handlesBranchKey()).toBe(true);
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
		const btwContainer = new Container();
		const ctx = makeCtx(session, btwContainer);
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

	it("handleBranch returns false and does not call the context when not branchable", async () => {
		const runEphemeralTurn = vi.fn(async () => ({ replyText: "", assistantMessage: createAssistantMessage("") }));
		const ctx = makeCtx(makeFakeSession(runEphemeralTurn));
		const controller = new BtwController(ctx);

		await controller.start("Question?");
		await drainBtwRequest();

		expect(await controller.handleBranch()).toBe(false);
		expect(ctx.handleBtwBranch).not.toHaveBeenCalled();
	});

	it("handleBranch calls the context with the question and full assistant message when branchable", async () => {
		const assistantMessage = createAssistantMessage("Answer");
		const runEphemeralTurn = vi.fn(async () => ({ replyText: "Answer", assistantMessage }));
		const ctx = makeCtx(makeFakeSession(runEphemeralTurn));
		const controller = new BtwController(ctx);

		await controller.start("Question?");
		await drainBtwRequest();

		expect(await controller.handleBranch()).toBe(true);
		expect(ctx.handleBtwBranch).toHaveBeenCalledWith("Question?", assistantMessage, "leaf-1", "session-1");
	});

	it("keeps a pending branch visible and refuses to dismiss it", async () => {
		const branch = Promise.withResolvers<void>();
		const assistantMessage = createAssistantMessage("Answer");
		const runEphemeralTurn = vi.fn(async () => ({ replyText: "Answer", assistantMessage }));
		const btwContainer = new Container();
		const ctx = makeCtx(makeFakeSession(runEphemeralTurn), btwContainer);
		ctx.handleBtwBranch = vi.fn(async () => {
			await branch.promise;
		});
		const controller = new BtwController(ctx);

		await controller.start("Question?");
		await drainBtwRequest();
		const branchPromise = controller.handleBranch();
		await Promise.resolve();
		expect(controller.handlesBranchKey()).toBe(true);

		const panel = btwContainer.children[0];
		expect(Bun.stripANSI(panel?.render(120).join("\n") ?? "")).toContain("Branching to chat");
		expect(controller.handleEscape()).toBe(true);
		expect(btwContainer.children).toHaveLength(1);

		branch.resolve();
		await branchPromise;
	});

	it("branches the sanitized reply text while preserving non-text assistant content", async () => {
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

		await controller.start("Question?");
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
		const showOverlay = vi.spyOn(ctx.ui, "showOverlay");
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
			const panel = showOverlay.mock.calls.at(-1)?.[0];
			if (!(panel instanceof BtwHistoryPanel)) throw new Error("Expected BTW history");
			const copy = vi.spyOn(clipboard, "copyToClipboard").mockResolvedValue(undefined);
			panel.handleInput("c");
			await drainBtwRequest();
			expect(copy).toHaveBeenCalledWith("Saved side answer");
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
		const showOverlay = vi.spyOn(ctx.ui, "showOverlay");
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
			const panel = showOverlay.mock.calls.at(-1)?.[0];
			if (!(panel instanceof BtwHistoryPanel)) throw new Error("Expected BTW history");
			expect(Bun.stripANSI(panel.render(100).join("\n"))).not.toContain("Partial answer");
		} finally {
			await controller.dispose();
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
});
