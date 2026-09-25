/**
 * Contract tests for SelectorController.handleResumeSession UI behavior.
 *
 * Persona restoration is now owned by AgentSession.switchSession() via the
 * resolvePersona callback (see sdk-persona-startup.test.ts for those contracts).
 * handleResumeSession is responsible for:
 *   1. Calling switchSession() with the target path.
 *   2. Calling applyCwdChange() when the project cwd changes.
 *   3. Refreshing the terminal title, clearing the chat, re-rendering.
 *   4. Showing "Resumed session" status (or "Resumed session in <path>" on cwd change).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

beforeAll(() => {
	initTheme();
});

function createHandle(opts?: { newCwd?: string }) {
	const cwd = "/tmp/original-project";
	const newCwd = opts?.newCwd ?? cwd;

	const switchSession = vi.fn(async () => true);
	const showStatus = vi.fn();
	const applyCwdChange = vi.fn(async () => {});

	const ctx = {
		clearTransientSessionUi: vi.fn(),
		prepareSessionSwitch: vi.fn(async () => {}),
		resetObserverRegistry: vi.fn(),
		settings: { flush: vi.fn(async () => {}) },
		session: {
			switchSession,
			settings: {
				get: (key: string) =>
					key === "task.disabledAgents" ? [] : key === "task.agentModelOverrides" ? {} : undefined,
			},
		},
		sessionManager: {
			getCwd: vi.fn().mockReturnValueOnce(cwd).mockReturnValue(newCwd),
			getLastAgentName: vi.fn(() => undefined),
			getSessionName: vi.fn(() => "test-session"),
			getSessionFile: vi.fn(() => "/tmp/original-project/sessions/session.jsonl"),
		},
		applyCwdChange,
		chatContainer: { clear: vi.fn() },
		renderInitialMessages: vi.fn(),
		reloadTodos: vi.fn(async () => {}),
		showStatus,
		showError: vi.fn(),
		statusLine: { invalidate: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		ui: { requestRender: vi.fn() },
	} as unknown as InteractiveModeContext;

	return { ctx, switchSession, showStatus, applyCwdChange };
}

describe("SelectorController.handleResumeSession — UI contract", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("calls switchSession with the target path", async () => {
		const { ctx, switchSession } = createHandle();
		const controller = new SelectorController(ctx);

		await controller.handleResumeSession("/tmp/test-project/sessions/session.jsonl");

		expect(switchSession).toHaveBeenCalledTimes(1);
		expect(switchSession).toHaveBeenCalledWith("/tmp/test-project/sessions/session.jsonl");
	});

	it("shows 'Resumed session' when cwd is unchanged", async () => {
		const { ctx, showStatus } = createHandle();
		const controller = new SelectorController(ctx);

		await controller.handleResumeSession("/tmp/original-project/sessions/session.jsonl");

		expect(showStatus).toHaveBeenCalledWith("Resumed session");
	});

	it("calls applyCwdChange and shows path in status when cwd changes", async () => {
		const { ctx, applyCwdChange, showStatus } = createHandle({ newCwd: "/tmp/other-project" });
		const controller = new SelectorController(ctx);

		await controller.handleResumeSession("/tmp/other-project/sessions/session.jsonl");

		expect(applyCwdChange).toHaveBeenCalledTimes(1);
		const statusCall = showStatus.mock.calls[0]?.[0] as string;
		expect(statusCall).toMatch(/Resumed session in/);
	});

	it("does NOT call applyCwdChange when cwd is unchanged", async () => {
		const { ctx, applyCwdChange } = createHandle();
		const controller = new SelectorController(ctx);

		await controller.handleResumeSession("/tmp/original-project/sessions/session.jsonl");

		expect(applyCwdChange).not.toHaveBeenCalled();
	});
});
