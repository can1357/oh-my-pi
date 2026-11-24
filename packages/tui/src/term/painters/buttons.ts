/**
 * `buttons`: its `button`/`menu` children side by side (one cell apart when
 * joined or split, two in a toolbar), cut at the width. The focused child
 * (keyboard, see the widget) is drawn on the selection band.
 */
import type { TspButtonProps, TspButtonsProps } from "@oh-my-pi/pi-wire";
import { truncate, visibleWidth } from "../../text/width";
import { type Block, definePainter, EMPTY_BLOCK, type Hit } from "../paint";
import "../widgets/buttons";
import { buttonLabel, clickAction } from "./button";
import { nodeState } from "./state";

/** Widget state: index of the keyboard-focused child. */
export const BUTTONS_FOCUS = "focus";

definePainter("buttons", (node, cx): Block => {
	if (cx.width <= 0) return EMPTY_BLOCK;
	const props = node.props() as TspButtonsProps;
	const gap = props.variant === "toolbar" ? "  " : " ";
	const focusIndex = cx.focused(node) ? nodeState(node, BUTTONS_FOCUS, () => 0)() : -1;
	let row = "";
	const hits: Hit[] = [];
	node.children().forEach((child, index) => {
		const text =
			child.kind === "button"
				? buttonLabel(cx.theme, child.props() as TspButtonProps, index === focusIndex)
				: (cx.paint(child, Math.max(1, cx.width - visibleWidth(row))).rows[0] ?? "");
		if (text === "") return;
		if (row !== "") row += gap;
		const col = visibleWidth(row);
		row += text;
		if (child.kind === "button")
			hits.push({ row: 0, col, width: visibleWidth(text), height: 1, node: child, act: clickAction(child) });
	});
	const cut = truncate(row, cx.width);
	return { rows: [cut], hits: hits.filter(hit => hit.col < cx.width) };
});
