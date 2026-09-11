import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

function createContainer() {
	return {
		children: [] as unknown[],
		addChild(child: unknown) {
			this.children.push(child);
		},
		clear() {
			this.children = [];
		},
		disposeChildren() {
			this.children = [];
		},
	};
}

describe("/handoff command", () => {
	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Expected dark theme");
		setThemeInstance(theme);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("shows a cancellable loader while handoff generation is running", async () => {
		const handoffStarted = Promise.withResolvers<void>();
		const handoffDone = Promise.withResolvers<{ document: string }>();
		let isGeneratingHandoff = false;
		const statusContainer = createContainer();
		const chatContainer = createContainer();
		const abortHandoff = vi.fn();
		// InputController installs the real Esc handler; CommandController should
		// leave it in place while showing the handoff loader.
		const originalOnEscape = vi.fn(() => {
			if (isGeneratingHandoff) abortHandoff();
		});
		const requestRender = vi.fn();
		const ctx = {
			sessionManager: {
				getEntries: () => [{ type: "message" }, { type: "message" }],
			},
			session: {
				handoff: vi.fn(async () => {
					isGeneratingHandoff = true;
					handoffStarted.resolve();
					try {
						return await handoffDone.promise;
					} finally {
						isGeneratingHandoff = false;
					}
				}),
				abortHandoff,
			},
			loadingAnimation: undefined,
			statusContainer,
			chatContainer,
			ui: { requestRender, requestComponentRender: vi.fn() },
			editor: { onEscape: originalOnEscape },
			rebuildChatFromMessages: vi.fn(),
			statusLine: { invalidate: vi.fn() },
			updateEditorTopBorder: vi.fn(),
			updateEditorBorderColor: vi.fn(),
			reloadTodos: vi.fn(async () => undefined),
			showStatus: vi.fn(),
			showWarning: vi.fn(),
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new CommandController(ctx);

		const commandPromise = controller.handleHandoffCommand("focus on tests");
		await handoffStarted.promise;

		expect(statusContainer.children).toHaveLength(1);
		expect(ctx.editor.onEscape).toBe(originalOnEscape);
		ctx.editor.onEscape?.();
		expect(abortHandoff).toHaveBeenCalledTimes(1);

		handoffDone.resolve({ document: "## Goal\nContinue" });
		await commandPromise;

		expect(statusContainer.children).toHaveLength(0);
		expect(ctx.editor.onEscape).toBe(originalOnEscape);
		expect(ctx.session.handoff).toHaveBeenCalledWith("focus on tests");
	});

	it("clears a working loader mounted while the completed handoff rebuilds the transcript", async () => {
		const statusContainer = createContainer();
		const lateWorkingLoader = { stop: vi.fn() };
		let loadingAnimation: { stop: () => void } | undefined;
		const ctx = {
			sessionManager: {
				getEntries: () => [{ type: "message" }, { type: "message" }],
			},
			session: {
				isStreaming: false,
				handoff: vi.fn(async () => ({ document: "## Goal\nContinue" })),
			},
			get loadingAnimation() {
				return loadingAnimation;
			},
			set loadingAnimation(value: { stop: () => void } | undefined) {
				loadingAnimation = value;
			},
			statusContainer,
			ui: { requestRender: vi.fn(), requestComponentRender: vi.fn() },
			clearTransientSessionUi: vi.fn(() => {
				loadingAnimation?.stop();
				loadingAnimation = undefined;
				statusContainer.disposeChildren();
			}),
			renderInitialMessages: vi.fn(async () => {
				// Simulate a delayed agent_start event landing while transcript replay yields.
				loadingAnimation = lateWorkingLoader;
				statusContainer.addChild(lateWorkingLoader);
			}),
			statusLine: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			reloadTodos: vi.fn(async () => undefined),
			present: vi.fn(),
			showStatus: vi.fn(),
			showWarning: vi.fn(),
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new CommandController(ctx);

		await controller.handleHandoffCommand();

		expect(lateWorkingLoader.stop).toHaveBeenCalledTimes(1);
		expect(loadingAnimation).toBeUndefined();
		expect(statusContainer.children).toHaveLength(0);
	});

	it("recreates a fresh working loader when a new turn is streaming after handoff", async () => {
		const statusContainer = createContainer();
		const staleWorkingLoader = { stop: vi.fn() };
		const freshWorkingLoader = { stop: vi.fn() };
		let loadingAnimation: { stop: () => void } | undefined;
		let isStreaming = false;
		let loaderAtEnsureCall: { stop: () => void } | undefined | "unset" = "unset";
		const ctx = {
			sessionManager: {
				getEntries: () => [{ type: "message" }, { type: "message" }],
			},
			session: {
				get isStreaming() {
					return isStreaming;
				},
				handoff: vi.fn(async () => ({ document: "## Goal\nContinue" })),
			},
			get loadingAnimation() {
				return loadingAnimation;
			},
			set loadingAnimation(value: { stop: () => void } | undefined) {
				loadingAnimation = value;
			},
			statusContainer,
			ui: { requestRender: vi.fn(), requestComponentRender: vi.fn() },
			clearTransientSessionUi: vi.fn(() => {
				loadingAnimation?.stop();
				loadingAnimation = undefined;
				statusContainer.disposeChildren();
			}),
			renderInitialMessages: vi.fn(async () => {
				// A new turn begins and a delayed agent_start mounts its loader while
				// handoff cleanup is still running.
				isStreaming = true;
				loadingAnimation = staleWorkingLoader;
				statusContainer.addChild(staleWorkingLoader);
			}),
			ensureLoadingAnimation: vi.fn(() => {
				loaderAtEnsureCall = loadingAnimation;
				loadingAnimation = freshWorkingLoader;
				statusContainer.addChild(freshWorkingLoader);
			}),
			statusLine: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			reloadTodos: vi.fn(async () => undefined),
			present: vi.fn(),
			showStatus: vi.fn(),
			showWarning: vi.fn(),
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new CommandController(ctx);

		await controller.handleHandoffCommand();

		// The frozen loader (its timer stopped by disposeChildren) must be dropped
		// before ensureLoadingAnimation runs, so it builds a fresh running loader
		// instead of reattaching the stale one.
		expect(staleWorkingLoader.stop).toHaveBeenCalledTimes(1);
		expect(loaderAtEnsureCall).toBeUndefined();
		expect(ctx.ensureLoadingAnimation).toHaveBeenCalledTimes(1);
		expect(loadingAnimation).toBe(freshWorkingLoader);
	});

	it("preserves a retry loader that replaces the handoff overlay during replay", async () => {
		const statusContainer = createContainer();
		const retryLoader = { stop: vi.fn() };
		let isStreaming = false;
		let activeRetryLoader: { stop: () => void } | undefined;
		const ensureLoadingAnimation = vi.fn();
		const ctx = {
			sessionManager: {
				getEntries: () => [{ type: "message" }, { type: "message" }],
			},
			session: {
				get isStreaming() {
					return isStreaming;
				},
				handoff: vi.fn(async () => ({ document: "## Goal\nContinue" })),
			},
			loadingAnimation: undefined,
			autoCompactionLoader: undefined,
			get retryLoader() {
				return activeRetryLoader;
			},
			set retryLoader(value: { stop: () => void } | undefined) {
				activeRetryLoader = value;
			},
			statusContainer,
			ui: { requestRender: vi.fn(), requestComponentRender: vi.fn() },
			clearTransientSessionUi: vi.fn(() => {
				statusContainer.disposeChildren();
			}),
			renderInitialMessages: vi.fn(async () => {
				isStreaming = true;
				activeRetryLoader = retryLoader;
				statusContainer.addChild(retryLoader);
			}),
			ensureLoadingAnimation,
			statusLine: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			reloadTodos: vi.fn(async () => undefined),
			present: vi.fn(),
			showStatus: vi.fn(),
			showWarning: vi.fn(),
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new CommandController(ctx);

		await controller.handleHandoffCommand();

		expect(statusContainer.children).toEqual([retryLoader]);
		expect(activeRetryLoader).toBe(retryLoader);
		expect(ensureLoadingAnimation).not.toHaveBeenCalled();
	});

	it("surfaces a provider failure named AbortError as a real error, not a cancellation", async () => {
		// Regression: the catch used to map any name==="AbortError" error to
		// "Handoff cancelled". session.handoff() now normalizes genuine cancellations
		// to the exact "Handoff cancelled" message and re-throws real provider failures
		// verbatim, so the controller must report those as a failure.
		const providerError = new Error("Deepseek stream stalled");
		providerError.name = "AbortError";
		const showError = vi.fn();
		const statusContainer = createContainer();
		const ctx = {
			sessionManager: {
				getEntries: () => [{ type: "message" }, { type: "message" }],
			},
			session: {
				handoff: vi.fn(async () => {
					throw providerError;
				}),
				abortHandoff: vi.fn(),
			},
			loadingAnimation: undefined,
			statusContainer,
			chatContainer: createContainer(),
			ui: { requestRender: vi.fn(), requestComponentRender: vi.fn() },
			editor: { onEscape: vi.fn() },
			showError,
			showStatus: vi.fn(),
			showWarning: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new CommandController(ctx);

		await controller.handleHandoffCommand();

		expect(showError).toHaveBeenCalledTimes(1);
		expect(showError).toHaveBeenCalledWith("Handoff failed: Deepseek stream stalled");
	});

	it("refuses to hand off while a response is streaming", async () => {
		// Bug: /handoff dispatches before the streaming-queue branch, so without a
		// guard it resets the agent mid-turn and the live stream keeps emitting into
		// the torn-down session. Streaming must short-circuit with a warning.
		const handoff = vi.fn();
		const showWarning = vi.fn();
		const statusContainer = createContainer();
		const ctx = {
			sessionManager: {
				getEntries: () => [{ type: "message" }, { type: "message" }],
			},
			session: { isStreaming: true, handoff },
			loadingAnimation: undefined,
			statusContainer,
			ui: { requestRender: vi.fn(), requestComponentRender: vi.fn() },
			showWarning,
			showError: vi.fn(),
			showStatus: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new CommandController(ctx);

		await controller.handleHandoffCommand();

		expect(handoff).not.toHaveBeenCalled();
		expect(showWarning).toHaveBeenCalledTimes(1);
		expect(statusContainer.children).toHaveLength(0);
	});

	it("preserves idle auto-compaction UI instead of starting handoff", async () => {
		const statusContainer = createContainer();
		const autoCompactionLoader = { stop: vi.fn() };
		statusContainer.addChild(autoCompactionLoader);
		const handoff = vi.fn(async () => {
			throw new Error("Compaction already in progress");
		});
		const showWarning = vi.fn();
		const ctx = {
			sessionManager: {
				getEntries: () => [{ type: "message" }, { type: "message" }],
			},
			session: { isStreaming: false, isCompacting: true, handoff },
			loadingAnimation: undefined,
			autoCompactionLoader,
			retryLoader: undefined,
			statusContainer,
			ui: { requestRender: vi.fn(), requestComponentRender: vi.fn() },
			showWarning,
			showError: vi.fn(),
			showStatus: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new CommandController(ctx);

		await controller.handleHandoffCommand();

		expect(handoff).not.toHaveBeenCalled();
		expect(statusContainer.children).toEqual([autoCompactionLoader]);
		expect(autoCompactionLoader.stop).not.toHaveBeenCalled();
		expect(showWarning).toHaveBeenCalledWith(
			"Wait for context compaction to finish or cancel it before handing off.",
		);
	});
});
