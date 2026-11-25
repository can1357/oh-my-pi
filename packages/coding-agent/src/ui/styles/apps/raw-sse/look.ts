/**
 * `omp.debug.bar`: the raw provider stream viewer in the terminal. The bar's
 * place shows the whole viewer frame (`term.viewer`): the counters, the
 * scrolling wire text, the copy status and key hints. Mouse events anywhere
 * on it go to the viewer (wheel scrolls, a click on the counters toggles
 * following the tail, a click on the stream pins that row to the top).
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { type Block, defineRolePainter } from "@oh-my-pi/pi-tui/term/paint";
import { defineRoleWidget } from "@oh-my-pi/pi-tui/term/widgets";
import type { RawSseViewerModel } from "../../../apps/raw-sse/model";
import { paintViewerFrame } from "../viewer/frame";

const ROLE = "omp.debug.bar";

function viewerOf(node: UiNode): RawSseViewerModel | undefined {
	return (node.props() as { term?: { viewer?: RawSseViewerModel } }).term?.viewer;
}

defineRolePainter("col", ROLE, (node, cx): Block => {
	const viewer = viewerOf(node);
	if (!viewer) return { rows: [] };
	const rows = paintViewerFrame(cx.theme, viewer.frame.layout(cx.width), cx.width);
	return { rows, hits: [{ row: 0, col: 0, width: cx.width, height: rows.length, node }] };
});

defineRoleWidget("col", ROLE, {
	mouse: (node, mouse, at) => viewerOf(node)?.mouse(at.row, mouse) ?? false,
});
