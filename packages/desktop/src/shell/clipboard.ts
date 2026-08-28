import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";

/**
 * The system clipboard, through Rust.
 *
 * Not `navigator.clipboard`: suppressing the native menu everywhere makes paste
 * our job, and reading the clipboard from JS is the half of that API WKWebView
 * is least reliable about. The plugin reads and writes from the Rust side, where
 * neither permission prompts nor user-activation heuristics apply.
 */
export async function writeClipboard(text: string): Promise<void> {
	await writeText(text);
}

export async function readClipboard(): Promise<string> {
	return (await readText()) ?? "";
}

/** The focused field, when the focus is somewhere text can be edited. */
export function focusedField(): HTMLInputElement | HTMLTextAreaElement | null {
	const element = document.activeElement;
	if (element instanceof HTMLTextAreaElement) return element;
	if (element instanceof HTMLInputElement && !element.readOnly) return element;
	return null;
}

export function isEditable(node: EventTarget | null): boolean {
	if (!(node instanceof HTMLElement)) return false;
	if (node.isContentEditable) return true;
	if (node instanceof HTMLTextAreaElement) return true;
	return node instanceof HTMLInputElement && !node.readOnly;
}

/** The selection inside a field, or "" when there is none. */
export function fieldSelection(field: HTMLInputElement | HTMLTextAreaElement): string {
	const { selectionStart, selectionEnd, value } = field;
	if (selectionStart === null || selectionEnd === null || selectionStart === selectionEnd) return "";
	return value.slice(selectionStart, selectionEnd);
}

/**
 * Type into the focused field the way a person would.
 *
 * `execCommand` rather than assigning `.value`: these fields are React
 * controlled, and a direct assignment updates the DOM without telling React,
 * so the next render puts the old text back. `insertText` raises the same input
 * event a keystroke does, which is the only edit React accepts.
 */
export function insertText(text: string): void {
	document.execCommand("insertText", false, text);
}

/**
 * Put the caret back where the menu found it, then type.
 *
 * `execCommand` edits whatever is focused *now*, and by the time a menu item
 * runs the menu has closed and the focus may have gone with it — the field the
 * menu was built for is no longer the one being edited, so Cut deleted nothing
 * and Paste landed nowhere. The selection has to be restored too: refocusing a
 * textarea does not bring back the range the user had highlighted, and Cut is
 * defined entirely by that range.
 */
export function editField(
	field: HTMLInputElement | HTMLTextAreaElement,
	range: { start: number; end: number },
	text: string,
): void {
	field.focus();
	field.setSelectionRange(range.start, range.end);
	insertText(text);
}
