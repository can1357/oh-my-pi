/**
 * Terminal looks of transcript notices.
 *
 * - `row` `omp.notice.*`: a line notice is a blank row, then `Warning: …` /
 *   `Error: …` one cell in, wrapped, in the tone's color; a notice with its
 *   own terminal rows (`term.alt`) draws those.
 * - `col` `omp.status-block`: each status row's parts joined by spaces,
 *   wrapped under the row's indent.
 * - `toast` / `col` `omp.toast.status`: a blank row, then the message one cell in (the `col` is a
 *   status kept out of native toasts).
 * - `row` `omp.recap`: a blank row, then a dim italic `※ recap: …`.
 * - `text` `omp.tool.elided`: the dim italic note one cell in.
 * - `card` / `section` / `checklist` `omp.notice.*` boxed notices: a blank
 *   row (unless `leadingSpace` is off), then a box one row and one cell in on
 *   every side, filled inverse in the severity color (or on a background):
 *   the glyph and header, then a blank row and the body texts.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { type Block, defineRolePainter, EMPTY_BLOCK, type PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { stack } from "@oh-my-pi/pi-tui/term/painters/layout";
import { padTo, replaceTabs, wrap } from "@oh-my-pi/pi-tui/text/width";
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
	return { rows: ["", ...paddedText(cx.theme.fg(tone, text), cx.width)] };
}

/** Rows of one status row: parts joined by spaces under the row's indent. */
export function statusRows(cx: PaintContext, row: Pick<StatusRow, "parts" | "indent">): string[] {
	const parts = row.parts.flatMap(part =>
		part && part.text !== "" ? [part.color ? cx.theme.fg(part.color, part.text) : part.text] : [],
	);
	if (parts.length === 0) return [];
	// The indent pads both sides.
	const indent = " ".repeat(row.indent ?? 1);
	return wrap(replaceTabs(parts.join(" ")), Math.max(1, cx.width - 2 * indent.length)).map(line => indent + line);
}

function paintStatusBlock(node: UiNode, cx: PaintContext): Block {
	const rows = termOf<{ rows: readonly StatusRow[] }>(node).rows ?? [];
	return { rows: rows.flatMap(row => statusRows(cx, row)) };
}

function paintStatusToast(node: UiNode, cx: PaintContext): Block {
	const term = termOf<{ message: string; color: string }>(node);
	const message = term.message ?? "";
	return {
		rows: ["", ...paddedText(term.color ? cx.theme.fg(term.color, message) : message, cx.width)],
	};
}

function paintRecap(node: UiNode, cx: PaintContext): Block {
	const recap = termOf<{ recap: string }>(node).recap ?? "";
	return {
		rows: ["", ...paddedText(cx.theme.style("dim em", `※ recap: ${recap}`), cx.width)],
	};
}

function paintElided(node: UiNode, cx: PaintContext): Block {
	const spans = propsOf<{ spans: readonly { t: string; s?: string }[] }>(node).spans ?? [];
	return {
		rows: paddedText(spans.map(span => cx.theme.style(span.s, span.t)).join(""), cx.width),
	};
}

/** Turns off every text attribute but inverse, and the foreground. */
const CLOSE = "\x1b[22m\x1b[23m\x1b[24m\x1b[29m\x1b[39m";

interface BoxTerm {
	box: NoticeBox;
	severity: string;
	background?: string;
	leadingSpace?: boolean;
}

/** The rows of a notice box at `width`. */
export function noticeBoxRows(cx: PaintContext, term: Partial<BoxTerm>): string[] {
	const box = term.box;
	if (!box) return [];
	const theme = cx.theme;
	const inner = Math.max(1, cx.width - 2);
	const glyph = box.icon ? theme.symbols.icon(box.icon) : "";
	const lines = wrap(replaceTabs(glyph ? `${glyph} ${box.header}` : box.header), inner);
	if (box.body && box.body.length > 0) {
		lines.push("");
		for (const text of box.body) lines.push(...wrap(replaceTabs(text), inner));
	}
	// Each line closes its attributes and color before the fill runs on to the edge.
	const content = ["", ...lines, ""].map(line => padTo(` ${line}${line ? CLOSE : ""}`, cx.width));
	const fill = term.background
		? (row: string) => fillRow(theme, term.background!, row, cx.width)
		: (row: string) => theme.style(`inverse ${term.severity ?? "warning"}`, row);
	const rows = content.map(fill);
	return term.leadingSpace === false ? rows : ["", ...rows];
}

function paintNoticeBox(node: UiNode, cx: PaintContext): Block {
	return { rows: noticeBoxRows(cx, termOf<BoxTerm>(node)) };
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
