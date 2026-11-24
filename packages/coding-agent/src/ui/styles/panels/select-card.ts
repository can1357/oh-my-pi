/**
 * `card` `omp.overlay` in the terminal: the inline panel a selector draws in the composer's place.
 * A rounded frame titled by the card's head; inside it a spacer is a blank row and an `omp.select`
 * column is the option list (pointer, detail column, scrollbar past the visible rows) over its
 * search status; with nothing to list, the status stands above the list's `empty` text. A press
 * on an option row picks it.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { type Block, defineRolePainter, type Hit, type PaintContext, roleOf } from "@oh-my-pi/pi-tui/term/paint";
import { boxBottom, boxRow, boxTop } from "@oh-my-pi/pi-tui/term/painters/picker";
import { windowStart } from "@oh-my-pi/pi-tui/term/painters/prefs";
import type { TspCardProps, TspListProps } from "@oh-my-pi/pi-wire";
import { selectRows } from "../forms/field";

/** Rows of an `omp.select` column at `width`, and the option each of its leading rows shows. */
function selectBlock(
	select: UiNode,
	cx: PaintContext,
	width: number,
): { rows: string[]; items: (string | undefined)[] } {
	const list = select.children().find(child => child.kind === "list");
	const rows = selectRows(cx.theme, select, width);
	if (!list) return { rows, items: [] };
	const props = list.props() as TspListProps;
	const options = list.children();
	if (options.length === 0) {
		// The status (the search being typed) stays on top of the reason nothing is listed.
		const status = rows.length > 1 ? [rows.at(-1)!] : [];
		const empty = typeof props.empty === "string" ? props.empty : (props.empty ?? []).map(span => span.t).join("");
		return { rows: [...status, cx.theme.fg("muted", `  ${empty}`)], items: [] };
	}
	const max = typeof props.max === "number" ? props.max : (props.max?.lines ?? 10);
	const budget = Math.max(1, Math.min(options.length, max));
	const selected = Math.max(
		0,
		options.findIndex(option => option.key() === props.selected),
	);
	const first = windowStart(options.length, selected, budget);
	return { rows, items: options.slice(first, first + budget).map(option => option.key()) };
}

function paintPanel(node: UiNode, cx: PaintContext): Block {
	const theme = cx.theme;
	const width = cx.width;
	const inner = Math.max(1, width - 4);
	const head = (node.props() as TspCardProps).head;
	const rows = [boxTop(theme, width, typeof head === "string" ? head : null)];
	const hits: Hit[] = [];
	for (const child of node.children()) {
		if (roleOf(child) !== "omp.select") {
			for (const row of cx.paint(child, inner).rows) rows.push(boxRow(theme, width, row));
			continue;
		}
		const list = child.children().find(candidate => candidate.kind === "list");
		const block = selectBlock(child, cx, inner);
		block.rows.forEach((row, index) => {
			const item = block.items[index];
			if (list && item !== undefined) {
				hits.push({ row: rows.length, col: 2, width: inner, height: 1, node: list, item });
			}
			rows.push(boxRow(theme, width, row));
		});
	}
	rows.push(boxBottom(theme, width));
	return { rows, hits };
}

defineRolePainter("card", "omp.overlay", paintPanel);
