/**
 * `picker` input: what a Tern terminal's picker does with keys and the
 * pointer, as the events it sends. The program owns `selected`, the query
 * and every item; the widget only reports intent:
 *
 * - ↑/↓ move to the neighbouring item (wrapping unless `term.wrap` is
 *   false), PgUp/PgDn by a page (`term.maxRows`), Home/End to the ends:
 *   `select` with the item id.
 * - ⏎ activates the selected item: `activate`.
 * - A key bound to an action (`actions[].keys`, e.g. ⎋ on `close`):
 *   `action` with its id. An action on a `select.cancel` or `select.confirm`
 *   key also runs on that widget action's other keys (⎋ and Ctrl+C both
 *   close when both cancel).
 *
 * Navigation and ⏎/⎋ follow the widget keymap (`../keymap`).
 * - Pointer: a press on a row selects it (on the selected row, activates
 *   it); the wheel moves the selection; motion sets the hovered row
 *   ({@link PICKER_HOVER} state, which looks may draw).
 *
 * Typing into the query and screen shortcuts are the program's: it sees keys
 * first (`onKey`). Navigation reads the node's props through
 * {@link pickerNavIds}, so the widget works whichever painter (role) draws it.
 */
import type { TspPickerAction, TspPickerProps } from "@oh-my-pi/pi-wire";
import type { KeyEvent } from "../../events";
import type { UiNode } from "../../node";
import { PICKER_HOVER, pickerNavIds, pickerPage, pickerState, pickerTerm } from "../painters/picker";
import { widgetActionOf, widgetKeyMatches } from "../keymap";
import { defineWidget, type WidgetContext } from "../widgets";

/** Widget actions an action's chord stands for: any of their keys runs it. */
const ALIASED = ["select.cancel", "select.confirm"] as const;

/** The action whose `keys` chord is `key` (a chord is joined with `+`, as key ids are). */
export function actionForKey(
	actions: readonly TspPickerAction[] | undefined,
	key: KeyEvent,
): TspPickerAction | undefined {
	for (const action of actions ?? []) {
		if (!action.keys || action.keys.length === 0 || action.disabled) continue;
		const chord = action.keys.map(part => (part === "esc" ? "escape" : part.toLowerCase())).join("+");
		if (chord === key.id) return action;
		const alias = widgetActionOf(chord, ALIASED);
		if (alias && widgetKeyMatches(key, alias)) return action;
	}
	return undefined;
}

/** The item id `delta` steps from the selection (`page` steps clamp; single steps wrap when allowed). */
export function pickerStep(node: UiNode, delta: number, options?: { wrap?: boolean }): string | undefined {
	const props = node.props() as TspPickerProps;
	const ids = pickerNavIds(props);
	if (ids.length === 0) return undefined;
	const at = props.selected == null ? -1 : ids.indexOf(props.selected);
	if (at < 0) return ids[delta < 0 ? ids.length - 1 : 0];
	let next = at + delta;
	if (next < 0 || next >= ids.length) {
		const wrap = options?.wrap ?? pickerTerm(node).wrap ?? true;
		if (wrap && Math.abs(delta) === 1) next = (next + ids.length) % ids.length;
		else next = Math.max(0, Math.min(ids.length - 1, next));
	}
	return ids[next];
}

function select(node: UiNode, id: string | undefined, cx: WidgetContext): boolean {
	const props = node.props() as TspPickerProps;
	if (id !== undefined && id !== props.selected) cx.emit({ type: "select", key: cx.keypath, item: id });
	return true;
}

defineWidget("picker", {
	key(node, key, cx) {
		if (key.kind === "release") return false;
		const props = node.props() as TspPickerProps;
		const page = pickerPage(node);
		if (widgetKeyMatches(key, "select.up")) return select(node, pickerStep(node, -1), cx);
		if (widgetKeyMatches(key, "select.down")) return select(node, pickerStep(node, 1), cx);
		if (widgetKeyMatches(key, "select.pageUp")) return select(node, pickerStep(node, -page), cx);
		if (widgetKeyMatches(key, "select.pageDown")) return select(node, pickerStep(node, page), cx);
		if (key.id === "home") return select(node, pickerNavIds(props)[0], cx);
		if (key.id === "end") return select(node, pickerNavIds(props).at(-1), cx);
		if (widgetKeyMatches(key, "select.confirm") && props.selected != null) {
			cx.emit({ type: "activate", key: cx.keypath, item: props.selected });
			return true;
		}
		const action = actionForKey(props.actions, key);
		if (action) {
			cx.emit({ type: "action", key: cx.keypath, act: action.id, mods: [] });
			return true;
		}
		return false;
	},
	mouse(node, mouse, _at, cx, hit) {
		if (mouse.action === "move") {
			const hover = pickerState<string | null>(node, PICKER_HOVER, () => null);
			hover.set(hit.item ?? null);
			return true;
		}
		if (mouse.button === "wheel-up" && mouse.action === "press")
			return select(node, pickerStep(node, -1, { wrap: false }), cx);
		if (mouse.button === "wheel-down" && mouse.action === "press")
			return select(node, pickerStep(node, 1, { wrap: false }), cx);
		if (mouse.button === "left" && mouse.action === "press" && hit.item !== undefined) {
			const props = node.props() as TspPickerProps;
			if (hit.item === props.selected) cx.emit({ type: "activate", key: cx.keypath, item: hit.item });
			else cx.emit({ type: "select", key: cx.keypath, item: hit.item });
			return true;
		}
		return false;
	},
});
