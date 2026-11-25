import type { InlineRule } from "./rule";

export const italic: InlineRule = {
	name: "italic",
	apply: html => html.replace(/\*(.+?)\*/g, "<em>$1</em>"),
};
