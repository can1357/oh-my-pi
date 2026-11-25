/**
 * Terminal look of a covering dock slot (`col` `omp.dock.covering`: a docked
 * report, a waiting ask): its children stacked, every row drawn over the
 * live transcript instead of taking room from it. The transcript rows that
 * still fit above stay on screen; the ones covered come back when the slot
 * empties, never moved into history.
 */
import { defineRolePainter } from "@oh-my-pi/pi-tui/term/paint";
import { stack } from "@oh-my-pi/pi-tui/term/painters/layout";

defineRolePainter("col", "omp.dock.covering", (node, cx) => {
	const block = stack(
		node.children().map(child => cx.paint(child, cx.width)),
		0,
	);
	return block.rows.length > 0 ? { ...block, covering: block.rows.length } : block;
});
