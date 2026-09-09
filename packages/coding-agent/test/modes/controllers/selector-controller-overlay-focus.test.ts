import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { SessionSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/session-selector";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	vi.restoreAllMocks();
});

interface EditorSlot {
	children: unknown[];
	clear: () => void;
	addChild: (child: unknown) => void;
}

function createEditorSlot(...initial: unknown[]): EditorSlot {
	return {
		children: [...initial],
		clear() {
			this.children = [];
		},
		addChild(child: unknown) {
			this.children.push(child);
		},
	};
}

function createCtx(slot: EditorSlot, editor: unknown) {
	const setFocus = vi.fn();
	const ctx = {
		editor,
		editorContainer: slot,
		ui: {
			setFocus,
			requestRender: vi.fn(),
		},
	} as unknown as InteractiveModeContext;
	return { ctx, setFocus };
}

describe("SelectorController.focusActiveEditorArea", () => {
	// Regression for issue #3349: closing a fullscreen overlay (settings,
	// extensions dashboard, agents dashboard) while a hook selector / approval
	// prompt occupies the editor slot must restore focus to that prompt — not
	// to the editor that the prompt replaced. Pre-fix, the close handlers
	// hardcoded `setFocus(this.ctx.editor)`, leaving keystrokes routed to a
	// no-longer-mounted editor while the visible prompt sat unreachable.

	it("focuses the editor when the slot has only the editor in it", () => {
		const editor = { id: "editor" };
		const slot = createEditorSlot(editor);
		const { ctx, setFocus } = createCtx(slot, editor);

		new SelectorController(ctx).focusActiveEditorArea();

		expect(setFocus).toHaveBeenCalledTimes(1);
		expect(setFocus).toHaveBeenCalledWith(editor);
	});

	it("focuses the active hook-selector-style prompt when the slot holds it instead of the editor", () => {
		const editor = { id: "editor" };
		const approvalPrompt = { id: "approval-prompt" };
		// Mirrors `ExtensionUiController.showHookSelector`: the hook surface
		// clears the slot and replaces the editor with its prompt component.
		const slot = createEditorSlot(approvalPrompt);
		const { ctx, setFocus } = createCtx(slot, editor);

		new SelectorController(ctx).focusActiveEditorArea();

		expect(setFocus).toHaveBeenCalledTimes(1);
		expect(setFocus).toHaveBeenCalledWith(approvalPrompt);
		expect(setFocus).not.toHaveBeenCalledWith(editor);
	});

	it("falls back to the editor when the slot is empty (defensive)", () => {
		const editor = { id: "editor" };
		const slot = createEditorSlot();
		const { ctx, setFocus } = createCtx(slot, editor);

		new SelectorController(ctx).focusActiveEditorArea();

		expect(setFocus).toHaveBeenCalledTimes(1);
		expect(setFocus).toHaveBeenCalledWith(editor);
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
		vi.spyOn(SessionManager, "list").mockResolvedValue([session]);

		const overlayHidden = Promise.withResolvers<void>();
		const hide = vi.fn(() => overlayHidden.resolve());
		let selector: SessionSelectorComponent | undefined;
		const editor = { id: "editor" };
		const editorContainer = createEditorSlot(editor);
		const ctx = {
			editor,
			editorContainer,
			sessionManager: {
				getCwd: () => "/tmp",
				getSessionDir: () => "/tmp",
			},
			ui: {
				showOverlay: vi.fn(component => {
					selector = component as SessionSelectorComponent;
					return { hide, setHidden: vi.fn(), isHidden: () => false };
				}),
				setFocus: vi.fn(),
				requestRender: vi.fn(),
				terminal: { rows: 24 },
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
		expect(selector).toBeDefined();
		selector!.handleInput("\n");
		await resumeStarted.promise;

		expect(handleResume).toHaveBeenCalledWith(session.path);
		expect(hide).not.toHaveBeenCalled();

		// The selector remains mounted until resume finishes, but it must not accept
		// a second selection or cancel the overlay during that interval.
		selector!.handleInput("\n");
		selector!.handleInput("\x1b");
		expect(handleResume).toHaveBeenCalledTimes(1);
		expect(hide).not.toHaveBeenCalled();

		resumed.resolve(true);
		await overlayHidden.promise;
		expect(hide).toHaveBeenCalledTimes(1);
	});
});
