/**
 * Multi-line editor component for hooks and ask custom input.
 * Supports Ctrl+G for external editor.
 *
 * Two modes:
 * - Default (hook): Enter inserts newline, the `app.message.followUp` chord
 *   (Ctrl+Q / Ctrl+Enter) submits, bordered popup
 * - Prompt-style (ask): Enter submits, Shift+Enter inserts newline, legacy ask chrome
 */
import { Container, Editor, matchesKey, Spacer, Text, type TUI } from "@pk-nerdsaver-ai/pi-tui";
import { getEditorTheme, theme } from "../../modes/theme/theme";
import {
	matchesAppExternalEditor,
	matchesAppFollowUp,
	matchesAppInterrupt,
} from "../../modes/utils/keybinding-matchers";
import { getEditorCommand, openInEditor } from "../../utils/external-editor";
import { DynamicBorder } from "./dynamic-border";

export interface HookEditorOptions {
	/** When true, use prompt-style keybindings with the legacy ask prompt chrome. */
	promptStyle?: boolean;
}

export class HookEditorComponent extends Container {
	#editor: Editor;
	#onSubmitCallback: (value: string) => void;
	#onCancelCallback: () => void;
	#tui: TUI;
	#promptStyle: boolean;

	constructor(
		tui: TUI,
		title: string,
		prefill: string | undefined,
		onSubmit: (value: string) => void,
		onCancel: () => void,
		options?: HookEditorOptions,
	) {
		super();

		this.#tui = tui;
		this.#onSubmitCallback = onSubmit;
		this.#onCancelCallback = onCancel;
		this.#promptStyle = options?.promptStyle ?? false;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		// Title
		this.addChild(new Text(theme.fg("accent", title), 1, 0));
		this.addChild(new Spacer(1));

		// Editor
		this.#editor = new Editor(getEditorTheme());
		if (this.#promptStyle) {
			this.#editor.setBorderVisible(false);
			this.#editor.setPromptGutter("> ");
			this.#editor.disableSubmit = true;
		}
		if (prefill) {
			this.#editor.setText(prefill);
		}
		this.addChild(this.#editor);

		this.addChild(new Spacer(1));

		// Hint
		const hint = this.#promptStyle
			? "enter or ctrl+q submit  esc cancel  ctrl+g external editor"
			: "ctrl+q/ctrl+enter submit  esc cancel  ctrl+g external editor";
		this.addChild(new Text(theme.fg("dim", hint), 1, 0));

		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
	}

	handleInput(keyData: string): void {
		if (this.#promptStyle) {
			this.#handlePromptStyleInput(keyData);
		} else {
			this.#handleHookStyleInput(keyData);
		}
	}

	#submitCurrentText(): void {
		this.#onSubmitCallback(this.#editor.getExpandedText());
	}

	/** Route non-bracketed paste transports (e.g. kitty's OSC 5522 enhanced clipboard)
	 *  into the inner editor, mirroring bracketed-paste semantics. Without this hook,
	 *  enhanced-paste routing falls back to the main prompt editor hidden behind the
	 *  dialog (#2127 routing contract). */
	pasteText(text: string): void {
		this.#editor.pasteText(text);
	}

	/**
	 * Prompt-style: raw Enter submits; Editor owns newline-producing sequences.
	 * The follow-up chord (`app.message.followUp` → Ctrl+Q / Ctrl+Enter) also
	 * submits, so muscle memory from the main editor / hook-style surface works
	 * here and Windows Terminal — which can't deliver a distinct Ctrl+Enter
	 * event (#1903) — still has a working chord via Ctrl+Q (#3353).
	 */
	#handlePromptStyleInput(keyData: string): void {
		// Submit on the follow-up chord first so it wins over Editor's own
		// Ctrl+Enter newline handling. Mirrors #handleHookStyleInput.
		if (matchesAppFollowUp(keyData)) {
			this.#submitCurrentText();
			return;
		}

		// Prompt-style keeps Escape as an explicit cancel key and also honors app.interrupt remaps.
		if (matchesKey(keyData, "escape") || matchesKey(keyData, "esc") || matchesAppInterrupt(keyData)) {
			this.#onCancelCallback();
			return;
		}

		// Ctrl+G for external editor
		if (matchesAppExternalEditor(keyData)) {
			void this.#openExternalEditor();
			return;
		}

		// Submit on any plain Enter encoding, including terminals that report unmodified Enter as LF.
		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return")) {
			this.#submitCurrentText();
			return;
		}

		// Let Editor handle modified newline-producing variants (Shift+Enter, Ctrl+Enter, Alt+Enter, etc.)
		this.#editor.handleInput(keyData);
	}

	/** Hook-style: Enter=newline, app.message.followUp chord (Ctrl+Q/Ctrl+Enter) submits. */
	#handleHookStyleInput(keyData: string): void {
		// Submit on the follow-up chord. Uses the shared keybinding so Ctrl+Q works
		// on Windows Terminal (#1903) and any user remap of `app.message.followUp`
		// applies here too.
		if (matchesAppFollowUp(keyData)) {
			this.#submitCurrentText();
			return;
		}

		// Plain Enter inserts a new line in hook editor
		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			this.#editor.handleInput("\n");
			return;
		}

		// Escape to cancel
		if (matchesAppInterrupt(keyData)) {
			this.#onCancelCallback();
			return;
		}

		// Ctrl+G for external editor
		if (matchesAppExternalEditor(keyData)) {
			void this.#openExternalEditor();
			return;
		}

		// Forward to editor
		this.#editor.handleInput(keyData);
	}

	async #openExternalEditor(): Promise<void> {
		const editorCmd = getEditorCommand();
		if (!editorCmd) return;

		const currentText = this.#editor.getExpandedText();
		try {
			this.#tui.stop();
			const result = await openInEditor(editorCmd, currentText);
			if (result !== null) {
				this.#editor.setText(result);
			}
		} finally {
			this.#tui.start();
			this.#tui.requestRender(true);
		}
	}
}
