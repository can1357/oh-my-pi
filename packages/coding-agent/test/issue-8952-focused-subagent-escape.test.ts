import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { vocalizer } from "@oh-my-pi/pi-coding-agent/tts/vocalizer";
import { setKeybindings } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { getEditorTheme, initTheme } from "@oh-my-pi/pi-tui/theme";

import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

/**
 * #8952: `app.interrupt` is the configurable abort shortcut, but the
 * focused-subagent view also leaves on Escape ("Esc returns to main").
 * Remapping the shortcut must move the abort action only — the focused view
 * must stay reachable with the raw Escape key, and that raw Escape must still
 * run the shared cancellation precedence (`/mcp test`, side panels, speech,
 * loop mode) ahead of the detach.
 */

type HarnessOptions = {
	focusedAgentId?: string;
	remapInterrupt?: boolean;
	streaming?: boolean;
	activeBtw?: boolean;
	loopModeEnabled?: boolean;
};

function createHarness(options: HarnessOptions = {}) {
	const editor = new CustomEditor(getEditorTheme());
	const keybindings = KeybindingsManager.inMemory(options.remapInterrupt ? { "app.interrupt": "alt+x" } : {});
	setKeybindings(keybindings);

	const unfocusSession = vi.fn(async () => {});
	const abort = vi.fn(async () => {});
	const handleBtwEscape = vi.fn(() => true);
	const pauseLoop = vi.fn();
	const cancelPendingSubmission = vi.fn(() => false);
	const ctx = createInteractiveModeContext({
		editor,
		keybindings,
		focusedAgentId: options.focusedAgentId,
		session: { isStreaming: options.streaming ?? false, abort },
		viewSession: { isCompacting: false, isGeneratingHandoff: false, isRetrying: false },
		unfocusSession,
		focusParentSession: vi.fn(async () => {}),
		dictationSpaceHold: () => ({ enabled: () => false, onStart: () => {}, onEnd: () => {} }),
		hasActiveBtw: () => options.activeBtw ?? false,
		handleBtwEscape,
		hasActiveOmfg: () => false,
		handleOmfgEscape: () => true,
		hasActiveCleanse: () => false,
		handleCleanseEscape: () => true,
		dismissCommandReport: () => false,
		loopModeEnabled: options.loopModeEnabled ?? false,
		pauseLoop,
		cancelPendingSubmission,
		eventController: {
			isAwaitingAsyncWork: () => false,
			stopAwaitingAsyncWork: vi.fn(async () => {}),
		},
	});

	const controller = new InputController(ctx);
	controller.setupKeyHandlers();
	return { ctx, editor, unfocusSession, abort, handleBtwEscape, pauseLoop };
}

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(async () => {
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	setKeybindings(KeybindingsManager.inMemory());
	vi.restoreAllMocks();
	resetSettingsForTest();
});

describe("focused-subagent Escape (#8952)", () => {
	it("returns to the main session on Escape when app.interrupt was remapped", () => {
		const { editor, unfocusSession, abort } = createHarness({
			focusedAgentId: "Worker",
			remapInterrupt: true,
		});

		editor.handleInput("\x1b");

		expect(unfocusSession).toHaveBeenCalledTimes(1);
		expect(abort).not.toHaveBeenCalled();
	});

	it("keeps the remapped abort shortcut on its own key in the main view", () => {
		const { editor, unfocusSession, abort } = createHarness({ remapInterrupt: true, streaming: true });

		editor.handleInput("\x1b");
		expect(abort).not.toHaveBeenCalled();
		expect(unfocusSession).not.toHaveBeenCalled();

		editor.handleInput("\x1bx");
		expect(abort).toHaveBeenCalledTimes(1);
	});

	it("returns to the main session on Escape when app.interrupt is left at its default", () => {
		const { editor, unfocusSession, abort } = createHarness({ focusedAgentId: "Worker" });

		editor.handleInput("\x1b");

		expect(unfocusSession).toHaveBeenCalledTimes(1);
		expect(abort).not.toHaveBeenCalled();
	});

	it("lets /mcp test own Escape before the focused-view detach", () => {
		const { ctx, editor, unfocusSession } = createHarness({
			focusedAgentId: "Worker",
			remapInterrupt: true,
		});
		const handler = vi.fn();
		ctx.mcpTestEscapeHandlers.add(handler);

		editor.handleInput("\x1b");

		expect(handler).toHaveBeenCalledTimes(1);
		expect(unfocusSession).not.toHaveBeenCalled();
	});

	it("lets a side panel own Escape before the focused-view detach", () => {
		const { editor, unfocusSession, handleBtwEscape } = createHarness({
			focusedAgentId: "Worker",
			remapInterrupt: true,
			activeBtw: true,
		});

		editor.handleInput("\x1b");

		expect(handleBtwEscape).toHaveBeenCalledTimes(1);
		expect(unfocusSession).not.toHaveBeenCalled();
	});

	it("lets speech own Escape before the focused-view detach", () => {
		const clear = vi.spyOn(vocalizer, "clear").mockImplementation(() => {});
		vi.spyOn(vocalizer, "isSpeaking").mockReturnValue(true);
		const { editor, unfocusSession } = createHarness({
			focusedAgentId: "Worker",
			remapInterrupt: true,
		});

		editor.handleInput("\x1b");

		expect(clear).toHaveBeenCalledTimes(1);
		expect(unfocusSession).not.toHaveBeenCalled();
	});

	it("lets loop mode own Escape before the focused-view detach", () => {
		const { editor, unfocusSession, pauseLoop } = createHarness({
			focusedAgentId: "Worker",
			remapInterrupt: true,
			loopModeEnabled: true,
		});

		editor.handleInput("\x1b");

		expect(pauseLoop).toHaveBeenCalledTimes(1);
		expect(unfocusSession).not.toHaveBeenCalled();
	});
});
