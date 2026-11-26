/**
 * `toast`: a one-row notice — the text, its `sub` muted after a dot, and
 * the action's button (`[ Undo ]`) at the end; a click on the button sends
 * the action. Timing (`ttl`) is the program's: it removes the node.
 */
import type { TspToastProps } from "@oh-my-pi/pi-wire";
import { spaces, truncate, visibleWidth } from "../../text/width";
import { type Block, definePainter, EMPTY_BLOCK } from "../paint";

/** `undo` → `Undo`, `open-file` → `Open file`. */
function actionLabel(action: string): string {
	const words = action.replace(/[-_]+/g, " ").trim();
	return words.charAt(0).toUpperCase() + words.slice(1);
}

definePainter("toast", (node, cx): Block => {
	if (cx.width <= 0) return EMPTY_BLOCK;
	const theme = cx.theme;
	const props = node.props() as TspToastProps;
	let line = props.text;
	if (props.sub) line += theme.fg("muted", ` ${theme.symbols.symbol("sep.dot") || "·"} ${props.sub}`);
	if (!props.action) return { rows: [truncate(line, cx.width)] };
	const button = theme.style("strong", theme.fg("accent", `[ ${props.label ?? actionLabel(props.action)} ]`));
	const buttonWidth = visibleWidth(button);
	if (buttonWidth + 2 > cx.width) return { rows: [truncate(line, cx.width)] };
	const text = truncate(line, cx.width - buttonWidth - 2);
	const col = visibleWidth(text) + 2;
	const row = `${text}${spaces(2)}${button}`;
	return { rows: [row], hits: [{ row: 0, col, width: buttonWidth, height: 1, node, act: props.action }] };
});
