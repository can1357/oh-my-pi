/**
 * The move dialog in the terminal: a box titled `Move to directory` with the
 * path field, the suggestions (`▶` and the accent on the highlighted one) or
 * the empty notice, and the dim key hints.
 */
import { type Block, defineRolePainter, EMPTY_BLOCK } from "@oh-my-pi/pi-tui/term/paint";
import { styledText } from "@oh-my-pi/pi-tui/term/painters/layout";
import { inputLine } from "@oh-my-pi/pi-tui/term/painters/prefs";
import { truncate } from "@oh-my-pi/pi-tui/text/width";
import type { TspCardProps, TspInputProps, TspItemProps, TspListProps } from "@oh-my-pi/pi-wire";
import { bindingGlyph, boxRows, findNode, plainText, propsOf, selectNavGlyphs } from "./common";

defineRolePainter("card", "omp.dialog.move", (node, cx): Block => {
	const theme = cx.theme;
	if (cx.width < 6) return EMPTY_BLOCK;
	const inner = cx.width - 4;
	const input = findNode(node, child => child.kind === "input");
	const field = input ? propsOf<TspInputProps>(input) : {};
	const text = field.text ?? "";
	const prompt = theme.fg("dim", "Path: ");
	const content = [
		`${prompt}${inputLine(text, field.cursor ?? text.length, Math.max(1, inner - 6), "").trimEnd()}`,
		"",
	];
	const list = findNode(node, child => child.kind === "list");
	const listProps = list ? propsOf<TspListProps>(list) : {};
	const items = list?.children() ?? [];
	if (items.length === 0) {
		if (listProps.empty) content.push(truncate(styledText(theme, listProps.empty), inner, "…"));
	}
	for (const item of items) {
		const label = plainText(propsOf<TspItemProps>(item).label);
		content.push(
			item.key() === listProps.selected
				? `${theme.fg("accent", "▶ ")}${theme.fg("accent", truncate(label, inner - 2, "…"))}`
				: `  ${theme.fg("text", truncate(label, inner - 2, "…"))}`,
		);
	}
	content.push(
		"",
		truncate(
			theme.fg(
				"dim",
				`Type to filter · ${selectNavGlyphs()} navigate · ⇥ accept · ${bindingGlyph("tui.select.confirm", "enter")} confirm · ${bindingGlyph("tui.select.cancel", "escape")} cancel`,
			),
			inner,
			"…",
		),
	);
	return { rows: boxRows(theme, plainText(propsOf<TspCardProps>(node).head), content, cx.width) };
});
