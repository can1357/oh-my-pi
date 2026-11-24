/**
 * `omp.standalone`: the standalone select prompt in the terminal. The list
 * rows alone (no frame, no title, no hints); a list longer than its visible
 * rows gets the scrollbar and, under the rows, the search line: muted
 * `  Type to search`, or `  Search: ` and the query with a block caret.
 */
import { definePickerLook, paintPickerList, pickerTerm } from "@oh-my-pi/pi-tui/term/painters/picker";
import { truncate } from "@oh-my-pi/pi-tui/text/width";
import type { TspPickerProps } from "@oh-my-pi/pi-wire";

/** The look id of the standalone select prompt. */
export const STANDALONE_LOOK = "omp.standalone";

definePickerLook(STANDALONE_LOOK, (node, cx) => {
	const theme = cx.theme;
	const list = paintPickerList(node, theme, cx.width);
	const rows = [...list.rows];
	if (pickerTerm(node).search) {
		const props = node.props() as TspPickerProps;
		const query = props.query ?? "";
		let line: string;
		if (query.length === 0) line = theme.style("muted", "  Type to search");
		else {
			const at = Math.min(query.length, Math.max(0, props.cursor ?? query.length));
			const chars = Array.from(query.slice(at));
			const under = chars.shift() ?? " ";
			line = `${theme.style("muted", "  Search: ")}${query.slice(0, at)}${theme.style("inverse", under)}${chars.join("")}`;
		}
		rows.push(truncate(line, cx.width, theme.symbols.ellipsis));
	}
	return { rows, hits: list.hits };
});
