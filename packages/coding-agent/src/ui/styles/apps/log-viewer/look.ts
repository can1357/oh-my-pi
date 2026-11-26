/**
 * `omp.app.logs` (`term.role` of the log viewer's picker): the log viewer in
 * the terminal, a framed list of raw log lines (`term.viewer`): the summary
 * and filter lines, the entries with cursor, selection and fold markers, the
 * status and key hints. Pointer events anywhere on it go to the viewer.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { type Block, defineRolePainter } from "@oh-my-pi/pi-tui/term/paint";
import { defineRoleWidget } from "@oh-my-pi/pi-tui/term/widgets";
import type { LogViewerModel } from "../../../apps/log-viewer/model";
import { paintViewerFrame } from "../viewer/frame";

const ROLE = "omp.app.logs";

function viewerOf(node: UiNode): LogViewerModel | undefined {
	return (node.props() as { term?: { viewer?: LogViewerModel } }).term?.viewer;
}

defineRolePainter("picker", ROLE, (node, cx): Block => {
	const viewer = viewerOf(node);
	if (!viewer) return { rows: [] };
	const rows = paintViewerFrame(cx.theme, viewer.frame.layout(cx.width), cx.width);
	return { rows, hits: [{ row: 0, col: 0, width: cx.width, height: rows.length, node }] };
});

defineRoleWidget("picker", ROLE, {
	mouse: (node, mouse, at) => viewerOf(node)?.mouse(at.row, mouse) ?? false,
});
