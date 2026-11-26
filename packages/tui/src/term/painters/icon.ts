/** `icon`: a named glyph from the theme's symbol preset, tinted by its tone. */
import type { TspIconProps, TspTone } from "@oh-my-pi/pi-wire";
import { definePainter, EMPTY_BLOCK } from "../paint";
import { lineBlock } from "./badge";

definePainter("icon", (node, cx) => {
	const props = node.props() as TspIconProps & { tone?: TspTone };
	const glyph = cx.theme.symbols.icon(props.name);
	if (!glyph) return EMPTY_BLOCK;
	return lineBlock(props.tone ? cx.theme.style(props.tone, glyph) : glyph, cx);
});
