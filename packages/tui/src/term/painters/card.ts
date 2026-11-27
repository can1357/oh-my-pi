/**
 * `card`: its children in a rounded box with the head in the top edge
 * (border in the tone's or status's color; `variant:"bare"` drops the box);
 * collapsed, a card with a `preview` keeps that many body rows under a
 * `… N more lines` row, without one it shows its head only. Also the
 * disclosure helpers `section` and the generic `tool` share.
 *
 * Text: the head's label and the body's text; the frame, the marker and the
 * `… N more lines` row are decoration.
 */
import type { TspCardProps, TspCardStatus, TspPreview, TspTone } from "@oh-my-pi/pi-wire";
import type { UiNode } from "../../node";
import { padTo, truncate, visibleWidth } from "../../text/width";
import type { Theme } from "../../theme/contract";
import { type Block, definePainter, EMPTY_BLOCK, type PaintContext } from "../paint";
import {
	blockText,
	clipRenderedText,
	lazyText,
	offsetRenderedText,
	type RenderedTextRow,
	shownText,
	sliceRenderedText,
} from "../text-layout";
import { styledText } from "./layout";

/** Children painted at `width`, stacked: their rows and their text (cursor and hits are not kept). */
export function body(node: UiNode, cx: PaintContext, width: number): Block {
	const blocks = node.children().map(child => cx.paint(child, Math.max(1, width)));
	const rows: string[] = [];
	for (const block of blocks) rows.push(...block.rows);
	return { rows, text: lazyText(() => blocks.flatMap(blockText)) };
}

/** A collapsed body clamped to its preview (`… N more lines` after), or dropped without one. */
export function disclosed(theme: Theme, block: Block, collapsed: boolean, preview: TspPreview | undefined): Block {
	if (!collapsed) return block;
	if (preview === undefined || preview === "auto" || typeof preview !== "object") return EMPTY_BLOCK;
	const keep = Math.max(0, preview.lines);
	if (block.rows.length <= keep) return block;
	const hidden = block.rows.length - keep;
	return {
		rows: [...block.rows.slice(0, keep), theme.style("dim", `… ${hidden} more line${hidden === 1 ? "" : "s"}`)],
		text: lazyText(() => [...sliceRenderedText(blockText(block), 0, keep), undefined]),
	};
}

export function marker(theme: Theme, collapsible: boolean | undefined, collapsed: boolean | undefined): string {
	if (!collapsible) return "";
	return `${theme.style("dim", theme.symbols.symbol(collapsed ? "nav.expand" : "nav.collapse"))} `;
}

/**
 * The text of a head row: `label` as `shown` (a cut of `chrome` + `label`)
 * shows it from column `column` + the chrome's width; the chrome (a marker,
 * a status glyph) is decoration.
 */
export function headText(chrome: string, label: string, shown: string, column: number): RenderedTextRow | undefined {
	if (!label || !shown.startsWith(chrome)) return undefined;
	const rest = shown.slice(chrome.length);
	return rest ? offsetRenderedText(shownText(label, rest), column + visibleWidth(chrome)) : undefined;
}

/**
 * A rounded box around `block` at `width`, `chrome` + `label` in the top
 * edge, borders in `border`.
 */
export function boxed(theme: Theme, block: Block, width: number, label: string, border: string, chrome = ""): Block {
	const box = theme.symbols.box;
	const rows = block.rows;
	if (width < 4) {
		return {
			rows: rows.map(row => truncate(row, width)),
			text: lazyText(() =>
				blockText(block).map((row, i) => (visibleWidth(rows[i]!) > width ? clipRenderedText(row, width - 1) : row)),
			),
		};
	}
	const inner = width - 4;
	const head = `${chrome}${label}`;
	const shown = head ? truncate(head, Math.max(0, width - 6), theme.symbols.ellipsis) : "";
	const fitted = head ? ` ${shown} ` : "";
	const fill = Math.max(0, width - 3 - visibleWidth(fitted));
	const top = `${theme.style(border, `${box.topLeft}${box.horizontal}`)}${fitted}${theme.style(border, `${box.horizontal.repeat(fill)}${box.topRight}`)}`;
	const side = theme.style(border, box.vertical);
	const out = [top];
	for (const row of rows) out.push(`${side} ${padTo(truncate(row, inner, ""), inner)} ${side}`);
	out.push(theme.style(border, `${box.bottomLeft}${box.horizontal.repeat(width - 2)}${box.bottomRight}`));
	return {
		rows: out,
		text: lazyText(() => [
			headText(chrome, label, shown, 3),
			...blockText(block).map(row => clipRenderedText(offsetRenderedText(row, 2), 2 + inner)),
			undefined,
		]),
	};
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
	const chrome = marker(theme, props.collapsible, props.collapsed);
	const label = styledText(theme, props.head);
	const head = `${chrome}${label}`;
	const bare = props.variant === "bare";
	const shown = disclosed(
		theme,
		body(node, cx, bare ? cx.width : cx.width - 4),
		props.collapsed === true,
		props.preview,
	);
	if (!bare) return boxed(theme, shown, cx.width, label, borderOf(props.tone, props.status), chrome);
	const cut = head ? truncate(head, cx.width, theme.symbols.ellipsis) : undefined;
	const rows = cut === undefined ? [] : [cut];
	for (const row of shown.rows) rows.push(truncate(row, cx.width, ""));
	return {
		rows,
		text: lazyText(() => [
			...(cut === undefined ? [] : [headText(chrome, label, cut, 0)]),
			...blockText(shown).map(row => clipRenderedText(row, cx.width)),
		]),
	};
});
