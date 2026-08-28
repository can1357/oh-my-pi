import { useEffect } from "react";
import { editField, fieldSelection, focusedField, isEditable, readClipboard, writeClipboard } from "./clipboard";
import type { MenuItem } from "./contextMenu";
import { useContextMenu } from "./contextMenu";

/**
 * The floor of the context-menu system: nothing anywhere gets WKWebView's menu.
 *
 * Surfaces claim the event first — they call `open`, which calls
 * `preventDefault` — and React dispatches from the root, so by the time this
 * window listener runs a handled event is already marked. `defaultPrevented` is
 * the same lever the Escape arbitration uses, for the same reason: React's
 * `stopPropagation` does not stop a listener bound to `window`.
 *
 * Whatever is left gets one of two menus, because suppressing the system's
 * without replacing it would leave the composer — where pasting actually
 * happens — with nothing at all.
 */
export function useGlobalContextMenu(fallback: () => MenuItem[]): void {
	const { open } = useContextMenu();

	useEffect(() => {
		const onContextMenu = (event: MouseEvent) => {
			if (event.defaultPrevented) return; // a surface answered
			event.preventDefault();
			const items = isEditable(event.target) ? textItems() : fallback();
			open(event, items);
		};
		window.addEventListener("contextmenu", onContextMenu);
		return () => window.removeEventListener("contextmenu", onContextMenu);
	}, [open, fallback]);
}

/**
 * Cut, copy, paste, select all — the four the system menu was providing.
 *
 * Built from the field that has focus rather than the one clicked: a right
 * click inside a field focuses it first, and reading the focus keeps this
 * honest for a menu opened from the keyboard too.
 */
export function textItems(): MenuItem[] {
	const field = focusedField();
	const selected = field ? fieldSelection(field) : "";
	const editable = field !== null;
	/*
	 * The range is captured here, not read when the item runs. Opening the menu
	 * and clicking a row can move the focus, and a refocused field does not come
	 * back with its selection — which is the entire definition of Cut.
	 */
	const range = { start: field?.selectionStart ?? 0, end: field?.selectionEnd ?? 0 };

	return [
		{
			kind: "action",
			id: "cut",
			label: "Cut",
			hint: "⌘X",
			disabled: !editable ? "Not a text field" : selected ? undefined : "Nothing selected",
			run: async () => {
				await writeClipboard(selected);
				if (field) editField(field, range, "");
			},
		},
		{
			kind: "action",
			id: "copy",
			label: "Copy",
			hint: "⌘C",
			disabled: selected ? undefined : "Nothing selected",
			run: () => writeClipboard(selected),
		},
		{
			kind: "action",
			id: "paste",
			label: "Paste",
			hint: "⌘V",
			disabled: editable ? undefined : "Not a text field",
			run: async () => {
				const text = await readClipboard();
				if (field && text) editField(field, range, text);
			},
		},
		{ kind: "separator", id: "sep" },
		{
			kind: "action",
			id: "select-all",
			label: "Select all",
			hint: "⌘A",
			disabled: editable ? undefined : "Not a text field",
			run: () => {
				field?.focus();
				field?.select();
			},
		},
	];
}
