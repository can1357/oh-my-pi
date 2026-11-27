/**
 * Terminal looks of transcript notices.
 *
 * - `row` `omp.notice.*`: a line notice is a blank row, then `Warning: …` /
 *   `Error: …` with the standard inset, wrapped, in the tone's color; a notice with its
 *   own terminal rows (`term.alt`) draws those.
 * - `col` `omp.status-block`: each status row's parts joined by spaces,
 *   wrapped under the row's indent.
 * - `toast` / `col` `omp.toast.status`: a blank row, then the inset message (the `col` is a
 *   status kept out of native toasts).
 * - `row` `omp.recap`: a blank row, then a dim italic `※ recap: …`.
 * - `text` `omp.tool.elided`: the dim italic note with the standard inset.
 * - `card` / `section` / `checklist` `omp.notice.*` boxed notices: a blank
 *   row (unless `leadingSpace` is off), then a box one row and one cell in on
 *   every side, filled inverse in the severity color (or on a background):
 *   the glyph and header, then a blank row and the body texts.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { type Block, defineRolePainter, EMPTY_BLOCK, type PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { stack } from "@oh-my-pi/pi-tui/term/painters/layout";
import { padTo, replaceTabs, wrap } from "@oh-my-pi/pi-tui/text/width";
import { terminalPaddingX } from "../terminal-padding";
import { RowText } from "../rendered-text";
import type { NoticeBox, StatusRow } from "../../transcript/messages/notices";
import { fillRow, paddedText, propsOf, termOf } from "./fill";

interface LineTerm {
	line?: { label?: string; message: string };
	alt?: UiNode | readonly UiNode[];
}

function altNodes(alt: UiNode | readonly UiNode[]): readonly UiNode[] {
	return Array.isArray(alt) ? alt : [alt as UiNode];
}

function paintNoticeRow(node: UiNode, cx: PaintContext): Block {
	const term = termOf<LineTerm>(node);
	if (term.alt)
		return stack(
			altNodes(term.alt).map(child => cx.paint(child, cx.width)),
			0,
		);
	if (!term.line) return EMPTY_BLOCK;
	const tone = propsOf<{ tone: string }>(node).tone ?? "warning";
	const text = term.line.label ? `${term.line.label}: ${term.line.message}` : term.line.message;
	return new RowText()
		.deco("")
		.block(paddedText(cx.theme.fg(tone, text), cx.width).done())
		.done();
}

/** Rows of one status row: parts joined by spaces under the row's indent, copying as one line. */
export function statusRows(cx: PaintContext, row: Pick<StatusRow, "parts" | "indent">): RowText {
	const out = new RowText();
	const parts = row.parts.flatMap(part =>
		part && part.text !== "" ? [part.color ? cx.theme.fg(part.color, part.text) : part.text] : [],
	);
	if (parts.length === 0) return out;
	// The indent pads both sides.
	const indent = " ".repeat(terminalPaddingX(row.indent));
	const source = replaceTabs(parts.join(" "));
	const rows = wrap(source, Math.max(1, cx.width - 2 * indent.length));
	return out.wrapped(
		source,
		rows,
		indent.length,
		rows.map(line => indent + line),
	);
}

function paintStatusBlock(node: UiNode, cx: PaintContext): Block {
	const out = new RowText();
	for (const row of termOf<{ rows: readonly StatusRow[] }>(node).rows ?? []) out.block(statusRows(cx, row).done());
	return out.done();
}

function paintStatusToast(node: UiNode, cx: PaintContext): Block {
	const term = termOf<{ message: string; color: string }>(node);
	const message = term.message ?? "";
	return new RowText()
		.deco("")
		.block(paddedText(term.color ? cx.theme.fg(term.color, message) : message, cx.width).done())
		.done();
}

function paintRecap(node: UiNode, cx: PaintContext): Block {
	const recap = termOf<{ recap: string }>(node).recap ?? "";
	return new RowText()
		.deco("")
		.block(paddedText(cx.theme.style("dim em", `※ recap: ${recap}`), cx.width).done())
		.done();
}

function paintElided(node: UiNode, cx: PaintContext): Block {
	const spans = propsOf<{ spans: readonly { t: string; s?: string }[] }>(node).spans ?? [];
	return paddedText(spans.map(span => cx.theme.style(span.s, span.t)).join(""), cx.width).done();
}

/** Turns off every text attribute but inverse, and the foreground. */
const CLOSE = "\x1b[22m\x1b[23m\x1b[24m\x1b[29m\x1b[39m";

interface BoxTerm {
	box: NoticeBox;
	severity: string;
	background?: string;
	leadingSpace?: boolean;
}

/** The rows of a notice box at `width`: its fill is decoration, the header (past its glyph) and body copy. */
export function noticeBoxRows(cx: PaintContext, term: Partial<BoxTerm>): RowText {
	const out = new RowText();
	const box = term.box;
	if (!box) return out;
	const theme = cx.theme;
	const inner = Math.max(1, cx.width - 2);
	const glyph = box.icon ? theme.symbols.icon(box.icon) : "";
	// Each line closes its attributes and color before the fill runs on to the edge.
	const fill = term.background
		? (row: string) => fillRow(theme, term.background!, row, cx.width)
		: (row: string) => theme.style(`inverse ${term.severity ?? "warning"}`, row);
	const shown = (line: string): string => fill(padTo(` ${line}${line ? CLOSE : ""}`, cx.width));
	if (term.leadingSpace !== false) out.deco("");
	out.deco(shown(""));
	const header = replaceTabs(box.header);
	const headRows = wrap(replaceTabs(glyph ? `${glyph} ${box.header}` : box.header), inner);
	out.prefixed(header, headRows, glyph ? `${Bun.stripANSI(glyph)} ` : "", "", 1, headRows.map(shown));
	if (box.body && box.body.length > 0) {
		out.deco(shown(""));
		for (const text of box.body) {
			const source = replaceTabs(text);
			const rows = wrap(source, inner);
			out.wrapped(source, rows, 1, rows.map(shown));
		}
	}
	return out.deco(shown(""));
}

function paintNoticeBox(node: UiNode, cx: PaintContext): Block {
	return noticeBoxRows(cx, termOf<BoxTerm>(node)).done();
}

defineRolePainter("row", "omp.notice", paintNoticeRow, { prefix: true });
defineRolePainter("col", "omp.status-block", paintStatusBlock);
defineRolePainter("toast", "omp.toast.status", paintStatusToast);
// A status kept out of native toasts (`col`, hidden natively) draws as the toast would.
defineRolePainter("col", "omp.toast.status", paintStatusToast);
defineRolePainter("row", "omp.recap", paintRecap);
defineRolePainter("text", "omp.tool.elided", paintElided);
defineRolePainter("card", "omp.notice", paintNoticeBox, { prefix: true });
defineRolePainter("section", "omp.notice", paintNoticeBox, { prefix: true });
defineRolePainter("checklist", "omp.notice", paintNoticeBox, { prefix: true });
