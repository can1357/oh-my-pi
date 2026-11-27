import { afterEach, describe, expect, it, type Mock, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createRoot } from "@oh-my-pi/pi-tui";
import * as historySearchModule from "../../../src/ui/overlays/pickers/history-search";
import * as sessionSelectorModule from "../../../src/ui/overlays/pickers/session-selector";

afterEach(() => {
	vi.restoreAllMocks();
});

interface FakeHandle {
	readonly node: object;
	readonly closed: boolean;
	readonly close: Mock<() => void>;
}

/** An overlay or editor-area handle whose view was built (in a root of its own) and can be closed. */
function fakeHandle(factory: () => unknown): FakeHandle {
	createRoot(factory);
	return { node: {}, closed: false, close: vi.fn() };
}

describe("SelectorController.focusActiveEditorArea", () => {
	// Regression for issue #3349: closing a fullscreen overlay (settings,
	// extensions dashboard, agents dashboard) while a hook selector / approval
	// prompt occupies the editor slot must give the keys to that prompt — not
	// to the composer it replaced. The shell's home is the editor-area owner.
	it("hands focus back to the shell's home, the editor area's owner", () => {
		const focus = vi.fn();
		const ctx = { shell: { focus } } as unknown as InteractiveModeContext;

		new SelectorController(ctx).focusActiveEditorArea();

		expect(focus).toHaveBeenCalledTimes(1);
		expect(focus).toHaveBeenCalledWith(null);
	});
});

describe("SelectorController.showHistorySearch", () => {
	const storage = {
		getRecent: () => [{ id: 1, prompt: "deploy the release", created_at: 0, useCount: 1 }],
		search: () => [],
	} as unknown as HistoryStorage;

	function setup(focusedPrompt: boolean) {
		let picker: historySearchModule.HistorySearchProps | undefined;
		vi.spyOn(historySearchModule, "HistorySearch").mockImplementation(props => {
			picker = props;
			return [];
		});
		const promptNode = {};
		const prompt = { node: promptNode, attachImage: vi.fn(), setText: vi.fn() };
		const composer = { setText: vi.fn() };
		let dialog: FakeHandle | undefined;
		const ctx = {
			historyStorage: storage,
			composer,
			promptPasteTarget: prompt,
			shell: { focused: () => (focusedPrompt ? promptNode : null) },
			showEditorAreaDialog: vi.fn((factory: () => unknown) => (dialog = fakeHandle(factory))),
		} as unknown as InteractiveModeContext;
		new SelectorController(ctx).showHistorySearch();
		if (!picker || !dialog) throw new Error("history search was not mounted in the editor area");
		return { picker, dialog, prompt, composer };
	}

	it("delivers the picked entry to the focused prompt, not the hidden composer", () => {
		const { picker, dialog, prompt, composer } = setup(true);

		picker.onSelect("deploy the release");

		expect(dialog.close).toHaveBeenCalledTimes(1);
		expect(prompt.setText).toHaveBeenCalledWith("deploy the release");
		expect(composer.setText).not.toHaveBeenCalled();
	});

	it("fills the composer when no prompt holds its place", () => {
		const { picker, prompt, composer } = setup(false);

		picker.onSelect("deploy the release");

		expect(composer.setText).toHaveBeenCalledWith("deploy the release");
		expect(prompt.setText).not.toHaveBeenCalled();
	});
});

describe("SelectorController session replacement overlay", () => {
	it("keeps the fullscreen selector visible until the resumed transcript is ready", async () => {
		const session: SessionInfo = {
			path: "/tmp/resume.jsonl",
			id: "resume",
			cwd: "/tmp",
			title: "Resume target",
			created: new Date("2026-01-01T00:00:00Z"),
			modified: new Date("2026-01-02T00:00:00Z"),
			messageCount: 2,
			size: 1,
			firstMessage: "first",
			allMessagesText: "first second",
		};
		const listed = [session];
		vi.spyOn(SessionManager, "listForPicker").mockResolvedValue({
			sessions: listed,
			complete: Promise.resolve(listed),
		});
		let picker: sessionSelectorModule.SessionSelectorProps | undefined;
		vi.spyOn(sessionSelectorModule, "SessionSelector").mockImplementation(props => {
			picker = props;
			return [];
		});
		const overlayClosed = Promise.withResolvers<void>();
		const close = vi.fn(() => overlayClosed.resolve());
		const ctx = {
			settings: Settings.isolated(),
			sessionManager: {
				getCwd: () => "/tmp",
				getSessionDir: () => "/tmp",
				getSessionFile: () => session.path,
			},
			shell: {
				focus: vi.fn(),
				size: () => ({ columns: 80, rows: 24 }),
				overlays: {
					show: vi.fn((factory: () => unknown) => ({ ...fakeHandle(factory), close })),
				},
			},
		} as unknown as InteractiveModeContext;
		const controller = new SelectorController(ctx);
		const resumeStarted = Promise.withResolvers<void>();
		const resumed = Promise.withResolvers<boolean>();
		const handleResume = vi.spyOn(controller, "handleResumeSession").mockImplementation(() => {
			resumeStarted.resolve();
			return resumed.promise;
		});
		await controller.showSessionSelector();
		if (!picker) throw new Error("Expected the session picker");
		picker.onSelect(session);
		await resumeStarted.promise;

		expect(handleResume).toHaveBeenCalledWith(session.path, { followContinuation: true });
		expect(close).not.toHaveBeenCalled();

		// The selector remains mounted until resume finishes, but it is locked
		// against a second selection (the screen ignores input while locked).
		expect(picker.locked?.()).toBe(true);
		picker.onSelect(session);
		expect(handleResume).toHaveBeenCalledTimes(1);
		expect(close).not.toHaveBeenCalled();

		resumed.resolve(true);
		await overlayClosed.promise;
		expect(close).toHaveBeenCalledTimes(1);
	});
});
