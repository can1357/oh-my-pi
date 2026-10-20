import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { setKeybindings } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { getEditorTheme, initTheme } from "@oh-my-pi/pi-tui/theme";

/**
 * #8952: `app.interrupt` is the configurable abort shortcut, but the
 * focused-subagent view also leaves on Escape ("Esc returns to main").
 * Remapping the shortcut must move the abort action only — the focused view
 * must stay reachable with the raw Escape key.
 */

function createHarness(options: { focusedAgentId?: string; remapInterrupt?: boolean; streaming?: boolean }) {
	const editor = new CustomEditor(getEditorTheme());
	const keybindings = KeybindingsManager.inMemory(options.remapInterrupt ? { "app.interrupt": "alt+x" } : {});
	setKeybindings(keybindings);

	const unfocusSession = vi.fn(async () => {});
	const abort = vi.fn(async () => {});
	const ctx = {
		editor,
		keybindings,
		ui: {
			requestRender: vi.fn(),
			resetDisplay: vi.fn(),
			addInputListener: vi.fn(() => () => {}),
			addStartListener: vi.fn(),
			getFocused: () => editor,
			hasOverlay: () => false,
		},
		focusedAgentId: options.focusedAgentId,
		session: {
			isStreaming: options.streaming ?? false,
			isBashRunning: false,
			isEvalRunning: false,
			isCompacting: false,
			isGeneratingHandoff: false,
			abort,
		},
		viewSession: { isCompacting: false, isGeneratingHandoff: false, isRetrying: false },
		unfocusSession,
		focusParentSession: vi.fn(async () => {}),
		mcpTestEscapeHandlers: new Set(),
		hasActiveBtw: () => false,
		handleBtwEscape: () => false,
		hasActiveOmfg: () => false,
		handleOmfgEscape: () => false,
		hasActiveCleanse: () => false,
		handleCleanseEscape: () => false,
		dismissCommandReport: () => false,
		loopModeEnabled: false,
		collabGuest: false,
		loadingAnimation: undefined,
		isBashMode: false,
		isPythonMode: false,
		dictationSpaceHold: () => undefined,
		handleSTTToggle: vi.fn(),
		handleLiveCommand: vi.fn(),
		handlePlanModeCommand: vi.fn(),
		handleNewCommand: vi.fn(),
		handleFollowUp: vi.fn(),
		showAgentHub: vi.fn(),
		showTreeSelector: vi.fn(),
		showUserMessageSelector: vi.fn(),
		showSessionSelector: vi.fn(),
		showStatus: vi.fn(),
		updateEditorBorderColor: vi.fn(),
	} as unknown as InteractiveModeContext;

	const controller = new InputController(ctx);
	controller.setupKeyHandlers();
	return { ctx, editor, keybindings, unfocusSession, abort };
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
});
