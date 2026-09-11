import { beforeAll, describe, expect, it, vi } from "bun:test";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings";
import { getKeybindings, setKeybindings } from "@oh-my-pi/pi-tui";
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
	it("exits on ctrl+d with an empty draft", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onExit = vi.fn();
		editor.onExit = onExit;
		editor.handleInput("\x04"); // Ctrl+D
		expect(onExit).toHaveBeenCalledTimes(1);
	});

	it("forward-deletes instead of exiting on ctrl+d with draft text", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onExit = vi.fn();
		editor.onExit = onExit;
		editor.setText("ab");
		editor.moveToLineStart();
		editor.handleInput("\x04"); // Ctrl+D
		expect(onExit).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("b");
	});

	it("exits on ctrl+d after the last attachment chip is deleted", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onExit = vi.fn();
		editor.onExit = onExit;
		editor.insertTextAttachment("a long pasted blob");
		expect(editor.composerChips()).toHaveLength(1);
		// Deleting the chip token empties the buffer; `pendingTexts` keeps the
		// record so attachment numbering isn't recycled.
		editor.setText("");
		expect(editor.composerChips()).toHaveLength(0);
		editor.handleInput("\x04"); // Ctrl+D
		expect(onExit).toHaveBeenCalledTimes(1);
	});

	it("keeps the exit chord's precedence when forward-deleting: later handlers on the same chord do not fire", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onExit = vi.fn();
		const onDequeue = vi.fn();
		const customHandler = vi.fn();
		editor.onExit = onExit;
		editor.onDequeue = onDequeue;
		// A later app action and an extension handler both user-bound to Ctrl+D while
		// the default exit binding stays; KeybindingsManager only flags clashes between
		// explicit user claims, so this configuration is reachable.
		editor.setActionKeys("app.message.dequeue", ["ctrl+d"]);
		editor.setCustomKeyHandler("ctrl+d", customHandler);
		editor.setText("ab");
		editor.moveToLineStart();
		editor.handleInput("\x04"); // Ctrl+D
		expect(editor.getText()).toBe("b");
		expect(onExit).not.toHaveBeenCalled();
		expect(onDequeue).not.toHaveBeenCalled();
		expect(customHandler).not.toHaveBeenCalled();
	});

	it("forward-deletes even when an earlier base-editor action is user-bound to the same chord", () => {
		// Editor.handleInput checks tui.input.submit before tui.editor.deleteCharForward, so
		// redispatching the raw key would submit the draft; the operation must be invoked directly.
		const previous = getKeybindings();
		setKeybindings(KeybindingsManager.inMemory({ "tui.input.submit": ["enter", "ctrl+d"] }));
		try {
			const editor = new CustomEditor(getEditorTheme());
			const onExit = vi.fn();
			const onSubmit = vi.fn();
			editor.onExit = onExit;
			editor.onSubmit = onSubmit;
			editor.setText("ab");
			editor.moveToLineStart();
			editor.handleInput("\x04"); // Ctrl+D
			expect(editor.getText()).toBe("b");
			expect(onSubmit).not.toHaveBeenCalled();
			expect(onExit).not.toHaveBeenCalled();
		} finally {
			setKeybindings(previous);
		}
	});

	it("leaves the cursor on a grapheme after ctrl+d in vim normal mode, like the Delete key", () => {
		// Vim maps the Delete key to `x`, which clamps the Normal-mode cursor; Ctrl+D resolves in
		// the exit slot and must land on the same state, or the next insert goes in at the wrong
		// column (deleting the last grapheme of "ab" then `iX` produced "aX" instead of "Xa").
		const editor = new CustomEditor(getEditorTheme());
		editor.setVimMode(true);
		editor.setText("ab");
		editor.handleInput("\x1b"); // Escape -> Normal, cursor rests on "b"
		editor.handleInput("\x04"); // Ctrl+D
		expect(editor.getText()).toBe("a");
		expect(editor.getCursor()).toEqual({ line: 0, col: 0 });
		editor.handleInput("i");
		editor.handleInput("X");
		expect(editor.getText()).toBe("Xa");
	});

	it("still exits on a remapped exit key with no forward-delete role, even with text", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.setActionKeys("app.exit", ["ctrl+q"]);
		const onExit = vi.fn();
		editor.onExit = onExit;
		editor.setText("ab");
		editor.handleInput("\x11"); // Ctrl+Q
		expect(onExit).toHaveBeenCalledTimes(1);
		expect(editor.getText()).toBe("ab");
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
