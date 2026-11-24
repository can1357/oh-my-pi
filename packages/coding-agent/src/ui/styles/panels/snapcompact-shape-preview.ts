/**
 * The snapcompact preview's terminal look: the indented muted caption, a
 * blank row, and a dim notice where the sample would be (the terminal
 * backend does not draw images inside panels).
 */
import { type Block, defineRolePainter } from "@oh-my-pi/pi-tui/term/paint";
import { truncate } from "@oh-my-pi/pi-tui/text/width";
import type { TspTextProps } from "@oh-my-pi/pi-wire";
import { plainText, propsOf, termOf } from "./common";

const NOTICES: Readonly<Record<string, string>> = {
	rendering: "rendering sample…",
	failed: "(sample render failed)",
	ready: "(graphic sample needs a Kitty-graphics terminal)",
};

defineRolePainter("col", "omp.preview.snapcompact-shape", (node, cx): Block => {
	const theme = cx.theme;
	const term = termOf<{ graphics: boolean; state: string }>(node);
	const caption = node.children()[0];
	const text = caption ? plainText(propsOf<TspTextProps>(caption).spans) : "";
	const notice = term.graphics
		? (NOTICES[term.state ?? "rendering"] ?? NOTICES.ready!)
		: "(graphic sample needs a Kitty-graphics terminal)";
	return {
		rows: [
			theme.fg("muted", truncate(`  ${text}`, cx.width, theme.symbols.ellipsis)),
			"",
			theme.fg("dim", truncate(`  ${notice}`, cx.width, theme.symbols.ellipsis)),
		],
	};
});
