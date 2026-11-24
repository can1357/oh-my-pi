/**
 * `menu` input. Closed: ⏎/␣/↓ open it (`toggle` with `collapsed: false`).
 * Open: ↑/↓ move the highlight over choosable rows (`select` with the row,
 * which the program shows as `active`), ⏎/␣ choose (`action` with the row's
 * id, `checked` flipped for check/radio rows), ⎋ closes (`toggle`).
 * Pointer: a trigger click toggles; a row click chooses. ↑/↓, ⏎ and ⎋
 * follow the widget keymap (`../keymap`).
 */
import type { TspMenuProps } from "@oh-my-pi/pi-wire";
import type { UiNode } from "../../node";
import { type MenuRow, menuRows } from "../painters/menu";
import { widgetKeyMatches } from "../keymap";
import { defineWidget, type WidgetContext } from "../widgets";

function choose(row: MenuRow, cx: WidgetContext): void {
	if (row.disabled || row.items) return;
	const checkable = row.checked !== undefined || row.radio !== undefined;
	cx.emit({
		type: "action",
		key: cx.keypath,
		act: row.id,
		mods: [],
		...(checkable ? { checked: row.radio !== undefined ? true : !row.checked } : {}),
	});
}

function toggle(node: UiNode, cx: WidgetContext): void {
	const props = node.props() as TspMenuProps;
	if (props.disabled) return;
	cx.emit({ type: "toggle", key: cx.keypath, collapsed: props.open === true });
}

defineWidget("menu", {
	key(node, key, cx) {
		if (key.kind === "release") return false;
		const props = node.props() as TspMenuProps;
		const choosing = widgetKeyMatches(key, "select.confirm") || key.id === "space";
		if (!props.open) {
			if (!choosing && !widgetKeyMatches(key, "select.down")) return false;
			toggle(node, cx);
			return true;
		}
		const rows = menuRows(props.items).filter(row => !row.disabled);
		const at = rows.findIndex(row => row.id === props.active);
		const delta = widgetKeyMatches(key, "select.up") ? -1 : widgetKeyMatches(key, "select.down") ? 1 : 0;
		if (delta !== 0) {
			if (rows.length === 0) return true;
			const next = rows[at < 0 ? (delta > 0 ? 0 : rows.length - 1) : (at + delta + rows.length) % rows.length]!;
			cx.emit({ type: "select", key: cx.keypath, item: next.id });
			return true;
		}
		if (choosing) {
			if (rows[at]) choose(rows[at], cx);
			return true;
		}
		if (widgetKeyMatches(key, "select.cancel")) {
			toggle(node, cx);
			return true;
		}
		return false;
	},
	mouse(node, mouse, _at, cx, hit) {
		if (mouse.action !== "press" || mouse.button !== "left") return false;
		const id = hit?.item;
		if (!id) {
			toggle(node, cx);
			return true;
		}
		const row = menuRows((node.props() as TspMenuProps).items).find(candidate => candidate.id === id);
		if (row) choose(row, cx);
		return true;
	},
});
