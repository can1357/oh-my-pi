/**
 * `section`: its head (`▸`/`▾` before it when collapsible, its run time
 * after), then its children indented two cells; a collapsed section shows its
 * head only.
 */
import { formatDuration } from "@oh-my-pi/pi-utils";
import type { TspSectionProps, TspTone } from "@oh-my-pi/pi-wire";
import { truncate } from "../../text/width";
import { type Block, definePainter, EMPTY_BLOCK } from "../paint";
import { bodyRows, marker } from "./card";
import { styledText } from "./layout";

definePainter("section", (node, cx): Block => {
	const props = node.props() as TspSectionProps & { tone?: TspTone };
	const theme = cx.theme;
	if (cx.width <= 0) return EMPTY_BLOCK;
	const head = styledText(theme, props.head);
	const rows: string[] = [];
	if (head || props.collapsible) {
		let line = `${marker(theme, props.collapsible, props.collapsed)}${props.tone ? theme.style(props.tone, head) : theme.style("strong", head)}`;
		if (props.took !== undefined) line += theme.style("dim", ` ${formatDuration(props.took)}`);
		rows.push(truncate(line, cx.width, theme.symbols.ellipsis));
	}
	if (props.collapsed) return { rows };
	const indent = head ? 2 : 0;
	for (const row of bodyRows(node, cx, cx.width - indent))
		rows.push(truncate(`${" ".repeat(indent)}${row}`, cx.width, ""));
	return { rows };
});
