/**
 * The plan-save prompt's terminal look: a box titled `Save plan` holding the
 * path field (the suggested path dimmed while it is empty) and the keys.
 */
import { type Block, defineRolePainter, EMPTY_BLOCK } from "@oh-my-pi/pi-tui/term/paint";
import { inputLine } from "@oh-my-pi/pi-tui/term/painters/prefs";
import { truncate, visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import type { TspInputProps } from "@oh-my-pi/pi-wire";
import { bindingGlyph, boxRows, propsOf, termOf } from "./common";

defineRolePainter("col", "omp.planSave", (node, cx): Block => {
	const theme = cx.theme;
	if (cx.width < 5) return EMPTY_BLOCK;
	const inner = cx.width - 4;
	const input = node.children().find(child => child.kind === "input");
	const props = input ? propsOf<TspInputProps>(input) : {};
	const text = props.text ?? "";
	const prompt = theme.fg("dim", typeof props.prompt === "string" ? props.prompt : "");
	const room = inner - visibleWidth(prompt);
	let field: string;
	if (text === "") {
		const suggested = termOf<{ suggested: string }>(node).suggested ?? "";
		field = `${theme.style("inverse", " ")}${theme.fg("dim", truncate(suggested, Math.max(0, room - 1), theme.symbols.ellipsis))}`;
	} else field = inputLine(text, props.cursor ?? text.length, room, "");
	const hints = theme.fg("dim", `${bindingGlyph("tui.input.submit", "enter")} save · ⌃G cancel`);
	return { rows: boxRows(theme, "Save plan", [`${prompt}${field}`, hints], cx.width) };
});
