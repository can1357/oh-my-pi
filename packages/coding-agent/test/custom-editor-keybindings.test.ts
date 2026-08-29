import { beforeAll, describe, expect, it, vi } from "bun:test";
import { KEYBINDINGS, KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings";
import { CustomEditor } from "@oh-my-pi/pi-coding-agent/modes/components/custom-editor";
import { getEditorTheme, initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

describe("CustomEditor keybindings", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("routes the configured retry chord through handleInput", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onRetry = vi.fn();

		editor.setActionKeys("app.retry", ["alt+shift+r"]);
		editor.onRetry = onRetry;
		editor.handleInput("\x1bR");

		expect(onRetry).toHaveBeenCalledTimes(1);
	});

	it("routes the configured tool activity visibility chord through handleInput", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onToggleToolActivity = vi.fn();

		editor.setActionKeys("app.tools.toggleVisibility", ["alt+h"]);
		editor.onToggleToolActivity = onToggleToolActivity;
		editor.handleInput("\x1bh");

		expect(onToggleToolActivity).toHaveBeenCalledTimes(1);
	});

	it("lets custom handlers keep precedence over the default retry chord", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onRetry = vi.fn();
		const customHandler = vi.fn();

		editor.onRetry = onRetry;
		editor.setCustomKeyHandler("alt+r", customHandler);
		editor.handleInput("\x1br");

		expect(customHandler).toHaveBeenCalledTimes(1);
		expect(onRetry).not.toHaveBeenCalled();
	});

	it("lets copy-prompt remaps keep precedence over the default retry chord", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onRetry = vi.fn();
		const onCopyPrompt = vi.fn();

		editor.onRetry = onRetry;
		editor.onCopyPrompt = onCopyPrompt;
		editor.setActionKeys("app.clipboard.copyPrompt", ["alt+r"]);
		editor.handleInput("\x1br");

		expect(onCopyPrompt).toHaveBeenCalledTimes(1);
		expect(onRetry).not.toHaveBeenCalled();
	});

	describe("persona cycle — Tab only fires on empty editor", () => {
		it("cycles forward on Tab when the editor is empty", () => {
			const editor = new CustomEditor(getEditorTheme());
			const onCycleForward = vi.fn();
			editor.onCyclePersonaForward = onCycleForward;
			editor.handleInput("\t");
			expect(onCycleForward).toHaveBeenCalledTimes(1);
		});

		it("does not cycle forward on Tab when the editor has text", () => {
			const editor = new CustomEditor(getEditorTheme());
			const onCycleForward = vi.fn();
			editor.onCyclePersonaForward = onCycleForward;
			editor.handleInput("/");
			editor.handleInput("\t");
			expect(onCycleForward).not.toHaveBeenCalled();
		});

		it("cycles backward on Shift+Tab when the editor is empty", () => {
			const editor = new CustomEditor(getEditorTheme());
			editor.setActionKeys("app.thinking.cycle", ["ctrl+tab"]);
			editor.setActionKeys("app.persona.cycleBackward", ["shift+tab"]);
			const onCycleBackward = vi.fn();
			editor.onCyclePersonaBackward = onCycleBackward;
			editor.handleInput("\x1b[Z");
			expect(onCycleBackward).toHaveBeenCalledTimes(1);
		});

		it("does not cycle backward on Shift+Tab when the editor has text", () => {
			const editor = new CustomEditor(getEditorTheme());
			editor.setActionKeys("app.thinking.cycle", ["ctrl+tab"]);
			editor.setActionKeys("app.persona.cycleBackward", ["shift+tab"]);
			const onCycleBackward = vi.fn();
			editor.onCyclePersonaBackward = onCycleBackward;
			editor.handleInput("h");
			editor.handleInput("\x1b[Z");
			expect(onCycleBackward).not.toHaveBeenCalled();
		});

		it("falls through to base Tab completion when onCyclePersonaForward returns false", () => {
			const editor = new CustomEditor(getEditorTheme());
			const onCycle = vi.fn(() => false as false);
			editor.onCyclePersonaForward = onCycle;
			editor.handleInput("\t");
			// Callback fired once — the "no personas" signal was received
			expect(onCycle).toHaveBeenCalledTimes(1);
			// Base editor Tab completion opens a suggestion popup rather than inserting a
			// literal tab character, so the text buffer stays empty.
			expect(editor.getText()).toBe("");
		});

		it("falls through to thinking-level cycle when onCyclePersonaBackward returns false", () => {
			const editor = new CustomEditor(getEditorTheme());
			editor.setActionKeys("app.thinking.cycle", ["ctrl+tab"]);
			editor.setActionKeys("app.persona.cycleBackward", ["shift+tab"]);
			const onCycleBackward = vi.fn(() => false as false);
			const onCycleThinking = vi.fn();
			editor.onCyclePersonaBackward = onCycleBackward;
			editor.onCycleThinkingLevel = onCycleThinking;
			editor.handleInput("\x1b[Z"); // Shift+Tab
			expect(onCycleBackward).toHaveBeenCalledTimes(1);
			expect(onCycleThinking).toHaveBeenCalledTimes(1);
		});

		it("does NOT call thinking cycle when persona backward succeeds (returns undefined)", () => {
			const editor = new CustomEditor(getEditorTheme());
			editor.setActionKeys("app.thinking.cycle", ["ctrl+tab"]);
			editor.setActionKeys("app.persona.cycleBackward", ["shift+tab"]);
			const onCycleBackward = vi.fn(); // returns undefined — success
			const onCycleThinking = vi.fn();
			editor.onCyclePersonaBackward = onCycleBackward;
			editor.onCycleThinkingLevel = onCycleThinking;
			editor.handleInput("\x1b[Z");
			expect(onCycleBackward).toHaveBeenCalledTimes(1);
			expect(onCycleThinking).not.toHaveBeenCalled();
		});
	});

	it("routes Ctrl+L to a live-toggle custom handler and Alt+L to display reset by default", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onDisplayReset = vi.fn();
		const onLiveToggle = vi.fn();

		editor.onDisplayReset = onDisplayReset;
		editor.setCustomKeyHandler("ctrl+l", onLiveToggle);

		editor.handleInput("\x0c"); // Ctrl+L
		expect(onLiveToggle).toHaveBeenCalledTimes(1);
		expect(onDisplayReset).not.toHaveBeenCalled();

		editor.handleInput("\x1bl"); // Alt+L
		expect(onDisplayReset).toHaveBeenCalledTimes(1);
		expect(onLiveToggle).toHaveBeenCalledTimes(1);
	});
});

describe("shipped dequeue defaults", () => {
	it("binds both alt+up and shift+up to the steering dequeue", () => {
		const keybindings = KeybindingsManager.inMemory();
		const keys = keybindings.getKeys("app.message.dequeue");
		expect(keys).toContain("alt+up");
		expect(keys).toContain("shift+up");
	});
	it("does not steal shift+up from an explicit user binding", () => {
		const keybindings = KeybindingsManager.inMemory({
			"tui.editor.cursorUp": "shift+up",
		});

		expect(keybindings.getKeys("app.message.dequeue")).toEqual(["alt+up"]);
		expect(keybindings.getKeys("tui.editor.cursorUp")).toEqual(["shift+up"]);
	});
	it("routes the shipped shift+up default through DEFAULT_ACTION_KEYS to the dequeue handler", () => {
		// F12: the registry test above does not cover DEFAULT_ACTION_KEYS, the second
		// defaults table that custom-editor.ts seeds its match set from. Drive a real
		// editor without calling setActionKeys, so the shipped entry is the only thing
		// that can make the shift+up wire form (CSI 1;2A) reach onDequeue.
		const editor = new CustomEditor(getEditorTheme());
		const onDequeue = vi.fn();

		editor.onDequeue = onDequeue;
		editor.handleInput("\x1b[1;2A");

		expect(onDequeue).toHaveBeenCalledTimes(1);
	});
});

describe("shipped persona/thinking default keybinding metadata", () => {
	it("keeps persona cycleBackward on ctrl+tab and thinking cycle on shift+tab", () => {
		expect(KEYBINDINGS["app.persona.cycleBackward"].defaultKeys).toBe("ctrl+tab");
		expect(KEYBINDINGS["app.thinking.cycle"].defaultKeys).toBe("shift+tab");
	});
});
