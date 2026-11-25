/**
 * Relative prose links handed to a native terminal resolved: it renders the
 * Markdown source itself and would resolve `./a.ts` against its own idea of
 * the working directory.
 */
import { lexMarkdown, type Token } from "@oh-my-pi/pi-tui/text/markdown/lexer";

/**
 * `text` with the destination of every inline link and link definition
 * replaced by `resolve(href)` (when it names another target); everything
 * else stays byte for byte. Links inside code, images and autolinks are left
 * alone, as is a link whose source cannot be located exactly.
 */
export function rewriteLinkDestinations(text: string, resolve: (href: string) => string | undefined): string {
	if (!text.includes("]")) return text;
	const edits: { start: number; end: number; target: string }[] = [];
	let cursor = 0;
	const visit = (tokens: readonly Token[] | undefined): void => {
		for (const token of tokens ?? []) {
			const at = token.raw ? text.indexOf(token.raw, cursor) : -1;
			if (token.type === "link" || token.type === "def") {
				if (at < 0) continue;
				cursor = at + token.raw.length;
				const href = "href" in token && typeof token.href === "string" ? token.href : "";
				const target = href ? resolve(href) : undefined;
				if (!target || target === href) continue;
				// The destination follows the label: `](dest` for links, `]: dest` for definitions.
				const opener = token.type === "link" ? "](" : "]:";
				const labelEnd = token.raw.indexOf(opener);
				if (labelEnd < 0) continue;
				let start = labelEnd + opener.length;
				while (token.raw[start] === " " || token.raw[start] === "\t") start++;
				const raw = token.raw.slice(start);
				const bracketed = raw.startsWith("<") && raw.indexOf(">") > 0;
				const dest = bracketed ? raw.slice(1, raw.indexOf(">")) : (/^[^\s)]+/.exec(raw)?.[0] ?? "");
				if (dest !== href) continue;
				const offset = at + start + (bracketed ? 1 : 0);
				edits.push({ start: offset, end: offset + dest.length, target });
				continue;
			}
			const nested = "tokens" in token && Array.isArray(token.tokens) ? token.tokens : undefined;
			const items = token.type === "list" && "items" in token ? (token.items as readonly Token[]) : undefined;
			if (token.type === "image" || token.type === "code" || token.type === "codespan" || (!nested && !items)) {
				if (at >= 0) cursor = at + token.raw.length;
				continue;
			}
			visit(nested);
			visit(items);
		}
	};
	visit(lexMarkdown(text));
	let out = text;
	for (const edit of edits.reverse()) out = out.slice(0, edit.start) + edit.target + out.slice(edit.end);
	return out;
}
