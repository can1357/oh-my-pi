/** `badge`: a short tone-colored chip (`[truncated]`, `[3]`). */
import type { TspBadgeProps, TspTone } from "@oh-my-pi/pi-wire";
import { truncate } from "../../text/width";
import { type Block, definePainter, EMPTY_BLOCK, type PaintContext } from "../paint";

/** One row cut to the width; empty text paints nothing. */
export function lineBlock(text: string, cx: PaintContext): Block {
	return text === "" ? EMPTY_BLOCK : { rows: [truncate(text, cx.width, cx.theme.symbols.ellipsis)] };
}

definePainter("badge", (node, cx) => {
	const props = node.props() as TspBadgeProps & { tone?: TspTone };
	if (!props.text) return EMPTY_BLOCK;
	return lineBlock(cx.theme.style(props.tone ?? "muted", `[${props.text}]`), cx);
});
