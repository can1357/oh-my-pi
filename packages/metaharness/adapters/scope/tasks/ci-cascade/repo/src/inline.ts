import { escape } from "./escape";
import { RULES } from "./rules/index";

/** Renders inline Markdown: applies {@link RULES} in order to the safe text; code spans stay literal. */
export function renderInline(text: string): string {
	let html = escape(text);
	for (const rule of RULES) html = rule.apply(html);
	return html.replace(/`([^`]+)`/g, "<code>$1</code>");
}
