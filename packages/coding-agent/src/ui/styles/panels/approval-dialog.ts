/**
 * The approval prompt in the terminal: a box titled with the call (and its
 * countdown), up to eight detail rows (accented, segments tinted, a
 * scrollbar when they overflow), the choices (`❯` and the choice's tone on
 * the selected one), a rule, and the dim key hints.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { type Block, defineRolePainter, EMPTY_BLOCK } from "@oh-my-pi/pi-tui/term/paint";
import { styledText } from "@oh-my-pi/pi-tui/term/painters/layout";
import { padTo, truncate, wrap } from "@oh-my-pi/pi-tui/text/width";
import type { TspItemProps, TspListProps, TspTextProps } from "@oh-my-pi/pi-wire";
import { bindingGlyph, boxRows, findNode, keyLabels, plainText, propsOf, selectNavGlyphs, termOf } from "./common";
import { appApproveKeys } from "../../../config/keybindings/matchers";
import { expandKeyLabel } from "../../keys/hints";

const DETAIL_ROWS = 8;

interface ApprovalTerm {
	readonly title: string;
	readonly drafting: boolean;
	readonly draftHost: boolean;
	readonly expandable: boolean;
	readonly expanded: boolean;
	readonly offset: number;
}

defineRolePainter("col", "omp.editor.ask.approval", (node, cx): Block => {
	const theme = cx.theme;
	if (cx.width < 8) return EMPTY_BLOCK;
	const inner = cx.width - 4;
	const term = termOf<ApprovalTerm>(node);
	const details = findNode(node, child => child.key() === "details");
	const entries = (details?.children() ?? []).map((line: UiNode) => {
		const props = propsOf<TspTextProps>(line);
		const text = props.spans ? styledText(theme, props.spans) : theme.fg("accent", props.text ?? "");
		return { text, wraps: props.truncate === undefined };
	});
	// Whole details (no truncation) wrap: they scroll by row.
	const layout = (width: number) => entries.flatMap(entry => (entry.wraps ? wrap(entry.text, width) : [entry.text]));
	let lines = layout(inner);
	if (lines.length > DETAIL_ROWS) lines = layout(inner - 1);
	const content: string[] = [];
	if (lines.length === 0) content.push("");
	else if (lines.length <= DETAIL_ROWS)
		for (const line of lines) content.push(truncate(line, inner, theme.symbols.ellipsis));
	else {
		const start = Math.max(0, Math.min(term.offset ?? 0, lines.length - DETAIL_ROWS));
		const thumb = Math.max(1, Math.floor((DETAIL_ROWS * DETAIL_ROWS) / lines.length));
		const at = Math.round((start / (lines.length - DETAIL_ROWS)) * (DETAIL_ROWS - thumb));
		lines.slice(start, start + DETAIL_ROWS).forEach((line, i) => {
			const bar = i >= at && i < at + thumb ? theme.fg("accent", "█") : theme.fg("muted", "│");
			content.push(`${padTo(truncate(line, inner - 1, theme.symbols.ellipsis), inner - 1)}${bar}`);
		});
	}
	const choices = findNode(node, child => child.key() === "choices");
	const selected = choices ? propsOf<TspListProps>(choices).selected : undefined;
	for (const choice of choices?.children() ?? []) {
		const props = propsOf<TspItemProps & { tone?: string }>(choice);
		let label = plainText(props.label);
		const id = choice.key();
		if (id === "deny" && term.drafting) label = "Deny and send message";
		if (id === selected)
			content.push(
				theme.style(
					"strong",
					theme.fg(props.tone === "error" ? "error" : "accent", `${theme.symbols.symbol("nav.cursor")} ${label}`),
				),
			);
		else content.push(`  ${label}`);
	}
	const approve = `${keyLabels(theme, appApproveKeys())} approve`;
	const deny = `${bindingGlyph("tui.select.cancel", "escape", theme)} deny`;
	const hints = term.drafting
		? [`${bindingGlyph("tui.input.submit", "enter", theme)} deny and send`, approve, deny]
		: [
				`${selectNavGlyphs(theme)} choose`,
				`${bindingGlyph("tui.select.confirm", "enter", theme)} select`,
				approve,
				deny,
			];
	if (term.expandable) hints.push(`${expandKeyLabel(theme)} ${term.expanded ? "less" : "details"}`);
	// A draft holds the keys: no scrolling, and typing already steers.
	if (!term.drafting) {
		if (lines.length > DETAIL_ROWS)
			hints.push(
				`${bindingGlyph("tui.select.pageUp", "pageUp", theme)}/${bindingGlyph("tui.select.pageDown", "pageDown", theme)} scroll`,
			);
		if (term.draftHost) hints.push("type to deny and steer");
	}
	const box = theme.symbols.box;
	const rows = boxRows(
		theme,
		term.title ?? "",
		[...content, "\u0000", truncate(theme.fg("dim", hints.join(" · ")), inner, theme.symbols.ellipsis)],
		cx.width,
	);
	const ruleAt = rows.findIndex(row => row.includes("\u0000"));
	rows[ruleAt] = theme.fg("border", `${box.teeRight}${box.horizontal.repeat(cx.width - 2)}${box.teeLeft}`);
	return { rows };
});
