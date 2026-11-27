/**
 * History-collapse summaries (`section` roles `omp.compaction`,
 * `omp.handoff`, `omp.branch`): a blank row, the label and expansion hint
 * centered between dim rules (the bare muted label when the width leaves
 * fewer than four rule cells), a blank row; expanded, the detail Markdown in
 * a `customMessageBg` box one row and one cell in.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { type Block, defineRolePainter, type PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { renderMarkdownFrame } from "@oh-my-pi/pi-tui/text/markdown/index";
import { visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import type { SummaryTerm } from "../../transcript/messages/summaries";
import { expandKeyLabel } from "../../keys/hints";
import { fillRow, propsOf, termOf } from "./fill";
import type { RenderedText } from "@oh-my-pi/pi-tui/term/text-layout";
import { RowText, type TextRows } from "../rendered-text";

/** The divider row, and the label's text: what copies (the rules, glyphs and hint are chrome). */
function dividerRow(cx: PaintContext, term: Partial<SummaryTerm>): TextRows {
	const theme = cx.theme;
	const glyph = term.glyph ? theme.symbols.icon(term.glyph) : "";
	const text = term.label ?? "";
	let label = glyph ? `${glyph} ${text}` : text;
	if (term.warning) label += ` ${theme.fg("warning", theme.symbols.icon("status.warning"))}`;
	const hint = `${theme.symbols.symbol("sep.dot").trim()} ${expandKeyLabel(theme)}`;
	const remaining = cx.width - visibleWidth(`${label} ${hint}`) - 2;
	const lead = glyph ? visibleWidth(glyph) + 1 : 0;
	const labelText = (column: number) => (): RenderedText => [
		{ line: { text }, start: 0, end: text.length, column: column + lead },
	];
	if (remaining < 4) return { rows: [theme.fg("muted", label)], text: labelText(0) };
	const left = Math.floor(remaining / 2);
	const rule = theme.symbols.box.horizontal;
	return {
		rows: [
			`${theme.fg("dim", rule.repeat(left))} ${theme.fg("muted", label)} ${theme.fg("dim", hint)} ${theme.fg("dim", rule.repeat(remaining - left))}`,
		],
		text: labelText(left + 1),
	};
}

/** `markdown` in a `customMessageBg` box with one row and one cell of padding (decoration); the Markdown copies one cell in. */
export function detailBox(cx: PaintContext, markdown: string): RowText {
	const theme = cx.theme;
	const frame = renderMarkdownFrame(markdown, Math.max(1, cx.width - 2), {
		theme,
		textStyle: "customMessageText",
		hyperlinks: cx.hyperlinks,
	});
	const fill = (row: string): string => fillRow(theme, "customMessageBg", row, cx.width);
	return new RowText()
		.deco(fill(""))
		.block(
			frame,
			1,
			frame.rows.map(row => fill(` ${row}`)),
		)
		.deco(fill(""));
}

function paintSummary(node: UiNode, cx: PaintContext): Block {
	const term = termOf<SummaryTerm>(node);
	const out = new RowText().deco("").block(dividerRow(cx, term)).deco("");
	if (propsOf<{ collapsed: boolean }>(node).collapsed === false) out.block(detailBox(cx, term.detail ?? "").done());
	return out.done();
}

for (const role of ["omp.compaction", "omp.handoff", "omp.branch"]) defineRolePainter("section", role, paintSummary);
