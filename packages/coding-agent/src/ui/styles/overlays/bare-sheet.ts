/**
 * `omp.sheet.bare`: a sheet whose content draws its own look in the terminal
 * (an extension's `ctx.ui.custom` overlay, the git shortcuts). The overlay
 * adds no frame: its children stack at its width. On the whole screen a
 * single child is offered the screen's height, and the rows it leaves are
 * split above and below it.
 */
import { type Block, defineRolePainter, type Hit } from "@oh-my-pi/pi-tui/term/paint";
import { padTo } from "@oh-my-pi/pi-tui/text/width";
import { fitHeight, RowText } from "../rendered-text";

defineRolePainter("overlay", "omp.sheet.bare", (node, cx): Block => {
	const out = new RowText();
	const hits: Hit[] = [];
	let cursor: Block["cursor"];
	const children = node.children();
	for (const child of children) {
		const block = cx.paint(child, cx.width, children.length === 1 ? cx.height : undefined);
		const at = out.length;
		if (block.cursor) cursor = { row: block.cursor.row + at, col: block.cursor.col };
		for (const hit of block.hits ?? []) hits.push({ ...hit, row: hit.row + at });
		// The sheet owns its whole width: cells a row leaves are blank, not what lies under it.
		out.block(
			block,
			0,
			block.rows.map(row => padTo(row, cx.width)),
		);
	}
	if (cx.height === undefined) return cursor ? { ...out.done(), hits, cursor } : { ...out.done(), hits };
	const lead = Math.floor((cx.height - Math.min(out.length, cx.height)) / 2);
	const placed = hits.map(hit => ({ ...hit, row: hit.row + lead }));
	const content = fitHeight(out.done(), cx.height, lead);
	return cursor
		? { ...content, hits: placed, cursor: { row: cursor.row + lead, col: cursor.col } }
		: { ...content, hits: placed };
});
