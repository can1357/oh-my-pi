/**
 * The `mcp` look: `🔌 server/tool` (spinner while streaming, `⏳` pending),
 * the pending call's args summary on a branch, then the output: JSON as a
 * tree, text as muted lines or Markdown (four collapsed, twelve expanded, then
 * `… N more lines`), the args listed above it when expanded, an expand hint
 * while collapsed.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import type { Block, PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { styledText } from "@oh-my-pi/pi-tui/term/painters/layout";
import { replaceTabs, truncate, wrap } from "@oh-my-pi/pi-tui/text/width";
import { argsSummaryCells } from "../../tools/args";
import type { McpTerm } from "../../tools/mcp";
import { expandHint, hangingWrap, moreLinesHint, spinnerGlyph } from "./frame";
import { COLLAPSED_TREE, EXPANDED_TREE, jsonTreeRows } from "./json-tree";
import { defineToolLook, toolProps } from "./look";
import { renderMarkdownFrame } from "@oh-my-pi/pi-tui/text/markdown/index";

/** Fewest cells a pending call's args summary gets. */
const SUMMARY_MIN = 20;
/** Output lines shown collapsed / expanded. */
const COLLAPSED_LINES = 4;
const EXPANDED_LINES = 12;

function paintMcp(node: UiNode, cx: PaintContext): Block {
	const props = toolProps(node);
	const term = (props.term ?? { look: "mcp" }) as McpTerm;
	const theme = cx.theme;
	const title = theme.fg("accent", styledText(theme, props.title));
	// The call's part: its head never animates, and its args summary hangs under it.
	const callRows: string[] = [];
	if (term.call || !term.result) {
		const callTitle = term.callTitle === undefined ? title : theme.fg("accent", term.callTitle);
		callRows.push(...wrap(`${theme.fg("muted", theme.symbols.symbol("status.pending"))} ${callTitle}`, cx.width));
		// The summary gets at least SUMMARY_MIN cells; a narrower row wraps it under the branch.
		if (term.args) {
			const summary = argsSummaryCells(term.args, Math.max(SUMMARY_MIN, cx.width - 4));
			callRows.push(
				...hangingWrap(
					` ${theme.fg("dim", theme.symbols.symbol("tree.last"))} `,
					"    ",
					theme.fg("dim", summary),
					cx.width,
				),
			);
		}
	}
	if (!term.result) return { rows: callRows };
	const glyph =
		props.status === "running"
			? spinnerGlyph(cx)
			: props.status === "cancelled"
				? theme.fg("muted", theme.symbols.symbol("status.pending"))
				: term.error !== undefined
					? theme.fg("error", theme.symbols.symbol("status.error"))
					: theme.fg("accent", theme.symbols.symbol("tool.mcp"));
	const rows = [...callRows, ...wrap(`${glyph} ${title}`, cx.width)];
	const expanded = props.collapsed === false;
	const output: string[] = [];
	let hint: string | undefined;
	if (term.json !== undefined) {
		// Tree rows are cut to the width: a wrapped row would restart left of its gutter.
		const tree = jsonTreeRows(theme, term.json, expanded ? EXPANDED_TREE : COLLAPSED_TREE).rows;
		output.push(...tree.map(row => truncate(row, cx.width)));
		if (!expanded) hint = expandHint(theme);
	} else {
		const text = term.error ?? term.text;
		if (text === undefined) output.push(theme.fg("dim", "(no output)"));
		else {
			const lines =
				term.markdown && term.error === undefined
					? renderMarkdownFrame(text, cx.width, {
							theme,
							hyperlinks: cx.hyperlinks,
						}).rows.map(row => row.trimEnd())
					: text.split("\n").map(line => theme.fg("muted", replaceTabs(line.trimEnd())));
			const limit = expanded ? EXPANDED_LINES : COLLAPSED_LINES;
			const hidden = Math.max(0, lines.length - limit);
			output.push(...lines.slice(0, lines.length - hidden));
			if (hidden > 0)
				hint = expanded
					? theme.fg("dim", `${theme.symbols.ellipsis} ${hidden} more lines`)
					: moreLinesHint(theme, hidden);
			else if (!expanded) hint = expandHint(theme);
		}
	}
	const lines =
		expanded && term.args
			? [
					theme.fg("dim", "Args"),
					...jsonTreeRows(theme, term.args).rows.map(row => truncate(row, cx.width)),
					"",
					...output,
				]
			: output;
	for (const line of lines) rows.push(...(line === "" ? [""] : wrap(line, cx.width)));
	if (hint) rows.push(...wrap(hint, cx.width));
	return { rows };
}

defineToolLook("mcp", { paint: paintMcp, boxed: true });
