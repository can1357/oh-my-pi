/**
 * History-collapse summaries (`section` roles `omp.compaction`,
 * `omp.handoff`, `omp.branch`): a blank row, the label and `· ⌃O` hint
 * centered between dim rules (the bare muted label when the width leaves
 * fewer than four rule cells), a blank row; expanded, the detail Markdown in
 * a `customMessageBg` box one row and one cell in.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { type Block, defineRolePainter, type PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { renderMarkdownFrame } from "@oh-my-pi/pi-tui/text/markdown/index";
import { visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import type { SummaryTerm } from "../../transcript/messages/summaries";
import { EXPAND_KEY, fillRow, propsOf, termOf } from "./fill";

function dividerRow(cx: PaintContext, term: Partial<SummaryTerm>): string {
	const theme = cx.theme;
	const glyph = term.glyph ? theme.symbols.icon(term.glyph) : "";
	let label = glyph ? `${glyph} ${term.label ?? ""}` : (term.label ?? "");
	if (term.warning) label += ` ${theme.fg("warning", theme.symbols.icon("status.warning"))}`;
	const hint = `· ${EXPAND_KEY}`;
	const remaining = cx.width - visibleWidth(`${label} ${hint}`) - 2;
	if (remaining < 4) return theme.fg("muted", label);
	const left = Math.floor(remaining / 2);
	const rule = theme.symbols.box.horizontal;
	return `${theme.fg("dim", rule.repeat(left))} ${theme.fg("muted", label)} ${theme.fg("dim", hint)} ${theme.fg("dim", rule.repeat(remaining - left))}`;
}

/** `markdown` in a `customMessageBg` box with one row and one cell of padding. */
export function detailBox(cx: PaintContext, markdown: string): string[] {
	const theme = cx.theme;
	const { rows } = renderMarkdownFrame(markdown, Math.max(1, cx.width - 2), {
		theme,
		textStyle: "customMessageText",
		hyperlinks: cx.hyperlinks,
	});
	return ["", ...rows.map(row => ` ${row}`), ""].map(row => fillRow(theme, "customMessageBg", row, cx.width));
}

function paintSummary(node: UiNode, cx: PaintContext): Block {
	const term = termOf<SummaryTerm>(node);
	const rows = ["", dividerRow(cx, term), ""];
	if (propsOf<{ collapsed: boolean }>(node).collapsed === false) rows.push(...detailBox(cx, term.detail ?? ""));
	return { rows };
}

for (const role of ["omp.compaction", "omp.handoff", "omp.branch"]) defineRolePainter("section", role, paintSummary);
