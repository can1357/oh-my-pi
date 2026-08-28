/**
 * Multi-line editor component for hooks and ask custom input.
 * Supports Ctrl+G for external editor.
 *
 * Two modes:
 * - Default (hook): Enter inserts newline, the `app.message.followUp` chord
 *   (Ctrl+Q / Ctrl+Enter) submits, bordered popup
 * - Prompt-style (ask): Enter submits, Shift+Enter inserts newline, legacy ask chrome
 */
import { Editor, type Focusable, matchesKey, Spacer, Text, type TUI } from "@oh-my-pi/pi-tui";
import { getEditorTheme, theme } from "../../modes/theme/theme";
import {
	matchesAppExternalEditor,
	matchesAppFollowUp,
	matchesAppInterrupt,
} from "../../modes/utils/keybinding-matchers";
import { getEditorCommand, openInEditor } from "../../utils/external-editor";
import { OverlayPanel } from "./overlay-box";

export interface HookEditorOptions {
	/** When true, use prompt-style keybindings with the legacy ask prompt chrome. */
	promptStyle?: boolean;
	/**
	 * Max rows the inner Editor may occupy. When omitted, the editor is
	 * bounded to the current terminal height minus the component's chrome
	 * (≈10 rows) so long content scrolls instead of pushing the submit
	 * hint out of view.
	 */
	maxHeight?: number;
}

/** Interactive multiline dialog used by hooks and the ask tool's Other response. */
export class HookEditorComponent extends OverlayPanel implements Focusable {
	#editor: Editor;
	#onSubmitCallback: (value: string) => void;
	#onCancelCallback: () => void;
	#tui: TUI;
	#promptStyle: boolean;
	/** Focus state mirrored to the nested editor during rendering. */
	focused = false;

	constructor(
		tui: TUI,
		title: string,
		prefill: string | undefined,
		onSubmit: (value: string) => void,
		onCancel: () => void,
		options?: HookEditorOptions,
	) {
		// First title line insets into the panel border; remaining lines (e.g. the
		// bounded ask question under "◆ Other (type your own)") stay as body rows
		// so they are never truncated into the one-row border.
		const [titleLine = "", ...detailLines] = title.split("\n");
		super(titleLine);

		this.#tui = tui;
		this.#onSubmitCallback = onSubmit;
		this.#onCancelCallback = onCancel;
		this.#promptStyle = options?.promptStyle ?? false;

		this.addChild(new Spacer(1));
		if (detailLines.length > 0) {
			for (const line of detailLines) this.addChild(new Text(theme.fg("accent", line), 0, 0));
			this.addChild(new Spacer(1));
		}

		// Editor
		this.#editor = new Editor(getEditorTheme());
		if (this.#promptStyle) {
			this.#editor.setBorderVisible(false);
			this.#editor.setPromptGutter("> ");
			this.#editor.disableSubmit = true;
		}
		// Bound the editor so long content scrolls instead of pushing the
		// submit hint off-screen. Caller may override via options.maxHeight.
		const termRows = this.#tui.terminal?.rows ?? process.stdout.rows ?? 40;
		this.#editor.setMaxHeight(options?.maxHeight ?? Math.max(3, termRows - 12));
		this.#editor.setScrollbarVisible(true);
		if (prefill) {
			this.#editor.setText(prefill);
		}
		this.addChild(this.#editor);

		this.addChild(new Spacer(1));

		// Hint
		const hint = this.#promptStyle
			? "enter or ctrl+q submit  esc cancel  ctrl+g external editor"
			: "ctrl+q/ctrl+enter submit  esc cancel  ctrl+g external editor";
		this.addChild(new Text(theme.fg("dim", hint), 0, 0));
		this.addChild(new Spacer(1));
	}

	/** Keep the nested editor's software/hardware cursor mode aligned with the dialog focus target. */
	setUseTerminalCursor(useTerminalCursor: boolean): void {
		if (this.#editor.getUseTerminalCursor() === useTerminalCursor) return;
		this.#editor.setUseTerminalCursor(useTerminalCursor);
	}

	/** Render the dialog after forwarding its focus state to the nested editor. */
	override render(width: number): readonly string[] {
		this.#editor.focused = this.focused;
		return super.render(width);
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
