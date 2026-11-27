/**
 * Transcript containers.
 *
 * - `col` `omp.transcript`: the blocks, each without its blank edge rows,
 *   set off by one blank row (blocks drawing nothing take none; blocks marked
 *   `term.compact` pack against each other).
 * - `col` `omp.activity`: its blocks stacked.
 * - `col` `omp.panel`: a blank row, each section followed by a blank row,
 *   then the footer line as styled.
 *
 * Bare `text` and `md` blocks sit one cell in, like the transcript's prose.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { type Block, defineRolePainter, type PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { stack } from "@oh-my-pi/pi-tui/term/painters/layout";
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";
import { replaceTabs, wrap } from "@oh-my-pi/pi-tui/text/width";
import { propsOf, termOf } from "./fill";
import { RowText, shiftText, sliceText, type TextRows } from "../rendered-text";

/** A block's rows and text; bare `text` and `md` blocks one cell in from both edges. */
export function blockRows(cx: PaintContext, node: UiNode): TextRows {
	const bare = (node.kind === "text" || node.kind === "md") && propsOf<{ role: string }>(node).role === undefined;
	if (!bare) return cx.paint(node, cx.width);
	const painted = cx.paint(node, Math.max(1, cx.width - 2));
	return { rows: painted.rows.map(row => ` ${row}`), text: shiftText(painted, 1) };
}

function blank(row: string): boolean {
	return stripEscapes(row).trim() === "";
}

/** `block` without leading and trailing blank rows. */
function trimBlankEdges(block: TextRows): TextRows {
	const rows = block.rows;
	let start = 0;
	let end = rows.length;
	while (start < end && blank(rows[start]!)) start++;
	while (end > start && blank(rows[end - 1]!)) end--;
	return start === 0 && end === rows.length ? block : sliceText(block, start, end);
}

function paintTranscript(node: UiNode, cx: PaintContext): Block {
	const out = new RowText();
	let previousCompact = false;
	for (const child of node.children()) {
		const block = trimBlankEdges(blockRows(cx, child));
		if (block.rows.length === 0) continue;
		const compact = termOf<{ compact: boolean }>(child).compact === true;
		// The gap between blocks copies as a paragraph break.
		if (out.length > 0 && !(compact && previousCompact)) out.literal("");
		out.block(block);
		previousCompact = compact;
	}
	return out.done();
}

function paintActivity(node: UiNode, cx: PaintContext): Block {
	const out = new RowText();
	for (const child of node.children()) out.block(blockRows(cx, child));
	return out.done();
}

function paintPanel(node: UiNode, cx: PaintContext): Block {
	const out = new RowText().deco("");
	for (const child of node.children()) {
		if (propsOf<{ role: string }>(child).role === "omp.panel.footer") {
			const footer = replaceTabs(termOf<{ footer: string }>(child).footer ?? "");
			out.wrapped(footer, wrap(footer, cx.width));
			continue;
		}
		const section = stack(
			child.children().map(member => blockRows(cx, member)),
			0,
		);
		if (section.rows.length === 0) continue;
		out.block(section).deco("");
	}
	return out.done();
}

defineRolePainter("col", "omp.transcript", paintTranscript);
defineRolePainter("col", "omp.activity", paintActivity);
defineRolePainter("col", "omp.panel", paintPanel);
