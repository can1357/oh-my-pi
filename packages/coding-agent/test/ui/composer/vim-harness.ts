/**
 * A {@link Composer} driven like a terminal editor, for the Vim tests: raw input decoded into keys
 * and pastes and routed as the terminal backend routes them, the draft read back as lines and a
 * line/column caret.
 */
import { createRoot, effect } from "@oh-my-pi/pi-tui";
import { bubbleEvent, pathTo } from "@oh-my-pi/pi-tui/dispatch";
import { decodeInput } from "@oh-my-pi/pi-tui/driver/input/decoder";
import type { EditorProps, EditorTerm } from "@oh-my-pi/pi-tui/term/painters/editor";
import { paintNode } from "@oh-my-pi/pi-tui/term/paint";
import { corpusEnvironment } from "@oh-my-pi/pi-tui/testing/corpus";
import { type AutocompleteProvider, Composer, type VimMode } from "../../../src/ui/composer";
import { sendKey, sendPaste } from "./harness";

export const ESC = "\x1b";
export const UP = "\x1b[A";
export const DOWN = "\x1b[B";
export const LEFT = "\x1b[D";
export const BACKSPACE = "\x7f";

/** See the module docs. */
export class VimComposer {
	readonly composer: Composer;

	constructor(options: { readonly autocomplete?: AutocompleteProvider } = {}) {
		this.composer = createRoot(() => new Composer({ autocomplete: options.autocomplete, onSubmit: () => {} }));
		this.render(80);
	}

	/** Lay the field out at `width` columns (wrapped rows decide `gj`/`gk`). */
	render(width: number): void {
		paintNode(corpusEnvironment("dark"), this.composer.node, width);
	}

	/** Feed raw terminal input: every key and paste in it, in order. */
	handleInput(data: string): void {
		const { node, field } = this.composer;
		for (const event of decodeInput(data, { kitty: true })) {
			if (event.type === "key") sendKey(node, field, event.key);
			else if (event.type === "paste") sendPaste(node, field, event.paste.text);
		}
	}

	getText(): string {
		return this.composer.text();
	}

	getExpandedText(): string {
		return this.composer.expandedText();
	}

	getCursor(): { line: number; col: number } {
		const before = this.composer.text().slice(0, this.composer.cursor()).split("\n");
		return { line: before.length - 1, col: before.at(-1)!.length };
	}

	setText(text: string): void {
		this.composer.setText(text);
	}

	setVimMode(on: boolean): void {
		this.composer.setVim(on);
	}

	set vimStartMode(mode: "insert" | "normal") {
		this.composer.setVimStartMode(mode);
	}

	/** The mode; Insert without Vim, as a plain editor always types. */
	get vimMode(): VimMode {
		return this.composer.vimMode() ?? "insert";
	}

	get vimPending(): string {
		return this.composer.vimPendingText();
	}

	get vimSelectedLines(): number {
		return this.composer.vimSelectedLines();
	}

	vimConsumesEscape(): boolean {
		return this.composer.vimConsumesEscape();
	}

	addToHistory(text: string): void {
		this.composer.addToHistory(text);
	}

	/** Keep the draft recallable and clear it (a draft put aside, as the app's `clearDraft`). */
	rememberDraft(): void {
		this.composer.clearDraft();
	}

	submit(): void {
		this.composer.submit();
	}

	set onYank(handler: (text: string, register: string | undefined) => void) {
		this.composer.onYank = handler;
	}

	set readClipboard(read: () => Promise<string>) {
		this.composer.readClipboard = read;
	}

	set onHistorySearch(handler: () => void) {
		this.composer.onHistorySearch = handler;
	}

	set onUpFromTop(handler: () => boolean) {
		this.composer.onUpFromTop = handler;
	}

	set onSubmit(handler: (text: string) => void) {
		this.composer.onSubmit = handler;
	}

	/** `:` starts a slash command only with a command menu (a completion source) to open. */
	set vimSlashCommands(on: boolean) {
		this.composer.setAutocomplete(
			on
				? {
						async getSuggestions() {
							return null;
						},
						applyCompletion(lines, cursorLine, cursorCol) {
							return { lines, cursorLine, cursorCol };
						},
					}
				: undefined,
		);
	}

	isShowingAutocomplete(): boolean {
		return this.composer.completing();
	}

	/** Insert an atom (a chip the draft shows as `label`) at the caret, followed by a space. */
	insertAtom(label: string): void {
		this.composer.insertAtom(label, `<${label}>`);
	}

	/** An edit the terminal made in the field itself (a native caret move, Tern's own typing). */
	applyHostEdit(edit: { len: number; from: number; to: number; cursor: number; text: string }): void {
		const { node, field } = this.composer;
		bubbleEvent(pathTo([node], field), { type: "edit", key: "", ...edit });
	}

	/** The field's terminal look facts (caret shape, Visual selection). */
	fieldTerm(): EditorTerm | undefined {
		// The field is an `editor` node, whose props the editor painter reads as `EditorProps`.
		const props = this.composer.field.props() as EditorProps;
		return props.term;
	}

	/** Record `read()` into `seen` each time what it reads changes. */
	watch(read: () => string, seen: string[]): void {
		let first = true;
		createRoot(() =>
			effect(() => {
				const value = read();
				if (first) first = false;
				else seen.push(value);
			}),
		);
	}
}

/** A composer with Vim on holding `text`, in Normal mode with the caret at the top unless `cursorToStart` is false. */
export function vimEditor(text = "", options: { cursorToStart?: boolean } = {}): VimComposer {
	const editor = new VimComposer();
	editor.setVimMode(true);
	editor.setText(text);
	if (options.cursorToStart !== false) {
		editor.handleInput(ESC);
		editor.handleInput("g");
		editor.handleInput("g");
	}
	return editor;
}

/** Press `key` (`u` or Ctrl+R) until the text stops changing; the text after each press. */
export function walk(editor: VimComposer, key: "u" | "\x12"): string[] {
	const seen: string[] = [];
	for (let n = 0; n < 20; n++) {
		const before = editor.getText();
		editor.handleInput(key);
		if (editor.getText() === before) break;
		seen.push(editor.getText());
	}
	return seen;
}
