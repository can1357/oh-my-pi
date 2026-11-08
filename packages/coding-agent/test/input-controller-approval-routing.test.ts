/**
 * A tool approval waiting in the main session keeps the composer mounted, and a
 * message typed there steers the turn that asked, denying the call. When the
 * user is viewing a subagent, that submission must still reach the main
 * session: sent to the focused child, it never denies the approval.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as builtinSlashCommands from "../src/slash-commands/builtin-registry";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { ApprovalSubmit, InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

afterEach(() => {
	vi.restoreAllMocks();
});

function createContext(approvalOwnsComposer: boolean, collabGuest?: { readOnly: boolean }) {
	const mainPrompt = vi.fn(async () => true);
	const focusedPrompt = vi.fn(async () => true);
	const editor = {
		pendingImages: [],
		pendingImageLinks: [],
		imageLinks: undefined,
		addToHistory: vi.fn(),
		setText: vi.fn(),
		getText: () => "",
		getExpandedText: () => "",
		clearDraft: vi.fn(),
		setCollapsedText: vi.fn(),
		composerChips: () => [],
	} as unknown as InteractiveModeContext["editor"];
	const ctx = {
		editor,
		ui: { requestRender: vi.fn() },
		session: {
			isStreaming: true,
			isCompacting: false,
			isBashRunning: false,
			isEvalRunning: false,
			queuedMessageCount: 0,
			extensionRunner: undefined,
			customCommands: [],
			promptTemplates: [],
			slashCommands: [],
			prompt: mainPrompt,
		},
		viewSession: { isStreaming: true, queuedMessageCount: 0, prompt: focusedPrompt, abort: vi.fn(async () => {}) },
		focusedAgentId: "Worker",
		approvalOwnsComposer,
		collabGuest,
		sessionManager: { putBlob: vi.fn() },
		loopModeEnabled: false,
		flushPendingBashComponents: vi.fn(),
		startPendingSubmission: vi.fn((input: { text: string }) => ({ ...input, cancelled: false, started: false })),
		withLocalSubmission: async (_text: string, fn: () => unknown) => fn(),
		updatePendingMessagesDisplay: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		showStatus: vi.fn(),
		showError: vi.fn(),
		handleBashCommand: vi.fn(),
		queueCompactionMessage: vi.fn(),
		skillCommands: new Map(),
		fileSlashCommands: new Set<string>(),
		isBashMode: false,
		isPythonMode: false,
		compactionQueuedMessages: [],
		locallySubmittedUserSignatures: new Set<string>(),
	} as unknown as InteractiveModeContext;
	return { ctx, mainPrompt, focusedPrompt };
}

describe("approval composer routing from a focused view", () => {
	it("steers the main session while its approval owns the composer, else the focused agent", async () => {
		for (const owned of [true, false]) {
			const { ctx, mainPrompt, focusedPrompt } = createContext(owned);
			const controller = new InputController(ctx);
			controller.setupEditorSubmitHandler();

			await ctx.editor.onSubmit?.("keep the build dir");

			expect(mainPrompt).toHaveBeenCalledTimes(owned ? 1 : 0);
			expect(focusedPrompt).toHaveBeenCalledTimes(owned ? 0 : 1);
		}
	});
});

describe("approval chord outcome mapping", () => {
	it("plain note queues a steer and reports steered", async () => {
		const { ctx, mainPrompt } = createContext(true);
		const approval: ApprovalSubmit = { steer: vi.fn(async () => {}) };
		const outcome = await new InputController(ctx).submitApprovalNote("keep the build dir", approval);
		expect(outcome).toBe("steered");
		expect(approval.steer).toHaveBeenCalledWith("keep the build dir", undefined);
		expect(mainPrompt).not.toHaveBeenCalled();
	});

	it("dispatched command reports dispatched and does not steer", async () => {
		const { ctx, mainPrompt } = createContext(true);
		vi.spyOn(builtinSlashCommands, "executeBuiltinSlashCommand").mockResolvedValue(true);
		const approval: ApprovalSubmit = { steer: vi.fn(async () => {}) };
		const outcome = await new InputController(ctx).submitApprovalNote("/settings", approval);
		expect(outcome).toBe("dispatched");
		expect(approval.steer).not.toHaveBeenCalled();
		expect(mainPrompt).not.toHaveBeenCalled();
	});

	it("read-only guest reports kept and sends nothing", async () => {
		const { ctx, mainPrompt } = createContext(true, { readOnly: true });
		vi.spyOn(builtinSlashCommands, "executeBuiltinSlashCommand").mockResolvedValue(false);
		const approval: ApprovalSubmit = { steer: vi.fn(async () => {}) };
		const outcome = await new InputController(ctx).submitApprovalNote("watch the build", approval);
		expect(outcome).toBe("kept");
		expect(approval.steer).not.toHaveBeenCalled();
		expect(mainPrompt).not.toHaveBeenCalled();
	});

	it("throwing command reports kept and restores the draft", async () => {
		const { ctx } = createContext(true);
		vi.spyOn(builtinSlashCommands, "executeBuiltinSlashCommand").mockRejectedValueOnce(
			new Error("security export needs --output"),
		);
		const approval: ApprovalSubmit = { steer: vi.fn(async () => {}) };
		const outcome = await new InputController(ctx).submitApprovalNote("/security export", approval);
		expect(outcome).toBe("kept");
		expect(ctx.showError).toHaveBeenCalledWith("security export needs --output");
		expect(ctx.editor.setCollapsedText).toHaveBeenCalledWith("/security export");
		expect(approval.steer).not.toHaveBeenCalled();
	});
});
