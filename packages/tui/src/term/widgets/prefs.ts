/**
 * `prefs` input: what a Tern terminal's settings window does with keys and
 * the pointer, as the events it sends. The program owns every value
 * (`focus`, `editing`, the rows); the widget only reports intent:
 *
 * - ↑/↓ (PgUp/PgDn by section, Home/End) move the row focus: `select` row.
 * - ⏎/␣ change the focused row: a switch flips and a plain choice cycles
 *   (`change`), menus/text/multi rows open (`activate`), action rows run
 *   (`action` with the row as `value`).
 * - ←/→ switch pages: `action page` with the page id.
 * - ⎋ closes the window (`action close`) or the open editor
 *   (`action close` with the row).
 * - In an open menu ↑/↓ highlight (`select` `row=option`), ⏎ picks
 *   (`change`); in a multi-select ␣/⏎ toggle, ←/→ and 1–9 reorder ordered
 *   lists (`change` with the new list).
 * - Pointer: clicks on pages, rows, options and sidebar sections; the wheel
 *   moves the focus; motion lights the row or tab under it.
 *
 * ↑/↓, PgUp/PgDn, ⏎ and ⎋ follow the widget keymap (`../keymap`).
 *
 * Text drafts, search typing and section focus are the program's: it sees
 * keys first (`onKey`). Nodes with a `role` have their own look and input.
 */
import type { TspPrefsControl, TspPrefsProps, TspPrefsRow } from "@oh-my-pi/pi-wire";
import type { MouseEvent } from "../../driver/contract";
import type { KeyEvent } from "../../events";
import type { UiNode } from "../../node";
import type { Hit } from "../paint";
import {
	cyclesInPlace,
	isSearching,
	menuOptions,
	PREFS_DRAG,
	PREFS_HOVER,
	PREFS_OPTION_HOVER,
	PREFS_TAB_HOVER,
	type PrefsItem,
	prefsItems,
	prefsProps,
	prefsRuns,
	runAt,
	selectedRow,
} from "../painters/prefs-model";
import { widgetKeyMatches } from "../keymap";
import { defineWidget, type WidgetContext } from "../widgets";
import { nodeState } from "../painters/state";
import { PLAIN_THEME } from "../../theme/plain";

function findRow(props: TspPrefsProps, id: string): TspPrefsRow | undefined {
	for (const section of props.sections) for (const row of section.rows) if (row.id === id) return row;
	return undefined;
}

/** Items of the page (glyphs do not matter for navigation). */
function itemsOf(node: UiNode): PrefsItem[] {
	const props = prefsProps(node);
	return prefsItems(props, props.term, PLAIN_THEME);
}

function selectRow(node: UiNode, id: string, cx: WidgetContext): void {
	cx.emit({ type: "select", key: cx.keypath, item: id });
	void node;
}

/** Move the row focus by `delta` selectable rows (wrapping when `wrap`). */
function moveRow(node: UiNode, delta: number, wrap: boolean, cx: WidgetContext): boolean {
	const props = prefsProps(node);
	const items = itemsOf(node);
	const rows = items.filter(item => !item.heading);
	if (rows.length === 0) return true;
	const at = rows.findIndex(item => item.id === selectedRow(props, props.term, items));
	let next = at + delta;
	if (wrap) next = ((next % rows.length) + rows.length) % rows.length;
	else next = Math.max(0, Math.min(rows.length - 1, next));
	const target = rows[next];
	if (target && target.id !== rows[at]?.id) selectRow(node, target.id, cx);
	return true;
}

/** Jump to the first row of the next/previous section (paging when there is one section). */
function jumpSection(node: UiNode, delta: -1 | 1, cx: WidgetContext): boolean {
	const props = prefsProps(node);
	const items = itemsOf(node);
	if (items.length === 0) return true;
	const runs = isSearching(props) ? [] : prefsRuns(items, props);
	const selected = Math.max(
		0,
		items.findIndex(item => !item.heading && item.id === selectedRow(props, props.term, items)),
	);
	let target: PrefsItem | undefined;
	if (runs.length < 2) {
		const index = Math.max(0, Math.min(selected + delta * cx.pageRows, items.length - 1));
		target = items[index];
	} else {
		const next = (runAt(runs, selected) + delta + runs.length) % runs.length;
		target = items[runs[next]!.first];
	}
	if (target && !target.heading) selectRow(node, target.id, cx);
	return true;
}

/** ⏎/␣ on a row: what a click on an already focused row does. */
function activateRow(row: TspPrefsRow, cx: WidgetContext): void {
	const control = row.control;
	if (control.k === "switch") {
		cx.emit({ type: "change", key: cx.keypath, item: row.id, value: !control.on });
		return;
	}
	if (cyclesInPlace(control) && control.k === "choice") {
		const options = control.options;
		if (options.length === 0) return;
		const at = options.findIndex(option => option.value === control.value);
		cx.emit({ type: "change", key: cx.keypath, item: row.id, value: options[(at + 1) % options.length]!.value });
		return;
	}
	if (control.k === "action") {
		cx.emit({ type: "action", key: cx.keypath, act: control.act, value: row.id, mods: [] });
		return;
	}
	cx.emit({ type: "activate", key: cx.keypath, item: row.id });
}

function stepPage(node: UiNode, delta: -1 | 1, cx: WidgetContext): boolean {
	const props = prefsProps(node);
	const pages = props.pages;
	if (pages.length === 0) return true;
	const at = Math.max(
		0,
		pages.findIndex(page => page.id === props.page),
	);
	for (let n = 1; n <= pages.length; n++) {
		const page = pages[(((at + delta * n) % pages.length) + pages.length) % pages.length]!;
		if (page.disabled) continue;
		cx.emit({ type: "action", key: cx.keypath, act: "page", value: page.id, mods: [] });
		return true;
	}
	return true;
}

/** The value a pick of `option` sends for a menu row. */
function menuValue(control: TspPrefsControl, option: string): string | number {
	return control.k === "number" ? Number(option) : option;
}

function multiChange(row: TspPrefsRow, values: readonly string[], cx: WidgetContext): void {
	cx.emit({ type: "change", key: cx.keypath, item: row.id, value: [...values] });
}

function toggled(values: readonly string[], option: string): string[] {
	return values.includes(option) ? values.filter(value => value !== option) : [...values, option];
}

function editingKey(
	node: UiNode,
	row: TspPrefsRow,
	option: string | undefined,
	key: KeyEvent,
	cx: WidgetContext,
): boolean {
	const control = row.control;
	const close = (): void => {
		cx.emit({ type: "action", key: cx.keypath, act: "close", value: row.id, mods: [] });
	};
	if (widgetKeyMatches(key, "select.cancel")) {
		close();
		return true;
	}
	if (control.k === "text") return false;
	const confirm = widgetKeyMatches(key, "select.confirm");
	const options = control.k === "multi" ? control.options : menuOptions(control);
	if (options.length === 0) return confirm;
	const at = Math.max(
		0,
		options.findIndex(candidate => candidate.value === option),
	);
	const highlight = (index: number): void => {
		const target = options[index];
		if (target && target.value !== option)
			cx.emit({ type: "select", key: cx.keypath, item: `${row.id}=${target.value}` });
	};
	const page = control.k === "multi" ? 12 : 10;
	let target: number | undefined;
	if (widgetKeyMatches(key, "select.up")) target = (at - 1 + options.length) % options.length;
	else if (widgetKeyMatches(key, "select.down")) target = (at + 1) % options.length;
	else if (widgetKeyMatches(key, "select.pageUp")) target = Math.max(0, at - page);
	else if (widgetKeyMatches(key, "select.pageDown")) target = Math.min(options.length - 1, at + page);
	else if (key.id === "home") target = 0;
	else if (key.id === "end") target = options.length - 1;
	if (target !== undefined) {
		highlight(target);
		return true;
	}
	const current = options[at]!.value;
	if (control.k === "multi") {
		if (key.id === "space" || confirm) {
			multiChange(row, toggled(control.values, current), cx);
			return true;
		}
		if (control.ordered && (key.id === "left" || key.id === "right")) {
			const from = control.values.indexOf(current);
			const to = from + (key.id === "left" ? -1 : 1);
			if (from !== -1 && to >= 0 && to < control.values.length) {
				const next = [...control.values];
				next[from] = next[to]!;
				next[to] = current;
				multiChange(row, next, cx);
			}
			return true;
		}
		if (control.ordered && key.text && /^[1-9]$/.test(key.text)) {
			const next = control.values.filter(value => value !== current);
			next.splice(Math.min(Number(key.text) - 1, next.length), 0, current);
			multiChange(row, next, cx);
			return true;
		}
		return true;
	}
	if (confirm) {
		cx.emit({ type: "change", key: cx.keypath, item: row.id, value: menuValue(control, current) });
		return true;
	}
	void node;
	return true;
}

defineWidget("prefs", {
	key(node, key, cx) {
		if (key.kind === "release") return false;
		const props = prefsProps(node);
		if (props.role) return false;
		const editing = props.editing;
		if (editing) {
			const row = findRow(props, editing.row);
			return row ? editingKey(node, row, editing.option, key, cx) : false;
		}
		if (widgetKeyMatches(key, "select.up")) return moveRow(node, -1, true, cx);
		if (widgetKeyMatches(key, "select.down")) return moveRow(node, 1, true, cx);
		if (widgetKeyMatches(key, "select.pageUp")) return jumpSection(node, -1, cx);
		if (widgetKeyMatches(key, "select.pageDown")) return jumpSection(node, 1, cx);
		if (widgetKeyMatches(key, "select.cancel")) {
			cx.emit({ type: "action", key: cx.keypath, act: "close", mods: [] });
			return true;
		}
		if (widgetKeyMatches(key, "select.confirm") || key.id === "space") {
			const items = itemsOf(node);
			const id = selectedRow(props, props.term, items);
			const row = id === undefined ? undefined : findRow(props, id);
			if (row) activateRow(row, cx);
			return true;
		}
		if (key.id === "left") return stepPage(node, -1, cx);
		if (key.id === "right") return stepPage(node, 1, cx);
		return false;
	},
	mouse(node, mouse, _at, cx, hit) {
		const props = prefsProps(node);
		if (props.role) return false;
		return pointer(node, props, mouse, cx, hit);
	},
});

function pointer(
	node: UiNode,
	props: TspPrefsProps & { role?: string },
	mouse: MouseEvent,
	cx: WidgetContext,
	hit?: Hit,
): boolean {
	const item = hit?.item ?? "";
	const colon = item.indexOf(":");
	const kind = colon < 0 ? item : item.slice(0, colon);
	const id = colon < 0 ? "" : item.slice(colon + 1);
	const wheel = mouse.button === "wheel-up" ? -1 : mouse.button === "wheel-down" ? 1 : 0;
	const editing = props.editing;
	if (editing) {
		const row = findRow(props, editing.row);
		if (!row || row.control.k === "text") return true;
		const optionHover = nodeState(node, PREFS_OPTION_HOVER, () => undefined as number | undefined);
		const options = row.control.k === "multi" ? row.control.options : menuOptions(row.control);
		// Only the option rows take the pointer while an editor is open.
		if (kind !== "opt") return true;
		if (wheel !== 0) {
			editingKey(node, row, editing.option, { id: wheel < 0 ? "up" : "down", kind: "press", raw: "" }, cx);
			return true;
		}
		const index = options.findIndex(option => option.value === id);
		const control = row.control;
		if (control.k === "multi") {
			// A press highlights; the release toggles, or (ordered) drops the pressed member before the one under it.
			const drag = nodeState(node, PREFS_DRAG, () => undefined as { from: string; to: string } | undefined);
			if (mouse.action === "move" || mouse.action === "drag") {
				optionHover.set(index >= 0 ? index : undefined);
				const pressed = drag();
				if (control.ordered && pressed && index >= 0 && id !== pressed.from && control.values.includes(id))
					drag.set({ from: pressed.from, to: id });
				return true;
			}
			if (mouse.action === "press" && mouse.button === "left") {
				if (index < 0) return true;
				if (id !== editing.option) cx.emit({ type: "select", key: cx.keypath, item: `${row.id}=${id}` });
				drag.set({ from: id, to: id });
				return true;
			}
			if (mouse.action === "release") {
				const pressed = drag();
				drag.set(undefined);
				if (!pressed) return true;
				if (control.ordered && pressed.to !== pressed.from) {
					const next = control.values.filter(value => value !== pressed.from);
					const at = next.indexOf(pressed.to);
					if (at >= 0) {
						next.splice(at, 0, pressed.from);
						multiChange(row, next, cx);
					}
					return true;
				}
				multiChange(row, toggled(control.values, pressed.from), cx);
			}
			return true;
		}
		if (mouse.action === "move" || mouse.action === "drag") {
			optionHover.set(index >= 0 ? index : undefined);
			return true;
		}
		if (mouse.action === "press" && mouse.button === "left" && index >= 0) {
			cx.emit({ type: "change", key: cx.keypath, item: row.id, value: menuValue(control, id) });
		}
		return true;
	}
	const hover = nodeState(node, PREFS_HOVER, () => undefined as string | undefined);
	const tabHover = nodeState(node, PREFS_TAB_HOVER, () => undefined as string | undefined);
	if (wheel !== 0) {
		if (kind === "row" || kind === "content") moveRow(node, wheel, false, cx);
		return true;
	}
	if (mouse.action === "move" || mouse.action === "drag") {
		tabHover.set(kind === "tab" && id !== props.page ? id : undefined);
		hover.set(kind === "row" ? id : undefined);
		return true;
	}
	if (mouse.action !== "press" || mouse.button !== "left") return true;
	if (kind === "tab") {
		// While searching, a page click jumps to that page's first result (search stays open).
		if (isSearching(props)) cx.emit({ type: "select", key: cx.keypath ? `${cx.keypath}/tabs` : "tabs", item: id });
		else if (id !== props.page) cx.emit({ type: "action", key: cx.keypath, act: "page", value: id, mods: [] });
		return true;
	}
	if (kind === "row" || kind === "jump") {
		const items = itemsOf(node);
		const wasSelected = selectedRow(props, prefsProps(node).term, items) === id;
		if (!wasSelected) selectRow(node, id, cx);
		else if (kind === "row") {
			const row = findRow(props, id);
			if (row) activateRow(row, cx);
		}
	}
	return true;
}
