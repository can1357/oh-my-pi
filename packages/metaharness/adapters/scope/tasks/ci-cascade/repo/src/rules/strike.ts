import type { InlineRule } from "./rule";

export const strike: InlineRule = {
	name: "strike",
	apply: html => html.replace(/~~(.+)~~/g, "<del>$1</del>"),
};
