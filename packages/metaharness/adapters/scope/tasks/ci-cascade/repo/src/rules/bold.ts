import type { InlineRule } from "./rule";

export const bold: InlineRule = {
	name: "bold",
	apply: html => html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>"),
};
