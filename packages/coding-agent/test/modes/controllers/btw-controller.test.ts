import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage, Usage } from "@oh-my-pi/pi-ai";
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
		ui: { requestRender: vi.fn(), requestComponentRender: vi.fn() } as unknown as TUI,
		btwContainer,
		session,
		sessionManager: {
			getLeafId: () => leafId,
			getSessionId: () => sessionId,
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

	it("advertises copy and branch actions after a complete non-empty answer", () => {
		const ui = { requestRender: vi.fn(), requestComponentRender: vi.fn() } as unknown as TUI;
		const panel = new BtwPanelComponent({ question: "Question?", tui: ui });

		panel.setAnswer("Answer");
		panel.markComplete();

		const rendered = Bun.stripANSI(panel.render(120).join("\n"));
		expect(rendered).toContain("c copy");
		expect(rendered).toContain("b branch to chat");
		expect(rendered).toContain("Esc dismiss");
	});

	it("hides the branch action when the controller rejects the current leaf", () => {
		const ui = { requestRender: vi.fn(), requestComponentRender: vi.fn() } as unknown as TUI;
		const panel = new BtwPanelComponent({ question: "Question?", tui: ui, canBranch: () => false });

		panel.setAnswer("Answer");
		panel.markComplete();

		const rendered = Bun.stripANSI(panel.render(120).join("\n"));
		expect(rendered).toContain("c copy");
		expect(rendered).not.toContain("b branch to chat");
	});
});

describe("BtwController", () => {
	it("dispatches the question to runEphemeralTurn with the btw prompt wrapper and a fresh signal", async () => {
		const runEphemeralTurn = vi.fn(async (_args: RunEphemeralTurnArgs) => ({
			replyText: "Answer",
			assistantMessage: createAssistantMessage("Answer"),
		}));
		const ctx = makeCtx(makeFakeSession(runEphemeralTurn));
		const controller = new BtwController(ctx);

		await controller.start("What changed?");
		// Drain microtasks so the inner promise can resolve.
		await Promise.resolve();
		await Promise.resolve();

		expect(runEphemeralTurn).toHaveBeenCalledTimes(1);
		const callArg = runEphemeralTurn.mock.calls[0]?.[0];
		expect(callArg).toBeDefined();
		expect(callArg?.promptText).toContain("<btw>");
		expect(callArg?.promptText).toContain("What changed?");
		expect(callArg?.signal).toBeInstanceOf(AbortSignal);
		expect(typeof callArg?.onTextDelta).toBe("function");
		expect(controller.hasActiveRequest()).toBe(true);
	});

	it("renders completed /btw answers with copy and branch affordances", async () => {
		const runEphemeralTurn = vi.fn(async () => ({
			replyText: "Answer",
			assistantMessage: createAssistantMessage("Answer"),
		}));
		const btwContainer = new Container();
		const ctx = makeCtx(makeFakeSession(runEphemeralTurn), btwContainer);
		const controller = new BtwController(ctx);

		await controller.start("What changed?");
		await drainBtwRequest();

		const panel = btwContainer.children[0] as BtwPanelComponent | undefined;
		expect(panel).toBeDefined();
		const rendered = Bun.stripANSI(panel?.render(120).join("\n") ?? "");
		expect(rendered).toContain("c copy");
		expect(rendered).toContain("b branch to chat");
	});

	it("replaces a previous request by aborting it before issuing the next runEphemeralTurn", async () => {
		const signals: AbortSignal[] = [];
		const first = Promise.withResolvers<RunEphemeralTurnResult>();
		const firstPromise = first.promise;
		const runEphemeralTurn = vi
			.fn<(args: RunEphemeralTurnArgs) => Promise<RunEphemeralTurnResult>>()
			.mockImplementationOnce(async args => {
				signals.push(args.signal as AbortSignal);
				return firstPromise;
			})
			.mockImplementationOnce(async args => {
				signals.push(args.signal as AbortSignal);
				return { replyText: "second", assistantMessage: createAssistantMessage("second") };
			});
		const btwContainer = new Container();
		const ctx = makeCtx(makeFakeSession(runEphemeralTurn), btwContainer);
		const controller = new BtwController(ctx);

		await controller.start("First?");
		await controller.start("Second?");
		// Allow the second call to settle.
		await Promise.resolve();
		await Promise.resolve();

		expect(runEphemeralTurn).toHaveBeenCalledTimes(2);
		expect(signals[0]?.aborted).toBe(true);
		expect(signals[1]?.aborted).toBe(false);
		expect(btwContainer.children).toHaveLength(1);
		// Allow the orphaned first request to finish to keep the test clean.
		first.resolve({ replyText: "first", assistantMessage: createAssistantMessage("first") });
	});

	it("clears the panel when the active request is dismissed via Escape", async () => {
		const runEphemeralTurn = vi.fn(async () => Promise.withResolvers<RunEphemeralTurnResult>().promise);
		const btwContainer = new Container();
		const ctx = makeCtx(makeFakeSession(runEphemeralTurn), btwContainer);
		const controller = new BtwController(ctx);

		await controller.start("Question?");
		expect(btwContainer.children).toHaveLength(1);
		expect(controller.handleEscape()).toBe(true);
		expect(btwContainer.children).toHaveLength(0);
		expect(controller.hasActiveRequest()).toBe(false);
	});

	it("rejects empty questions before issuing the side-channel call", async () => {
		const runEphemeralTurn = vi.fn(async () => ({
			replyText: "n/a",
			assistantMessage: createAssistantMessage("n/a"),
		}));
		const ctx = makeCtx(makeFakeSession(runEphemeralTurn));
		const controller = new BtwController(ctx);

		await controller.start("   ");
		expect(runEphemeralTurn).not.toHaveBeenCalled();
		expect(controller.hasActiveRequest()).toBe(false);
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
		expect(ctx.showStatus).toHaveBeenCalledWith("/btw branch unavailable: the session changed since /btw started", {
			dim: true,
		});
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
		const panel = btwContainer.children[0];
		expect(Bun.stripANSI(panel?.render(120).join("\n") ?? "")).not.toContain("b branch to chat");
		expect(await controller.handleBranch()).toBe(false);
		expect(ctx.showStatus).toHaveBeenCalledWith("/btw branch unavailable: a turn is still running", {
			dim: true,
		});
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
		expect(ctx.showStatus).toHaveBeenCalledWith("/btw branch is in progress", { dim: true });

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
		expect(ctx.showStatus).toHaveBeenCalledWith("Copied /btw answer to clipboard");
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
});
