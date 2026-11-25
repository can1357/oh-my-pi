/**
 * `menu`: a trigger (`text`/icon, caret) and, while `open`, its rows under
 * it in a rounded box: headers dim, `-` separators as rules, check/radio
 * marks, keys at the row's end, details muted under the label, the program's
 * `active` row on the selection band, disabled rows dim.
 */
import type { TspMenuItem, TspMenuProps } from "@oh-my-pi/pi-wire";
import type { Theme } from "../../theme/contract";
import { spaces, truncate, visibleWidth } from "../../text/width";
import { type Block, definePainter, EMPTY_BLOCK, type Hit } from "../paint";
import "../widgets/menu";
import { keycaps } from "./button";

/** A menu row that can be chosen. */
export type MenuRow = Extract<TspMenuItem, { id: string }>;

/** The menu's choosable rows, in order. */
export function menuRows(items: readonly TspMenuItem[] | undefined): MenuRow[] {
	return (items ?? []).filter((item): item is MenuRow => typeof item === "object" && "id" in item);
}

function triggerText(theme: Theme, props: TspMenuProps): string {
	const icon = props.icon ? theme.symbols.icon(props.icon) : "";
	const label = [icon, props.text ?? ""].filter(part => part !== "").join(" ") || theme.symbols.ellipsis;
	const text = `[ ${label}${props.caret ? " ▾" : ""} ]`;
	if (props.disabled) return theme.fg("dim", text);
	if (props.trigger === "primary") return theme.style("strong", theme.fg("accent", text));
	if (props.trigger === "quiet") return theme.fg("muted", text);
	return text;
}

function rowText(theme: Theme, item: MenuRow, width: number, active: boolean): string[] {
	const mark = item.checked !== undefined || item.radio !== undefined ? (item.checked ? "✓ " : "  ") : "";
	const icon = item.icon ? `${theme.symbols.icon(item.icon)} ` : "";
	const keys = item.keys ? keycaps(typeof item.keys === "string" ? [item.keys] : item.keys) : "";
	const label = `${mark}${icon}${item.label ?? item.id}${item.items ? " ▸" : ""}`;
	const room = Math.max(0, width - (keys ? visibleWidth(keys) + 2 : 0));
	let line = truncate(label, room);
	if (keys) line += spaces(Math.max(2, width - visibleWidth(line) - visibleWidth(keys))) + theme.fg("dim", keys);
	line = truncate(line, width);
	line += spaces(Math.max(0, width - visibleWidth(line)));
	if (item.disabled) line = theme.fg("dim", line);
	else if (item.danger) line = theme.fg("error", line);
	if (active && !item.disabled) line = theme.bg("selectedBg", line);
	const rows = [line];
	if (item.detail)
		rows.push(
			theme.fg(
				"muted",
				truncate(`${spaces(visibleWidth(mark))}${item.detail}`, width, theme.symbols.ellipsis, true),
			),
		);
	return rows;
}

definePainter("menu", (node, cx): Block => {
	if (cx.width <= 0) return EMPTY_BLOCK;
	const theme = cx.theme;
	const props = node.props() as TspMenuProps;
	const trigger = truncate(triggerText(theme, props), cx.width);
	const rows = [trigger];
	const hits: Hit[] = [{ row: 0, col: 0, width: visibleWidth(trigger), height: 1, node, item: "" }];
	if (!props.open) return { rows, hits };
	const box = theme.symbols.box;
	const inner = Math.max(1, cx.width - 4);
	const border = (text: string): string => theme.fg("border", text);
	rows.push(border(box.topLeft + box.horizontal.repeat(inner + 2) + box.topRight));
	for (const item of props.items ?? []) {
		if (item === "-") {
			rows.push(border(box.teeRight + box.horizontal.repeat(inner + 2) + box.teeLeft));
			continue;
		}
		if (typeof item === "string" || "header" in item) {
			const text = typeof item === "string" ? item : item.header;
			rows.push(
				`${border(box.vertical)} ${theme.fg("dim", truncate(text, inner, theme.symbols.ellipsis, true))} ${border(box.vertical)}`,
			);
			continue;
		}
		const start = rows.length;
		for (const line of rowText(theme, item, inner, item.id === props.active))
			rows.push(`${border(box.vertical)} ${line} ${border(box.vertical)}`);
		if (!item.disabled)
			hits.push({ row: start, col: 0, width: cx.width, height: rows.length - start, node, item: item.id });
	}
	rows.push(border(box.bottomLeft + box.horizontal.repeat(inner + 2) + box.bottomRight));
	// Narrower than the box itself: cut every row to the width.
	return { rows: cx.width < 5 ? rows.map(row => truncate(row, cx.width, "")) : rows, hits };
});
