import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { CommandController } from "@pk-nerdsaver-ai/pi-coding-agent/modes/controllers/command-controller";
import { getThemeByName, setThemeInstance } from "@pk-nerdsaver-ai/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@pk-nerdsaver-ai/pi-coding-agent/modes/types";

function createContainer() {
	return {
		children: [] as unknown[],
		addChild(child: unknown) {
			this.children.push(child);
		},
		clear() {
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
});
