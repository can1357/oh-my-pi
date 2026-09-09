import { describe, expect, it } from "bun:test";
import { type Component, Container, type Focusable, type OverlayFocusOwner, TUI } from "@oh-my-pi/pi-tui";
import type { Terminal, TerminalAppearance } from "@oh-my-pi/pi-tui/terminal";

class MinimalTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = false;
	kittyEnableSequence: string | null = null;
	keyboardEnhancementEnterSequence: string | null = null;
	keyboardEnhancementExitSequence: string | null = null;
	appearance: TerminalAppearance | undefined;
	#onInput: ((data: string) => void) | undefined;
	#onResize: (() => void) | undefined;
	output = "";
	cursorHidden = false;
	cursorTransitions = 0;

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.#onInput = onInput;
		this.#onResize = onResize;
	}

	stop(): void {
		this.#onInput = undefined;
		this.#onResize = undefined;
	}

	async drainInput(_maxMs?: number, _idleMs?: number): Promise<void> {}

	write(data: string): void {
		this.output += data;
		if (data.length === 0) this.output += "";
	}

	moveBy(_lines: number): void {}

	hideCursor(): void {
		this.cursorHidden = true;
		this.cursorTransitions += 1;
	}

	showCursor(): void {
		this.cursorHidden = false;
		this.cursorTransitions += 1;
	}

	clearLine(): void {}

	clearFromCursor(): void {}

	clearScreen(): void {}

	setTitle(_title: string): void {}

	setProgress(_active: boolean): void {}

	onAppearanceChange(_callback: (appearance: TerminalAppearance) => void): void {}

	sendInput(data: string): void {
		const onInput = this.#onInput;
		if (onInput) onInput(data);
	}

	emitResize(): void {
		const onResize = this.#onResize;
		if (onResize) onResize();
	}
}

class FocusRecorder implements Component, Focusable {
	focused = false;
	inputs: string[] = [];
	lastInput = "";

	constructor(readonly label: string) {}

	handleInput(data: string): void {
		this.inputs.push(data);
		this.lastInput = data;
	}

	render(_width: number): string[] {
		const suffix = this.focused ? "-focused" : "";
		return [`${this.label}${suffix}`];
	}
}

class OwningOverlay extends FocusRecorder implements OverlayFocusOwner {
	focusTarget: Component | undefined;

	ownsOverlayFocusTarget(component: Component): boolean {
		if (component !== this.focusTarget) return false;
		return true;
	}
}

describe("TUI overlay focus", () => {
	it("keeps keyboard focus on the visible overlay when a hidden surface requests focus", () => {
		const terminal = new MinimalTerminal();
		const tui = new TUI(terminal);
		const editor = new FocusRecorder("editor");
		const settingsOverlay = new FocusRecorder("settings");
		const approvalPrompt = new FocusRecorder("approval");

		tui.addChild(editor);
		tui.setFocus(editor);

		try {
			tui.start();
			tui.showOverlay(settingsOverlay, { fullscreen: true });

			tui.setFocus(approvalPrompt);
			terminal.sendInput("x");

			expect(tui.getFocused()).toBe(settingsOverlay);
			expect(settingsOverlay.inputs).toEqual(["x"]);
			expect(approvalPrompt.inputs).toEqual([]);
		} finally {
			tui.stop();
		}
	});

	it("allows a visible overlay to delegate focus to an owned prompt", () => {
		const terminal = new MinimalTerminal();
		const tui = new TUI(terminal);
		const editor = new FocusRecorder("editor");
		const wizardOverlay = new OwningOverlay("wizard");
		const authorizationCodeInput = new FocusRecorder("code");
		const approvalPrompt = new FocusRecorder("approval");

		tui.addChild(editor);
		tui.setFocus(editor);

		try {
			tui.start();
			tui.showOverlay(wizardOverlay, { fullscreen: true });

			wizardOverlay.focusTarget = authorizationCodeInput;
			tui.setFocus(authorizationCodeInput);
			terminal.sendInput("code");

			expect(tui.getFocused()).toBe(authorizationCodeInput);
			expect(authorizationCodeInput.inputs).toEqual(["code"]);
			expect(wizardOverlay.inputs).toEqual([]);

			tui.setFocus(approvalPrompt);
			terminal.sendInput("still-code");

			expect(tui.getFocused()).toBe(authorizationCodeInput);
			expect(authorizationCodeInput.inputs).toEqual(["code", "still-code"]);
			expect(approvalPrompt.inputs).toEqual([]);
		} finally {
			tui.stop();
		}
	});

	it("hands focus to the live editor-slot owner after a fullscreen overlay closes (issue #3349)", () => {
		// Repro for issue #3349: opening /settings (a fullscreen overlay)
		// while a tool approval prompt fires lands the prompt component in
		// the editor slot. When the overlay closes, `overlayHandle.hide()`
		// restores focus to the preFocus captured at open time — the
		// (now-unmounted) editor. Pre-fix, the visible prompt received no
		// keystrokes and the TUI looked frozen. The SelectorController fix
		// follows `hide()` with `setFocus(editorContainer.children[0] ?? editor)`;
		// this test pins that pattern at the TUI level.
		const terminal = new MinimalTerminal();
		const tui = new TUI(terminal);

		const editor = new FocusRecorder("editor");
		const editorContainer = new Container();
		editorContainer.addChild(editor);
		tui.addChild(editorContainer);
		tui.setFocus(editor);

		try {
			tui.start();

			// /settings opens a fullscreen overlay. preFocus captured = editor.
			const settingsOverlay = new FocusRecorder("settings");
			const handle = tui.showOverlay(settingsOverlay, { fullscreen: true });
			expect(tui.getFocused()).toBe(settingsOverlay);

			// While settings is open, a tool approval prompt swaps the editor
			// slot to a hook-selector component. Focus snaps back to the
			// settings overlay because it owns the top of the overlay stack.
			const approvalPrompt = new FocusRecorder("approval");
			editorContainer.clear();
			editorContainer.addChild(approvalPrompt);
			tui.setFocus(approvalPrompt);
			expect(tui.getFocused()).toBe(settingsOverlay);

			// User Esc's out of settings. Replicate the post-fix close path:
			// hide(), then setFocus on whatever owns the slot right now.
			handle.hide();
			const slotOwner = editorContainer.children[0] ?? editor;
			tui.setFocus(slotOwner);

			// The visible approval prompt now receives input. Pre-fix the
			// hide()-only restore left focus on the stale editor.
			terminal.sendInput("\x1b[B");
			terminal.sendInput("\r");
			expect(tui.getFocused()).toBe(approvalPrompt);
			expect(approvalPrompt.inputs).toEqual(["\x1b[B", "\r"]);
			expect(editor.inputs).toEqual([]);
		} finally {
			tui.stop();
		}
	});

	it("pre-fix snapshot: hide() alone restores focus to the stale editor, missing the live slot owner (issue #3349)", () => {
		// Companion to the test above: pin the exact pre-fix behavior so a
		// future refactor of `overlayHandle.hide()` cannot silently change the
		// contract that the SelectorController fix compensates for. `hide()`
		// restores focus to `preFocus` captured at open time — the editor —
		// regardless of what currently occupies the editor slot. The
		// SelectorController close handlers MUST call `focusActiveEditorArea()`
		// after `hide()`; this test demonstrates why.
		const terminal = new MinimalTerminal();
		const tui = new TUI(terminal);

		const editor = new FocusRecorder("editor");
		const editorContainer = new Container();
		editorContainer.addChild(editor);
		tui.addChild(editorContainer);
		tui.setFocus(editor);

		try {
			tui.start();

			const settingsOverlay = new FocusRecorder("settings");
			const handle = tui.showOverlay(settingsOverlay, { fullscreen: true });

			const approvalPrompt = new FocusRecorder("approval");
			editorContainer.clear();
			editorContainer.addChild(approvalPrompt);
			tui.setFocus(approvalPrompt);

			// Close the overlay WITHOUT the SelectorController's follow-up
			// `focusActiveEditorArea()`. hide() restores focus to preFocus.
			handle.hide();

			terminal.sendInput("\x1b[B");
			expect(tui.getFocused()).toBe(editor);
			expect(editor.inputs).toEqual(["\x1b[B"]);
			expect(approvalPrompt.inputs).toEqual([]);
		} finally {
			tui.stop();
		}
	});
});
