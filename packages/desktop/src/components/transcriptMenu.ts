import { writeClipboard } from "../shell/clipboard";
import type { MenuItem } from "../shell/contextMenu";

/**
 * What a right click offers over a message.
 *
 * "Copy message" copies the **markdown**, not the rendered HTML: the raw text
 * is what the model wrote and what you would paste back into a prompt. It comes
 * from the transcript entry, never from the DOM.
 *
 * "Copy code block" appears only when the click actually landed in one, which
 * the caller resolves by walking up from the event's target — a menu that lists
 * an action for something you did not click on is lying about what it will do.
 */
export function transcriptMenuItems(input: {
	text?: string;
	selection: string;
	codeBlock?: string;
	report(cause: unknown): void;
}): MenuItem[] {
	const copy = (value: string) => () => void writeClipboard(value).catch(input.report);

	const items: MenuItem[] = [
		{
			kind: "action",
			id: "copy-selection",
			label: "Copy selection",
			hint: "⌘C",
			disabled: input.selection ? undefined : "Nothing selected",
			run: copy(input.selection),
		},
	];

	if (input.codeBlock) {
		items.push({ kind: "action", id: "copy-code", label: "Copy code block", run: copy(input.codeBlock) });
	}
	if (input.text) {
		items.push({ kind: "action", id: "copy-message", label: "Copy message", run: copy(input.text) });
	}

	return items;
}

/** The `<pre>`/`<code>` the click landed in, if it landed in one. */
export function codeBlockAt(target: EventTarget | null): string | undefined {
	if (!(target instanceof HTMLElement)) return undefined;
	const block = target.closest("pre");
	const text = block?.textContent ?? "";
	return text.trim() ? text : undefined;
}

/** The current selection, but only when it lies inside this element. */
export function selectionWithin(element: HTMLElement | null): string {
	const selection = window.getSelection();
	if (!selection || selection.isCollapsed || !element) return "";
	const anchor = selection.anchorNode;
	return anchor && element.contains(anchor) ? selection.toString() : "";
}
