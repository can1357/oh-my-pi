/**
 * The generic `tool` (any tool without a look of its own): a head line
 * (status glyph, title, target, meta, badges, note, exit code) over its
 * body, boxed like a card for `frame:"card"`, indented under the head for
 * `frame:"inline"`; collapsed, the body keeps its `preview` rows.
 */
import type { TspCardStatus, TspPreview, TspTone, TspToolProps } from "@oh-my-pi/pi-wire";
import { truncate } from "../../text/width";
import { type Block, definePainter, EMPTY_BLOCK, type PaintContext } from "../paint";
import { bodyRows, borderOf, boxRows, disclosed } from "./card";
import { styledText } from "./layout";
import { SPINNER_INTERVAL_MS } from "./spinner";

/** The status glyph of a tool head: the spinner while it works (still under reduced motion). */
function statusGlyph(cx: PaintContext, status: TspCardStatus, tone: TspTone | undefined): string {
	const theme = cx.theme;
	const symbol = (key: string, color: string): string => theme.style(color, theme.symbols.symbol(key));
	switch (status) {
		case "running":
		case "pending": {
			const frames = theme.symbols.spinnerFrames;
			if (cx.reduceMotion || frames.length === 0) return symbol("status.pending", "muted");
			return theme.style("accent", frames[Math.floor(cx.now() / SPINNER_INTERVAL_MS) % frames.length]!);
		}
		case "error":
			return symbol("status.error", "error");
		case "cancelled":
			return symbol("status.aborted", "muted");
		default:
			return tone === "warning" ? symbol("status.warning", "warning") : symbol("status.success", "success");
	}
}

/** The head line of a tool: glyph, title, target, meta, badges, note, exit code. */
function toolHead(cx: PaintContext, props: TspToolProps & { tone?: TspTone }): string {
	const theme = cx.theme;
	let line = `${statusGlyph(cx, props.status, props.tone)} ${theme.style("accent", styledText(theme, props.title))}`;
	const target = styledText(theme, props.target);
	if (target) line += ` ${theme.style("muted", target.replace(/[\r\n]+/g, " "))}`;
	const meta = (props.meta ?? []).map(item => styledText(theme, item)).filter(item => item.length > 0);
	if (meta.length > 0) line += ` ${theme.style("dim", meta.join(theme.symbols.symbol("sep.dot")))}`;
	for (const badge of props.badges ?? [])
		line += ` ${theme.style(badge.tone ?? "muted", `${theme.symbols.symbol("format.bracketLeft")}${badge.text}${theme.symbols.symbol("format.bracketRight")}`)}`;
	const note = styledText(theme, props.note);
	if (note) line += ` ${theme.style("dim", note)}`;
	if (props.exit !== undefined && props.exit !== null && props.exit !== 0)
		line += ` ${theme.style("error", `exit ${props.exit}`)}`;
	return line;
}

definePainter("tool", (node, cx): Block => {
	const props = node.props() as TspToolProps & {
		tone?: TspTone;
		collapsible?: boolean;
		collapsed?: boolean;
		preview?: TspPreview;
	};
	const theme = cx.theme;
	if (cx.width <= 0) return EMPTY_BLOCK;
	const head = toolHead(cx, props);
	const collapsed = props.collapsed === true;
	if (props.frame === "inline") {
		const rows = [truncate(head, cx.width, theme.symbols.ellipsis)];
		for (const row of disclosed(theme, bodyRows(node, cx, cx.width - 2), collapsed, props.preview))
			rows.push(truncate(`  ${row}`, cx.width, ""));
		return { rows };
	}
	const body = disclosed(theme, bodyRows(node, cx, cx.width - 4), collapsed, props.preview);
	return {
		rows: boxRows(theme, body, cx.width, head, borderOf(props.tone, props.status)),
	};
});
