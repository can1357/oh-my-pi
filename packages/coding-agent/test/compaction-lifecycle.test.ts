import { afterEach, describe, expect, it, vi } from "bun:test";
import { CompactionCancelledError, type CompactionResult } from "@oh-my-pi/pi-agent-core/compaction";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

/**
 * Contract under test: `CommandController.executeCompaction` must not leak
 * transient UI across either terminal state.
 *
 *  - A cancelled compaction (session.compact rejects with the real
 *    CompactionCancelledError the code branches on) must leave the transcript
 *    as it was — nothing presented — and must take its working row down.
 *  - A successful compaction must take its working row down once it resolves,
 *    before the transcript rebuild.
 *
 * Exercised only through the public `executeCompaction` entrypoint with a
 * session stub whose `compact()` outcome we drive.
 */
function buildCtx(compact: InteractiveModeContext["session"]["compact"]) {
	/** What holds the status row's working row. */
	let working: string | undefined;
	// Record the working row at the instant the transcript rebuild runs, so a test
	// can prove cleanup happens BEFORE the rebuild and not merely after it.
	let workingAtRebuild: string | undefined | null = null;
	const rebuildChatFromMessages = vi.fn(() => {
		workingAtRebuild = working;
	});
	const present = vi.fn();
	const showError = vi.fn();
	const ctx = {
		get working() {
			return working;
		},
		showWorking: vi.fn((kind: string) => {
			working = kind;
		}),
		clearWorking: vi.fn((kind?: string) => {
			if (working === undefined || (kind !== undefined && working !== kind)) return false;
			working = undefined;
			return true;
		}),
		maintenanceInterruptKey: () => "escape",
		present,
		session: { compact },
		rebuildChatFromMessages,
		statusLine: { refresh: vi.fn() },
		shell: { host: { replayHistory: vi.fn() } },
		showError,
		flushCompactionQueue: vi.fn(async () => undefined),
		keybindings: { keysFor: () => ["escape"] },
		settings: Settings.isolated({ "display.collapseCompacted": true }),
	} as unknown as InteractiveModeContext;

	return {
		ctx,
		present,
		rebuildChatFromMessages,
		showError,
		working: () => working,
		workingAtRebuild: () => workingAtRebuild,
	};
}

describe("executeCompaction UI lifecycle", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("leaves the transcript untouched and drains the working row when compaction is cancelled", async () => {
		const compact = vi.fn(async () => {
			throw new CompactionCancelledError();
		});
		const { ctx, present, rebuildChatFromMessages, showError, working } = buildCtx(compact);

		const controller = new CommandController(ctx);
		const outcome = await controller.executeCompaction();

		expect(outcome).toBe("cancelled");
		// Nothing leaked into the transcript on the cancel path.
		expect(present).not.toHaveBeenCalled();
		// The compacting row was taken down.
		expect(ctx.showWorking).toHaveBeenCalledWith(
			"maintenance",
			expect.objectContaining({ label: "Compacting context…" }),
		);
		expect(working()).toBeUndefined();
		// Proof the cancel branch ran instead of the success branch.
		expect(showError).toHaveBeenCalledWith("Compaction cancelled");
		expect(rebuildChatFromMessages).not.toHaveBeenCalled();
	});

	it("drains the working row after a successful compaction resolves", async () => {
		const compact = vi.fn(async (): Promise<CompactionResult<unknown>> => ({
			summary: "",
			firstKeptEntryId: "",
			tokensBefore: 0,
		}));
		const { ctx, rebuildChatFromMessages, working, workingAtRebuild } = buildCtx(compact);

		const controller = new CommandController(ctx);
		const outcome = await controller.executeCompaction();

		expect(outcome).toBe("ok");
		expect(working()).toBeUndefined();
		expect(rebuildChatFromMessages).toHaveBeenCalledTimes(1);
		// The row was drained BEFORE the transcript rebuild, not only afterward.
		expect(workingAtRebuild()).toBeUndefined();
	});
});

describe("compaction queued for the next yield", () => {
	/** `agentRun`: the agent loop streams; `promptSetup`: a prompt is in pre-dispatch setup (no agent run
	 *  yet); `retrying`: an auto-retry waits out its backoff; `transitioning`: a session switch is applying;
	 *  `compactingChecks`: how many `isCompacting` reads report a pass started elsewhere. */
	function buildYieldCtx(
		onWaitForIdle: (state: { agentRun: boolean; promptSetup: boolean; retrying: boolean }) => void = () => {},
	) {
		const state = { agentRun: false, promptSetup: false, retrying: false, transitioning: false, compactingChecks: 0 };
		const session = {
			agent: {
				state: {
					get isStreaming() {
						return state.agentRun;
					},
				},
			},
			get isStreaming() {
				return state.agentRun || state.promptSetup;
			},
			get isRetrying() {
				return state.retrying;
			},
			get isCompacting() {
				if (state.compactingChecks === 0) return false;
				state.compactingChecks--;
				return true;
			},
			hasAdmittedSubmission: false,
			queuedMessageCount: 0,
			isRunActive: false,
			waitForRunEnd: vi.fn(async () => {}),
			waitForIdle: vi.fn(async () => onWaitForIdle(state)),
			waitForAdmittedSubmissions: vi.fn(async () => {}),
			get isSessionTransitioning() {
				return state.transitioning;
			},
			// The switch rolls back: the session and the request survive.
			waitForSessionTransition: vi.fn(async () => {
				state.transitioning = false;
			}),
		};
		const compactingAtFlush: boolean[] = [];
		const flushCompactionQueue = vi.fn(async () => {
			compactingAtFlush.push(state.compactingChecks > 0);
		});
		const sessionManager = {
			branch: [{ id: "e1" }, { id: "e2" }],
			getSessionId: () => "s1",
			getBranch: () => sessionManager.branch,
			getEntries: () => [{ type: "message" }],
		};
		const ctx = {
			session,
			sessionManager,
			yieldCompaction: { text: "/compact soft", sessionId: "s1", leafId: "e1", mode: "soft" },
			compactionQueuedMessages: [],
			updatePendingMessagesDisplay: vi.fn(),
			showStatus: vi.fn(),
			showWarning: vi.fn(),
			restoreCompactionQueueToEditor: vi.fn(),
			flushCompactionQueue,
			waitForSubmissionDispatches: vi.fn(async () => {}),
			hasPendingSubmission: () => false,
		} as unknown as InteractiveModeContext;
		const controller = new CommandController(ctx);
		const handleCompactCommand = vi.spyOn(controller, "handleCompactCommand");
		return { state, ctx, sessionManager, controller, handleCompactCommand, flushCompactionQueue, compactingAtFlush };
	}

	it("runs the queued compaction once the session is idle", async () => {
		const { ctx, controller, handleCompactCommand } = buildYieldCtx();
		handleCompactCommand.mockResolvedValue("ok");

		await controller.runYieldCompaction();

		expect(handleCompactCommand).toHaveBeenCalledWith(undefined, "soft", expect.any(Function));
		expect(ctx.yieldCompaction).toBeUndefined();
	});

	it("does not compact while the run can still continue on its own", async () => {
		let idleWaits = 0;
		const { state, controller, handleCompactCommand } = buildYieldCtx(current => {
			// The retry's backoff ends (and its turn finishes) before the second idle check.
			if (++idleWaits === 2) current.retrying = false;
		});
		state.retrying = true;
		const retryingAtCompact: boolean[] = [];
		handleCompactCommand.mockImplementation(async () => {
			retryingAtCompact.push(state.retrying);
			return "ok";
		});

		await controller.runYieldCompaction();

		expect(retryingAtCompact).toEqual([false]);
	});

	it("runs once a prompt still in setup bails without starting a run", async () => {
		let idleWaits = 0;
		const { state, controller, handleCompactCommand } = buildYieldCtx(current => {
			// The prompt bails before the second idle check.
			if (++idleWaits === 2) current.promptSetup = false;
		});
		handleCompactCommand.mockResolvedValue("ok");
		state.promptSetup = true;

		await controller.runYieldCompaction();

		expect(handleCompactCommand).toHaveBeenCalledWith(undefined, "soft", expect.any(Function));
	});

	it("releases held follow-ups when there is nothing to compact", async () => {
		const { ctx, controller, flushCompactionQueue } = buildYieldCtx();

		await controller.runYieldCompaction();

		expect(ctx.showWarning).toHaveBeenCalledWith("Nothing to compact (no messages yet)");
		expect(flushCompactionQueue).toHaveBeenCalled();
	});

	it("leaves the flush to a compaction that ran", async () => {
		const { controller, handleCompactCommand, flushCompactionQueue } = buildYieldCtx();
		// `executeCompaction` runs the before-flush hook, then flushes (and on failure re-queues) the batch.
		handleCompactCommand.mockImplementation(async (_instructions, _mode, beforeFlush) => {
			await beforeFlush?.("ok");
			return "ok";
		});

		await controller.runYieldCompaction();

		expect(flushCompactionQueue).not.toHaveBeenCalled();
	});

	it("hands the request back after the tree moved to another branch", async () => {
		const { ctx, sessionManager, controller, handleCompactCommand, flushCompactionQueue } = buildYieldCtx();
		// Tree navigation reuses the session: the leaf the request was queued at is off the new branch.
		sessionManager.branch = [{ id: "e3" }];

		await controller.runYieldCompaction();

		expect(ctx.restoreCompactionQueueToEditor).toHaveBeenCalledTimes(1);
		expect(handleCompactCommand).not.toHaveBeenCalled();
		expect(flushCompactionQueue).not.toHaveBeenCalled();
	});

	it("releases held follow-ups after a compaction started elsewhere ends", async () => {
		const { state, controller, handleCompactCommand, compactingAtFlush } = buildYieldCtx();
		state.compactingChecks = 3;

		await controller.runYieldCompaction();

		expect(handleCompactCommand).not.toHaveBeenCalled();
		expect(compactingAtFlush).toEqual([false]);
	});

	it("waits for a session switch to settle before compacting", async () => {
		const { state, controller, handleCompactCommand } = buildYieldCtx();
		state.transitioning = true;
		const transitioningAtCompact: boolean[] = [];
		handleCompactCommand.mockImplementation(async () => {
			transitioningAtCompact.push(state.transitioning);
			return "ok";
		});

		await controller.runYieldCompaction();

		expect(transitioningAtCompact).toEqual([false]);
	});

	it("lets a follow-up sent before it finish dispatching before compacting", async () => {
		const { ctx, controller, handleCompactCommand } = buildYieldCtx();
		// A Ctrl+Q skill sent before the `/compact` is still expanding when the run ends.
		const skillDispatch = Promise.withResolvers<void>();
		ctx.waitForSubmissionDispatches = () => skillDispatch.promise;
		handleCompactCommand.mockResolvedValue("ok");

		const running = controller.runYieldCompaction();
		// Every other wait settles at once; drain them so only the pending dispatch can hold the pass.
		for (let i = 0; i < 20; i++) await Promise.resolve();
		expect(handleCompactCommand).not.toHaveBeenCalled();

		skillDispatch.resolve();
		await running;
		expect(handleCompactCommand).toHaveBeenCalledTimes(1);
	});
});
