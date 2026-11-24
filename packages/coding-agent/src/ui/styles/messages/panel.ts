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

/** A block's rows; bare `text` and `md` blocks one cell in from both edges. */
export function blockRows(cx: PaintContext, node: UiNode): readonly string[] {
	const bare = (node.kind === "text" || node.kind === "md") && propsOf<{ role: string }>(node).role === undefined;
	if (!bare) return cx.paint(node, cx.width).rows;
	return cx.paint(node, Math.max(1, cx.width - 2)).rows.map(row => ` ${row}`);
}

function blank(row: string): boolean {
	return stripEscapes(row).trim() === "";
}

/** `rows` without leading and trailing blank rows. */
function trimBlankEdges(rows: readonly string[]): readonly string[] {
	let start = 0;
	let end = rows.length;
	while (start < end && blank(rows[start]!)) start++;
	while (end > start && blank(rows[end - 1]!)) end--;
	return rows.slice(start, end);
}

function paintTranscript(node: UiNode, cx: PaintContext): Block {
	const rows: string[] = [];
	let previousCompact = false;
	for (const child of node.children()) {
		const block = trimBlankEdges(blockRows(cx, child));
		if (block.length === 0) continue;
		const compact = termOf<{ compact: boolean }>(child).compact === true;
		if (rows.length > 0 && !(compact && previousCompact)) rows.push("");
		rows.push(...block);
		previousCompact = compact;
	}
	return { rows };
}

function paintActivity(node: UiNode, cx: PaintContext): Block {
	return { rows: node.children().flatMap(child => blockRows(cx, child)) };
}

function paintPanel(node: UiNode, cx: PaintContext): Block {
	const rows: string[] = [""];
	for (const child of node.children()) {
		if (propsOf<{ role: string }>(child).role === "omp.panel.footer") {
			const footer = termOf<{ footer: string }>(child).footer ?? "";
			rows.push(...wrap(replaceTabs(footer), cx.width));
			continue;
		}
		const section = stack(
			child.children().map(member => ({ rows: blockRows(cx, member) })),
			0,
		);
		if (section.rows.length === 0) continue;
		rows.push(...section.rows, "");
	}
	return { rows };
}

defineRolePainter("col", "omp.transcript", paintTranscript);
defineRolePainter("col", "omp.activity", paintActivity);
defineRolePainter("col", "omp.panel", paintPanel);
