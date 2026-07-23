import { beforeAll, describe, expect, it, vi } from "bun:test";
import { SelectorController } from "@pk-nerdsaver-ai/pi-coding-agent/modes/controllers/selector-controller";
import { initTheme } from "@pk-nerdsaver-ai/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@pk-nerdsaver-ai/pi-coding-agent/modes/types";
import { SessionAlreadyOwnedError } from "@pk-nerdsaver-ai/pi-coding-agent/session/session-writer-guard";

beforeAll(() => {
	initTheme();
});

describe("SelectorController.handleResumeSession", () => {
	it("surfaces SessionAlreadyOwnedError in the UI instead of rejecting", async () => {
		const showError = vi.fn();
		const showStatus = vi.fn();
		const switchSession = vi.fn(async () => {
			throw new SessionAlreadyOwnedError("019f8bbf-7a11-7000-ad2e-e856862be0fe", "/tmp/session.jsonl");
		});
		const ctx = {
			clearTransientSessionUi: vi.fn(),
			sessionManager: {
				getCwd: () => "/tmp/project",
			},
			session: { switchSession },
			applyCwdChange: vi.fn(async () => undefined),
			updateEditorBorderColor: vi.fn(),
			chatContainer: { clear: vi.fn() },
			renderInitialMessages: vi.fn(),
			reloadTodos: vi.fn(async () => undefined),
			showStatus,
			showError,
		} as unknown as InteractiveModeContext;

		const controller = new SelectorController(ctx);
		await expect(controller.handleResumeSession("/tmp/session.jsonl")).resolves.toBeUndefined();

		expect(switchSession).toHaveBeenCalledWith("/tmp/session.jsonl");
		expect(showError).toHaveBeenCalledTimes(1);
		const message = String(showError.mock.calls[0]?.[0]);
		expect(message).toContain("already has a writable owner");
		expect(message).toContain("ompk resume");
		expect(showStatus).not.toHaveBeenCalled();
		expect(ctx.renderInitialMessages).not.toHaveBeenCalled();
		expect(ctx.clearTransientSessionUi).not.toHaveBeenCalled();
	});

	it("sanitizes generic switch failures before rendering them", async () => {
		const showError = vi.fn();
		const clearTransientSessionUi = vi.fn();
		const ctx = {
			clearTransientSessionUi,
			sessionManager: {
				getCwd: () => "/tmp/project",
			},
			session: {
				switchSession: vi.fn(async () => {
					throw new Error("provider\tfailed\n\u001b[31munsafe");
				}),
			},
			showStatus: vi.fn(),
			showError,
		} as unknown as InteractiveModeContext;

		const controller = new SelectorController(ctx);
		await controller.handleResumeSession("/tmp/session.jsonl");

		expect(showError).toHaveBeenCalledWith("provider failed [31munsafe");
		expect(clearTransientSessionUi).not.toHaveBeenCalled();
	});

	it("renders the selected previous session after a successful switch", async () => {
		let cwd = "/tmp/current-project";
		const showError = vi.fn();
		const showStatus = vi.fn();
		const applyCwdChange = vi.fn(async () => undefined);
		const chatClear = vi.fn();
		const renderInitialMessages = vi.fn();
		const reloadTodos = vi.fn(async () => undefined);
		const switchSession = vi.fn(async () => {
			cwd = "/tmp/previous-project";
			return true;
		});
		const ctx = {
			clearTransientSessionUi: vi.fn(),
			sessionManager: {
				getCwd: () => cwd,
				getSessionName: () => "Previous session",
			},
			session: { switchSession },
			applyCwdChange,
			updateEditorBorderColor: vi.fn(),
			chatContainer: { clear: chatClear },
			renderInitialMessages,
			reloadTodos,
			showStatus,
			showError,
		} as unknown as InteractiveModeContext;

		const controller = new SelectorController(ctx);
		await controller.handleResumeSession("/tmp/previous-session.jsonl");

		expect(switchSession).toHaveBeenCalledWith("/tmp/previous-session.jsonl");
		expect(applyCwdChange).toHaveBeenCalledWith("/tmp/previous-project");
		expect(chatClear).toHaveBeenCalledTimes(1);
		expect(renderInitialMessages).toHaveBeenCalledWith({ clearTerminalHistory: true });
		expect(reloadTodos).toHaveBeenCalledTimes(1);
		expect(showStatus).toHaveBeenCalledWith(expect.stringContaining("Resumed session in"));
		expect(showError).not.toHaveBeenCalled();
	});

	it("does not claim success when a session_before_switch hook cancels resume", async () => {
		const showStatus = vi.fn();
		const ctx = {
			clearTransientSessionUi: vi.fn(),
			sessionManager: {
				getCwd: () => "/tmp/project",
			},
			session: { switchSession: vi.fn(async () => false) },
			applyCwdChange: vi.fn(async () => undefined),
			updateEditorBorderColor: vi.fn(),
			chatContainer: { clear: vi.fn() },
			renderInitialMessages: vi.fn(),
			reloadTodos: vi.fn(async () => undefined),
			showStatus,
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;

		const controller = new SelectorController(ctx);
		await controller.handleResumeSession("/tmp/previous-session.jsonl");

		expect(showStatus).toHaveBeenCalledWith("Session resume cancelled");
		expect(ctx.chatContainer.clear).not.toHaveBeenCalled();
		expect(ctx.renderInitialMessages).not.toHaveBeenCalled();
		expect(ctx.clearTransientSessionUi).not.toHaveBeenCalled();
	});
});
