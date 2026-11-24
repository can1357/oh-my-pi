/**
 * `button` input: ⏎/␣ on a focused button runs its click action (⏎: the
 * widget keymap's `select.confirm` keys; a click goes through the backend's hit).
 */
import type { TspButtonProps } from "@oh-my-pi/pi-wire";
import { clickAction } from "../painters/button";
import { widgetKeyMatches } from "../keymap";
import { defineWidget } from "../widgets";

defineWidget("button", {
	key(node, key, cx) {
		if (key.kind === "release" || (key.id !== "space" && !widgetKeyMatches(key, "select.confirm"))) return false;
		const props = node.props() as TspButtonProps;
		if (props.disabled || props.busy) return true;
		cx.emit({ type: "action", key: cx.keypath, act: clickAction(node), mods: [] });
		return true;
	},
});
