/**
 * Terminal look of the activity line (`row` `omp.hud.activity`): the
 * status row's rows (the native todo pill and tray caption stay native).
 * Idle, the trailer docks right under a blank row. On a short terminal the
 * todo folds in: `TODO 2/5 · ☐ next task` docks right on the status row's
 * last line (a blank row, then the line, when nothing else shows).
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { type Block, defineRolePainter, EMPTY_BLOCK, type PaintContext, roleOf } from "@oh-my-pi/pi-tui/term/paint";
import { truncate, visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import type { StatusHudModel } from "../../dock/status";
import { termOf } from "../messages/fill";
import { todoCompactLine } from "./todo";

/** Cells kept between the status line and the folded todo. */
const MIN_GAP = 2;

/** `left` and `right` on one row of `width`, `right` docked one cell from the edge. */
function dockRight(left: string, right: string, width: number): string {
	const rightWidth = visibleWidth(right) + 1;
	const leftWidth = visibleWidth(left);
	if (leftWidth === 0) {
		const shown = rightWidth <= width ? right : truncate(right, Math.max(4, width - 1));
		return `${" ".repeat(Math.max(0, width - visibleWidth(shown) - 1))}${shown} `;
	}
	if (leftWidth + MIN_GAP + rightWidth <= width)
		return `${left}${" ".repeat(width - leftWidth - rightWidth)}${right} `;
	const shownRight = truncate(right, Math.min(rightWidth, Math.max(10, Math.floor(width * 0.45))));
	const shownRightWidth = visibleWidth(shownRight) + 1;
	const shownLeft = truncate(left, Math.max(4, width - shownRightWidth - MIN_GAP));
	const gap = Math.max(MIN_GAP, width - visibleWidth(shownLeft) - shownRightWidth);
	return `${shownLeft}${" ".repeat(gap)}${shownRight} `;
}

function paintActivity(node: UiNode, cx: PaintContext): Block {
	const model = termOf<{ status: StatusHudModel }>(node).status;
	if (!model) return EMPTY_BLOCK;
	const status = node.children().find(child => roleOf(child) === "omp.hud.status");
	const block = status ? cx.paint(status, cx.width) : EMPTY_BLOCK;
	const todo = model.todo;
	const view = todo?.compact() ? todo.window() : undefined;
	if (view) {
		const lines = block.rows;
		const right = todoCompactLine(cx.theme, view);
		const lead = lines.length > 1 ? lines.slice(0, -1) : [""];
		return { rows: [...lead, dockRight(lines.at(-1) ?? "", right, cx.width)] };
	}
	if (block.rows.length > 0) return block;
	const trailer = model.idleTrailer();
	if (!trailer) return EMPTY_BLOCK;
	return {
		rows: ["", `${" ".repeat(Math.max(0, cx.width - visibleWidth(trailer)))}${truncate(trailer, cx.width)}`],
	};
}

defineRolePainter("row", "omp.hud.activity", paintActivity);
