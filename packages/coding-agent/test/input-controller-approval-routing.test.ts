/**
 * A tool approval waiting in the main session keeps the composer mounted, and a
 * message typed there steers the turn that asked, denying the call. When the
 * user is viewing a subagent, that submission must still reach the main
 * session: sent to the focused child, it never denies the approval.
 */
import { describe, expect, it, vi } from "bun:test";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { Composer } from "../src/ui/composer/composer";

function createContext(approvalOwnsComposer: boolean) {
	const mainPrompt = vi.fn(async () => true);
	const focusedPrompt = vi.fn(async () => true);
	const ctx = {
		composer: new Composer(),
		session: {
			isStreaming: true,
			isCompacting: false,
			isBashRunning: false,
			isEvalRunning: false,
			queuedMessageCount: 0,
			extensionRunner: undefined,
			customCommands: [],
			promptTemplates: [],
			prompt: mainPrompt,
		},
		viewSession: { isStreaming: true, queuedMessageCount: 0, prompt: focusedPrompt, abort: vi.fn(async () => {}) },
		focusedAgentId: "Worker",
		approvalOwnsComposer,
		sessionManager: { putBlob: vi.fn() },
		loopModeEnabled: false,
		flushPendingExecRuns: vi.fn(),
		startPendingSubmission: vi.fn((input: { text: string }) => ({ ...input, cancelled: false, started: false })),
		withLocalSubmission: async (_text: string, fn: () => unknown) => fn(),
		updatePendingMessagesDisplay: vi.fn(),
		updateEditorBorderColor: vi.fn(),
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

			ctx.composer.onSubmit?.("keep the build dir");
			await controller.waitForSubmissionDispatches();

			expect(mainPrompt).toHaveBeenCalledTimes(owned ? 1 : 0);
			expect(focusedPrompt).toHaveBeenCalledTimes(owned ? 0 : 1);
		}
	});
});
