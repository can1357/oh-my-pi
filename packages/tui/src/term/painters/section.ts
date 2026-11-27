/**
 * `section`: its head (`▸`/`▾` before it when collapsible, its run time
 * after), then its children indented two cells; a collapsed section shows its
 * head only. Text: the head without its marker, then the children's.
 */
import { formatDuration } from "@oh-my-pi/pi-utils";
import type { TspSectionProps, TspTone } from "@oh-my-pi/pi-wire";
import { truncate } from "../../text/width";
import { type Block, definePainter, EMPTY_BLOCK } from "../paint";
import { blockText, clipRenderedText, lazyText, offsetRenderedText } from "../text-layout";
import { body, headText, marker } from "./card";
import { styledText } from "./layout";

definePainter("section", (node, cx): Block => {
	const props = node.props() as TspSectionProps & { tone?: TspTone };
	const theme = cx.theme;
	if (cx.width <= 0) return EMPTY_BLOCK;
	const head = styledText(theme, props.head);
	const rows: string[] = [];
	const chrome = marker(theme, props.collapsible, props.collapsed);
	let label = "";
	if (head || props.collapsible) {
		label = props.tone ? theme.style(props.tone, head) : theme.style("strong", head);
		if (props.took !== undefined) label += theme.style("dim", ` ${formatDuration(props.took)}`);
		rows.push(truncate(`${chrome}${label}`, cx.width, theme.symbols.ellipsis));
	}
	const titled = rows.length > 0;
	const indent = head ? 2 : 0;
	const inner = props.collapsed ? EMPTY_BLOCK : body(node, cx, cx.width - indent);
	for (const row of inner.rows) rows.push(truncate(`${" ".repeat(indent)}${row}`, cx.width, ""));
	return {
		rows,
		text: lazyText(() => [
			...(titled ? [headText(chrome, label, rows[0]!, 0)] : []),
			...blockText(inner).map(row => clipRenderedText(offsetRenderedText(row, indent), cx.width)),
		]),
	};
});
