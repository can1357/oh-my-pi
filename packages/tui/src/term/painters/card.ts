/**
 * `card`: its children in a rounded box with the head in the top edge
 * (border in the tone's or status's color; `variant:"bare"` drops the box);
 * collapsed, a card with a `preview` keeps that many body rows under a
 * `… N more lines` row, without one it shows its head only. Also the
 * disclosure helpers `section` and the generic `tool` share.
 */
import type { TspCardProps, TspCardStatus, TspPreview, TspTone } from "@oh-my-pi/pi-wire";
import type { UiNode } from "../../node";
import { padTo, truncate, visibleWidth } from "../../text/width";
import type { Theme } from "../../theme/contract";
import { type Block, definePainter, EMPTY_BLOCK, type PaintContext } from "../paint";
import { styledText } from "./layout";

/** Children painted at `width`, stacked. */
export function bodyRows(node: UiNode, cx: PaintContext, width: number): string[] {
	const rows: string[] = [];
	for (const child of node.children()) rows.push(...cx.paint(child, Math.max(1, width)).rows);
	return rows;
}

/** A collapsed body clamped to its preview (`… N more lines` after), or dropped without one. */
export function disclosed(
	theme: Theme,
	rows: readonly string[],
	collapsed: boolean,
	preview: TspPreview | undefined,
): string[] {
	if (!collapsed) return [...rows];
	if (preview === undefined || preview === "auto" || typeof preview !== "object") return [];
	const keep = Math.max(0, preview.lines);
	if (rows.length <= keep) return [...rows];
	const hidden = rows.length - keep;
	return [...rows.slice(0, keep), theme.style("dim", `… ${hidden} more line${hidden === 1 ? "" : "s"}`)];
}

export function marker(theme: Theme, collapsible: boolean | undefined, collapsed: boolean | undefined): string {
	if (!collapsible) return "";
	return `${theme.style("dim", theme.symbols.symbol(collapsed ? "nav.expand" : "nav.collapse"))} `;
}

/** A rounded box around `rows` at `width`, `head` in the top edge, borders in `border`. */
export function boxRows(theme: Theme, rows: readonly string[], width: number, head: string, border: string): string[] {
	const box = theme.symbols.box;
	if (width < 4) return rows.map(row => truncate(row, width));
	const inner = width - 4;
	const label = head ? ` ${truncate(head, Math.max(0, width - 6), theme.symbols.ellipsis)} ` : "";
	const fill = Math.max(0, width - 3 - visibleWidth(label));
	const top = `${theme.style(border, `${box.topLeft}${box.horizontal}`)}${label}${theme.style(border, `${box.horizontal.repeat(fill)}${box.topRight}`)}`;
	const side = theme.style(border, box.vertical);
	const out = [top];
	for (const row of rows) out.push(`${side} ${padTo(truncate(row, inner, ""), inner)} ${side}`);
	out.push(theme.style(border, `${box.bottomLeft}${box.horizontal.repeat(width - 2)}${box.bottomRight}`));
	return out;
}

export function borderOf(tone: TspTone | undefined, status: TspCardStatus | undefined): string {
	if (tone === "error" || status === "error") return "error";
	if (tone === "warning") return "warning";
	if (tone === "success") return "success";
	if (tone === "info" || tone === "pending" || status === "running" || status === "pending") return "accent";
	return "dim";
}

definePainter("card", (node, cx): Block => {
	const props = node.props() as TspCardProps & { tone?: TspTone };
	const theme = cx.theme;
	if (cx.width <= 0) return EMPTY_BLOCK;
	const head = `${marker(theme, props.collapsible, props.collapsed)}${styledText(theme, props.head)}`;
	const bare = props.variant === "bare";
	const body = disclosed(
		theme,
		bodyRows(node, cx, bare ? cx.width : cx.width - 4),
		props.collapsed === true,
		props.preview,
	);
	if (bare) {
		const rows = head ? [truncate(head, cx.width, theme.symbols.ellipsis)] : [];
		for (const row of body) rows.push(truncate(row, cx.width, ""));
		return { rows };
	}
	return {
		rows: boxRows(theme, body, cx.width, head, borderOf(props.tone, props.status)),
	};
});
