/**
 * `seg`: one status-bar segment on one row — its icon (tinted by its tone),
 * a space, then its spans. Cut to the width it gets: at the end with an
 * ellipsis, or at the start when the `term` look says `truncate: "start"`
 * (paths, whose tail is what matters).
 */
import type { TspSegProps, TspTone } from "@oh-my-pi/pi-wire";
import type { UiNode } from "../../node";
import { truncate, truncateStart } from "../../text/width";
import type { Theme } from "../../theme/contract";
import { type Block, definePainter, EMPTY_BLOCK, type PaintContext } from "../paint";
import { styledText } from "./layout";

/** Terminal-only look facts a `seg` may carry. */
export interface SegTermLook {
	/** Which end gives way when the segment is cut (default `end`). */
	readonly truncate?: "start" | "end";
}

type SegProps = TspSegProps & { tone?: TspTone; term?: SegTermLook };

/** The segment's full row: icon (tinted by tone) and spans; "" when it shows nothing. */
export function segText(theme: Theme, props: SegProps): string {
	const body = styledText(theme, props.spans);
	const glyph = props.icon ? theme.symbols.icon(props.icon) : "";
	if (!glyph) return body;
	const icon = props.tone ? theme.style(props.tone, glyph) : glyph;
	return body ? `${icon} ${body}` : icon;
}

/** `text` cut to `width` cells from the end the look names. */
export function cutSeg(text: string, width: number, look: SegTermLook | undefined, ellipsis: string): string {
	return look?.truncate === "start" ? truncateStart(text, width, ellipsis) : truncate(text, width, ellipsis);
}

function paintSeg(node: UiNode, cx: PaintContext): Block {
	const props = node.props() as SegProps;
	const text = segText(cx.theme, props);
	if (!text) return EMPTY_BLOCK;
	return { rows: [cutSeg(text, cx.width, props.term, cx.theme.symbols.ellipsis)] };
}

definePainter("seg", paintSeg);
