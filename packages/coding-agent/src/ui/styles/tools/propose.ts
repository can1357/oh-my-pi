/**
 * `propose`: `⏳ Propose: subject` (the mark stays still while working),
 * then the body's text rows.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import type { Block, PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { styledText } from "@oh-my-pi/pi-tui/term/painters/layout";
import { wrap } from "@oh-my-pi/pi-tui/text/width";
import { nodeText, splitLabel, stillMark } from "./agent-common";
import { defineToolLook, toolProps } from "./look";

function paintPropose(node: UiNode, cx: PaintContext): Block {
	const props = toolProps(node);
	const theme = cx.theme;
	const { title, rest } = splitLabel(props.title);
	const subject = rest.length > 0 ? `: ${styledText(theme, rest)}` : "";
	const rows = wrap(`${stillMark(theme, props)} ${theme.fg("accent", title)}${subject}`, cx.width);
	for (const child of node.children()) rows.push(...wrap(nodeText(theme, child), cx.width));
	return { rows };
}

defineToolLook("propose", { paint: paintPropose });
