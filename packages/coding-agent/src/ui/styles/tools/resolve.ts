/**
 * `resolve`: the call as `⏳ Resolve: apply ⟦proposed -> resolved⟧ reason`
 * wrapped to the width (the reason cut to {@link REASON_CHARS}); the result
 * as a reverse-video banner in its tone: blank, `✓ Accept: summary ⟦tool⟧`,
 * blank, the reason in italics, blank.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import type { Block, PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { replaceTabs, wrap } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import { bannerRow, nodePlain, spansOf, stillMark } from "./agent-common";
import { bracketed, isActive } from "./frame";
import { defineToolLook, type ToolProps, toolProps } from "./look";

/** Characters of the reason the call line shows. */
const REASON_CHARS = 72;

/** `proposed → resolved` as the terminal draws it: `⟦proposed -> resolved⟧`. */
function transition(theme: Theme, span: TspSpan | undefined): string {
	if (!span) return "";
	return theme.style(span.s, bracketed(theme, span.t.replace("→", "->")));
}

function paintCall(node: UiNode, props: ToolProps, cx: PaintContext): string[] {
	const theme = cx.theme;
	const spans = spansOf(props.title);
	const action = spans[2];
	let line = `${stillMark(theme, props)} ${theme.fg("accent", spans[0]?.t ?? "")}: ${theme.style(action?.s, action?.t ?? "")} ${transition(theme, spans[4])}`;
	const reason = node.children()[0];
	if (reason) line += ` ${theme.fg("dim", theme.fg("muted", nodePlain(reason).slice(0, REASON_CHARS)))}`;
	return wrap(line, cx.width);
}

function paintResult(node: UiNode, props: ToolProps, cx: PaintContext): string[] {
	const theme = cx.theme;
	const color = props.tone === "error" ? "error" : props.tone === "warning" ? "warning" : "success";
	const spans = spansOf(props.title);
	const glyph = theme.symbols.symbol(color === "success" ? "tool.resolve" : "status.error");
	let head = ` ${glyph} ${theme.style("strong", spans[0]?.t ?? "")} ${replaceTabs(spans[2]?.t ?? "")}`;
	const tool = spans[4];
	if (tool) head += ` ${theme.style("strong", bracketed(theme, tool.t.slice(1, -1)))}`;
	const reason = node.children()[0];
	const reasonRow = reason ? ` ${theme.style("em", nodePlain(reason))}` : "";
	const width = cx.width;
	return [
		bannerRow(theme, color, "", width),
		bannerRow(theme, color, head, width),
		bannerRow(theme, color, "", width),
		bannerRow(theme, color, reasonRow, width),
		bannerRow(theme, color, "", width),
	];
}

function paintResolve(node: UiNode, cx: PaintContext): Block {
	const props = toolProps(node);
	const settled = !isActive(props) && props.tone !== undefined;
	return {
		rows: settled ? paintResult(node, props, cx) : paintCall(node, props, cx),
	};
}

defineToolLook("resolve", { paint: paintResolve, margin: true });
