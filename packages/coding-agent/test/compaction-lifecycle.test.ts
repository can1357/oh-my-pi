import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { CompactionCancelledError, type CompactionResult } from "@oh-my-pi/pi-agent-core/compaction";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { getThemeByName, setThemeInstance, type Theme, theme } from "@oh-my-pi/pi-tui/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { Container, Spacer } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";

/**
 * Contract under test: `CommandController.executeCompaction` must not leak
 * transient UI across either terminal state.
 *
 *  - A cancelled compaction (session.compact rejects with the real
 *    CompactionCancelledError the code branches on) must leave the chat
 *    transcript byte-for-byte as it was — no orphan Spacer pushed into
 *    chatContainer — and must drain the status container's loader.
 *  - A successful compaction must drain the status container's loader once it
 *    resolves.
 *
 * Exercised only through the public `executeCompaction` entrypoint with real
 * in-memory Container instances and a session stub whose `compact()` outcome we
 * drive.
 */
function buildCtx(compact: InteractiveModeContext["session"]["compact"]) {
	const chatContainer = new Container();
	const statusContainer = new Container();
	// Pre-existing transcript content. The regression we defend leaked an extra
	// Spacer into this container on the cancel path, so we seed it with real
	// children and require the count to survive the call untouched.
	chatContainer.addChild(new Spacer(1));
	chatContainer.addChild(new Spacer(1));

	// Record the status container's state at the instant the transcript rebuild
	// runs, so a test can prove cleanup happens BEFORE the rebuild (the fix) and
	// not merely in the finally that runs after it.
	let statusChildrenAtRebuild: number | undefined;
	const rebuildChatFromMessages = vi.fn(() => {
		statusChildrenAtRebuild = statusContainer.children.length;
	});
	const showError = vi.fn();
	const ctx = {
		loadingAnimation: undefined,
		chatContainer,
		statusContainer,
		ui: { requestRender: vi.fn(), requestComponentRender: vi.fn() },
		session: { compact },
		rebuildChatFromMessages,
		statusLine: { invalidate: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		showError,
		flushCompactionQueue: vi.fn(async () => undefined),
		keybindings: KeybindingsManager.inMemory(),
		// executeCompaction consults display.collapseCompacted on the ok path to
		// decide whether the rebuild replaces the terminal transcript.
		settings: Settings.isolated({ "display.collapseCompacted": true }),
	} as unknown as InteractiveModeContext;

	return {
		ctx,
		chatContainer,
		statusContainer,
		rebuildChatFromMessages,
		showError,
		statusAtRebuild: () => statusChildrenAtRebuild,
	};
}

describe("executeCompaction UI lifecycle", () => {
	let priorTheme: Theme | undefined;

	beforeAll(async () => {
		// The compacting Loader colorizes through the active theme on construction.
		// Capture the prior global theme first so afterAll can restore it and not
		// couple later suites sharing this process to our dark override.
		priorTheme = theme;
		const dark = await getThemeByName("dark");
		if (!dark) throw new Error("Expected dark theme");
		setThemeInstance(dark);
	});

	afterAll(() => {
		if (priorTheme) setThemeInstance(priorTheme);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("leaves the transcript untouched and drains the loader when compaction is cancelled", async () => {
		const compact = vi.fn(async () => {
			throw new CompactionCancelledError();
		});
		const { ctx, chatContainer, statusContainer, rebuildChatFromMessages, showError } = buildCtx(compact);
		const childrenBefore = chatContainer.children.length;

		const controller = new CommandController(ctx);
		const outcome = await controller.executeCompaction();

		expect(outcome).toBe("cancelled");
		// No orphan Spacer leaked into the chat transcript on the cancel path.
		expect(chatContainer.children).toHaveLength(childrenBefore);
		// The compacting loader was removed from the status container.
		expect(statusContainer.children).toHaveLength(0);
		// Proof the cancel branch ran instead of the success branch.
		expect(showError).toHaveBeenCalledWith("Compaction cancelled");
		expect(rebuildChatFromMessages).not.toHaveBeenCalled();
	});

	it("drains the loader after a successful compaction resolves", async () => {
		const compact = vi.fn(async (): Promise<CompactionResult<unknown>> => ({
			summary: "",
			firstKeptEntryId: "",
			tokensBefore: 0,
		}));
		const { ctx, statusContainer, rebuildChatFromMessages, statusAtRebuild } = buildCtx(compact);

		const controller = new CommandController(ctx);
		const outcome = await controller.executeCompaction();

		expect(outcome).toBe("ok");
		// Status container is empty once compaction resolves.
		expect(statusContainer.children).toHaveLength(0);
		// Post-compaction rebuilds preserve settled components so their warmed
		// Markdown/layout caches survive the transcript reset.
		expect(rebuildChatFromMessages).toHaveBeenCalledWith({ reuseSettledComponents: true });
		// The loader was drained BEFORE the transcript rebuild, not only by the
		// finally that runs afterward: the status container was already empty at
		// the instant rebuildChatFromMessages ran (1 leaked loader without the fix).
		expect(statusAtRebuild()).toBe(0);
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
			hasPendingAsyncWork: () => false,
			settleAsyncWork: vi.fn(async () => {}),
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
