/**
 * The sandbox access request in the terminal: a box titled with the request,
 * the labeled fields (Intent, Command, Effect, If denied; wrapped and cut to
 * a few rows, the command one clipped row), then the choices (`❯` and the
 * choice's tone on the selected one) or the reply field, a rule, and the dim
 * key hints.
 */
import { type Block, defineRolePainter, EMPTY_BLOCK } from "@oh-my-pi/pi-tui/term/paint";
import { inputLine } from "@oh-my-pi/pi-tui/term/painters/prefs";
import { truncate, wrap } from "@oh-my-pi/pi-tui/text/width";
import type { TspInputProps, TspItemProps, TspListProps } from "@oh-my-pi/pi-wire";
import {
	MAX_ALTERNATIVE_ROWS,
	MAX_EFFECT_ROWS,
	MAX_INTENT_ROWS,
	SANDBOX_ACCESS_CHOICE_LABELS,
} from "../../../modes/view-model/overlays/sandbox-access-dialog";
import type { SandboxAccessTerm } from "../../overlays/panels/sandbox-access-dialog";
import { bindingGlyph, boxRows, findNode, plainText, propsOf, selectNavGlyphs, termOf } from "./common";

defineRolePainter("col", "omp.editor.ask.sandbox", (node, cx): Block => {
	const theme = cx.theme;
	if (cx.width < 8) return EMPTY_BLOCK;
	const inner = cx.width - 4;
	const ellipsis = theme.symbols.ellipsis;
	const term = termOf<SandboxAccessTerm>(node);
	/** `lines` wrapped to the box, at most `max` rows; the last ends in an ellipsis when more remain. */
	const bounded = (lines: readonly string[], max: number): string[] => {
		const rows = lines.flatMap(line => (line === "" ? [""] : wrap(line, inner)));
		if (rows.length <= max) return rows;
		return [...rows.slice(0, max - 1), truncate(`${rows[max - 1]}${ellipsis}`, inner, ellipsis)];
	};
	const label = (name: string) => theme.style("strong", theme.fg("muted", name));
	const intent = term.intent ?? [];
	const content = [label("Intent"), ...bounded(intent.length > 0 ? intent : ["(none given)"], MAX_INTENT_ROWS)];
	if (term.command) content.push(label("Command"), truncate(theme.fg("accent", term.command), inner, ellipsis));
	content.push(label("Effect"), ...bounded(term.effect ?? [], MAX_EFFECT_ROWS));
	if (term.alternative && term.alternative.length > 0)
		content.push(label("If denied"), ...bounded(term.alternative, MAX_ALTERNATIVE_ROWS));
	const choices = findNode(node, child => child.key() === "choices");
	const input = findNode(node, child => child.kind === "input");
	let hints: string;
	if (term.replying && input) {
		content.push(theme.style("strong", theme.fg("accent", SANDBOX_ACCESS_CHOICE_LABELS.instruct)));
		const props = propsOf<TspInputProps>(input);
		const text = props.text ?? "";
		content.push(
			text === "" && props.placeholder
				? `> ${theme.fg("dim", plainText(props.placeholder))}`
				: `> ${inputLine(text, props.cursor ?? text.length, inner - 2, "")}`,
		);
		hints = `${bindingGlyph("tui.input.submit", "enter")} send · ${bindingGlyph("tui.select.cancel", "escape")} back`;
	} else {
		const selected = choices ? propsOf<TspListProps>(choices).selected : undefined;
		for (const choice of choices?.children() ?? []) {
			const props = propsOf<TspItemProps & { tone?: string }>(choice);
			const text = plainText(props.label);
			if (choice.key() === selected)
				content.push(theme.style("strong", theme.fg(props.tone === "error" ? "error" : "accent", `❯ ${text}`)));
			else content.push(`  ${text}`);
		}
		hints = `${selectNavGlyphs()} choose · ${bindingGlyph("tui.select.confirm", "enter")} select · ${bindingGlyph("tui.select.cancel", "escape")} deny`;
	}
	const box = theme.symbols.box;
	const rows = boxRows(
		theme,
		term.title ?? "",
		[...content, "\u0000", truncate(theme.fg("dim", hints), inner, ellipsis)],
		cx.width,
	);
	const ruleAt = rows.findIndex(row => row.includes("\u0000"));
	rows[ruleAt] = theme.fg("border", `${box.teeRight}${box.horizontal.repeat(cx.width - 2)}${box.teeLeft}`);
	return { rows };
});
