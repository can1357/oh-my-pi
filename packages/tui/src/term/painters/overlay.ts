/**
 * `overlay`: a floating sheet — a rounded frame with `head` set into its top
 * border and its children stacked inside, one column of inset each side.
 * The backend sizes and places it (a `full` overlay gets the screen's height
 * and its body is padded to fill it).
 */
import type { TspOverlayProps } from "@oh-my-pi/pi-wire";
import { padTo, truncate, visibleWidth } from "../../text/width";
import { type Block, definePainter, EMPTY_BLOCK, type Hit } from "../paint";
import { styledText } from "./layout";

definePainter("overlay", (node, cx): Block => {
	const width = cx.width;
	if (width < 4) return EMPTY_BLOCK;
	const theme = cx.theme;
	const props = node.props() as TspOverlayProps;
	const box = theme.symbols.box;
	const inner = width - 4;
	const border = (text: string): string => theme.fg("border", text);
	const head = styledText(theme, props.head);
	let top: string;
	if (head) {
		const shown = truncate(` ${head} `, Math.max(0, width - 4));
		top =
			border(box.topLeft + box.horizontal) +
			theme.style("strong", theme.fg("accent", shown)) +
			border(box.horizontal.repeat(Math.max(0, width - 3 - visibleWidth(shown))) + box.topRight);
	} else top = border(box.topLeft + box.horizontal.repeat(width - 2) + box.topRight);
	const rows = [top];
	const hits: Hit[] = [];
	let cursor: Block["cursor"];
	for (const child of node.children()) {
		const block = cx.paint(child, inner);
		const at = rows.length;
		if (block.cursor) cursor = { row: block.cursor.row + at, col: block.cursor.col + 2 };
		for (const hit of block.hits ?? []) hits.push({ ...hit, row: hit.row + at, col: hit.col + 2 });
		for (const line of block.rows) rows.push(`${border(box.vertical)} ${padTo(line, inner)} ${border(box.vertical)}`);
	}
	if (cx.height !== undefined)
		while (rows.length < cx.height - 1)
			rows.push(`${border(box.vertical)} ${padTo("", inner)} ${border(box.vertical)}`);
	rows.push(border(box.bottomLeft + box.horizontal.repeat(width - 2) + box.bottomRight));
	return cursor ? { rows, hits, cursor } : { rows, hits };
});
