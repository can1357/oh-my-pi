import type { InlineRule } from "./rule";

export const link: InlineRule = {
	name: "link",
	apply: html => html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>'),
};
