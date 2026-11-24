/**
 * `think`: the reasoning as Markdown in the thinking face (muted italic
 * prose), one cell in from either edge; nothing while it is empty.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { type Block, EMPTY_BLOCK, type PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { renderMarkdown } from "@oh-my-pi/pi-tui/text/markdown/index";
import { defineToolLook } from "./look";

function paintThink(node: UiNode, cx: PaintContext): Block {
	const md = node.children().find(child => child.kind === "md");
	const text = (md?.props() as { text?: string } | undefined)?.text ?? "";
	if (!text.trim()) return EMPTY_BLOCK;
	return {
		rows: renderMarkdown(text, cx.width, {
			theme: cx.theme,
			paddingX: 1,
			textStyle: "muted em",
		}),
	};
}

defineToolLook("think", { paint: paintThink, margin: true });
