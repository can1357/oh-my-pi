/**
 * Settings window looks for the children a `prefs` node places by role:
 * the status-line preview (drawn from the ANSI-free spans in `term.line`,
 * which may differ from the native bar it describes) and editors without a
 * page control. Their form fields (`omp.form.field`) are drawn by the forms
 * looks.
 */
import "../forms";
import { type Block, defineRolePainter } from "@oh-my-pi/pi-tui/term/paint";
import { styledText } from "@oh-my-pi/pi-tui/term/painters/layout";
import { truncate } from "@oh-my-pi/pi-tui/text/width";
import type { TspSpan } from "@oh-my-pi/pi-wire";

/** Terminal facts of the preview child. */
interface PreviewTerm {
	readonly line?: readonly TspSpan[];
}

defineRolePainter("col", "omp.prefs.preview.status", (node, cx): Block => {
	const line = (node.props() as { term?: PreviewTerm }).term?.line;
	if (line) return { rows: [truncate(styledText(cx.theme, line), cx.width)] };
	const rows: string[] = [];
	for (const child of node.children()) rows.push(...cx.paint(child, cx.width).rows);
	return { rows };
});

defineRolePainter("col", "omp.prefs.editor", (node, cx): Block => {
	const rows: string[] = [];
	for (const child of node.children()) rows.push(...cx.paint(child, cx.width).rows);
	return { rows };
});
