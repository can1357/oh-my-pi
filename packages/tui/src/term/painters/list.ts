/**
 * `list` and its `item`s. An item is `icon label  detail … value` on one row
 * (label and detail cut, the value at the row's end). A list stacks its
 * items; a selectable list (one with a `selected` prop) marks the selected
 * item with a pointer and indents the rest, a plain list bullets them.
 * `max` keeps the first items under a `… N more` row; `empty` shows when
 * there are none.
 */
import type { TspItemProps, TspListProps, TspTone } from "@oh-my-pi/pi-wire";
import type { UiNode } from "../../node";
import type { Theme } from "../../theme/contract";
import { padTo, truncate, visibleWidth } from "../../text/width";
import { type Block, definePainter, EMPTY_BLOCK, type Hit } from "../paint";
import { styledText } from "./layout";

/** The one-row line of an item at `width`. */
export function itemLine(theme: Theme, props: TspItemProps & { tone?: TspTone }, width: number): string {
	const icon = props.icon ? theme.symbols.icon(props.icon) : "";
	let label = styledText(theme, props.label);
	if (props.tone) label = theme.style(props.tone, label);
	if (props.disabled) label = theme.style("dim", label);
	const detail = styledText(theme, props.detail);
	const value = styledText(theme, props.value);
	let head = icon ? `${icon} ${label}` : label;
	if (detail) head += `  ${theme.style("muted", detail)}`;
	if (!value) return truncate(head, width, theme.symbols.ellipsis);
	const valueWidth = visibleWidth(value);
	if (valueWidth + 2 >= width) return truncate(head, width, theme.symbols.ellipsis);
	const room = width - valueWidth - 2;
	return `${padTo(truncate(head, room, theme.symbols.ellipsis), room)}  ${value}`;
}

definePainter("item", (node, cx) => {
	if (cx.width <= 0) return EMPTY_BLOCK;
	return { rows: [itemLine(cx.theme, node.props() as TspItemProps, cx.width)] };
});

function maxItems(max: TspListProps["max"]): number | undefined {
	if (max === undefined) return undefined;
	return typeof max === "number" ? max : max.lines;
}

definePainter("list", (node, cx): Block => {
	const props = node.props() as TspListProps;
	const theme = cx.theme;
	const items = node.children();
	if (items.length === 0) {
		const empty = styledText(theme, props.empty);
		return empty
			? {
					rows: [truncate(theme.style("muted", empty), cx.width, theme.symbols.ellipsis)],
				}
			: EMPTY_BLOCK;
	}
	const selectable = props.selected !== undefined;
	const limit = maxItems(props.max);
	const shown = limit !== undefined && items.length > limit ? items.slice(0, Math.max(0, limit - 1)) : items;
	const rows: string[] = [];
	const hits: Hit[] = [];
	const inner = Math.max(0, cx.width - 2);
	for (const item of shown) {
		const key = item.key();
		const selected = selectable && key !== undefined && key === props.selected;
		const marker = selectable ? (selected ? theme.style("accent", "❯") : " ") : theme.style("dim", "•");
		const block = cx.paint(item, inner);
		const start = rows.length;
		for (let r = 0; r < block.rows.length; r++) {
			const row = block.rows[r]!;
			rows.push(`${r === 0 ? marker : " "} ${selected ? theme.style("strong", row) : row}`);
		}
		if (block.rows.length > 0)
			hits.push({
				row: start,
				col: 0,
				width: cx.width,
				height: block.rows.length,
				node: node as UiNode,
				item: key,
			});
	}
	const hidden = items.length - shown.length;
	if (hidden > 0) rows.push(truncate(theme.style("muted", `${theme.symbols.ellipsis} ${hidden} more`), cx.width, ""));
	return hits.length > 0 ? { rows, hits } : { rows };
});
