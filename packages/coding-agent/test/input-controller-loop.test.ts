import { describe, expect, it, type Mock, vi } from "bun:test";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { Composer } from "../src/ui/composer/composer";
type Spy = Mock<(...args: unknown[]) => unknown>;

function createLoopContext(options: {
	isStreaming: boolean;
	isCompacting?: boolean;
	extensionCommandNames?: string[];
	onInputCallback?: (...args: never[]) => void;
}) {
	const extensionCommandNames = options.extensionCommandNames ?? [];
	const extensionRunner =
		extensionCommandNames.length > 0
			? {
					hasHandlers: () => false,
					getCommand: (name: string) => (extensionCommandNames.includes(name) ? {} : undefined),
				}
			: undefined;
	let loopPrompt: string | undefined = "original loop prompt";
	const setLoopPrompt = vi.fn((prompt: string) => {
		loopPrompt = prompt;
	});
	const prompt = vi.fn(async () => true);
	const pauseLoop = vi.fn(() => {
		loopPrompt = undefined;
	});
	const ctx = {
		composer: new Composer(),
		session: {
			isStreaming: options.isStreaming,
			isCompacting: options.isCompacting ?? false,
			isBashRunning: false,
			isEvalRunning: false,
			queuedMessageCount: 0,
			extensionRunner,
			customCommands: [],
			promptTemplates: [],
			prompt,
		},
		sessionManager: { putBlob: vi.fn() },
		loopModeEnabled: true,
		get loopPrompt() {
			return loopPrompt;
		},
		set loopPrompt(value: string | undefined) {
			loopPrompt = value;
		},
		setLoopPrompt,
		pauseLoop,
		flushPendingExecRuns: vi.fn(),
		startPendingSubmission: vi.fn((input: { text: string }) => ({ ...input, cancelled: false, started: false })),
		withLocalSubmission: async (_text: string, fn: () => unknown) => fn(),
		updatePendingMessagesDisplay: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		showError: vi.fn(),
		handleBashCommand: vi.fn(),
		queueCompactionMessage: vi.fn(),
		onInputCallback: options.onInputCallback,
		skillCommands: new Map(),
		fileSlashCommands: new Set<string>(),
		isBashMode: false,
		isPythonMode: false,
		focusedAgentId: undefined,
		compactionQueuedMessages: [],
		locallySubmittedUserSignatures: new Set<string>(),
	} as unknown as InteractiveModeContext;
	return {
		ctx,
		setLoopPrompt,
		pauseLoop,
		prompt,
		getLoopPrompt: () => loopPrompt,
		queueCompactionMessage: ctx.queueCompactionMessage as Spy,
		handleBashCommand: ctx.handleBashCommand as Spy,
		showError: ctx.showError as Spy,
	};
}

describe("loop mode interjections", () => {
	it("submits prose and expands boundary-delimited emoticons even without a trailing space", async () => {
		const { ctx, getLoopPrompt } = createLoopContext({ isStreaming: false, onInputCallback: () => {} });
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();
		// A paste or restored draft bypasses inline expansion; submit must still expand it.
		ctx.composer.setText("report embedded:D and (:D then :-)");
		ctx.composer.submit();
		await controller.waitForSubmissionDispatches();
		expect(getLoopPrompt()).toBe("report embedded:D and (😃 then 🙂");
	});

	it("keeps the original loop prompt when steering mid-turn", async () => {
		const { ctx, setLoopPrompt, prompt, getLoopPrompt } = createLoopContext({ isStreaming: true });
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		ctx.composer.onSubmit?.("one-off correction");

		await controller.waitForSubmissionDispatches();

		// One-off steer reaches the session but must not replace the loop body.
		expect(prompt).toHaveBeenCalledTimes(1);
		expect(setLoopPrompt).not.toHaveBeenCalled();
		expect(getLoopPrompt()).toBe("original loop prompt");
	});

	it("adopts an idle submission as the new loop prompt", async () => {
		const onInputCallback = vi.fn();
		const { ctx, setLoopPrompt } = createLoopContext({ isStreaming: false, onInputCallback });
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		ctx.composer.onSubmit?.("new loop body");

		await controller.waitForSubmissionDispatches();

		expect(setLoopPrompt).toHaveBeenCalledWith("new loop body");
		expect(onInputCallback).toHaveBeenCalledTimes(1);
	});

	it("records an inline /loop prompt even while streaming", async () => {
		const { ctx, setLoopPrompt, prompt, getLoopPrompt } = createLoopContext({ isStreaming: true });
		// Mirror handleLoopCommand: enabling loop mode hands the inline prompt
		// back to the dispatcher for normal submission.
		(ctx as unknown as Record<string, unknown>).handleLoopCommand = vi.fn(async () => "inline loop body");
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		ctx.composer.onSubmit?.("/loop 3 inline loop body");

		await controller.waitForSubmissionDispatches();

		expect(setLoopPrompt).toHaveBeenCalledWith("inline loop body");
		expect(getLoopPrompt()).toBe("inline loop body");
		expect(prompt).toHaveBeenCalledTimes(1);
	});

	it("records an inline /loop prompt queued during compaction", async () => {
		const { ctx, setLoopPrompt, getLoopPrompt, queueCompactionMessage } = createLoopContext({
			isStreaming: false,
			isCompacting: true,
		});
		// Mirror handleLoopCommand: enabling loop mode hands the inline prompt
		// back to the dispatcher for normal submission.
		(ctx as unknown as Record<string, unknown>).handleLoopCommand = vi.fn(async () => "compact loop body");
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		ctx.composer.onSubmit?.("/loop 3 compact loop body");

		await controller.waitForSubmissionDispatches();

		expect(setLoopPrompt).toHaveBeenCalledWith("compact loop body");
		expect(getLoopPrompt()).toBe("compact loop body");
		expect(queueCompactionMessage).toHaveBeenCalledTimes(1);
	});

	it("does not arm the loop when the inline body is a local command", async () => {
		const { ctx, setLoopPrompt, getLoopPrompt, handleBashCommand } = createLoopContext({ isStreaming: false });
		// Mirror handleLoopCommand: enabling loop mode hands the inline body
		// back to the dispatcher, where the bash branch consumes it.
		(ctx as unknown as Record<string, unknown>).handleLoopCommand = vi.fn(async () => "!echo hi");
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		ctx.composer.onSubmit?.("/loop 3 !echo hi");

		await controller.waitForSubmissionDispatches();

		expect(handleBashCommand).toHaveBeenCalledWith("echo hi", false);
		expect(setLoopPrompt).not.toHaveBeenCalled();
		expect(getLoopPrompt()).toBe("original loop prompt");
	});

	it("does not arm the loop when the compacted body is a local command", async () => {
		const { ctx, setLoopPrompt, getLoopPrompt, queueCompactionMessage } = createLoopContext({
			isStreaming: false,
			isCompacting: true,
			extensionCommandNames: ["ext-cmd"],
		});
		// Mirror handleLoopCommand: enabling loop mode hands the inline body
		// back to the dispatcher, where it queues for compaction.
		(ctx as unknown as Record<string, unknown>).handleLoopCommand = vi.fn(async () => "/ext-cmd args");
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		ctx.composer.onSubmit?.("/loop 3 /ext-cmd args");

		await controller.waitForSubmissionDispatches();

		expect(queueCompactionMessage).toHaveBeenCalledTimes(1);
		expect(setLoopPrompt).not.toHaveBeenCalled();
		expect(getLoopPrompt()).toBe("original loop prompt");
	});

	it("leaves the loop untouched when a streamed body is consumed locally", async () => {
		const { ctx, setLoopPrompt, pauseLoop, prompt, getLoopPrompt } = createLoopContext({ isStreaming: true });
		// Mirror handleLoopCommand: enabling loop mode hands the inline body
		// back to the dispatcher for normal submission.
		(ctx as unknown as Record<string, unknown>).handleLoopCommand = vi.fn(async () => "/void-cmd");
		// Mirror AgentSession.prompt reporting local consumption (void custom
		// command) instead of a started turn.
		prompt.mockResolvedValueOnce(false);
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		ctx.composer.onSubmit?.("/loop 3 /void-cmd");

		await controller.waitForSubmissionDispatches();

		expect(prompt).toHaveBeenCalledTimes(1);
		expect(setLoopPrompt).not.toHaveBeenCalled();
		expect(pauseLoop).not.toHaveBeenCalled();
		expect(getLoopPrompt()).toBe("original loop prompt");
	});

	it("parks the loop when a direct submission is consumed locally", async () => {
		const { ctx, setLoopPrompt, pauseLoop, prompt, getLoopPrompt } = createLoopContext({ isStreaming: false });
		prompt.mockResolvedValueOnce(false);
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		ctx.composer.onSubmit?.("/void-cmd");

		await controller.waitForSubmissionDispatches();

		expect(prompt).toHaveBeenCalledTimes(1);
		expect(setLoopPrompt).toHaveBeenCalledWith("/void-cmd");
		expect(pauseLoop).toHaveBeenCalledTimes(1);
		expect(getLoopPrompt()).toBeUndefined();
	});

	it("arms a direct submission after dispatch succeeds", async () => {
		const { ctx, setLoopPrompt, getLoopPrompt } = createLoopContext({ isStreaming: false });
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		ctx.composer.onSubmit?.("direct body");

		await controller.waitForSubmissionDispatches();

		expect(setLoopPrompt).toHaveBeenCalledWith("direct body");
		expect(getLoopPrompt()).toBe("direct body");
	});

	it("keeps the prior body when a streamed inline body is rejected", async () => {
		const { ctx, setLoopPrompt, pauseLoop, prompt, getLoopPrompt, showError } = createLoopContext({
			isStreaming: true,
		});
		// Mirror handleLoopCommand: enabling loop mode hands the inline body
		// back to the dispatcher for normal submission.
		(ctx as unknown as Record<string, unknown>).handleLoopCommand = vi.fn(async () => "new body");
		// Mirror attachment normalization failing inside prompt dispatch.
		prompt.mockRejectedValueOnce(new Error("attachment too large"));
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		ctx.composer.onSubmit?.("/loop 3 new body");

		await controller.waitForSubmissionDispatches();

		expect(setLoopPrompt).not.toHaveBeenCalled();
		expect(pauseLoop).not.toHaveBeenCalled();
		expect(getLoopPrompt()).toBe("original loop prompt");
		expect(showError).toHaveBeenCalledWith("attachment too large");
	});

	it("parks the loop when a direct submission is rejected", async () => {
		const { ctx, setLoopPrompt, pauseLoop, prompt, getLoopPrompt, showError } = createLoopContext({
			isStreaming: false,
		});
		prompt.mockRejectedValueOnce(new Error("attachment too large"));
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		ctx.composer.onSubmit?.("direct body");

		await controller.waitForSubmissionDispatches();

		expect(setLoopPrompt).toHaveBeenCalledWith("direct body");
		expect(pauseLoop).toHaveBeenCalledTimes(1);
		expect(getLoopPrompt()).toBeUndefined();
		expect(showError).toHaveBeenCalledWith("attachment too large");
	});
});
