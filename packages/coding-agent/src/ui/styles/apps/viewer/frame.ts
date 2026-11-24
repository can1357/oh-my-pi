/**
 * `omp.viewer.frame`: a debug viewer's frame in the terminal. A rounded box
 * titled with the viewer's name: header rows, a rule, the body window (a
 * scrollbar in its last column while the body overflows), a rule, footer
 * rows. Header and footer rows are cut with an ellipsis at the inner width;
 * body rows one cell shorter when the scrollbar shows.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { defineRolePainter } from "@oh-my-pi/pi-tui/term/paint";
import { boxBottom, boxRow, boxRule, boxTop, scrollbar } from "@oh-my-pi/pi-tui/term/painters/picker";
import { padTo, truncate } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";

/** The terminal role of a viewer frame's `canvas`. */
export const FRAME_ROLE = "omp.viewer.frame";

/** One resolved frame: content rows and the body window. */
export interface ViewerFrameLayout {
	readonly title: string;
	readonly header: readonly string[];
	readonly body: readonly string[];
	/** First body row shown. */
	readonly top: number;
	readonly bodyHeight: number;
	readonly footer: readonly string[];
}

/** The frame's rows at `width`. */
export function paintViewerFrame(theme: Theme, layout: ViewerFrameLayout, width: number): string[] {
	const inner = Math.max(0, width - 4);
	const ellipsis = theme.symbols.ellipsis;
	const line = (text: string): string => boxRow(theme, width, truncate(text, inner, ellipsis));
	const rows = [boxTop(theme, width, layout.title)];
	for (const header of layout.header) rows.push(line(header));
	rows.push(boxRule(theme, width));
	const total = layout.body.length;
	const overflow = total > layout.bodyHeight;
	const bar = overflow ? scrollbar(theme, total, layout.top, layout.bodyHeight) : undefined;
	for (let i = 0; i < layout.bodyHeight; i++) {
		const text = layout.body[layout.top + i] ?? "";
		if (!bar) rows.push(line(text));
		else rows.push(boxRow(theme, width, `${padTo(truncate(text, inner - 1, ellipsis), inner - 1)}${bar[i]}`));
	}
	rows.push(boxRule(theme, width));
	for (const footer of layout.footer) rows.push(line(footer));
	rows.push(boxBottom(theme, width));
	return rows;
}

defineRolePainter("canvas", FRAME_ROLE, (node: UiNode, cx) => {
	const frame = (node.props() as { term?: { frame?: { layout(width: number): ViewerFrameLayout } } }).term?.frame;
	return { rows: frame ? paintViewerFrame(cx.theme, frame.layout(cx.width), cx.width) : [] };
});
