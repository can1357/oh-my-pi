/**
 * The session-info box in the terminal: the report text as written, wrapped
 * and scrolled inside a box titled `Session Info` (a scrollbar column when
 * it overflows), a rule, and the key hint. The box takes at most the
 * terminal's rows.
 */
import { type Block, defineRolePainter, EMPTY_BLOCK } from "@oh-my-pi/pi-tui/term/paint";
import { padTo, wrap } from "@oh-my-pi/pi-tui/text/width";
import { bindingGlyph, boxRows, selectNavGlyphs, termOf } from "./common";

interface InfoTerm {
	readonly report: string;
	readonly rows: number;
	readonly offset: number;
}

/** Rows around the body: top border, rule, hint, bottom border. */
const CHROME = 4;

defineRolePainter("col", "omp.info", (node, cx): Block => {
	const theme = cx.theme;
	if (cx.width < 6) return EMPTY_BLOCK;
	const term = termOf<InfoTerm>(node);
	const inner = cx.width - 4;
	const lines = (term.report ?? "").split("\n");
	const layout = (width: number) => lines.flatMap(line => (line === "" ? [""] : wrap(line, width)));
	const viewport = Math.max(1, (term.rows ?? 24) - CHROME);
	let body = layout(inner);
	if (body.length > viewport) {
		body = layout(inner - 1);
		const total = body.length;
		const start = Math.max(0, Math.min(term.offset ?? 0, total - viewport));
		const thumb = Math.max(1, Math.round((viewport * viewport) / total));
		const at = Math.round((start / (total - viewport)) * (viewport - thumb));
		body = body
			.slice(start, start + viewport)
			.map(
				(row, i) =>
					`${padTo(row, inner - 1)}${i >= at && i < at + thumb ? theme.fg("accent", "█") : theme.fg("dim", "│")}`,
			);
	}
	const box = theme.symbols.box;
	const rows = boxRows(
		theme,
		"Session Info",
		[
			...body,
			"\u0000",
			theme.fg("dim", `${selectNavGlyphs()} scroll · ${bindingGlyph("tui.select.cancel", "escape")} close`),
		],
		cx.width,
	);
	const ruleAt = rows.findIndex(row => row.includes("\u0000"));
	rows[ruleAt] = theme.fg("border", `${box.teeRight}${box.horizontal.repeat(cx.width - 2)}${box.teeLeft}`);
	return { rows };
});
