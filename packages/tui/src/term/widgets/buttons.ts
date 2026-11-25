/**
 * `buttons` input: ←/→ (Tab/Shift+Tab) move the keyboard focus among the
 * group's buttons, ⏎/␣ run the focused one's click action (⏎: the widget
 * keymap's `select.confirm` keys).
 */
import type { TspButtonProps } from "@oh-my-pi/pi-wire";
import { clickAction } from "../painters/button";
import { BUTTONS_FOCUS } from "../painters/buttons";
import { widgetKeyMatches } from "../keymap";
import { defineWidget } from "../widgets";

defineWidget("buttons", {
	key(node, key, cx) {
		if (key.kind === "release") return false;
		const buttons = node.children().filter(child => child.kind === "button");
		if (buttons.length === 0) return false;
		const focus = cx.state(BUTTONS_FOCUS, () => 0);
		const at = Math.min(focus(), buttons.length - 1);
		if (widgetKeyMatches(key, "select.confirm") || key.id === "space") {
			const button = buttons[at]!;
			const props = button.props() as TspButtonProps;
			if (!props.disabled && !props.busy)
				cx.emit({ type: "action", key: cx.keypath, act: clickAction(button), mods: [] });
			return true;
		}
		switch (key.id) {
			case "left":
			case "shift+tab":
				focus.set((at - 1 + buttons.length) % buttons.length);
				return true;
			case "right":
			case "tab":
				focus.set((at + 1) % buttons.length);
				return true;
		}
		return false;
	},
});
