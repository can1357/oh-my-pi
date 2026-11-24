/**
 * `input`: a one-line editable field. The text never wraps: a field narrower
 * than its text shows the columns around the caret (the editor's looks
 * otherwise, see `./editor`).
 */
import { sliceColumns, visibleWidth } from "../../text/width";
import { definePainter } from "../paint";
import { caretCell, caretOf, type EditorProps, layoutText, paintField } from "./editor";

definePainter("input", (node, cx) => {
	const block = paintField(node, cx, { wrap: false });
	const row = block.rows[0] ?? "";
	if (visibleWidth(row) <= cx.width) return block;
	const props = node.props() as EditorProps;
	const text = props.text ?? "";
	const caret = caretCell(text, layoutText(text, Number.MAX_SAFE_INTEGER), caretOf(props)).col;
	// Keep one cell right of the caret for an end-of-text bar.
	const start = Math.max(0, caret + 1 - cx.width);
	return {
		rows: [sliceColumns(row, start, start + cx.width)],
		...(block.cursor ? { cursor: { row: 0, col: block.cursor.col - start } } : {}),
	};
});
