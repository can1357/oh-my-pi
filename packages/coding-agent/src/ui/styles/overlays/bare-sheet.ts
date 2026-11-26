/**
 * `omp.sheet.bare`: a sheet whose content draws its own look in the terminal
 * (an extension's `ctx.ui.custom` overlay, the git shortcuts). The overlay
 * adds no frame: its children stack at its width. On the whole screen a
 * single child is offered the screen's height, and the rows it leaves are
 * split above and below it.
 */
import { type Block, defineRolePainter, type Hit } from "@oh-my-pi/pi-tui/term/paint";
import { padTo } from "@oh-my-pi/pi-tui/text/width";

defineRolePainter("overlay", "omp.sheet.bare", (node, cx): Block => {
	const rows: string[] = [];
	const hits: Hit[] = [];
	let cursor: Block["cursor"];
	const children = node.children();
	for (const child of children) {
		const block = cx.paint(child, cx.width, children.length === 1 ? cx.height : undefined);
		const at = rows.length;
		if (block.cursor) cursor = { row: block.cursor.row + at, col: block.cursor.col };
		for (const hit of block.hits ?? []) hits.push({ ...hit, row: hit.row + at });
		// The sheet owns its whole width: cells a row leaves are blank, not what lies under it.
		for (const row of block.rows) rows.push(padTo(row, cx.width));
	}
	if (cx.height === undefined) return cursor ? { rows, hits, cursor } : { rows, hits };
	rows.length = Math.min(rows.length, cx.height);
	const lead = Math.floor((cx.height - rows.length) / 2);
	rows.unshift(...Array.from({ length: lead }, () => ""));
	while (rows.length < cx.height) rows.push("");
	const placed = hits.map(hit => ({ ...hit, row: hit.row + lead }));
	return cursor ? { rows, hits: placed, cursor: { row: cursor.row + lead, col: cursor.col } } : { rows, hits: placed };
});
