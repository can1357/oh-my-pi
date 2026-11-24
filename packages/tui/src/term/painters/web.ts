/**
 * `web`: a terminal cannot show a live page, so it names it: `▣ <title>`
 * (else the URL) in `dim`, cut to the width.
 */
import type { TspWebProps } from "@oh-my-pi/pi-wire";
import { truncate } from "../../text/width";
import { definePainter } from "../paint";

definePainter("web", (node, cx) => {
	const props = node.props() as TspWebProps;
	return { rows: [truncate(cx.theme.fg("dim", `▣ ${props.title || props.url}`), cx.width)] };
});
