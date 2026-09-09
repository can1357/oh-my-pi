import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { CustomEditor } from "@oh-my-pi/pi-coding-agent/modes/components/custom-editor";
import { getEditorTheme, initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { StdinBuffer } from "@oh-my-pi/pi-tui/stdin-buffer";

/**
 * Regression for #3857.
 *
 * A fast double-Esc lands as one `"\x1b\x1b"` chunk on stdin. Before the fix,
 * `StdinBuffer` held it as the buffered remainder, then timer-flushed it as
 * one sequence. `parseKey("\x1b\x1b")` returns `undefined`, so
 * `CustomEditor.handleInput` fell through to the base editor and never fired
 * the configured `onEscape` — breaking the double-escape gesture.
 *
 * The fix splits a bare `"\x1b\x1b"` into two ESC events only when no follower
 * arrives in the disambiguation window. If a follower arrives, the second ESC
 * remains attached to that follower so legacy Alt chords survive.
 */
describe("buffered double-Esc reaches CustomEditor.onEscape", () => {
	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("fires onEscape twice when a fast double-Esc arrives as one buffered chunk", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onEscape = vi.fn();
		editor.onEscape = onEscape;

		const buf = new StdinBuffer({ timeout: 5, partialHoldTimeout: 5 });
		buf.on("data", chunk => editor.handleInput(chunk));

		buf.process("\x1b\x1b");
		// Drain the flush timer chain (main timeout + zero-delay deferral).
		vi.runAllTimers();

		expect(onEscape).toHaveBeenCalledTimes(2);
		buf.destroy();
	});

	it("preserves a legacy Alt chord batched after a bare ESC", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onEscape = vi.fn();
		editor.onEscape = onEscape;
		editor.setText("foo bar");

		const buf = new StdinBuffer({ timeout: 5, partialHoldTimeout: 5 });
		buf.on("data", chunk => editor.handleInput(chunk));

		buf.process("\x1b\x1b\x7f");
		vi.runAllTimers();

		expect(onEscape).toHaveBeenCalledTimes(1);
		expect(editor.getText()).toBe("foo ");
		buf.destroy();
	});

	it("does not split a meta-CSI arrow into two ESC events", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onEscape = vi.fn();
		editor.onEscape = onEscape;

		const buf = new StdinBuffer({ timeout: 5, partialHoldTimeout: 5 });
		buf.on("data", chunk => editor.handleInput(chunk));

		buf.process("\x1b\x1b[A");
		vi.runAllTimers();

		// alt+up is its own keypress and must never look like two ESC keys.
		expect(onEscape).not.toHaveBeenCalled();
		buf.destroy();
	});
});
