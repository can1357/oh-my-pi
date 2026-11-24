/**
 * `button`: a bracketed label (icon, text, keycaps) in the variant's color:
 * primary bold accent, danger red, quiet muted, a pressed toggle on the
 * selection band; disabled and busy buttons are dim. A click runs its
 * `actions.click` (else `click`) through the backend's hit routing.
 */
import type { TspButtonProps, TspCommonProps } from "@oh-my-pi/pi-wire";
import type { UiNode } from "../../node";
import type { Theme } from "../../theme/contract";
import { truncate, visibleWidth } from "../../text/width";
import { type Block, definePainter, EMPTY_BLOCK } from "../paint";
import "../widgets/button";

/** Display names of keycaps. */
const KEY_GLYPHS: Readonly<Record<string, string>> = {
	enter: "⏎",
	escape: "⎋",
	esc: "⎋",
	tab: "⇥",
	space: "␣",
	backspace: "⌫",
	up: "↑",
	down: "↓",
	left: "←",
	right: "→",
	ctrl: "^",
	alt: "⌥",
	shift: "⇧",
	super: "⌘",
};

/** A key chord as keycaps (`["ctrl","g"]` → `^G`). */
export function keycaps(keys: readonly string[]): string {
	return keys.map(key => KEY_GLYPHS[key] ?? (key.length === 1 ? key.toUpperCase() : key)).join("");
}

/** The action a click on `node` runs. */
export function clickAction(node: UiNode): string {
	return (node.props() as TspCommonProps).actions?.click ?? "click";
}

/** One button's styled label, without the backend's hit. */
export function buttonLabel(theme: Theme, props: TspButtonProps, focused = false): string {
	const icon = props.busy ? (theme.symbols.spinnerFrames[0] ?? "") : props.icon ? theme.symbols.icon(props.icon) : "";
	const parts = [icon, props.text ?? "", props.keys && props.keys.length > 0 ? keycaps(props.keys) : ""].filter(
		part => part !== "",
	);
	const text = `[ ${parts.join(" ")} ]`;
	if (props.disabled || props.busy) return theme.fg("dim", text);
	let styled: string;
	switch (props.variant) {
		case "primary":
			styled = theme.style("strong", theme.fg("accent", text));
			break;
		case "danger":
			styled = theme.fg("error", text);
			break;
		case "quiet":
			styled = theme.fg("muted", text);
			break;
		default:
			styled = text;
	}
	if (props.on || focused) styled = theme.bg("selectedBg", styled);
	return styled;
}

definePainter("button", (node, cx): Block => {
	if (cx.width <= 0) return EMPTY_BLOCK;
	const props = node.props() as TspButtonProps;
	const row = truncate(buttonLabel(cx.theme, props, cx.focused(node)), cx.width);
	const inert = props.disabled || props.busy;
	return {
		rows: [row],
		hits: inert ? [] : [{ row: 0, col: 0, width: visibleWidth(row), height: 1, node, act: clickAction(node) }],
	};
});
