/**
 * The report panel's terminal look: a box titled with the report, its body
 * scrolled to the panel's offset (with a scrollbar when it overflows), and
 * the key hint; cut to the panel's most rows.
 */
import { type Block, defineRolePainter, EMPTY_BLOCK } from "@oh-my-pi/pi-tui/term/paint";
import { visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { boxRows, termOf } from "./common";

interface ReportTerm {
	readonly title: string;
	readonly closeKey: string;
	readonly offset: number;
	readonly maxRows?: number;
}

/** Rows around the body: top border, blank, blank, hint, bottom border. */
const CHROME = 5;

defineRolePainter("col", "omp.report", (node, cx): Block => {
	const theme = cx.theme;
	if (cx.width < 6) return EMPTY_BLOCK;
	const term = termOf<ReportTerm>(node);
	const inner = cx.width - 4;
	const body = node.children().find(child => child.key() === "body");
	const viewport = term.maxRows === undefined ? Number.POSITIVE_INFINITY : Math.max(1, term.maxRows - CHROME);
	let rows = body ? [...cx.paint(body, inner).rows] : [];
	const overflow = rows.length > viewport;
	if (overflow) {
		// The scrollbar takes the last column; the body gets every column before it.
		rows = body ? [...cx.paint(body, inner - 1).rows] : [];
		const total = rows.length;
		const start = Math.max(0, Math.min(term.offset ?? 0, total - viewport));
		const thumb = Math.max(1, Math.floor((viewport * viewport) / total));
		const at = Math.round((start / (total - viewport)) * (viewport - thumb));
		rows = rows.slice(start, start + viewport).map((row, i) => {
			const bar = i >= at && i < at + thumb ? theme.fg("accent", "█") : theme.fg("dim", "│");
			return `${row}${" ".repeat(Math.max(0, inner - 1 - visibleWidth(row)))}${bar}`;
		});
	}
	const hint = `${overflow ? "PgUp/PgDn scroll · " : ""}${term.closeKey ?? "Esc"} to close`;
	const content = ["", ...rows, "", theme.fg("muted", hint)];
	const box = boxRows(theme, (term.title ?? "").replace(/\s*\n\s*/g, " "), content, cx.width);
	return { rows: term.maxRows === undefined ? box : box.slice(0, Math.max(0, term.maxRows)) };
});
