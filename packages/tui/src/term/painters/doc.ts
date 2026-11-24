/**
 * `doc`: a Markdown document the user reads (and, natively, edits and
 * comments on). The terminal draws the Markdown and lists the comments under
 * it: each quoted excerpt with its note.
 */
import type { TspDocProps } from "@oh-my-pi/pi-wire";
import { renderMarkdown } from "../../text/markdown";
import { truncate, wrap } from "../../text/width";
import { definePainter, EMPTY_BLOCK } from "../paint";

definePainter("doc", (node, cx) => {
	const props = node.props() as TspDocProps;
	if (cx.width <= 0) return EMPTY_BLOCK;
	const theme = cx.theme;
	const rows = props.text?.trim() ? renderMarkdown(props.text, cx.width, { theme }) : [];
	for (const comment of props.comments ?? []) {
		rows.push("");
		const quote = comment.quote.replace(/\s+/g, " ").trim();
		rows.push(
			truncate(`${theme.fg("dim", theme.symbols.symbol("md.quoteBorder"))} ${theme.fg("muted", quote)}`, cx.width),
		);
		rows.push(...wrap(`  ${theme.fg("accent", "✎")} ${comment.note}`, cx.width));
	}
	return rows.length === 0 ? EMPTY_BLOCK : { rows };
});
