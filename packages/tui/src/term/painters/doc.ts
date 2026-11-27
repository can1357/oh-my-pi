/**
 * `doc`: a Markdown document the user reads (and, natively, edits and
 * comments on). The terminal draws the Markdown and lists the comments under
 * it: each quoted excerpt with its note. Text: the Markdown's, then each
 * excerpt without its bar and each note.
 */
import type { TspDocProps } from "@oh-my-pi/pi-wire";
import { renderMarkdownFrame } from "../../text/markdown";
import { truncate, wrap } from "../../text/width";
import { definePainter, EMPTY_BLOCK } from "../paint";
import { lazyText, literalRenderedText, mapWrappedText, type RenderedTextRow } from "../text-layout";
import { headText } from "./card";

definePainter("doc", (node, cx) => {
	const props = node.props() as TspDocProps;
	if (cx.width <= 0) return EMPTY_BLOCK;
	const theme = cx.theme;
	const frame = props.text?.trim() ? renderMarkdownFrame(props.text, cx.width, { theme }) : undefined;
	const rows = frame ? [...frame.rows] : [];
	const comments: { readonly bar: string; readonly quote: string; readonly note: string; readonly rows: number }[] =
		[];
	for (const comment of props.comments ?? []) {
		rows.push("");
		const quote = comment.quote.replace(/\s+/g, " ").trim();
		const bar = `${theme.fg("dim", theme.symbols.symbol("md.quoteBorder"))} `;
		rows.push(truncate(`${bar}${theme.fg("muted", quote)}`, cx.width));
		const note = `  ${theme.fg("accent", "✎")} ${comment.note}`;
		const noteRows = wrap(note, cx.width);
		rows.push(...noteRows);
		comments.push({ bar, quote, note, rows: noteRows.length });
	}
	if (rows.length === 0) return EMPTY_BLOCK;
	const text = lazyText(() => {
		const out: (RenderedTextRow | undefined)[] = frame ? [...frame.text()] : [];
		for (const comment of comments) {
			out.push(literalRenderedText(""));
			out.push(headText(comment.bar, comment.quote, rows[out.length]!, 0));
			out.push(...mapWrappedText(comment.note, rows.slice(out.length, out.length + comment.rows)));
		}
		return out;
	});
	return { rows, text };
});
