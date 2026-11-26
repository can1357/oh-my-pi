/**
 * `omp.app.screen`: a fullscreen app's overlay in the terminal. The app owns
 * every cell, so the overlay draws no frame: its children stack at the full
 * width, padded to the screen's height.
 */
import { type Block, defineRolePainter, type Hit } from "@oh-my-pi/pi-tui/term/paint";

defineRolePainter("overlay", "omp.app.screen", (node, cx): Block => {
	const rows: string[] = [];
	const hits: Hit[] = [];
	let cursor: Block["cursor"];
	const children = node.children();
	for (const child of children) {
		// A single app view gets the whole screen; several share it top to bottom at natural height.
		const block = cx.paint(child, cx.width, children.length === 1 ? cx.height : undefined);
		const at = rows.length;
		if (block.cursor) cursor = { row: block.cursor.row + at, col: block.cursor.col };
		for (const hit of block.hits ?? []) hits.push({ ...hit, row: hit.row + at });
		rows.push(...block.rows);
	}
	if (cx.height !== undefined) {
		while (rows.length < cx.height) rows.push("");
		rows.length = cx.height;
	}
	return cursor ? { rows, hits, cursor } : { rows, hits };
});
