/** `kbd`: a key combination (`ctrl+o`), dimmed. */
import type { TspKbdProps } from "@oh-my-pi/pi-wire";
import { definePainter, EMPTY_BLOCK } from "../paint";
import { lineBlock } from "./badge";

definePainter("kbd", (node, cx) => {
	const keys = (node.props() as TspKbdProps).keys ?? [];
	if (keys.length === 0) return EMPTY_BLOCK;
	return lineBlock(cx.theme.style("dim", keys.join("+")), cx);
});
