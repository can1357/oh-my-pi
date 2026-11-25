/**
 * The bordered loader's terminal look: ruled top and bottom, the spinner
 * frame and the muted message wrapped beneath it, then the muted key hints.
 */
import { type Block, defineRolePainter } from "@oh-my-pi/pi-tui/term/paint";
import { wrap } from "@oh-my-pi/pi-tui/text/width";
import type { TspTextProps } from "@oh-my-pi/pi-wire";
import { terminalPaddingX } from "../terminal-padding";
import { activityFrame, findNode, hintText, plainText, propsOf, roleOf, rule } from "./common";

defineRolePainter("card", "omp.hook.loader", (node, cx): Block => {
	const theme = cx.theme;
	const message = findNode(node, child => child.kind === "text" && child.key() === "message");
	const text = message ? plainText(propsOf<TspTextProps>(message).spans) : "";
	const hints = findNode(node, child => roleOf(child) === "omp.overlay.hints");
	const paddingX = terminalPaddingX();
	const pad = " ".repeat(paddingX);
	const inner = Math.max(1, cx.width - 2 * paddingX);
	const head = `${theme.fg("accent", activityFrame(cx))} ${theme.fg("muted", text)}`;
	const rows = [rule(theme, "border", cx.width), ""];
	for (const row of wrap(head, inner)) rows.push(pad + row);
	if (hints) {
		rows.push("");
		for (const row of wrap(theme.fg("muted", hintText(hints)), inner)) rows.push(pad + row);
	}
	rows.push("", rule(theme, "border", cx.width));
	return { rows };
});
