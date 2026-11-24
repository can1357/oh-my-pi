/**
 * Pieces the agent-tool looks share (propose, resolve, vibe, todo, yield,
 * wait, task…): plain text of spans, the inline status mark, the tinted
 * status box and the rows of a body's `text` nodes.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import type { PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { styledText } from "@oh-my-pi/pi-tui/term/painters/layout";
import { padTo, truncate, visibleWidth, wrap } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import type { TspSpan, TspText } from "@oh-my-pi/pi-wire";
import { type FeedModel, feedModelBadge } from "../../tools/agent-common";
import { tintRow } from "./default";
import { isActive, spinnerGlyph } from "./frame";
import type { ToolProps } from "./look";

/** The characters of a text, without styles. */
export function plainText(text: TspText | undefined): string {
	if (text === undefined) return "";
	if (typeof text === "string") return text;
	let out = "";
	for (const span of text) out += span.t;
	return out;
}

/** A text as spans. */
export function spansOf(text: TspText | undefined): readonly TspSpan[] {
	if (text === undefined) return [];
	return typeof text === "string" ? [{ t: text }] : text;
}

/** A view label's first span (the verb) and the spans after the separator that follows it. */
export function splitLabel(text: TspText | undefined): {
	title: string;
	rest: readonly TspSpan[];
} {
	const spans = spansOf(text);
	const title = spans[0]?.t ?? "";
	let rest = spans.slice(1);
	if (rest[0] && !rest[0].s && rest[0].t === " ") rest = rest.slice(1);
	return { title, rest };
}

/** The still status mark of an inline head: `⏳` while working, `✔`/`✘` once settled. */
export function stillMark(theme: Theme, props: ToolProps): string {
	if (isActive(props) || props.status === "cancelled")
		return theme.fg("muted", theme.symbols.symbol("status.pending"));
	if (props.status === "error" || props.tone === "error")
		return theme.fg("error", theme.symbols.symbol("status.error"));
	return theme.fg("success", theme.symbols.symbol("status.success"));
}

/** The animated status mark: spinner frame while working (uncolored), else `stillMark`; stopped spinners draw a muted `⏳`. */
export function liveMark(cx: PaintContext, props: ToolProps): string {
	if (!isActive(props)) return stillMark(cx.theme, props);
	return cx.reduceMotion ? cx.theme.fg("muted", spinnerGlyph(cx)) : spinnerGlyph(cx);
}

/** Background key of a status box. */
export function boxTint(props: ToolProps): string {
	if (isActive(props)) return "toolPendingBg";
	if (props.status === "error" || props.tone === "error") return "toolErrorBg";
	if (props.status === "cancelled") return "toolPendingBg";
	return "toolSuccessBg";
}

/** A status box: a blank row above and below, lines wrapped one cell in, every row in the tint. */
export function tintBox(theme: Theme, key: string, width: number, lines: readonly string[]): string[] {
	const content = Math.max(1, width - 2);
	const rows = [tintRow(theme, key, "", width)];
	for (const line of lines) {
		for (const row of line === "" ? [""] : wrap(line, content)) rows.push(tintRow(theme, key, ` ${row}`, width));
	}
	rows.push(tintRow(theme, key, "", width));
	return rows;
}

/** The styled text of a `text` (or `md`) node. */
export function nodeText(theme: Theme, node: UiNode): string {
	const props = node.props() as { text?: string; spans?: readonly TspSpan[] };
	if (props.spans) return styledText(theme, props.spans);
	return props.text ?? "";
}

/** The plain text of a `text` (or `md`) node. */
export function nodePlain(node: UiNode): string {
	const props = node.props() as { text?: string; spans?: readonly TspSpan[] };
	return props.spans ? plainText(props.spans) : (props.text ?? "");
}

/** The first span style of a `text` node. */
export function nodeStyle(node: UiNode): string | undefined {
	return (node.props() as { spans?: readonly TspSpan[] }).spans?.[0]?.s;
}

/** Each line of `text` styled with `tokens` (styles never span a row break). */
export function styledLines(theme: Theme, tokens: string | undefined, text: string): string[] {
	return text.split("\n").map(line => (tokens ? theme.style(tokens, line) : line));
}

/** A head row cut to the width. */
export function headRow(text: string, width: number): string {
	return visibleWidth(text) > width ? truncate(text, width) : text;
}

/** A row's resolved-model badge ({@link feedModelBadge}) styled: the thinking glyph accent, the rest dim; "" when nothing fits. */
export function styledModelBadge(theme: Theme, model: FeedModel, width: number): string {
	const badge = feedModelBadge(key => theme.symbols.symbol(key), model, width);
	if (!badge) return "";
	return `${badge.lead ? theme.fg("accent", badge.lead) : ""}${badge.rest ? theme.fg("dim", badge.rest) : ""}`;
}

/** A row in reverse video of `color`, full width; a row cut short loses the reverse on its last cell. */
export function bannerRow(theme: Theme, color: string, text: string, width: number): string {
	if (visibleWidth(text) > width - 1)
		return `${theme.fg(color, theme.style("inverse", truncate(text, width - 1, "")))} `;
	return theme.fg(color, theme.style("inverse", padTo(text, width)));
}
