import { describe, expect, it } from "bun:test";
import { type Component, Container, type Focusable, type OverlayFocusOwner, TUI } from "@oh-my-pi/pi-tui";
import { Terminal, type TerminalIo, type TerminalIoSink } from "@oh-my-pi/pi-tui/terminal";

const utf8Decoder = new TextDecoder();
const utf8Encoder = new TextEncoder();

/** Byte-capturing IO port: engine output is recorded, nothing answers on stdin. */
class CaptureIo implements TerminalIo {
	readonly interactive = false;
	readonly backlog = 0;
	readonly writes: string[] = [];
	sink: TerminalIoSink | undefined;

	constructor(
		readonly columns: number,
		readonly rows: number,
	) {}

	open(sink: TerminalIoSink): void {
		this.sink = sink;
	}

	write(chunks: readonly Uint8Array[]): void {
		for (const chunk of chunks) this.writes.push(utf8Decoder.decode(chunk, { stream: true }));
	}

	close(): void {
		this.sink = undefined;
	}
}

class MinimalTerminal extends Terminal {
	readonly #io: CaptureIo;
	cursorHidden = false;
	cursorTransitions = 0;

	constructor() {
		const io = new CaptureIo(80, 24);
		super(io);
		this.#io = io;
	}

	override async drainInput(_maxMs?: number, _idleMs?: number): Promise<void> {}

	/** Everything the engine wrote so far. */
	get output(): string {
		return this.#io.writes.join("");
	}

	override hideCursor(force?: boolean): void {
		this.cursorHidden = true;
		this.cursorTransitions += 1;
		super.hideCursor(force);
	}

	override showCursor(force?: boolean): void {
		this.cursorHidden = false;
		this.cursorTransitions += 1;
		super.showCursor(force);
	}

	/** Deliver stdin bytes through the engine's input parser. */
	sendInput(data: string): void {
		this.#io.sink?.input(utf8Encoder.encode(data));
	}

	/** Report the (unchanged) OS size again, as a SIGWINCH does. */
	emitResize(): void {
		this.#io.sink?.resize(this.#io.columns, this.#io.rows);
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

class CapturingRecorder extends FocusRecorder {
	constructor(
		label: string,
		readonly captured: string,
	) {
		super(label);
	}

	capturesInput(data: string): boolean {
		return data === this.captured;
	}
}

describe("TUI overlay focus", () => {
	it("delivers keys to the displaced editor beneath a paint-only overlay", () => {
		const terminal = new MinimalTerminal();
		const tui = new TUI(terminal);
		const editor = new FocusRecorder("editor");
		const sidebar: Component = { render: () => ["sidebar"] };

		tui.addChild(editor);
		tui.setFocus(editor);

		try {
			tui.start();
			tui.showOverlay(sidebar);
			terminal.sendInput("hello");

			// The stdin parser delivers typed text one key at a time.
			expect(tui.getFocused()).toBe(sidebar);
			expect(editor.inputs).toEqual([..."hello"]);
		} finally {
			tui.stop();
		}
	});

	it("follows the live editor-slot owner while a paint-only overlay holds focus", () => {
		const terminal = new MinimalTerminal();
		const tui = new TUI(terminal);
		const editor = new FocusRecorder("editor");
		const editorSlot = new Container();
		const approvalPrompt = new FocusRecorder("approval");
		const sidebar: Component = { render: () => ["sidebar"] };

		editorSlot.addChild(editor);
		tui.addChild(editorSlot);
		tui.setFocus(editor);

		try {
			tui.start();
			const handle = tui.showOverlay(sidebar);
			editorSlot.clear();
			editorSlot.addChild(approvalPrompt);
			tui.setFocus(approvalPrompt);
			terminal.sendInput("x");

			expect(tui.getFocused()).toBe(sidebar);
			expect(approvalPrompt.inputs).toEqual(["x"]);
			expect(editor.inputs).toEqual([]);

			handle.hide();
			terminal.sendInput("y");
			expect(tui.getFocused()).toBe(approvalPrompt);
			expect(approvalPrompt.inputs).toEqual(["x", "y"]);
		} finally {
			tui.stop();
		}
	});

	it("lets the displaced editor reserve captured keys before input listeners", () => {
		const terminal = new MinimalTerminal();
		const tui = new TUI(terminal);
		const editor = new CapturingRecorder("editor", "\x00");
		const sidebar: Component = { render: () => ["sidebar"] };
		const listenerInputs: string[] = [];

		tui.addChild(editor);
		tui.setFocus(editor);
		tui.addInputListener(data => {
			listenerInputs.push(data);
			return { consume: true };
		});

		try {
			tui.start();
			tui.showOverlay(sidebar);
			terminal.sendInput("\x00");

			expect(editor.inputs).toEqual(["\x00"]);
			expect(listenerInputs).toEqual([]);
		} finally {
			tui.stop();
		}
	});

	it("does not pass through multiple paint-only overlays to a distant editor", () => {
		const terminal = new MinimalTerminal();
		const tui = new TUI(terminal);
		const editor = new FocusRecorder("editor");
		const sidebar: Component = { render: () => ["sidebar"] };
		const decoration: Component = { render: () => ["decoration"] };

		tui.addChild(editor);
		tui.setFocus(editor);

		try {
			tui.start();
			tui.showOverlay(sidebar);
			tui.showOverlay(decoration);
			terminal.sendInput("hello");

			expect(tui.getFocused()).toBe(decoration);
			expect(editor.inputs).toEqual([]);
		} finally {
			tui.stop();
		}
	});

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
			expect(authorizationCodeInput.inputs).toEqual([..."code"]);
			expect(wizardOverlay.inputs).toEqual([]);

			tui.setFocus(approvalPrompt);
			terminal.sendInput("still-code");

			expect(tui.getFocused()).toBe(authorizationCodeInput);
			expect(authorizationCodeInput.inputs).toEqual([..."code", ..."still-code"]);
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
			// One stdin read: a lone break-bearing read is held for the 10 ms raw-paste
			// classification window, while the arrow's ESC delivers both keys at once.
			terminal.sendInput("\x1b[B\r");
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
